import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = name => fs.readFileSync(new URL(`../public/${name}.html`, import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function openPage(name, { path = `/${name}`, token, cachedUser, apiRole = 'owner', authStatus = 200, supabase = null } = {}) {
  const errors = [], calls = [];
  const console = new VirtualConsole();
  console.on('jsdomError', e => {
    // jsdom cannot perform a cross-document navigation; browsers can.
    if (!e.message.includes('navigation to another Document')) errors.push(e.message);
  });
  const dom = new JSDOM(html(name), {
    url: `https://example.test${path}`, runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: console,
    beforeParse(window) {
      window.tailwind = { config: {} };
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      if (token) window.localStorage.setItem('mf_token', token);
      if (cachedUser) window.localStorage.setItem('mf_current_user', JSON.stringify(cachedUser));
      if (supabase) window.supabase = { createClient: () => supabase };
      window.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        const isMe = String(url).endsWith('/api/auth/me');
        const status = isMe ? authStatus : 200;
        const data = isMe
          ? (status === 200 ? { ok: true, user: { id: 'user-1', fullName: 'Test Owner', email: 'owner@example.test' }, organization: { id: 'org-1', name: 'Test Company' }, role: apiRole } : { ok: false, error: 'Invalid session' })
          : { ok: true, supabaseUrl: 'https://synthetic.supabase.test', supabaseAnonKey: 'synthetic-anon-key', leads: [], conversations: [], products: [], stats: {} };
        return { ok: status === 200, status, headers: { get: () => 'application/json' }, json: async () => data, text: async () => JSON.stringify(data) };
      };
    }
  });
  return { dom, calls, errors };
}

test('every redesigned HTML page has valid inline JavaScript and unique IDs', () => {
  for (const name of ['index', 'app', 'login', 'admin', 'demo']) {
    const source = html(name);
    for (const script of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc\s*=/.test(script[1]) && script[2].trim()) assert.doesNotThrow(() => new vm.Script(script[2], { filename: `${name}.html` }));
    }
    const dom = new JSDOM(source);
    const ids = [...dom.window.document.querySelectorAll('[id]')].map(el => el.id);
    assert.equal(new Set(ids).size, ids.length, `${name} contains duplicate IDs`);
    dom.window.close();
  }
});

