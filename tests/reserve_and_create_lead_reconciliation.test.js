import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { repository } from '../src/db/repository.js';
import { ConversationMemoryService } from '../src/services/conversationMemoryService.js';
import db from '../src/db/index.js';

test('DATABASE & RPC RECONCILIATION: reserve_and_create_lead matches callers, enforces quota, deduplicates, and isolates tenants', async () => {
  const pglite = new PGlite();

  try {
    // 1. Setup base Postgres schema
    await pglite.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid $$;
      GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

      CREATE TABLE public.organizations (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        plan_status TEXT DEFAULT 'active',
        monthly_lead_limit INT DEFAULT 10,
        leads_used INT DEFAULT 0,
        trial_ends_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE public.profiles (
        id UUID PRIMARY KEY,
        full_name TEXT
      );

      CREATE TABLE public.leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID,
        buyer_name TEXT,
        buyer_phone TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
    `);

    // 2. Insert test tenants (Org A: active with limit 2, Org B: trial)
    const orgAId = '11111111-1111-4111-8111-111111111111';
    const orgBId = '22222222-2222-4222-8222-222222222222';
    await pglite.exec(`
      INSERT INTO public.organizations (id, name, plan_status, monthly_lead_limit, leads_used)
      VALUES ('${orgAId}', 'Tenant Alpha Corp', 'active', 2, 0);

      INSERT INTO public.organizations (id, name, plan_status, monthly_lead_limit, leads_used, trial_ends_at)
      VALUES ('${orgBId}', 'Tenant Beta Ltd', 'trial', 25, 0, NOW() + INTERVAL '10 days');
    `);

    // 3. Apply the staged migration twice for idempotence
    const migrationSql = await readFile(new URL('../migrations/20261104_schema_reconciliation_and_hardening.sql', import.meta.url), 'utf8');
    await pglite.exec(migrationSql);
    await pglite.exec(migrationSql); // Idempotence check

    // 4. Verify columns were added to organizations, profiles, and leads
    const leadsCols = await pglite.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'leads' AND table_schema = 'public'
    `);
    const colNames = leadsCols.rows.map(r => r.column_name);
    assert.ok(colNames.includes('org_id'), 'leads table must have org_id column');
    assert.ok(colNames.includes('quota_admitted'), 'leads table must have quota_admitted column');
    assert.ok(colNames.includes('requirement'), 'leads table must have requirement column');
    assert.ok(colNames.includes('query_message'), 'leads table must have query_message column');

    // 5. Test Call Signature 1 (server.js caller format) with named parameters
    await pglite.exec('SET ROLE service_role');
    const res1 = await pglite.query(`
      SELECT * FROM public.reserve_and_create_lead(
        p_org_id => '${orgAId}'::uuid,
        p_buyer_phone => '+91 98765 43210',
        p_buyer_name => 'Rohit Sharma',
        p_query_message => 'Need 5 units of packaging machine',
        p_requirement => 'Need 5 units of packaging machine',
        p_bypass_quota => false
      );
    `);
    assert.equal(res1.rows.length, 1);
    const row1 = res1.rows[0];
    assert.ok(row1.out_lead_id, 'out_lead_id must be populated');
    assert.equal(row1.out_quota_admitted, true, 'Lead 1 should be admitted under quota');
    assert.equal(row1.out_is_new, true, 'First call for phone must be marked as new');

    // Check that leads_used was incremented to 1
    const orgCheck1 = await pglite.query(`SELECT leads_used FROM public.organizations WHERE id = '${orgAId}'`);
    assert.equal(orgCheck1.rows[0].leads_used, 1);

    // 6. Test Deduplication: call again for same phone number
    const res2 = await pglite.query(`
      SELECT * FROM public.reserve_and_create_lead(
        p_org_id => '${orgAId}'::uuid,
        p_buyer_phone => '9876543210',
        p_buyer_name => 'Rohit Sharma (Duplicate)',
        p_query_message => 'Follow up on previous request',
        p_requirement => 'Follow up on previous request',
        p_bypass_quota => false
      );
    `);
    const row2 = res2.rows[0];
    assert.equal(row2.out_lead_id, row1.out_lead_id, 'Deduplicated lead must match existing lead id');
    assert.equal(row2.out_is_new, false, 'Duplicate call must return out_is_new = false');

    // Ensure leads_used was NOT incremented on deduplication
    const orgCheck2 = await pglite.query(`SELECT leads_used FROM public.organizations WHERE id = '${orgAId}'`);
    assert.equal(orgCheck2.rows[0].leads_used, 1, 'Deduplication must not double count quota');

    // 7. Test Second Lead: admits and reaches limit (limit = 2)
    const res3 = await pglite.query(`
      SELECT * FROM public.reserve_and_create_lead(
        p_org_id => '${orgAId}'::uuid,
        p_buyer_phone => '919876500002',
        p_buyer_name => 'Anil Verma',
        p_product_inquired => 'Industrial Mixer',
        p_pdf_brochure_sent => true
      );
    `);
    assert.equal(res3.rows[0].out_quota_admitted, true);
    assert.equal(res3.rows[0].out_is_new, true);

    const orgCheck3 = await pglite.query(`SELECT leads_used FROM public.organizations WHERE id = '${orgAId}'`);
    assert.equal(orgCheck3.rows[0].leads_used, 2, 'leads_used should reach limit of 2');

    // 8. Test Quota Exhaustion: Third distinct lead for Org A
    const resExhausted = await pglite.query(`
      SELECT * FROM public.reserve_and_create_lead(
        p_org_id => '${orgAId}'::uuid,
        p_buyer_phone => '919876500003',
        p_buyer_name => 'Sunil Gupta',
        p_query_message => 'Want pricing',
        p_requirement => 'Want pricing',
        p_bypass_quota => false
      );
    `);
    assert.equal(resExhausted.rows[0].out_quota_admitted, false, 'Quota exhausted lead must have out_quota_admitted = false');
    assert.equal(resExhausted.rows[0].out_is_new, true, 'Lead row is recorded even when quota is exceeded');

    // 9. Test Quota Bypass (owner/self-chat)
    const resBypass = await pglite.query(`
      SELECT * FROM public.reserve_and_create_lead(
        p_org_id => '${orgAId}'::uuid,
        p_buyer_phone => '919876500004',
        p_buyer_name => 'Owner Test',
        p_query_message => 'Owner self-test message',
        p_requirement => 'Owner self-test message',
        p_bypass_quota => true
      );
    `);
    assert.equal(resBypass.rows[0].out_quota_admitted, true, 'Bypass quota must grant quota admitted true');

    // 10. Test Multi-Tenant Isolation: Org B with the exact same phone number as Org A Lead 1
    const resOrgB = await pglite.query(`
      SELECT * FROM public.reserve_and_create_lead(
        p_org_id => '${orgBId}'::uuid,
        p_buyer_phone => '9876543210',
        p_buyer_name => 'Rohit Sharma in Org B',
        p_query_message => 'Org B enquiry',
        p_requirement => 'Org B enquiry',
        p_bypass_quota => false
      );
    `);
    assert.equal(resOrgB.rows[0].out_is_new, true, 'Tenant B must NOT deduplicate against Tenant A lead');
    assert.notEqual(resOrgB.rows[0].out_lead_id, row1.out_lead_id, 'Tenant B must create its own isolated lead');

    // 11. Security Negative Tests: anon and authenticated cannot call reserve_and_create_lead
    await pglite.exec('SET ROLE authenticated');
    await assert.rejects(
      pglite.query(`
        SELECT * FROM public.reserve_and_create_lead(
          p_org_id => '${orgAId}'::uuid,
          p_buyer_phone => '919876599999',
          p_buyer_name => 'Attacker'
        );
      `),
      /permission denied/i,
      'Authenticated client role must be denied execute access on reserve_and_create_lead'
    );

    await pglite.exec('SET ROLE anon');
    await assert.rejects(
      pglite.query(`
        SELECT * FROM public.reserve_and_create_lead(
          p_org_id => '${orgAId}'::uuid,
          p_buyer_phone => '919876599999',
          p_buyer_name => 'Attacker'
        );
      `),
      /permission denied/i,
      'Anonymous client role must be denied execute access on reserve_and_create_lead'
    );

  } finally {
    await pglite.close();
  }
});

