import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = name => fs.readFileSync(new URL(`../public/${name}.html`, import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function openPage(name, { path = `/${name}`, token, cachedUser, apiRole = 'owner', authStatus = 200, supabase = null, canManageCatalog = false, products = [] } = {}) {
  const errors = [], calls = [], state = { clientCreations: 0 };
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
      window.HTMLElement.prototype.scrollIntoView = function() {};
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      if (token) window.localStorage.setItem('mf_token', token);
      if (cachedUser) window.localStorage.setItem('mf_current_user', JSON.stringify(cachedUser));
      if (supabase) window.supabase = { createClient: () => { state.clientCreations++; return supabase; } };
      window.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        const isMe = String(url).endsWith('/api/auth/me');
        const status = isMe ? authStatus : 200;
        const data = isMe
          ? (status === 200 ? { ok: true, user: { id: 'user-1', fullName: 'Test Owner', email: 'owner@example.test' }, organization: { id: 'org-1', name: 'Test Company' }, role: apiRole, permissions: { canManageCatalog } } : { ok: false, error: 'Invalid session' })
          : { ok: true, supabaseUrl: 'https://synthetic.supabase.test', supabaseAnonKey: 'synthetic-anon-key', leads: [], conversations: [], products, stats: {} };
        return { ok: status === 200, status, headers: { get: () => 'application/json' }, json: async () => data, text: async () => JSON.stringify(data) };
      };
    }
  });
  return { dom, calls, errors, state };
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
  for (const name of ['app', 'admin']) {
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
  const w = dom.window, d = w.document;
  for (const [id, value] of Object.entries({ name: 'Test User', business: 'Test company', email: 'test@example.test', phone: '9876543210', message: 'Synthetic enquiry' })) d.getElementById(id).value = value;
  d.getElementById('contactConsent').checked = true;
  let payload;
  w.fetch = async (_url, options) => { payload = JSON.parse(options.body); throw new Error('offline'); };
  await w.handleContactSubmit();
  assert.equal(payload.name, 'Test User');
  assert.equal(payload.phone, '9876543210');
  assert.match(payload.message, /Business: Test company/);
  assert.match(payload.message, /Email: test@example.test/);
  assert.match(payload.message, /Synthetic enquiry/);
  assert.match(d.getElementById('formNote').textContent, /Unable to submit/i);
  assert.equal(d.getElementById('contactSubmit').disabled, false);
  assert.equal(d.getElementById('business').value, 'Test company');
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

test('valid restored login on the home page navigates to the separate dashboard', async () => {
  const { dom, calls, errors } = openPage('index', { path: '/', token: 'backend-token' });
  let target;
  dom.window.navigateFromLanding = value => { target = value; };
  await wait(100);
  assert.equal(target, '/app');
  assert.ok(calls.some(c => c.url === '/api/auth/me' && c.options.headers.Authorization === 'Bearer backend-token'));
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('home page rejects stale cached login instead of redirecting to a broken workspace', async () => {
  const { dom } = openPage('index', { path: '/', token: 'expired', authStatus: 401 });
  let target;
  dom.window.navigateFromLanding = value => { target = value; };
  await wait(100);
  assert.equal(target, undefined);
  assert.equal(dom.window.localStorage.getItem('mf_token'), null);
  assert.equal(dom.window.document.getElementById('publicLandingPage').classList.contains('hidden'), false);
  dom.window.close();
});

test('OAuth callbacks reaching the home page keep the PKCE code for login', async () => {
  const { dom } = openPage('index', { path: '/?code=synthetic-code' });
  let target;
  dom.window.navigateFromLanding = value => { target = value; };
  await wait(50);
  assert.equal(target, '/login?code=synthetic-code');
  dom.window.close();
});

test('authenticated visitors can still visit public information pages', async () => {
  const { dom } = openPage('index', { path: '/features', token: 'synthetic' });
  let target;
  dom.window.navigateFromLanding = value => { target = value; };
  await wait(100);
  assert.equal(target, undefined);
  dom.window.close();
});

test('password-recovery PKCE event redirects to workspace password settings', async () => {
  let authListener;
  const session = { access_token: 'recovery-token', user: { id: 'user-1', email: 'owner@example.test' } };
  const client = { auth: {
    onAuthStateChange: callback => { authListener = callback; },
    getSession: async () => { authListener?.('PASSWORD_RECOVERY', session); return { data: { session } }; }
  } };
  const { dom } = openPage('login', { path: '/login?code=synthetic-recovery-code', supabase: client });
  let target;
  dom.window.navigateAfterAuth = value => { target = value; };
  await wait(100);
  assert.equal(target, '/app/settings');
  dom.window.close();
});

test('dashboard shows unavailable data instead of fabricated zeroes when a query fails', async () => {
  const client = { auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({}) },
    from: table => {
      const query = { select: () => query, eq: () => {
        if (table === 'organizations') return { single: async () => ({ data: null }) };
        return Promise.resolve(table === 'leads' ? { data: null, error: { message: 'Database unavailable' } } : { data: [] });
      } };
      return query;
    }
  };
  const { dom } = openPage('app', { token: 'synthetic', supabase: client });
  await wait(150);
  await dom.window.loadDashboardData();
  assert.equal(dom.window.document.getElementById('statLeadsToday').textContent, '—');
  assert.match(dom.window.document.getElementById('dashboardLeadsTable').textContent, /unavailable/i);
  dom.window.close();
});

test('each page initializes at most one authentication client', async () => {
  const client = { auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({}) } };
  for (const name of ['index', 'login', 'app']) {
    const { dom, state } = openPage(name, { path: name === 'index' ? '/' : `/${name}`, supabase: client });
    await wait(80);
    assert.equal(state.clientCreations, name === 'index' ? 0 : 1, `${name} should initialize only the clients it needs`);
    dom.window.close();
  }
});

test('workspace content is hidden until authentication is verified', async () => {
  const { dom } = openPage('app', { token: 'valid' });
  const workspace = dom.window.document.getElementById('appWorkspaceContainer');
  assert.equal(workspace.classList.contains('hidden'), true);
  await wait(100);
  assert.equal(workspace.classList.contains('hidden'), false);
  dom.window.close();
});

test('engineer navigation stays hidden regardless of role or forged query parameters', async () => {
  for (const [role, expectedHidden] of [['owner', true], ['superadmin', true]]) {
    const { dom } = openPage('app', { path: '/app?admin=1', token: 'synthetic', apiRole: role });
    await wait(120);
    assert.equal(dom.window.document.getElementById('nav-engineer').classList.contains('hidden'), expectedHidden);
    assert.equal(dom.window.document.getElementById('cardEngineerSettings').classList.contains('hidden'), expectedHidden);
    dom.window.close();
  }
});

test('dashboard and analytics use recorded results rather than fabricated performance or call counts', async () => {
  const leads = [{ id: 'l1', status: 'qualified', first_response_ms: 2000 }, { id: 'l2', status: 'new', pdf_brochure_sent: true }];
  const calls = [{ lead_id: 'l1', status: 'confirmed' }, { lead_id: 'l2', status: 'requested' }];
  const client = { auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({}) },
    from: table => { const q = { select: () => q, eq: () => Promise.resolve({ data: table === 'leads' ? leads : table === 'call_requests' ? calls : [] }) }; return q; }
  };
  const { dom } = openPage('app', { token: 'valid', supabase: client });
  await wait(120);
  await dom.window.loadDashboardData();
  await dom.window.loadAnalyticsData();
  assert.equal(dom.window.document.getElementById('statMedianResponse').textContent, '2.0s');
  assert.equal(dom.window.document.getElementById('statQualifiedRate').textContent, '50%');
  assert.equal(dom.window.document.getElementById('statCallsBooked').textContent, '1');
  assert.equal(dom.window.document.getElementById('anCallRate').textContent, '50%');
  assert.equal(dom.window.document.getElementById('anSpeedPct').textContent, 'N/A');
  dom.window.close();
});


