import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const read = name => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('disabled imports load no vulnerable browser PDF/spreadsheet parsers or parser entrypoints', () => {
  for (const page of ['app.html', 'admin.html']) {
    const html = read(page);
    assert.doesNotMatch(html, /pdfjsLib|pdf\.js\/3\.11\.174|xlsx@0\.18\.5|XLSX\.read|renderAndParsePdfWithImages/);
    assert.match(html, /File import is not available yet/);
    assert.doesNotMatch(html, /localStorage\.setItem\(['"]mf_gemini_key/);
  }
  assert.doesNotMatch(read('login.html'), /End-to-End Encryption|Private Business Data/);
});

test('legacy admin product fields, ids and errors are rendered as text, never markup or JavaScript', async () => {
  const injection = `<img src=x onerror="window.compromised=1">`;
  let failure = false;
  const vc = new VirtualConsole();
  const dom = new JSDOM(read('admin.html'), { url: 'https://example.test/admin.html?admin=1', runScripts: 'dangerously', virtualConsole: vc, beforeParse(w) {
    w.tailwind = {}; w.HTMLElement.prototype.scrollIntoView = () => {};
    w.fetch = async url => {
      const payload = String(url).includes('/api/catalog/products')
        ? (failure ? { ok: false, error: injection } : { ok: true, products: [{ id: "id');window.compromised=1;//", sku: injection, name: injection, price_raw: injection }] })
        : {ok:true,products:[],leads:[],conversations:[],stats:{}};
      return { ok: !failure, status: failure ? 500 : 200, headers:{get:()=> 'application/json'}, json:async()=>payload };
    };
  }});
  await pause(30);
  const w = dom.window;
  assert.equal(w.document.getElementById('directAdminEmail').value, '');
  w.checkAdminParam();
  const nav = w.document.getElementById('nav-engineer');
  if (nav) assert.equal(nav.classList.contains('hidden'), true);
  await w.loadAdminClientProducts("org');window.compromised=1;//");
  const table = w.document.getElementById('adminProductsTableBody');
  assert.equal(table.querySelector('img'), null);
  assert.match(table.textContent, /<img/);
  let clicked; w.deleteAdminProduct = (id, org) => { clicked = [id, org]; };
  table.querySelector('button').click();
  assert.deepEqual(clicked, ["id');window.compromised=1;//", "org');window.compromised=1;//"]);
  assert.equal(w.compromised, undefined);
  failure = true; await w.loadAdminClientProducts('org');
  assert.equal(table.querySelector('img'), null); assert.match(table.textContent, /<img/);
  dom.window.close();
});

test('demo uses explicit WhatsApp link after successful enquiry and provides inline errors', async () => {
  const calls = [];
  const dom = new JSDOM(read('demo.html'), { url: 'https://example.test/demo', runScripts: 'dangerously', beforeParse(w) {
    w.open = () => { throw new Error('Unexpected popup'); };
    w.alert = () => { throw new Error('Unexpected alert'); };
    w.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => String(url).includes('public-config') ? {demoBotWhatsapp:'919876543210'} : {ok:true} }; };
  }});
  const w = dom.window, d = w.document;
  assert.equal(d.querySelector('label[for="bPhone"]').control.id, 'bPhone');
  d.getElementById('bPhone').value = '0000000000';
  await w.submitEnquiry(); assert.match(d.getElementById('errorBox').textContent, /valid/i); assert.equal(calls.length, 0);
  d.getElementById('bPhone').value = '9876543210';
  await w.submitEnquiry(); assert.match(d.getElementById('errorBox').textContent, /agree/i); assert.equal(calls.length, 0);
  d.getElementById('demoConsent').checked = true;
  await w.submitEnquiry();
  assert.equal(calls.length, 2);
  const link = d.querySelector('#okBox a'); assert.ok(link); assert.match(link.href, /^https:\/\/wa\.me\/919876543210\?/); assert.equal(link.rel, 'noopener noreferrer');
  assert.match(d.getElementById('okBox').textContent, /No WhatsApp message has been sent/);
  assert.equal(d.getElementById('subBtn').disabled, false);
  dom.window.close();
});

test('public routes include actual crawler assets and 404 rules instead of homepage fallback', () => {
  assert.match(read('robots.txt'), /Sitemap: https:\/\/leadsy-ai\.netlify\.app\/sitemap.xml/);
  assert.match(read('sitemap.xml'), /<loc>https:\/\/leadsy-ai\.netlify\.app\//);
  assert.match(read('_redirects'), /\/\*\s+\/404\.html\s+404/);
  assert.match(read('404.html'), /Page not found/);
  for (const page of ['app.html', 'admin.html', 'login.html', 'catalog-admin.html']) assert.match(read(page), /name="robots" content="noindex/);
});

test('auth pages use the same pinned local SDK with an accurate integrity hash', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = fs.readFileSync(new URL('../public/vendor/supabase-2.119.0.min.js', import.meta.url));
  const hash = createHash('sha384').update(bytes).digest('base64');
  const sdkRuntime = new JSDOM('<!doctype html>', { url: 'https://example.test', runScripts: 'dangerously' });
  sdkRuntime.window.eval(bytes.toString('utf8'));
  assert.equal(typeof sdkRuntime.window.supabase.createClient, 'function');
  sdkRuntime.window.close();
  for (const page of ['app.html', 'admin.html', 'login.html', 'catalog-admin.html']) {
    const dom = new JSDOM(read(page));
    const sdk = dom.window.document.querySelector('script[src="/vendor/supabase-2.119.0.min.js"]');
    assert.ok(sdk, page); assert.equal(sdk.getAttribute('integrity'), 'sha384-' + hash);
    assert.equal(sdk.getAttribute('crossorigin'), 'anonymous');
    dom.window.close();
  }
});

test('opaque WhatsApp IDs are not displayed as fabricated Indian numbers', async () => {
  const vc = new VirtualConsole();
  const dom = new JSDOM(read('app.html'), { url:'https://example.test/app',runScripts:'dangerously',virtualConsole:vc,beforeParse(w) {
    w.tailwind={}; w.HTMLElement.prototype.scrollIntoView=()=>{};
    w.fetch=async()=>({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({ok:true}),text:async()=>''});
  }});
  await pause(20);
  assert.equal(dom.window.formatDisplayPhone('148004724064491@lid'), 'Unverified WhatsApp ID: 148004724064491');
  assert.equal(dom.window.formatDisplayPhone('+1415555012345'), '+1415555012345');
  assert.equal(dom.window.formatDisplayPhone('9876543210'), '+91 98765 43210');
  dom.window.close();
});