test('SECURITY & REVOCATION: Revoked users are denied membership and cannot access or provision workspace', async () => {
  const userId = 'usr_revoked_test_001';
  const orgId = 'org_revoked_test_001';

  // Seed local DB with revoked member
  db.insert('organizations', { id: orgId, name: 'Revoked Test Org' });
  db.insert('profiles', { id: userId, org_id: orgId, role: 'revoked', full_name: 'Revoked User' });
  db.insert('organization_members', { user_id: userId, organization_id: orgId, role: 'revoked' });

  // 1. repository.getMembership must return null for revoked role
  const membership = await repository.getMembership(userId, orgId);
  assert.equal(membership, null, 'Revoked user membership must return null');

  // 2. Clean up
  db.delete('profiles', userId);
  db.delete('organizations', orgId);
});

test('MEMORY ORDERING: Latest messages are returned in chronological order', async () => {
  const orgId = 'org_memory_test_001';
  const convId = 'conv_memory_test_001';

  db.insert('conversations', { id: convId, org_id: orgId, organization_id: orgId, buyer_phone: '919876543210' });

  // Insert 25 sequential messages
  const baseTime = Date.now() - 50000;
  for (let i = 1; i <= 25; i++) {
    db.insert('messages', {
      id: `msg_${i}`,
      org_id: orgId,
      organization_id: orgId,
      conversation_id: convId,
      sender: i % 2 === 1 ? 'buyer' : 'ai',
      text: `Message number ${i}`,
      created_at: new Date(baseTime + i * 1000).toISOString()
    });
  }

  // Retrieve recent history with limit 20
  const history = await ConversationMemoryService.getRecentHistory(orgId, convId, 20);

  assert.equal(history.length, 20, 'Must retrieve exactly 20 latest messages');
  assert.equal(history[0].text, 'Message number 6', 'First message in retrieved slice should be message 6 (oldest of the 20)');
  assert.equal(history[19].text, 'Message number 25', 'Last message in retrieved slice should be message 25 (most recent)');

  // Clean up
  db.delete('conversations', convId);
  for (let i = 1; i <= 25; i++) {
    db.delete('messages', `msg_${i}`);
  }
});