test('catalogue is view-only for client owners and editable for explicitly granted managers', async () => {
  const products = [{ id: 'product-1', name: 'Widget', sku: 'SKU-1', price_raw: '100', model_specs: 'Size 5' }];
  for (const allowed of [false, true]) {
    const { dom, errors } = openPage('app', { path: '/app/catalogue', token: 'synthetic', apiRole: 'owner', canManageCatalog: allowed, products });
    await wait(150);
    await dom.window.fetchCatalogProducts();
    const d = dom.window.document;
    assert.equal(d.getElementById('btnQuickAddSku').classList.contains('hidden'), !allowed);
    assert.match(d.getElementById('catalogTableBody').textContent, /Widget/);
    assert.equal(d.getElementById('catalogTableBody').textContent.includes('Edit'), allowed);
    assert.equal(d.getElementById('catalogDropzone').classList.contains('hidden'), true);
    assert.deepEqual(errors, []);
    dom.window.close();
  }
});


test('catalogue manager submits manual details through authenticated JSON API', async () => {
  const { dom, calls, errors } = openPage('app', { path: '/app/catalogue', token: 'synthetic', canManageCatalog: true });
  await wait(150);
  dom.window.applyBusinessNiche('machinery'); // hidden input is not a SELECT
  const d = dom.window.document;
  d.getElementById('qaProductName').value = 'Precision Widget';
  d.getElementById('qaSku').value = 'A-42';
  d.getElementById('qaPriceRaw').value = '100';
  d.getElementById('qaModel').value = 'Size 5';
  await dom.window.submitQuickAddProduct();
  const call = calls.find(c => c.url === '/api/catalog/quick-add');
  assert.ok(call);
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.equal(call.options.headers.Authorization, 'Bearer synthetic');
  assert.deepEqual(JSON.parse(call.options.body), { name: 'Precision Widget', sku: 'A-42', priceRaw: '100', model: 'Size 5' });
  assert.deepEqual(errors, []);
  dom.window.close();
});


