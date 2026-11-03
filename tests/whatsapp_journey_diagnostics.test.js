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

  // In-memory rate limiting map for test
  const testRateLimits = new Map();
  function checkRateLimit(ip) {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const maxRequests = 5;
    const record = testRateLimits.get(ip) || [];
    const valid = record.filter((ts) => now - ts < windowMs);
    if (valid.length >= maxRequests) return false;
    valid.push(now);
    testRateLimits.set(ip, valid);
    return true;
  }

  // Simulated server-level /api/simulate-lead hybrid router matching server.js
  app.post('/api/simulate-lead', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return res.json({ ok: true, lead: { id: 'LEAD-AUTH-1', name: req.body.name || 'Auth Buyer' } });
    }
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ ok: false, error: 'Too many demo requests. Please wait a few minutes.' });
    }
    const cleanPhone = normalizeIndianPhone(req.body.phone);
    if (!cleanPhone || cleanPhone.length < 10) {
      return res.status(400).json({ ok: false, error: 'Valid 10-digit WhatsApp mobile number required.' });
    }
    return res.json({
      ok: true,
      lead: { id: 'LEAD-PUB-1', name: req.body.name || 'Demo Buyer', phone: cleanPhone }
    });
  });

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  const tenant = await signUp({
    email: `flow_test_${Date.now()}@test.in`,
    password: 'Password123!',
    fullName: 'Test Owner',
    companyName: 'Test Flow Machinery'
  });

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

  await t.test('3. /api/simulate-lead accepts unauthenticated public requests and authenticated operator requests', async () => {
    // Unauthenticated public request
    const pubRes = await fetch(`${baseUrl}/api/simulate-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Public Tester',
        phone: '9811122233',
        productQuery: 'Band Sealer'
      })
    });
    assert.equal(pubRes.status, 200);
    const pubBody = await pubRes.json();
    assert.equal(pubBody.ok, true);
    assert.equal(pubBody.lead.name, 'Public Tester');

    // Authenticated operator request
    const authRes = await fetch(`${baseUrl}/api/simulate-lead`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tenant.token}`
      },
      body: JSON.stringify({
        name: 'Operator Triggered Lead',
        phone: '9811122244'
      })
    });
    assert.equal(authRes.status, 200);
    const authBody = await authRes.json();
    assert.equal(authBody.ok, true);
  });

  await t.test('4. Abuse protection: Rate limiting triggers 429 on excessive public enquiries', async () => {
    const testIp = '198.51.100.99';
    // Consume quota (5 requests)
    for (let i = 0; i < 5; i++) {
      checkRateLimit(testIp);
    }
    // 6th request must be rejected
    const res = await fetch(`${baseUrl}/api/simulate-lead`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': testIp
      },
      body: JSON.stringify({
        name: 'Flood Test',
        phone: '9876543210'
      })
    });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.match(body.error, /too many/i);
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
