import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { signUp, createSessionToken } from '../src/auth/authService.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const html = name => fs.readFileSync(new URL(`../public/${name}.html`, import.meta.url), 'utf8');

test('real local login token carries through to the workspace dashboard', async () => {
  process.env.NODE_ENV = 'test';
  process.env.USE_LOCAL_DB = 'true';
  db.persist = () => {};
  const email = `synthetic_${Date.now()}@example.test`;
  await signUp({ email, password: 'Password123!', fullName: 'Test Owner', companyName: 'Login Test Company' });
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!e.message.includes('navigation to another Document')) errors.push(e.message); });
  const makePage = (page, url, token) => new JSDOM(html(page), {
    url: base + url, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.tailwind = { config: {} };
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.fetch = (url, options) => fetch(new URL(url, base), options);
      if (token) w.localStorage.setItem('mf_token', token);
    }
  });
  let loginPage, appPage;
  try {
    loginPage = makePage('login', '/login');
    let redirect;
    loginPage.window.navigateAfterAuth = value => { redirect = value; };
    loginPage.window.document.getElementById('loginEmail').value = email;
    loginPage.window.document.getElementById('loginPassword').value = 'Password123!';
    await loginPage.window.handleLoginSubmit({ preventDefault() {} });
    await wait(750);
    assert.equal(redirect, '/app');
    const token = loginPage.window.localStorage.getItem('mf_token');
    assert.ok(token);
    appPage = makePage('app', redirect, token);
    await wait(200);
    assert.equal(appPage.window.document.getElementById('view-dashboard').classList.contains('hidden'), false);
    assert.equal(appPage.window.document.getElementById('topOrgName').textContent, 'Login Test Company');
    assert.deepEqual(errors, []);
  } finally {
    loginPage?.window.close(); appPage?.window.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('simulator rejects invalid and revoked credentials rather than falling back to a demo tenant', async () => {
  process.env.NODE_ENV = 'test'; process.env.USE_LOCAL_DB = 'true'; db.persist = () => {};
  const orgId = `synthetic-org-${Date.now()}`;
  db.insert('organizations', { id: orgId, name: 'Synthetic tenant' });
  const revoked = createSessionToken('revoked-user', orgId, 'owner');
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [token, expected] of [['invalid-token', 401], [revoked, 403]]) {
      const res = await fetch(`${base}/api/simulate-lead`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ consent: true, phone: '9876543210' }) });
      assert.equal(res.status, expected);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('production demo uses authoritative storage and never falls back to the local tenant store', async () => {
  const { repository } = await import('../src/db/repository.js');
  const previous = { env: process.env.NODE_ENV, local: process.env.USE_LOCAL_DB, get: repository.getOrganizationById, create: repository.createLead };
  process.env.NODE_ENV = 'production'; delete process.env.USE_LOCAL_DB;
  const demoId = '6fd354d9-3437-412d-856e-28bc19d44268';
  let written;
  repository.getOrganizationById = async id => id === demoId ? { id, name: 'Synthetic Demo' } : null;
  repository.createLead = async (orgId, data) => { written = { orgId, data }; return { id: 'synthetic-lead', ...data, status: 'new' }; };
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/public/demo-enquiry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test', phone: '9876543210', message: 'Synthetic' }) });
    assert.equal(res.status, 200);
    assert.equal(written.orgId, demoId);
    assert.equal(written.data.query_message, 'Synthetic');
    repository.getOrganizationById = async () => { const error = new Error('offline'); error.statusCode = 503; throw error; };
    const offline = await fetch(`http://127.0.0.1:${server.address().port}/api/public/demo-enquiry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test', phone: '9876543210' }) });
    assert.equal(offline.status, 503);
  } finally {
    repository.getOrganizationById = previous.get; repository.createLead = previous.create;
    process.env.NODE_ENV = previous.env;
    if (previous.local === undefined) delete process.env.USE_LOCAL_DB; else process.env.USE_LOCAL_DB = previous.local;
    await new Promise(resolve => server.close(resolve));
  }
});

test('account verification fails closed if the authoritative profile cannot be read', async () => {
  process.env.NODE_ENV = 'test'; process.env.USE_LOCAL_DB = 'true'; db.persist = () => {};
  const tenant = await signUp({ email: `profile_${Date.now()}@example.test`, password: 'Password123!', fullName: 'Test Owner', companyName: 'Synthetic' });
  const { repository } = await import('../src/db/repository.js');
  const original = repository.getProfileById;
  repository.getProfileById = async () => { const error = new Error('private database detail'); error.statusCode = 503; throw error; };
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/me`, { headers: { Authorization: `Bearer ${tenant.token}` } });
    assert.equal(res.status, 503);
    assert.doesNotMatch((await res.json()).error, /private database detail/);
  } finally {
    repository.getProfileById = original;
    await new Promise(resolve => server.close(resolve));
  }
});