test('homepage menu, FAQ and plan enquiry remain accessible and functional', async () => {
  const { dom, errors } = openPage('index', { path: '/' });
  await wait(30);
  const w = dom.window, d = w.document;
  const menu = d.getElementById('toggle');
  menu.click();
  assert.equal(menu.getAttribute('aria-expanded'), 'true');
  assert.equal(d.getElementById('links').classList.contains('open'), true);
  d.querySelector('#links a[href="#features"]').click();
  assert.equal(menu.getAttribute('aria-expanded'), 'false');
  const faq = d.querySelector('.q');
  faq.click();
  assert.equal(faq.getAttribute('aria-expanded'), 'true');
  assert.equal(d.getElementById(faq.getAttribute('aria-controls')).parentElement.classList.contains('open'), true);
  faq.click();
  assert.equal(faq.getAttribute('aria-expanded'), 'false');
  d.querySelector('[data-interest="Standard Growth"]').click();
  assert.match(d.getElementById('formNote').textContent, /Standard Growth/);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('homepage enquiry validates consent, retains fields on failure and resets only on confirmed success', async () => {
  const { dom } = openPage('index', { path: '/?ref=Partner_42' });
  await wait(30);
  const w = dom.window, d = w.document;
  for (const [id, value] of Object.entries({ name: 'Test User', business: 'Synthetic Co', email: 'test@example.test', phone: '9876543210', message: 'Synthetic requirement' })) d.getElementById(id).value = value;
  let calls = [];
  w.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ok: true }) }; };
  await w.handleContactSubmit();
  assert.equal(calls.length, 0, 'consent must be checked');
  d.getElementById('contactConsent').checked = true;
  d.querySelector('[data-interest="Pro Business"]').click();
  await w.handleContactSubmit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/public/demo-enquiry');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.productQuery, 'Pro Business');
  assert.match(payload.message, /Partner reference: Partner_42/);
  assert.match(payload.message, /Synthetic requirement/);
  assert.match(d.getElementById('formNote').textContent, /received/i);
  assert.equal(d.getElementById('name').value, '');
  assert.equal(d.getElementById('contactConsent').checked, false);
  dom.window.close();
});


test('homepage prevents duplicate submissions and keeps entered data when the API rejects an enquiry', async () => {
  const { dom } = openPage('index', { path: '/' }); await wait(30);
  const w = dom.window, d = w.document;
  for (const [id, value] of Object.entries({ name: 'Test User', business: 'Synthetic Co', email: 'test@example.test', phone: '9876543210' })) d.getElementById(id).value = value;
  d.getElementById('contactConsent').checked = true;
  let resolveFetch, calls = 0;
  w.fetch = () => { calls++; return new Promise(resolve => { resolveFetch = resolve; }); };
  const first = w.handleContactSubmit();
  await w.handleContactSubmit();
  assert.equal(calls, 1);
  resolveFetch({ ok: false, json: async () => ({ ok: false, error: 'Enquiries are unavailable.' }) });
  await first;
  assert.match(d.getElementById('formNote').textContent, /unavailable/i);
  assert.equal(d.getElementById('business').value, 'Synthetic Co');
  assert.equal(d.getElementById('contactSubmit').disabled, false);
  dom.window.close();
});

test('login never falls back to a client profile after a rejected workspace verification', async () => {
  let directLookups = 0;
  const client = {
    auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => { directLookups++; return { data: { user: { id: 'attacker', email: 'x@example.test' } } }; } },
    from: () => { directLookups++; throw new Error('direct lookup must not be used'); }
  };
  const { dom } = openPage('login', { authStatus: 403, supabase: client });
  await wait(30);
  await assert.rejects(dom.window.getAuthenticatedWorkspace('token'), /Could not verify/);
  assert.equal(directLookups, 0);
  dom.window.close();
});

test('manual reply keeps draft and reports queue failure, then reports queueing without claiming delivery', async () => {
  const { dom } = openPage('app', { token: 'synthetic-token' });
  await wait(100);
  const w = dom.window;
  let failQueue = true, queued = 0;
  const chain = (table) => ({
    select() { return this; }, eq() { return this; }, update() { return this; },
    async single() { return { data: { buyer_phone: '919876543210' }, error: null }; },
    async maybeSingle() { return { data: { id: 'conv-1' }, error: null }; },
    async insert() { if (table === 'wa_outbound_queue') { queued++; return { error: failQueue ? new Error('queue denied') : null }; } return { error: null }; }
  });
  w.__testClient = { from: table => chain(table) };
  w.eval("sb = window.__testClient; currentOrg = { id: 'org-1' }; activeConversationId = 'conv-1'");
  w.selectConversation = async () => {};
  const input = w.document.getElementById('chatComposerInput');
  input.value = 'Hello';
  await w.sendManualReply();
  assert.equal(input.value, 'Hello');
  assert.match(w.document.getElementById('toastContainer').textContent, /queueing could not be confirmed/i);
  failQueue = false;
  await w.sendManualReply();
  assert.equal(input.value, '');
  assert.equal(queued, 2);
  assert.match(w.document.getElementById('toastContainer').textContent, /delivery is not yet confirmed/i);
  dom.window.close();
});
