process.env.NODE_ENV = 'test';
process.env.ALLOW_DEMO_LOGIN = 'true';
process.env.USE_LOCAL_DB = 'true';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { signUp, createSessionToken } from '../src/auth/authService.js';
import {
  isCustomerInManualMode,
  takeoverCustomer,
  releaseCustomer,
  parseOwnerCommand,
  normalizeIndianPhone
} from '../src/services/takeoverService.js';
import { baileysManager } from '../src/integrations/whatsapp/baileysManager.js';

test('WHATSAPP JOURNEY DIAGNOSTICS & FIX SUITE: Complete Flow Verification', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  const tenant = await signUp({
    email: `flow_test_${Date.now()}@test.in`,
    password: 'Password123!',
    fullName: 'Test Owner',
    companyName: 'Test Flow Machinery'
  });

  db.insert('organizations', { id: '6fd354d9-3437-412d-856e-28bc19d44268', name: 'Synthetic demo tenant' });

  await t.test('1. Public Demo Form Endpoint (/api/public/demo-enquiry) creates lead without auth', async () => {
    const res = await fetch(`${baseUrl}/api/public/demo-enquiry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Vikas Sharma',
        phone: '9876543210',
        productQuery: 'Pouch Packing Machine',
        city: 'Kanpur'
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.lead.id);
    assert.equal(body.lead.name, 'Vikas Sharma');
  });

  await t.test('2. Public Demo Form rejects invalid phone numbers (< 10 digits)', async () => {
    const res = await fetch(`${baseUrl}/api/public/demo-enquiry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Invalid Test',
        phone: '12345',
        productQuery: 'Machine'
      })
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /10-digit/i);
  });

  await t.test('3. Rebuilt simulator enforces consent, phone validation, and tenant isolation', async () => {
    // A: Missing consent must fail with 400
    const noConsentRes = await fetch(`${baseUrl}/api/simulate-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '9811122233' })
    });
    assert.equal(noConsentRes.status, 400);
    const noConsentBody = await noConsentRes.json();
    assert.equal(noConsentBody.ok, false);
    assert.match(noConsentBody.error, /consent/i);

    // B: Invalid phone (<10 digits) with consent must fail with 400
    const invalidPhoneRes = await fetch(`${baseUrl}/api/simulate-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true, phone: '1234' })
    });
    assert.equal(invalidPhoneRes.status, 400);
    const invalidPhoneBody = await invalidPhoneRes.json();
    assert.equal(invalidPhoneBody.ok, false);
    assert.match(invalidPhoneBody.error, /10-digit/i);

    // C: Authenticated tenant with consent scopes strictly to tenant organization
    const authRes = await fetch(`${baseUrl}/api/simulate-lead`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.token}`
      },
      body: JSON.stringify({
        consent: true,
        phone: '9811122233',
        name: 'Isolated Buyer',
        productQuery: 'Industrial Packaging Unit'
      })
    });
    assert.equal(authRes.status, 200);
    const authBody = await authRes.json();
    assert.equal(authBody.ok, true);
    assert.equal(authBody.simulated, true);
    assert.equal(authBody.tenantId, tenant.organization.id);
    assert.ok(authBody.deliveryStatus.startsWith('simulated_'));
  });

  await t.test('4. Public enquiry rate limit rejects excessive requests', async () => {
    // Two enquiries were already made above from this same client.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/api/public/demo-enquiry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9876543210' }) });
      assert.equal(res.status, 200);
    }
    const res = await fetch(`${baseUrl}/api/public/demo-enquiry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9876543210' }) });
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /too many/i);
  });

  await t.test('5. /api/public-config exposes dynamic demoBotWhatsapp and supportWhatsapp', async () => {
    const res = await fetch(`${baseUrl}/api/public-config`);
    const body = await res.json();
    if (res.status !== 200) console.error('Subtest 1 error body:', body);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.demoBotWhatsapp);
    assert.ok(body.supportWhatsapp);
    assert.ok(body.merchantUpiId);
  });

  await t.test('6. Manual Takeover auto-expires: 4-hour takeover gates AI then restores auto mode', async () => {
    const orgId = tenant.organization.id;
    const testBuyer = '919876543299';

    // 1. Activate manual takeover
    await takeoverCustomer({
      orgId,
      buyerPhone: testBuyer,
      durationMs: 4 * 3600 * 1000,
      takenBy: 'owner'
    });

    const activeCheck = await isCustomerInManualMode({ orgId, buyerPhone: testBuyer });
    assert.equal(activeCheck.inManualMode, true);
    assert.ok(activeCheck.remainingMinutes > 200);

    // 2. Explicit release restores AI mode
    const releaseRes = await releaseCustomer({ orgId, buyerPhone: testBuyer });
    assert.equal(releaseRes.ok, true);

    const postReleaseCheck = await isCustomerInManualMode({ orgId, buyerPhone: testBuyer });
    assert.equal(postReleaseCheck.inManualMode, false);
  });

  await t.test('7. Phone & LID resolution: 10-digit Indian phone and 15-digit LID digits are preserved', async () => {
    // 10-digit raw
    assert.equal(normalizeIndianPhone('9876543210'), '919876543210');
    // 11-digit leading 0
    assert.equal(normalizeIndianPhone('09876543210'), '919876543210');
    // 12-digit standard Indian format
    assert.equal(normalizeIndianPhone('+919876543210'), '919876543210');
    // 15-digit WhatsApp LID
    const lidDigits = '148004724064491';
    assert.equal(normalizeIndianPhone(lidDigits), lidDigits);
  });

  await t.test('8. Owner command parser: distinguishes administrative commands from testing inquiries', async () => {
    const ownerPhone = '919781018975';

    // Valid owner administrative commands
    const cmdTake = parseOwnerCommand('TAKE 9876543210', ownerPhone, ownerPhone);
    assert.equal(cmdTake.isOwnerCommand, true);
    assert.equal(cmdTake.action, 'TAKE');
    assert.equal(cmdTake.targetPhone, '919876543210');

    const cmdSend = parseOwnerCommand('SEND 9876543210 Ji hum call karenge', ownerPhone, ownerPhone);
    assert.equal(cmdSend.isOwnerCommand, true);
    assert.equal(cmdSend.action, 'SEND');

    // Customer testing question from owner personal phone -> isOwnerCommand is FALSE
    const customerQuestion = parseOwnerCommand('Namaste, packing machine ka price kya hai?', ownerPhone, ownerPhone);
    assert.equal(customerQuestion.isOwnerCommand, false);

    // Command from unauthorized buyer number -> rejected
    const rogueBuyer = parseOwnerCommand('TAKE 9876543210', '919999999999', ownerPhone);
    assert.equal(rogueBuyer.isOwnerCommand, false);
  });

  await t.test('9. Frontend file integrity: demo.html and index.html reference live demo endpoints', async () => {
    const demoHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'demo.html'), 'utf8');
    assert.ok(demoHtml.includes('/api/public/demo-enquiry'), 'demo.html must call /api/public/demo-enquiry');

    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('window.DEMO_BOT_WHATSAPP_LIVE'), 'index.html must dynamically read DEMO_BOT_WHATSAPP_LIVE');
  });

  server.close();
});
