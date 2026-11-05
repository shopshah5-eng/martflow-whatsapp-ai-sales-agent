process.env.NODE_ENV = 'test';
process.env.USE_LOCAL_DB = 'true';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { app, server as autoServer } from '../server.js';
import db from '../src/db/index.js';
import { createSessionToken } from '../src/auth/authService.js';

// Importing server.js starts its normal listener. Stop it after these tests.
test.after(() => { autoServer.close(); });
test('legacy config does not expose or change owner settings for catalogue-only members', async () => {
  db.persist = () => {};
  const org = db.insert('organizations', { name: 'Private', owner_alert_number:'919876543210' });
  const owner = db.insert('profiles', { email:'owner@example.test', role:'owner', org_id:org.id });
  const manager = db.insert('profiles', { email:'agency@example.test', role:'admin', org_id:org.id });
  const member = db.insert('profiles', { email:'member@example.test', role:'member', org_id:org.id });
  for (const [user,role] of [[owner,'owner'],[manager,'admin'],[member,'member']]) db.insert('organization_members',{user_id:user.id,organization_id:org.id,role});
  db.insert('catalog_management_grants',{organization_id:org.id,user_id:manager.id});
  const local = app.listen(0,'127.0.0.1'); await new Promise(r=>local.once('listening',r));
  const root = `http://127.0.0.1:${local.address().port}/api`;
  const token = (u,role) => createSessionToken(u.id,org.id,role);
  async function req(u,role,path='/config',method='GET',body) { return fetch(root+path,{method,headers:{Authorization:`Bearer ${token(u,role)}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}); }
  try {
    const ownerResponse = await req(owner,'owner'); assert.equal(ownerResponse.status,200,JSON.stringify(await ownerResponse.json()));
    assert.equal((await req(member,'member')).status,403);
    assert.equal((await req(manager,'admin','/config?org_id=other')).status,403);
    assert.equal((await req(manager,'admin','/config','POST',{ownerAlertPhone:'911111111111'})).status,403);
    assert.equal(db.findById('organizations',org.id).owner_alert_number,'919876543210');
  } finally { await new Promise(r=>local.close(r)); }
});

test('catalogue AI extraction reaches the model without undefined conversation variables', async () => {
  db.persist = () => {};
  const org = db.insert('organizations',{name:'Synthetic'});
  const user = db.insert('profiles',{email:'manager@example.test',org_id:org.id,role:'owner'});
  db.insert('organization_members',{organization_id:org.id,user_id:user.id,role:'owner'});
  db.insert('catalog_management_grants',{organization_id:org.id,user_id:user.id});
  const local=app.listen(0,'127.0.0.1'); await new Promise(r=>local.once('listening',r));
  const originalFetch=globalThis.fetch, oldKey=process.env.GEMINI_API_KEY;
  let modelCalls=0;
  process.env.GEMINI_API_KEY='synthetic-test-key';
  globalThis.fetch=async (url, opts) => {
    if (String(url).startsWith('https://generativelanguage.googleapis.com/')) {
      modelCalls++; return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify({items:[{name:'Example'}]})}]}}]})};
    }
    return originalFetch(url,opts);
  };
  try {
    const r=await originalFetch(`http://127.0.0.1:${local.address().port}/api/catalog/extract-ai`,{method:'POST',headers:{Authorization:`Bearer ${createSessionToken(user.id,org.id,'owner')}`,'Content-Type':'application/json'},body:JSON.stringify({rawText:'Example product'})});
    const data=await r.json();
    assert.equal(r.status,200); assert.equal(data.ok,true); assert.equal(data.items[0].name,'Example'); assert.equal(modelCalls,1);
  } finally { globalThis.fetch=originalFetch; if(oldKey===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=oldKey; await new Promise(r=>local.close(r)); }
});
