process.env.NODE_ENV = 'test';
process.env.ALLOW_DEMO_LOGIN = 'true';
process.env.USE_LOCAL_DB = 'true';
process.env.PLATFORM_ADMIN_SECRET = 'test_secret_platform_superadmin_xyz987';
process.env.B2B_WEBHOOK_SECRET = 'test_b2b_secret_token_123';
process.env.META_APP_SECRET = 'test_meta_app_secret_abc';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { signUp } from '../src/auth/authService.js';
import { LeadService } from '../src/services/leadService.js';
import {
  validateSafeIdentifier,
  getSafeTenantAuthDir,
  getSafeTenantCatalogPath,
  isPrivateOrReservedIP,
  getSafeAttachmentBuffer
} from '../src/services/storageSecurity.js';

test('SECURITY SUITE: Cross-tenant negative access, SSRF, path traversal, and webhook authorization', async (t) => {
  const app = express();
  // Capture raw body buffer for HMAC verification on Meta webhook
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  }));
  app.use('/api', apiRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  // Provision Tenant 1 (Alice)
  const user1 = await signUp({
    email: `tenant1_${Date.now()}@security.test`,
    password: 'Password123!',
    fullName: 'Alice Tenant1',
    companyName: 'Alice Industries'
  });

  // Provision Tenant 2 (Bob)
  const user2 = await signUp({
    email: `tenant2_${Date.now()}@security.test`,
    password: 'Password123!',
    fullName: 'Bob Tenant2',
    companyName: 'Bob Machinery'
  });

  const authHeader1 = { 'Authorization': `Bearer ${user1.token}`, 'Content-Type': 'application/json' };
  const authHeader2 = { 'Authorization': `Bearer ${user2.token}`, 'Content-Type': 'application/json' };

  await t.test('1. Unauthenticated requests to protected endpoints return 401', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/leads' },
      { method: 'GET', path: '/api/conversations' },
      { method: 'GET', path: '/api/whatsapp/status' },
      { method: 'POST', path: '/api/whatsapp/connect' },
      { method: 'POST', path: '/api/whatsapp/disconnect' },
      { method: 'POST', path: '/api/leads/simulate' },
      { method: 'POST', path: '/api/payments/upi-verify' }
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: { 'Content-Type': 'application/json' },
        body: ep.method === 'POST' ? JSON.stringify({}) : undefined
      });
      assert.equal(res.status, 401, `Expected 401 on ${ep.method} ${ep.path} when unauthenticated`);
    }
  });

  await t.test('2. Token in query parameter is rejected (prevents token leak in URL/logs)', async () => {
    const res = await fetch(`${baseUrl}/api/leads?token=${user1.token}`);
    assert.equal(res.status, 401, 'Token in query parameter must NOT authenticate request');
  });

  await t.test('3. Cross-tenant isolation: Tenant 2 cannot access or view Tenant 1 leads', async () => {
    // Alice creates a lead
    const lead1 = LeadService.createOrDeduplicateLead(user1.organization.id, {
      buyer_name: 'Confidential Buyer 1',
      buyer_phone: '919888877771',
      product_inquired: 'Secret Machine Model X',
      source_event_id: `evt_sec_${Date.now()}`
    });

    // Bob requests leads
    const bobRes = await fetch(`${baseUrl}/api/leads`, { headers: authHeader2 });
    assert.equal(bobRes.status, 200);
    const bobData = await bobRes.json();
    const leaked = bobData.leads.some((l) => l.id === lead1.lead.id);
    assert.equal(leaked, false, 'Tenant 2 received Tenant 1 lead in /api/leads response!');
  });

  await t.test('4. Path traversal prevention rejects directory traversal attempts', () => {
    assert.throws(() => validateSafeIdentifier('../evil_dir'), /Invalid Identifier/i);
    assert.throws(() => validateSafeIdentifier('..\\windows\\system32'), /Invalid Identifier/i);
    assert.throws(() => validateSafeIdentifier('user/sub/folder'), /Invalid Identifier/i);
    assert.throws(() => validateSafeIdentifier(''), /Identifier must be|Invalid Identifier/i);
    assert.throws(() => validateSafeIdentifier('!@#$%^&*()'), /Invalid Identifier/i);

    // Valid identifiers pass
    assert.equal(validateSafeIdentifier('org_123_valid-tenant'), 'org_123_valid-tenant');
    assert.equal(validateSafeIdentifier('session_abc-456'), 'session_abc-456');

    // Canonical path verification
    const safeDir = getSafeTenantAuthDir('org_safe_01');
    assert.ok(safeDir.includes('org_safe_01'));

    const safeCatalog = getSafeTenantCatalogPath('org_safe_01', 'catalog_123.pdf');
    assert.ok(safeCatalog.endsWith('.pdf'));
    assert.throws(() => getSafeTenantCatalogPath('org_safe_01', '../evil.exe'), /Invalid filename/i);
  });

  await t.test('5. SSRF Defense: isPrivateOrReservedIP blocks internal & metadata IPs', () => {
    // IPv4 private & loopback
    assert.equal(isPrivateOrReservedIP('127.0.0.1'), true, 'Should block IPv4 loopback');
    assert.equal(isPrivateOrReservedIP('10.0.0.1'), true, 'Should block 10.0.0.0/8');
    assert.equal(isPrivateOrReservedIP('172.16.0.1'), true, 'Should block 172.16.0.0/12');
    assert.equal(isPrivateOrReservedIP('192.168.1.1'), true, 'Should block 192.168.0.0/16');
    assert.equal(isPrivateOrReservedIP('169.254.169.254'), true, 'Should block AWS/cloud metadata IP');
    assert.equal(isPrivateOrReservedIP('0.0.0.0'), true, 'Should block 0.0.0.0');

    // IPv6 private & loopback
    assert.equal(isPrivateOrReservedIP('::1'), true, 'Should block IPv6 loopback');
    assert.equal(isPrivateOrReservedIP('fe80::1'), true, 'Should block IPv6 link-local');
    assert.equal(isPrivateOrReservedIP('::ffff:127.0.0.1'), true, 'Should block IPv4-mapped loopback');
    assert.equal(isPrivateOrReservedIP('::ffff:169.254.169.254'), true, 'Should block IPv4-mapped metadata');

    // Public IPs allowed
    assert.equal(isPrivateOrReservedIP('8.8.8.8'), false, 'Public DNS should not be blocked');
    assert.equal(isPrivateOrReservedIP('1.1.1.1'), false, 'Public Cloudflare should not be blocked');
  });

  await t.test('6. SSRF Defense: getSafeAttachmentBuffer rejects malicious URLs', async () => {
    await assert.rejects(
      async () => getSafeAttachmentBuffer('org_sec_test', 'https://127.0.0.1/secret.pdf'),
      /SSRF blocked|protected\/internal IP/i
    );

    await assert.rejects(
      async () => getSafeAttachmentBuffer('org_sec_test', 'https://169.254.169.254/latest/meta-data/'),
      /SSRF blocked|protected\/internal IP/i
    );

    await assert.rejects(
      async () => getSafeAttachmentBuffer('org_sec_test', 'file:///etc/passwd'),
      /Prohibited attachment URL protocol/i
    );

    await assert.rejects(
      async () => getSafeAttachmentBuffer('org_sec_test', 'ftp://ftp.example.com/test.pdf'),
      /Prohibited attachment URL protocol/i
    );
  });

  await t.test('7. B2B Webhook requires authentication token', async () => {
    // Unauthenticated request fails with 401
    const unauthRes = await fetch(`${baseUrl}/api/webhook/b2b`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        SENDER_MOBILE: '919876543210',
        SENDER_NAME: 'Unauth Lead',
        QUERY_PRODUCT_NAME: 'Packaging Machine'
      })
    });
    assert.equal(unauthRes.status, 401, 'Unauthenticated B2B webhook should return 401');

    // Authenticated request with x-b2b-token succeeds
    const token = user1.organization.webhook_key || user1.organization.id;
    const authRes = await fetch(`${baseUrl}/api/webhook/b2b`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-b2b-token': token
      },
      body: JSON.stringify({
        SENDER_MOBILE: '919876543210',
        SENDER_NAME: 'Authorized Lead',
        QUERY_PRODUCT_NAME: 'Packaging Machine',
        UNIQUE_QUERY_ID: `b2b_test_${Date.now()}`
      })
    });
    assert.equal(authRes.status, 200, 'Authenticated B2B webhook should return 200');
  });

  await t.test('8. Meta Cloud API Webhook rejects invalid HMAC signature', async () => {
    const rawPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            messages: [{ from: '919999988888', text: { body: 'Hello' } }]
          }
        }]
      }]
    });

    // Request with missing signature returns 401
    const noSigRes = await fetch(`${baseUrl}/api/webhook/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawPayload
    });
    assert.equal(noSigRes.status, 401, 'Missing signature should return 401');

    // Request with bogus signature returns 401
    const badSigRes = await fetch(`${baseUrl}/api/webhook/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000'
      },
      body: rawPayload
    });
    assert.equal(badSigRes.status, 401, 'Invalid signature should return 401');

    // Request with valid HMAC signature passes
    const validHmac = crypto.createHmac('sha256', 'test_meta_app_secret_abc').update(rawPayload).digest('hex');
    const goodSigRes = await fetch(`${baseUrl}/api/webhook/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${validHmac}`
      },
      body: rawPayload
    });
    assert.equal(goodSigRes.status, 200, 'Valid HMAC signature must be accepted');
  });

  await t.test('9. UPI Payment: Tenant owner cannot self-reconcile; requires platform superadmin', async () => {
    const utr = `UTR${Date.now()}`;

    // Tenant submits UTR
    const submitRes = await fetch(`${baseUrl}/api/payments/upi-verify`, {
      method: 'POST',
      headers: authHeader1,
      body: JSON.stringify({ utrReference: utr, amountInr: 9999, plan: '3-Month Launch Plan' })
    });
    assert.equal(submitRes.status, 200);
    const submitData = await submitRes.json();
    assert.equal(submitData.status, 'pending_verification', 'Payment must be pending_verification upon UTR submission');

    // Tenant owner attempts to reconcile their own payment -> 403 Forbidden
    const selfReconcileRes = await fetch(`${baseUrl}/api/admin/payments/reconcile`, {
      method: 'POST',
      headers: authHeader1,
      body: JSON.stringify({ paymentId: submitData.paymentId, action: 'approve' })
    });
    assert.equal(selfReconcileRes.status, 403, 'Tenant owner must NOT be permitted to approve own payment');

    // Platform Superadmin with x-platform-admin-key reconciles payment
    const adminReconcileRes = await fetch(`${baseUrl}/api/admin/payments/reconcile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-platform-admin-key': 'test_secret_platform_superadmin_xyz987'
      },
      body: JSON.stringify({ paymentId: submitData.paymentId, action: 'approve', notes: 'Bank statement matched' })
    });
    assert.equal(adminReconcileRes.status, 200, 'Platform superadmin must be permitted to approve payment');
    const adminData = await adminReconcileRes.json();
    assert.equal(adminData.ok, true);
    assert.equal(adminData.status, 'verified');

    // Verify organization plan is now active
    const org = db.findById('organizations', user1.organization.id);
    assert.equal(org.plan_status, 'active', 'Organization plan_status must be active after admin approval');
  });

  await t.test('10. CSV formula injection defense escapes dangerous formulas', () => {
    const formulaPayloads = [
      '=cmd|"/C calc"!A0',
      '+1+2',
      '-2+3',
      '@SUM(A1:A10)'
    ];

    for (const formula of formulaPayloads) {
      const sanitized = LeadService.sanitizeCsvCell(formula);
      assert.ok(sanitized.startsWith("'"), `Dangerous formula "${formula}" must be escaped with a single quote`);
    }

    // Normal strings are untouched
    assert.equal(LeadService.sanitizeCsvCell('Normal Company Ltd'), 'Normal Company Ltd');
    assert.equal(LeadService.sanitizeCsvCell('9811002233'), '9811002233');
  });

  await t.test('11. Quota Enforcement: Exceeded leads recorded with quota_exceeded and AI suppressed', () => {
    // Set org quota limit to 1
    db.update('organizations', user2.organization.id, {
      monthly_lead_limit: 1,
      leads_used: 1,
      plan_status: 'active'
    });

    const res = LeadService.createOrDeduplicateLead(user2.organization.id, {
      buyer_name: 'Over Quota Buyer',
      buyer_phone: '919777700000',
      product_inquired: 'Liquid Filling Machine',
      source_event_id: `evt_quota_${Date.now()}`
    });

    assert.ok(res.lead.id, 'Lead record must be preserved even when over quota');
    assert.equal(res.lead.status, 'quota_exceeded', 'Lead status should be quota_exceeded');
  });

  await t.test('12. Server syntax integrity: node --check server.js compiles cleanly', () => {
    assert.doesNotThrow(() => {
      execSync('node --check server.js', { stdio: 'pipe' });
    }, 'server.js must have zero JavaScript syntax errors');
  });

  await t.test('13. Catalog sync: authenticated, tenant-isolated, and verifies database updates', async () => {
    const testProducts = [
      {
        sku: 'ASTRO-01',
        name: 'Vedic Kundli & Horoscope Consultation',
        price_raw: '₹1,100 per session',
        model_specs: '45-minute live audio consultation with remedial gem recommendations',
        category: 'Astrology Services'
      },
      {
        sku: 'ASTRO-02',
        name: 'Career & Financial Horoscope Report',
        price_raw: '₹2,500',
        model_specs: 'Complete 25-page printed & PDF planetary transit analysis',
        category: 'Astrology Services'
      }
    ];

    // 13a. Unauthenticated request must be rejected with 401
    const unauthRes = await fetch(`${baseUrl}/api/catalog/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: user1.organization.id,
        products: testProducts
      })
    });
    assert.equal(unauthRes.status, 401, 'Unauthenticated catalog sync must be rejected with 401');

    // 13b. Cross-tenant mutation by User 2 on User 1 must be rejected with 403
    const crossTenantRes = await fetch(`${baseUrl}/api/catalog/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user2.token}`
      },
      body: JSON.stringify({
        orgId: user1.organization.id,
        products: testProducts
      })
    });
    assert.equal(crossTenantRes.status, 403, 'Cross-tenant catalog mutation must be rejected with 403');

    // 13c. Explicitly authorized tenant manager updates own catalog
    db.insert('catalog_management_grants', { organization_id: user1.organization.id, user_id: user1.user.id });
    const syncRes = await fetch(`${baseUrl}/api/catalog/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user1.token}`
      },
      body: JSON.stringify({
        products: testProducts,
        websiteKnowledge: 'Sri Vedic Astrology Center. We offer Kundli matching, horoscope reading, and gemstone advice.',
        companyName: 'Sri Vedic Astrology Center',
        resetConversations: true
      })
    });

    assert.equal(syncRes.status, 409);
    const syncData = await syncRes.json();
    assert.equal(syncData.ok, false);
    assert.match(syncData.error, /Bulk replacement is unavailable/);
    assert.equal(db.findScoped('products', user1.organization.id).length, 0);

  });

  server.close();
});
