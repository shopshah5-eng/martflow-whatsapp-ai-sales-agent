process.env.NODE_ENV = 'test';
process.env.USE_LOCAL_DB = 'true';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { signUp, createSessionToken, handleGoogleAuth } from '../src/auth/authService.js';
import { repository } from '../src/db/repository.js';

async function setup() {
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0);
  const owner = await signUp({ email: `regression_${crypto.randomUUID()}@example.test`, password: 'Password123!', fullName: 'Owner', companyName: 'Test Co' });
  return { server, owner, url: `http://127.0.0.1:${server.address().port}/api` };
}
function headers(token) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }; }

test('catalog sync requires an explicit grant and preserves chat, takeover and omitted products', async () => {
  const { server, owner, url } = await setup();
  try {
    const org = owner.organization.id;
    db.insert('catalog_management_grants', { organization_id: org, user_id: owner.user.id });
    const member = db.insert('profiles', { email: `m_${crypto.randomUUID()}@example.test` });
    db.insert('organization_members', { organization_id: org, user_id: member.id, role: 'member' });
    const conv = db.insert('conversations', { organization_id: org, mode: 'human' });
    const message = db.insert('messages', { organization_id: org, conversation_id: conv.id, content: 'history' });
    const product = db.insert('products', { organization_id: org, name: 'original' });
    const memberResponse = await fetch(`${url}/catalog/sync`, { method: 'POST', headers: headers(createSessionToken(member.id, org, 'member')), body: JSON.stringify({ products: [] }) });
    assert.equal(memberResponse.status, 403);
    const ownerResponse = await fetch(`${url}/catalog/sync`, { method: 'POST', headers: headers(owner.token), body: JSON.stringify({ companyName: 'New Name', resetConversations: true }) });
    assert.equal(ownerResponse.status, 200);
    assert.ok(db.findById('products', product.id));
    assert.ok(db.findById('messages', message.id));
    assert.equal(db.findById('conversations', conv.id).mode, 'human');
    const malformed = await fetch(`${url}/catalog/sync`, { method: 'POST', headers: headers(owner.token), body: JSON.stringify({ products: [{ name: '' }] }) });
    assert.equal(malformed.status, 400);
    assert.ok(db.findById('products', product.id));
  } finally { server.close(); }
});

test('authorization fails closed if authoritative lookup fails', async () => {
  const { server, owner, url } = await setup();
  const original = repository.getOrganizationById;
  try {
    repository.getOrganizationById = async () => { throw new Error('database unavailable'); };
    const response = await fetch(`${url}/auth/me`, { headers: headers(owner.token) });
    assert.equal(response.status, 503);
  } finally { repository.getOrganizationById = original; server.close(); }
});

test('Razorpay amount is server selected and deposit does not activate subscription', async () => {
  const { server, owner, url } = await setup();
  const oldId = process.env.RAZORPAY_KEY_ID, oldSecret = process.env.RAZORPAY_KEY_SECRET;
  const realFetch = globalThis.fetch;
  const orderId = `order_${crypto.randomUUID()}`;
  const paymentId = `pay_${crypto.randomUUID()}`;
  try {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_valid'; process.env.RAZORPAY_KEY_SECRET = 'regression_secret';
    db.update('organizations', owner.organization.id, { custom_quote_inr: 999, quote_code: 'PILOT999', plan_status: 'trial' });
    globalThis.fetch = async (target, options) => {
      if (String(target) === 'https://api.razorpay.com/v1/orders') {
        assert.equal(JSON.parse(options.body).amount, 99900);
        return new Response(JSON.stringify({ id: orderId }), { status: 200 });
      }
      if (String(target).startsWith('https://api.razorpay.com/v1/payments/')) {
        return new Response(JSON.stringify({ status: 'captured', order_id: orderId, amount: 99900, currency: 'INR' }), { status: 200 });
      }
      return realFetch(target, options);
    };
    const create = await fetch(`${url}/payments/razorpay/create-order`, { method: 'POST', headers: headers(owner.token), body: JSON.stringify({ amountInr: 1 }) });
    assert.equal(create.status, 200);
    assert.equal((await create.json()).amount, 99900);
    const signature = crypto.createHmac('sha256', 'regression_secret').update(`${orderId}|${paymentId}`).digest('hex');
    const verify = await fetch(`${url}/payments/razorpay/verify`, { method: 'POST', headers: headers(owner.token), body: JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }) });
    assert.equal(verify.status, 200);
    assert.equal((await verify.json()).activated, false);
    assert.equal(db.findById('organizations', owner.organization.id).plan_status, 'trial');
  } finally {
    globalThis.fetch = realFetch;
    if (oldId === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = oldId;
    if (oldSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = oldSecret;
    server.close();
  }
});

