process.env.NODE_ENV = 'test';
process.env.USE_LOCAL_DB = 'true';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { createSessionToken } from '../src/auth/authService.js';
import { FollowUpService } from '../src/services/followUpService.js';
import { validateReviewUrl } from '../src/routes/growthFeatures.js';

function account(name, role = 'owner') {
  const org = db.insert('organizations', { name });
  const user = db.insert('profiles', { org_id: org.id, role });
  db.insert('organization_members', { user_id: user.id, organization_id: org.id, role });
  return { org, user, token: createSessionToken(user.id, org.id, role) };
}

test('review preparation is tenant scoped, consent-confirmed, deduplicated, and never sends', async () => {
  db.persist = () => {};
  const owner = account('review-owner'), other = account('review-other'), agency = account('review-agency');
  const lead = db.insert('leads', { organization_id: owner.org.id, buyer_phone: '9876543201', status: 'new' });
  const opted = db.insert('leads', { organization_id: owner.org.id, buyer_phone: '9876543202', status: 'converted' });
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(user, path, method='GET', body) { const r = await fetch(base+path,{method,headers:{authorization:`Bearer ${user.token}`,'content-type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})}); return {status:r.status, data:await r.json()}; }
  try {
    assert.equal(validateReviewUrl('https://g.page/r/abc/review'), true);
    for (const url of ['https://google.com.evil.test', 'http://google.com', 'https://google.com@evil.test', 'javascript:alert(1)']) assert.equal(validateReviewUrl(url), false);
    assert.equal((await call(owner,'/review-requests/settings','PUT',{reviewUrl:'https://evil.test',enabled:true})).status, 400);
    assert.equal((await call(owner,'/review-requests/settings','PUT',{reviewUrl:'https://g.page/r/example/review',enabled:true})).status, 200);
    const payload={leadId:lead.id,dealConfirmed:true,consentConfirmed:true};
    assert.equal((await call(owner,'/review-requests','POST',{...payload,consentConfirmed:false})).status, 400);
    assert.equal((await call(owner,'/review-requests','POST',payload)).status, 409);
    assert.equal((await call(other,`/leads/${lead.id}/status`,'POST',{status:'converted'})).status, 404);
    assert.equal(db.findById('leads',lead.id).status,'new');
    assert.equal((await call(owner,`/leads/${lead.id}/status`,'POST',{status:'converted'})).status, 200);
    assert.equal((await call(other,'/review-requests/settings','PUT',{reviewUrl:'https://g.page/r/other/review',enabled:true})).status, 200);
    assert.equal((await call(other,'/review-requests','POST',payload)).status, 404);
    FollowUpService.recordOptOut(owner.org.id,'919876543202');
    assert.equal((await call(owner,'/review-requests','POST',{...payload,leadId:opted.id})).status, 409);
    const created=await call(owner,'/review-requests','POST',payload);
    assert.equal(created.status,201); assert.equal(created.data.deliveryAvailable,false); assert.equal(created.data.request.status,'awaiting_delivery_setup');
    assert.equal((await call(owner,'/review-requests','POST',payload)).status,409);
    assert.equal((await call(owner,'/review-requests')).data.requests.length,1);
    assert.equal((await call(other,'/review-requests')).data.requests.length,0);
    db.insert('catalog_management_grants', { user_id:agency.user.id, org_id:agency.org.id });
    assert.equal((await call(agency,'/review-requests')).status,403);
    assert.equal((await call(agency,'/review-requests/settings')).status,403);
  } finally { await new Promise(r=>server.close(r)); }
});

test('website key is scoped to approved catalogue, rotates, rejects stale updates and follows grant revocation', async () => {
  db.persist = () => {};
  const agency=account('website-agency'), client=account('website-client'), other=account('website-other');
  const grant=db.insert('catalog_management_grants',{user_id:agency.user.id,org_id:client.org.id});
  const p=db.insert('products',{org_id:client.org.id,name:'Widget',category:'Tools',is_active:true});
  db.insert('products',{org_id:other.org.id,name:'Private other product',is_active:true});
  const app=express();app.use(express.json());app.use('/api',apiRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}/api`;
  async function call(path,method='GET',body,headers={}) { const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...headers},...(body ? {body:JSON.stringify(body)} : {})});return {status:r.status,data:await r.json()}; }
  const auth=x=>({authorization:`Bearer ${x.token}`});
  const site=key=>({'x-website-key':key});
  try {
    assert.equal((await call('/website-integration/key','POST',{orgId:client.org.id},auth(client))).status,403);
    assert.equal((await call('/website-integration/key','POST',{orgId:other.org.id},auth(agency))).status,403);
    const issued=await call('/website-integration/key','POST',{orgId:client.org.id},auth(agency));
    assert.equal(issued.status,200); const key=issued.data.key;
    const stored=db.findOne('custom_website_integrations',r=>r.org_id===client.org.id);
    assert.ok(stored.token_hash && stored.token_hash !== key && !JSON.stringify(stored).includes(key));
    assert.equal((await call('/website-integration/products')).status,401);
    const list=await call('/website-integration/products','GET',null,site(key));
    assert.equal(list.status,200);assert.deepEqual(list.data.products.map(x=>x.name),['Widget']);
    assert.equal((await call(`/website-integration/products/${p.id}`,'PATCH',{expectedUpdatedAt:p.updated_at,name:'Updated',image_url:'https://evil.test'},site(key))).status,400);
    const update=await call(`/website-integration/products/${p.id}`,'PATCH',{expectedUpdatedAt:p.updated_at,name:'Updated',category:'Home'},site(key));
    assert.equal(update.status,200); assert.equal(update.data.product.name,'Updated');
    assert.equal((await call(`/website-integration/products/${p.id}`,'PATCH',{expectedUpdatedAt:p.updated_at,name:'Stale'},site(key))).status,409);
    const rotated=await call('/website-integration/key','POST',{orgId:client.org.id},auth(agency));
    assert.equal(rotated.status,200);assert.equal((await call('/website-integration/products','GET',null,site(key))).status,401);
    db.delete('catalog_management_grants',grant.id);
    assert.equal((await call('/website-integration/products','GET',null,site(rotated.data.key))).status,403);
  } finally {await new Promise(r=>server.close(r));}
});
