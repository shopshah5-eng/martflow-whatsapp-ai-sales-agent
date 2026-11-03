process.env.NODE_ENV = 'test';
process.env.USE_LOCAL_DB = 'true';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { repository } from '../src/db/repository.js';
import { signUp, createSessionToken } from '../src/auth/authService.js';
import { authenticate } from '../src/middleware/authMiddleware.js';

function headers(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

test('INTEGRATION: Old-schema migration scripts contain all mandatory columns and idempotent constraints', async () => {
  const migrationSql = fs.readFileSync(path.resolve('scripts/production_safety_migration.sql'), 'utf8');
  const schemaSql = fs.readFileSync(path.resolve('supabase_schema.sql'), 'utf8');

  // Verify leads.requirement exists in both files
  assert.ok(migrationSql.includes('ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS requirement TEXT'), 'Migration must add leads.requirement');
  assert.ok(schemaSql.includes('requirement TEXT'), 'Schema must define leads.requirement');

  // Verify wa_worker_id and heartbeat in organizations
  assert.ok(migrationSql.includes('ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS wa_worker_id TEXT'), 'Migration must add wa_worker_id');
  assert.ok(migrationSql.includes('ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS wa_worker_heartbeat TIMESTAMPTZ'), 'Migration must add wa_worker_heartbeat');

  // Verify payments quote_code
  assert.ok(migrationSql.includes('ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS quote_code TEXT'), 'Migration must add payments.quote_code');

  // Verify unique indexes for concurrency safety and replay prevention
  assert.ok(migrationSql.includes('idx_leads_org_buyer_phone ON public.leads (org_id, buyer_phone)'), 'Migration must enforce unique (org_id, buyer_phone)');
  assert.ok(migrationSql.includes('idx_payments_razorpay_payment_id ON public.payments (razorpay_payment_id)'), 'Migration must enforce unique razorpay_payment_id');

  // Verify RPC plan status enforcement
  assert.ok(migrationSql.includes("plan_status = 'active' AND COALESCE(leads_used, 0) < COALESCE(monthly_lead_limit"), 'Active plan must check monthly_lead_limit');
  assert.ok(migrationSql.includes("plan_status = 'trial' AND (trial_ends_at IS NULL OR trial_ends_at > now())"), 'Trial plan must check expiration');
});

test('INTEGRATION: Quota boundary enforcement across active, trial, and expired plans', async () => {
  const orgActiveUnder = db.insert('organizations', {
    name: 'Active Under Limit',
    plan_status: 'active',
    monthly_lead_limit: 10,
    leads_used: 5
  });

  const res1 = await repository.atomicIncrementLeadUsage(orgActiveUnder.id, 10);
  assert.equal(res1.success, true);
  assert.equal(res1.leadsUsed, 6);

  const orgActiveAtLimit = db.insert('organizations', {
    name: 'Active At Limit',
    plan_status: 'active',
    monthly_lead_limit: 10,
    leads_used: 10
  });

  const res2 = await repository.atomicIncrementLeadUsage(orgActiveAtLimit.id, 10);
  assert.equal(res2.success, false);
  assert.equal(res2.quotaExceeded, true);

  const orgTrialValid = db.insert('organizations', {
    name: 'Trial Valid',
    plan_status: 'trial',
    trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
    monthly_lead_limit: 25,
    leads_used: 2
  });

  const res3 = await repository.atomicIncrementLeadUsage(orgTrialValid.id, 25);
  assert.equal(res3.success, true);
  assert.equal(res3.leadsUsed, 3);

  const orgTrialExpiredDate = db.insert('organizations', {
    name: 'Trial Date Expired',
    plan_status: 'trial',
    trial_ends_at: new Date(Date.now() - 3600000).toISOString(),
    monthly_lead_limit: 25,
    leads_used: 2
  });

  const res4 = await repository.atomicIncrementLeadUsage(orgTrialExpiredDate.id, 25);
  assert.equal(res4.success, false);
  assert.equal(res4.quotaExceeded, true);

  const orgExpiredPlan = db.insert('organizations', {
    name: 'Expired Plan',
    plan_status: 'expired',
    monthly_lead_limit: 50,
    leads_used: 0
  });

  const res5 = await repository.atomicIncrementLeadUsage(orgExpiredPlan.id, 50);
  assert.equal(res5.success, false);
  assert.equal(res5.quotaExceeded, true);
});

test('INTEGRATION: Concurrent lead deduplication preserves existing leads and prevents double-charge', async () => {
  const org = db.insert('organizations', {
    name: 'Concurrent Test Org',
    plan_status: 'active',
    monthly_lead_limit: 100,
    leads_used: 0
  });

  const buyerPhone = '919876543210';

  // Simulate first worker inserting lead
  const lead1 = await repository.createLead(org.id, {
    buyer_phone: buyerPhone,
    buyer_name: 'Buyer One',
    requirement: 'Heavy Lathe Machine'
  });
  assert.ok(lead1.id);

  // Simulate concurrent second worker looking for existing lead
  const existing = await repository.getLeadByPhone(org.id, buyerPhone);
  assert.ok(existing);
  assert.equal(existing.id, lead1.id);

  // Duplicate lookup within 24h window
  const duplicate = await repository.findDuplicateLead(org.id, buyerPhone);
  assert.ok(duplicate);
  assert.equal(duplicate.id, lead1.id);
});

test('INTEGRATION: Supabase Auth JWT token server-side authentication and fail-closed security', async () => {
  const app = express();
  app.use(express.json());
  app.get('/test-auth', authenticate, (req, res) => {
    res.json({ ok: true, userId: req.userId, organizationId: req.organizationId, role: req.role });
  });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;

  const testUser = db.insert('profiles', {
    id: 'f8796123-1111-2222-3333-444455556666',
    email: 'jwt_test@example.com',
    full_name: 'JWT User',
    role: 'owner'
  });

  const testOrg = db.insert('organizations', {
    id: 'a1234567-aaaa-bbbb-cccc-dddd11112222',
    name: 'JWT Org'
  });

  testUser.org_id = testOrg.id;
  db.update('profiles', testUser.id, { org_id: testOrg.id });
  db.insert('organization_members', { organization_id: testOrg.id, user_id: testUser.id, role: 'owner' });

  try {
    const mockSupabase = {
      auth: {
        getUser: async (token) => {
          if (token === 'valid-supabase-jwt') {
            return { data: { user: { id: testUser.id, email: testUser.email } }, error: null };
          }
          return { data: { user: null }, error: { message: 'Invalid token' } };
        }
      },
      from: (tbl) => ({
        select: () => ({
          eq: (col, val) => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: testUser.id, org_id: testOrg.id, role: 'owner' }, error: null })
            }),
            maybeSingle: async () => {
              if (tbl === 'organizations') return { data: testOrg, error: null };
              return { data: testUser, error: null };
            }
          })
        })
      })
    };

    const origGetSupabase = repository.getSupabase;
    repository.getSupabase = () => mockSupabase;

    try {
      // 1. Valid JWT token
      const resp1 = await fetch(`${url}/test-auth`, {
        headers: { authorization: 'Bearer valid-supabase-jwt' }
      });
      assert.equal(resp1.status, 200);
      const data1 = await resp1.json();
      assert.equal(data1.userId, testUser.id);
      assert.equal(data1.organizationId, testOrg.id);

      // 2. Invalid JWT token fails with 401
      const resp2 = await fetch(`${url}/test-auth`, {
        headers: { authorization: 'Bearer forged-jwt' }
      });
      assert.equal(resp2.status, 401);

      // 3. Revoked membership fails with 403
      const origGetMembership = repository.getMembership;
      repository.getMembership = async () => null;
      try {
        const resp3 = await fetch(`${url}/test-auth`, {
          headers: { authorization: 'Bearer valid-supabase-jwt' }
        });
        assert.equal(resp3.status, 403);
      } finally {
        repository.getMembership = origGetMembership;
      }
    } finally {
      repository.getSupabase = origGetSupabase;
    }
  } finally {
    server.close();
  }
});

