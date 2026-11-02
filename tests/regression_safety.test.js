process.env.NODE_ENV = 'test';
process.env.USE_LOCAL_DB = 'true';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { signUp, createSessionToken } from '../src/auth/authService.js';
import { repository } from '../src/db/repository.js';

async function setup() {
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0);
  const owner = await signUp({ email: `regression_${crypto.randomUUID()}@example.test`, password: 'Password123!', fullName: 'Owner', companyName: 'Test Co' });
  return { server, owner, url: `http://127.0.0.1:${server.address().port}/api` };
}
function headers(token) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }; }

test('catalog sync requires owner and preserves chat, takeover and omitted products', async () => {
  const { server, owner, url } = await setup();
  try {
    const org = owner.organization.id;
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
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NODE_ENV: 'test', USE_LOCAL_DB: 'true', PORT: '0' }, timeout: 10000 });
});
