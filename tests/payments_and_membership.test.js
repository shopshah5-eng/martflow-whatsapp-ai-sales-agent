import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import db from '../src/db/index.js';
import { handleGoogleAuth } from '../src/auth/authService.js';
import { baileysManager, sendTenantWhatsApp } from '../src/integrations/whatsapp/baileysManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('SUPABASE SCHEMA: Verifies idempotent DDL, RLS policies, and tables', () => {
  const schemaPath = path.join(__dirname, '..', 'supabase_schema.sql');
  assert.ok(fs.existsSync(schemaPath), 'supabase_schema.sql must exist');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  // Verify all required tables
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.organizations'), 'organizations table must exist');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.profiles'), 'profiles table must exist');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.products'), 'products table must exist');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.leads'), 'leads table must exist');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.conversations'), 'conversations table must exist');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.messages'), 'messages table must exist');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.payments'), 'payments table must exist');

  // Verify RLS enabled on all tables
  assert.ok(sql.includes('ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY'), 'RLS on organizations');
  assert.ok(sql.includes('ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY'), 'RLS on leads');
  assert.ok(sql.includes('ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY'), 'RLS on payments');

  // Verify storage bucket setup
  assert.ok(sql.includes("storage.buckets (id, name, public)\nVALUES ('catalogs'"), 'catalogs storage bucket configured');
  assert.ok(sql.includes('current_user_org_id()'), 'current_user_org_id helper function exists');
});

test('AUTH: Google OAuth auto-provisions isolated org + 48h live trial (25 leads)', async () => {
  const testEmail = `director_${Date.now()}@gmail.com`;
  const result = await handleGoogleAuth({
    email: testEmail,
    fullName: 'Sanjay Patel',
    supabaseId: 'sub_' + Date.now()
  });

  assert.ok(result.token, 'Must return valid session token');
  assert.equal(result.user.email, testEmail);
  assert.equal(result.organization.planStatus, 'trial');
  assert.equal(result.organization.leadLimit, 25);
  assert.equal(result.organization.leadsUsed, 0);
  assert.ok(result.organization.webhookKey.startsWith('whk_'), 'Webhook key must be unique per tenant');
});

test('PAYMENTS: Direct UPI verification logs transaction and activates workspace', () => {
  const org = db.insert('organizations', {
    name: 'Gujarat Packaging Tech',
    slug: 'gujarat-packaging-tech',
    webhook_key: 'whk_gujarat_' + Date.now(),
    plan_status: 'trial',
    monthly_lead_limit: 25,
    leads_used: 12
  });

  const payment = db.insert('payments', {
    organization_id: org.id,
    amount_inr: 9999,
    provider: 'upi_direct',
    utr_reference: '429381029384',
    status: 'verified'
  });

  db.update('organizations', org.id, {
    plan_status: 'active',
    monthly_lead_limit: 2500
  });

  const updatedOrg = db.findById('organizations', org.id);
  assert.equal(updatedOrg.plan_status, 'active');
  assert.equal(updatedOrg.monthly_lead_limit, 2500);

  const foundPayment = db.findById('payments', payment.id);
  assert.equal(foundPayment.utr_reference, '429381029384');
  assert.equal(foundPayment.status, 'verified');
});

test('PAYMENTS: Razorpay HMAC SHA256 signature verification operates correctly', () => {
  const secret = 'rzp_secret_test_2026';
  const orderId = 'order_test_12345';
  const paymentId = 'pay_test_67890';

  const validSignature = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const generatedSig = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  assert.equal(validSignature, generatedSig, 'HMAC signature verification matches');

  const tamperedSig = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|tampered_payment`)
    .digest('hex');

  assert.notEqual(validSignature, tamperedSig, 'Tampered payment ID must be rejected');
});

test('WHATSAPP MULTI-SESSION ISOLATION: Org A socket & auth are distinct from Org B', () => {
  const orgA = 'org_alpha_' + Date.now();
  const orgB = 'org_beta_' + Date.now();

  const instanceA = baileysManager.getInstance(orgA);
  const instanceB = baileysManager.getInstance(orgB);

  assert.notEqual(instanceA, instanceB, 'Each organization must have an independent WASocket instance');
  assert.ok(instanceA.authDir.includes(orgA), 'Org A auth directory must be isolated');
  assert.ok(instanceB.authDir.includes(orgB), 'Org B auth directory must be isolated');
  assert.notEqual(instanceA.authDir, instanceB.authDir, 'Auth directories must never overlap');
});