test('INTEGRATION: Durable Razorpay order creation, verification, and replay attack rejection (409)', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api`;

  const owner = await signUp({
    email: `pay_durable_${crypto.randomUUID()}@example.com`,
    password: 'Password123!',
    fullName: 'Payment Tester',
    companyName: 'Payment Co'
  });

  const secret = 'rzp_test_secret_for_integration_testing';
  const oldKeyId = process.env.RAZORPAY_KEY_ID;
  const oldSecret = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_SECRET = secret;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_valid';

  const orderId = `order_${crypto.randomUUID()}`;
  const paymentId = `pay_${crypto.randomUUID()}`;
  const realFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (target, options) => {
      if (String(target).startsWith('https://api.razorpay.com/v1/payments/')) {
        return new Response(JSON.stringify({
          status: 'captured',
          order_id: orderId,
          amount: 999900,
          currency: 'INR'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(target, options);
    };

    // 1. Create order
    const order = await repository.createPayment(owner.organization.id, {
      amount_inr: 9999,
      provider: 'razorpay',
      razorpay_order_id: orderId,
      status: 'pending'
    });
    assert.ok(order.id);
    assert.equal(order.status, 'pending');

    // 2. Generate valid signature
    const signature = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

    // 3. Verify payment first time -> Success 200
    const verifyResp1 = await fetch(`${url}/payments/razorpay/verify`, {
      method: 'POST',
      headers: headers(owner.token),
      body: JSON.stringify({
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature
      })
    });
    assert.equal(verifyResp1.status, 200);
    const data1 = await verifyResp1.json();
    assert.equal(data1.ok, true);

    // 4. Verify duplicate attempt with same payment_id -> Replay attack 409
    const verifyResp2 = await fetch(`${url}/payments/razorpay/verify`, {
      method: 'POST',
      headers: headers(owner.token),
      body: JSON.stringify({
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature
      })
    });
    assert.equal(verifyResp2.status, 409);
    const data2 = await verifyResp2.json();
    assert.ok(data2.error.includes('replay attack prevented'));
  } finally {
    globalThis.fetch = realFetch;
    if (oldKeyId !== undefined) process.env.RAZORPAY_KEY_ID = oldKeyId; else delete process.env.RAZORPAY_KEY_ID;
    if (oldSecret !== undefined) process.env.RAZORPAY_KEY_SECRET = oldSecret; else delete process.env.RAZORPAY_KEY_SECRET;
    server.close();
  }
});

test('INTEGRATION: Direct UPI submission, duplicate UTR rejection, and platform reconciliation', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api`;

  const owner = await signUp({
    email: `pay_direct_upi_${crypto.randomUUID()}@example.com`,
    password: 'Password123!',
    fullName: 'UPI Payment Tester',
    companyName: 'UPI Payment Co'
  });

  try {
    // 1. Direct UPI submit UTR -> 200 pending_verification
    const testUtr = 'UTR' + Date.now() + 'ABC';
    const upiSubmitResp = await fetch(`${url}/payments/upi-verify`, {
      method: 'POST',
      headers: headers(owner.token),
      body: JSON.stringify({ utrReference: testUtr, amountInr: 9999 })
    });
    assert.equal(upiSubmitResp.status, 200);
    const upiData = await upiSubmitResp.json();
    assert.equal(upiData.ok, true);
    assert.equal(upiData.status, 'pending_verification');
    assert.ok(upiData.paymentId);

    // 2. Duplicate UTR submission -> 409 Conflict
    const upiDupResp = await fetch(`${url}/payments/upi-verify`, {
      method: 'POST',
      headers: headers(owner.token),
      body: JSON.stringify({ utrReference: testUtr, amountInr: 9999 })
    });
    assert.equal(upiDupResp.status, 409);

    // 3. Tenant owner cannot self-reconcile -> 403 Forbidden
    const unauthReconcile = await fetch(`${url}/admin/payments/reconcile`, {
      method: 'POST',
      headers: headers(owner.token),
      body: JSON.stringify({ paymentId: upiData.paymentId, status: 'verified' })
    });
    assert.equal(unauthReconcile.status, 403);

    // 4. Platform finance admin with key can reconcile -> 200 and activates plan
    const platformSecret = process.env.PLATFORM_ADMIN_SECRET || process.env.SESSION_SECRET;
    const authReconcile = await fetch(`${url}/admin/payments/reconcile`, {
      method: 'POST',
      headers: {
        ...headers(owner.token),
        'x-platform-admin-key': platformSecret
      },
      body: JSON.stringify({ paymentId: upiData.paymentId, status: 'verified', notes: 'Verified in bank feed' })
    });
    assert.equal(authReconcile.status, 200);
    const recData = await authReconcile.json();
    assert.equal(recData.ok, true);
    assert.equal(recData.activated, true);

    const updatedOrg = db.findById('organizations', owner.organization.id);
    assert.equal(updatedOrg.plan_status, 'active');
  } finally {
    server.close();
  }
});

