import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import { signUp, login, createSessionToken } from '../src/auth/authService.js';
import { repository } from '../src/db/repository.js';
import db from '../src/db/index.js';

test('production public entry points fail closed without configured demo and verification secrets', async () => {
  const previous = { env: process.env.NODE_ENV, local: process.env.USE_LOCAL_DB, demo: process.env.DEMO_TENANT_ID, verify: process.env.WHATSAPP_VERIFY_TOKEN, get: repository.getOrganizationById };
  process.env.NODE_ENV = 'production'; delete process.env.USE_LOCAL_DB; delete process.env.DEMO_TENANT_ID; delete process.env.WHATSAPP_VERIFY_TOKEN;
  let lookups = 0;
  repository.getOrganizationById = async () => { lookups++; throw new Error('must not look up default tenant'); };
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    for (const route of ['/public/demo-enquiry', '/simulate-lead']) {
      const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '9876543210', consent: true }) });
      assert.equal(res.status, 503);
    }
    assert.equal(lookups, 0);
    const verify = await fetch(base + '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=martflow_verify_secret&hub.challenge=123');
    assert.equal(verify.status, 503);
    const signup = await fetch(base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'synthetic@example.test', password: 'Password123!', fullName: 'Test', companyName: 'Test' }) });
    assert.equal(signup.status, 503);
    assert.equal((await signup.json()).token, undefined);
  } finally {
    repository.getOrganizationById = previous.get;
    for (const [key, value] of Object.entries({ NODE_ENV: previous.env, USE_LOCAL_DB: previous.local, DEMO_TENANT_ID: previous.demo, WHATSAPP_VERIFY_TOKEN: previous.verify })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
});

test('login and authorization never infer an unrelated workspace or an elevated role', async () => {
  process.env.NODE_ENV = 'test'; process.env.USE_LOCAL_DB = 'true'; db.persist = () => {};
  const email = `local-${Date.now()}@example.test`;
  const account = await signUp({ email, password: 'Password123!', fullName: 'Test', companyName: 'Test' });
  const membership = db.findOne('organization_members', m => m.user_id === account.user.id);
  db.update('organization_members', membership.id, { role: 'member' });
  const member = await login({ email, password: 'Password123!' });
  assert.equal(member.organization.webhook_key, undefined);
  db.update('organization_members', membership.id, { role: null, organization_id: 'missing-org' });
  await assert.rejects(login({ email, password: 'Password123!' }), /No active organization/);
  const previous = repository.getMembership;
  repository.getMembership = async () => ({ role: null });
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const forged = createSessionToken(account.user.id, account.organization.id, 'owner');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/conversations/x/mode`, { method: 'POST', headers: { authorization: `Bearer ${forged}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'human' }) });
    assert.equal(res.status, 403);
  } finally { repository.getMembership = previous; await new Promise(resolve => server.close(resolve)); }
});