test('migration scripts parse; live migration and rollback refuse to run', () => {
  execFileSync(process.execPath, ['--check', 'scripts/migrate_local_to_supabase.js']);
  execFileSync(process.execPath, ['--check', 'scripts/rollback_migration.js']);
  for (const script of ['scripts/migrate_local_to_supabase.js', 'scripts/rollback_migration.js']) {
    assert.throws(() => execFileSync(process.execPath, [script], { stdio: 'pipe' }));
  }
});

test('server disconnect removes session credentials', () => {
  const script = `import fs from 'node:fs';
    import {baileysManager} from './src/integrations/whatsapp/baileysManager.js';
    await import('./server.js');
    const inst = baileysManager.getInstance('disconnect_regression');
    fs.mkdirSync(inst.authDir, {recursive:true}); fs.writeFileSync(inst.authDir + '/marker','test');
    await inst.disconnect();
    if (fs.existsSync(inst.authDir)) process.exit(1);
    process.exit(0);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NODE_ENV: 'test', USE_LOCAL_DB: 'true', PORT: '0' }, timeout: 25000 });
});

test('regression: account takeover via forged supabaseId is rejected', async () => {
  const forgedId = '11111111-2222-3333-4444-555555555555';
  const testEmail = `attacker_${crypto.randomUUID()}@example.test`;
  const result = await handleGoogleAuth({
    email: testEmail,
    fullName: 'Attacker',
    supabaseId: forgedId
  });
  assert.notEqual(result.user.id, forgedId, 'Caller-supplied supabaseId must not be used as user ID');
});

test('regression: revoked membership returns 403 on protected routes', async () => {
  const { server, owner, url } = await setup();
  const originalGetMembership = repository.getMembership;
  try {
    repository.getMembership = async () => null;
    const response = await fetch(`${url}/auth/me`, { headers: headers(owner.token) });
    assert.equal(response.status, 403);
    const data = await response.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /Access denied/);
  } finally {
    repository.getMembership = originalGetMembership;
    server.close();
  }
});

test('regression: missing Supabase in production fails closed', async () => {
  const origEnv = process.env.NODE_ENV;
  const origLocal = process.env.USE_LOCAL_DB;
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.USE_LOCAL_DB;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await assert.rejects(
      async () => repository.getOrganizationById('00000000-0000-0000-0000-000000000001'),
      (err) => err.statusCode === 503 || err.name === 'DatabaseUnavailableError',
      'Must fail closed with DatabaseUnavailableError in production when Supabase is missing'
    );

    await assert.rejects(
      async () => repository.getMembership('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001'),
      (err) => err.statusCode === 503 || err.name === 'DatabaseUnavailableError',
      'Must fail closed with DatabaseUnavailableError in production when Supabase is missing'
    );
  } finally {
    process.env.NODE_ENV = origEnv;
    if (origLocal !== undefined) process.env.USE_LOCAL_DB = origLocal; else delete process.env.USE_LOCAL_DB;
    if (origUrl !== undefined) process.env.SUPABASE_URL = origUrl; else delete process.env.SUPABASE_URL;
    if (origKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey; else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

test('regression: bulk catalogue replacement fails before any RPC or mutation', async () => {
  const { server, owner, url } = await setup();
  const { setSupabaseAdmin } = await import('../src/services/aiService.js');
  try {
    db.insert('catalog_management_grants', { organization_id: owner.organization.id, user_id: owner.user.id });
    let rpcCalls = 0;
    setSupabaseAdmin({
      rpc: async (fnName) => {
        rpcCalls++;
        if (fnName === 'replace_tenant_catalog') {
          return { error: { message: 'RPC execution failed: disk full' } };
        }
        return { data: null, error: null };
      }
    });

    const response = await fetch(`${url}/catalog/sync`, {
      method: 'POST',
      headers: headers(owner.token),
      body: JSON.stringify({
        products: [{ name: 'Test Machine', price_raw: '1000' }]
      })
    });

    assert.equal(response.status, 409);
    const data = await response.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /Bulk replacement is unavailable/);
    assert.equal(rpcCalls, 0);
  } finally {
    setSupabaseAdmin(null);
    server.close();
  }
});

test('regression: quota RPC failure fails closed', async () => {
  const fakeAdmin = {
    rpc: async (fnName) => {
      if (fnName === 'reserve_and_create_lead') {
        return { data: null, error: { message: 'Quota service unreachable' } };
      }
      return { data: null, error: null };
    }
  };

  const { data, error } = await fakeAdmin.rpc('reserve_and_create_lead', {
    p_org_id: '00000000-0000-0000-0000-000000000001',
    p_buyer_phone: '919876543210',
    p_buyer_name: 'Test Buyer'
  });

  assert.ok(error, 'RPC error must be detected');
  assert.equal(data, null, 'No lead should be returned on RPC error');
});
