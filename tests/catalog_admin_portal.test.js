import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/catalog-admin.html', import.meta.url), 'utf8');
test('admin portal reuses the session, limits its list, and renders names as text', async () => {
  const calls=[];
  const dom=new JSDOM(html,{url:'https://example.test/admin',runScripts:'dangerously',beforeParse(window){
    window.localStorage.setItem('mf_token','synthetic-session');
    window.fetch=async (url,opts)=>{calls.push({url,opts});const body=url==='/api/auth/me'
      ? {ok:true,role:'owner',user:{email:'agency@example.test'},permissions:{canAccessCatalogAdmin:true}}
      : {ok:true,isSuperAdmin:false,quota:{max:2,assigned:1,pending:0},clients:[{id:'one',name:'<img src=x onerror=alert(1)>',email:'client@example.test'}],requests:[]};
      return {ok:true,json:async()=>body};};
  }});
  try {
    await new Promise(r=>setTimeout(r,50));
    const doc=dom.window.document;
    assert.equal(doc.querySelector('#content').classList.contains('hidden'),false);
    assert.equal(doc.querySelector('#superPanel').classList.contains('hidden'),true);
    assert.match(doc.querySelector('#clients').textContent,/client@example.test/);
    assert.equal(doc.querySelector('#clients img'),null);
    assert.equal(calls[0].opts.headers.Authorization,'Bearer synthetic-session');
    assert.equal(doc.querySelector('input[type=password]'),null);
  } finally {dom.window.close();}
});