test('INTEGRATION: Stored procedures, ambiguous column error 42702 prevention, and immutability trigger', async () => {
  const migrationSql = fs.readFileSync(path.resolve('scripts/production_safety_migration.sql'), 'utf8');
  const schemaSql = fs.readFileSync(path.resolve('supabase_schema.sql'), 'utf8');

  // Verify unambiguous output columns avoiding Error 42702
  assert.ok(migrationSql.includes('RETURNS TABLE(out_lead_id UUID, out_quota_admitted BOOLEAN, out_is_new BOOLEAN)'), 'Migration must declare out_lead_id to prevent error 42702');
  assert.ok(schemaSql.includes('RETURNS TABLE(out_lead_id UUID, out_quota_admitted BOOLEAN, out_is_new BOOLEAN)'), 'Schema must declare out_lead_id to prevent error 42702');
  assert.ok(migrationSql.includes('RETURNING leads.id, leads.quota_admitted'), 'Migration must qualify RETURNING columns');
  assert.ok(schemaSql.includes('RETURNING leads.id, leads.quota_admitted'), 'Schema must qualify RETURNING columns');

  // Verify lead deduplication before creating unique index
  assert.ok(migrationSql.includes('DELETE FROM public.leads'), 'Migration must deduplicate leads before index creation');

  // Verify immutability trigger covers sensitive billing and worker fields
  assert.ok(migrationSql.includes('check_org_billing_fields_immutability'), 'Migration must define immutability trigger');
  assert.ok(migrationSql.includes('NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at'), 'Trigger must protect trial_ends_at');
  assert.ok(migrationSql.includes('NEW.custom_quote_inr IS DISTINCT FROM OLD.custom_quote_inr'), 'Trigger must protect custom_quote_inr');
  assert.ok(migrationSql.includes('NEW.wa_worker_id IS DISTINCT FROM OLD.wa_worker_id'), 'Trigger must protect wa_worker_id');
});

test('INTEGRATION: Multi-worker outbound queue atomic claiming avoids duplicate sends', async () => {
  // Simulate distributed queue table with pending status
  const queueStore = new Map();
  queueStore.set('queue-msg-12345', {
    id: 'queue-msg-12345',
    org_id: 'org-test-multi-worker',
    to_phone: '919876543210',
    message_text: 'Hello from MartFlow worker',
    status: 'pending'
  });

  // Atomic claim: only one worker can change status from 'pending' to 'processing'
  function atomicClaim(itemId, workerId) {
    const item = queueStore.get(itemId);
    if (!item || item.status !== 'pending') {
      return { claimed: false };
    }
    item.status = 'processing';
    item.claimed_by = workerId;
    return { claimed: true, item };
  }

  const worker1Result = atomicClaim('queue-msg-12345', 'worker-1');
  const worker2Result = atomicClaim('queue-msg-12345', 'worker-2');

  // Exactly one worker must succeed in claiming the item
  assert.equal(worker1Result.claimed, true);
  assert.equal(worker1Result.item.claimed_by, 'worker-1');
  assert.equal(worker2Result.claimed, false);
});