test('workspace validates a backend session and routes the sidebar without script errors', async () => {
  const { dom, calls, errors } = openPage('app', { path: '/app/inbox', token: 'synthetic-token' });
  await wait(120);
  assert.ok(calls.some(c => c.url === '/api/auth/me' && c.options.headers.Authorization === 'Bearer synthetic-token'));
  assert.equal(dom.window.document.getElementById('topOrgName').textContent, 'Test Company');
  assert.equal(dom.window.document.getElementById('view-conversations').classList.contains('hidden'), false);
  dom.window.document.getElementById('nav-leads').click();
  assert.equal(dom.window.document.getElementById('view-leads').classList.contains('hidden'), false);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('expired token is removed rather than trusted from browser storage', async () => {
  const { dom, errors } = openPage('login', { token: 'expired', authStatus: 401 });
  await wait(80);
  assert.equal(dom.window.localStorage.getItem('mf_token'), null);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('login redirect stays local and toast renders untrusted text safely', async () => {
  const { dom } = openPage('login');
  await wait(30);
  const w = dom.window;
  for (const bad of ['https://attacker.example', '//attacker.example', '/\\attacker.example', '/login']) {
    w.sessionStorage.setItem('mf_auth_redirect', bad);
    assert.equal(w.getSafeRedirectUrl(), '/app');
  }
  w.sessionStorage.setItem('mf_auth_redirect', '/app/inbox');
  assert.equal(w.getSafeRedirectUrl(), '/app/inbox');
  w.showToast('<img src=x onerror="window.pwned=true">', 'error');
  assert.equal(w.document.querySelector('#toastContainer img'), null);
  assert.match(w.document.querySelector('#toastContainer').textContent, /<img/);
  dom.window.close();
});

test('admin screen does not trust a forged cached admin identity', async () => {
  const { dom, calls, errors } = openPage('admin', { token: 'synthetic', cachedUser: { email: 'admin@example.test', role: 'superadmin' }, apiRole: 'member' });
  await wait(100);
  assert.ok(calls.some(c => c.url === '/api/auth/me'));
  assert.equal(dom.window.document.getElementById('adminContent').classList.contains('hidden'), true);
  assert.equal(dom.window.document.getElementById('adminAccessDenied').classList.contains('hidden'), false);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('sign-up confirmation allows the form to be used again', async () => {
  const client = { auth: { getSession: async () => ({ data: { session: null } }), signUp: async () => ({ data: { user: { id: 'u' }, session: null }, error: null }) } };
  const { dom, calls, errors } = openPage('login', { path: '/signup', supabase: client });
  await wait(20);
  for (const [id, value] of Object.entries({ signupFullName: 'Test', signupCompany: 'Company', signupEmail: 'test@example.test', signupPhone: '9876543210', signupPassword: 'Password123' })) dom.window.document.getElementById(id).value = value;
  await dom.window.handleSignupSubmit({ preventDefault() {} });
  assert.equal(dom.window.document.getElementById('btnSignupSubmit').disabled, false);
  assert.equal(calls.some(c => c.url === '/api/auth/signup'), false);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('workspace checks membership for a Supabase session instead of trusting its profile', async () => {
  const session = { access_token: 'supabase-token', user: { id: 'user-1', email: 'owner@example.test' } };
  const query = { select: () => query, eq: () => query, single: async () => ({ data: null }), then: (resolve, reject) => Promise.resolve({ data: [] }).then(resolve, reject) };
  const client = { auth: { getSession: async () => ({ data: { session } }), onAuthStateChange: () => ({}) }, from: table => { assert.notEqual(table, 'profiles'); return query; } };
  const { dom, calls, errors } = openPage('app', { path: '/app', supabase: client });
  await wait(120);
  assert.ok(calls.some(c => c.url === '/api/auth/me' && c.options.headers.Authorization === 'Bearer supabase-token'));
  assert.equal(dom.window.document.getElementById('topOrgName').textContent, 'Test Company');
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('authentication provider errors do not trigger an alternate signup', async () => {
  const client = { auth: { getSession: async () => ({ data: { session: null } }), signUp: async () => ({ data: null, error: new Error('Signup denied') }) } };
  const { dom, calls } = openPage('login', { path: '/signup', supabase: client });
  await wait(20);
  for (const [id, value] of Object.entries({ signupFullName: 'Test', signupCompany: 'Company', signupEmail: 'test@example.test', signupPhone: '9876543210', signupPassword: 'Password123' })) dom.window.document.getElementById(id).value = value;
  await dom.window.handleSignupSubmit({ preventDefault() {} });
  assert.equal(calls.some(c => c.url === '/api/auth/signup'), false);
  assert.match(dom.window.document.getElementById('toastContainer').textContent, /Signup denied/);
  assert.equal(dom.window.document.getElementById('btnSignupSubmit').disabled, false);
  dom.window.close();
});

test('network fallback never fakes success for real API calls', async () => {
  for (const name of ['index', 'app', 'admin']) {
    const { dom } = openPage(name);
    await wait(20);
    await assert.rejects(dom.window.handleStaticDemoRequest('/api/catalog/sync', {}), /server is unavailable/i);
    dom.window.close();
  }
});

test('legacy dashboard deep links are routed to the workspace on both hosts', () => {
  assert.match(fs.readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8'), /from = "\/dashboard\/\*"/);
  assert.match(fs.readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8'), /\/dashboard\/\*\s+\/app\.html/);
  assert.match(fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8'), /'\/dashboard\/\*'/);
});

test('contact form sends the fields the API expects and reports connection failures honestly', async () => {
  const { dom } = openPage('index');
  await wait(30);
  const w = dom.window;
  w.document.getElementById('contactOrgName').value = 'Test company';
  w.document.getElementById('contactPhone').value = '9876543210';
  w.document.getElementById('contactRequirement').value = 'Synthetic enquiry';
  let payload;
  w.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    throw new Error('offline');
  };
  await w.handleContactSubmit();
  assert.equal(payload.name, 'Test company');
  assert.equal(payload.phone, '9876543210');
  assert.equal(payload.message, 'Synthetic enquiry');
  assert.match(w.document.getElementById('toastContainer').textContent, /Unable to submit/i);
  dom.window.close();
});

test('admin content remains hidden until the server confirms a superadmin role', async () => {
  const { dom, errors } = openPage('admin', { token: 'synthetic', apiRole: 'superadmin' });
  assert.equal(dom.window.document.getElementById('adminContent').classList.contains('hidden'), true);
  await wait(100);
  assert.equal(dom.window.document.getElementById('adminContent').classList.contains('hidden'), false);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('mobile workspace drawer opens and closes without hiding navigation permanently', async () => {
  const { dom } = openPage('app', { token: 'synthetic' });
  await wait(100);
  const w = dom.window, sidebar = w.document.getElementById('appSidebar'), backdrop = w.document.getElementById('mobileBackdrop');
  assert.equal(sidebar.classList.contains('-translate-x-full'), true);
  w.document.getElementById('btnMobileSidebar').click();
  assert.equal(sidebar.classList.contains('-translate-x-full'), false);
  assert.equal(backdrop.classList.contains('hidden'), false);
  backdrop.click();
  assert.equal(sidebar.classList.contains('-translate-x-full'), true);
  assert.equal(backdrop.classList.contains('hidden'), true);
  dom.window.close();
});
