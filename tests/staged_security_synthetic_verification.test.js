import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { signUp, login, verifySessionToken } from '../src/auth/authService.js';
import db from '../src/db/index.js';

test('SYNTHETIC VERIFICATION: Staging security hardening migration, RLS policies, and triggers', async () => {
  const pglite = new PGlite();
  try {
    // 1. Setup mock PostgreSQL environment with Supabase auth and storage schemas
    await pglite.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE SCHEMA IF NOT EXISTS storage;

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
        SELECT '00000000-0000-4000-8000-000000000002'::uuid;
      $$;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$
        SELECT jsonb_build_object('role', current_user, 'sub', '00000000-0000-4000-8000-000000000002');
      $$;

      GRANT USAGE ON SCHEMA public, storage, auth TO anon, authenticated, service_role;

      CREATE TABLE public.organizations (
        id uuid PRIMARY KEY,
        name text,
        webhook_key text,
        waba_token text,
        waba_phone_id text,
        wa_command text,
        wa_command_payload text
      );

      CREATE TABLE public.profiles (
        id uuid PRIMARY KEY,
        org_id uuid,
        organization_id uuid,
        role text,
        full_name text,
        email text
      );

      CREATE TABLE public.products (
        id uuid PRIMARY KEY,
        org_id uuid,
        name text,
        price_raw text
      );

      CREATE TABLE public.conversations (
        id uuid PRIMARY KEY,
        org_id uuid,
        customer_phone text
      );

      CREATE TABLE public.messages (
        id uuid PRIMARY KEY,
        conversation_id uuid,
        text text
      );

      CREATE TABLE public.leads (
        id uuid PRIMARY KEY,
        org_id uuid,
        organization_id uuid,
        customer_name text
      );

      CREATE TABLE storage.objects (
        id uuid PRIMARY KEY,
        bucket_id text,
        name text
      );

      -- Base synthetic data
      INSERT INTO public.organizations VALUES
        ('00000000-0000-4000-8000-000000000001', 'Tenant A Org', 'key_a', 'token_a', 'phone_a', NULL, NULL),
        ('00000000-0000-4000-8000-000000000009', 'Tenant B Org', 'key_b', 'token_b', 'phone_b', NULL, NULL);

      INSERT INTO public.profiles VALUES
        ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'owner', 'Tenant A User', 'a@test.com'),
        ('00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000009', 'owner', 'Tenant B User', 'b@test.com');

      INSERT INTO public.products VALUES
        ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000001', 'Existing Product A', '100');

      INSERT INTO public.conversations VALUES
        ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', '+919876543210');

      INSERT INTO public.messages VALUES
        ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000011', 'Confidential chat inquiry');

      INSERT INTO public.leads VALUES
        ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Confidential Lead A');

      ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

      -- Base permissive policies (simulating Supabase defaults before hardening)
      CREATE POLICY base_org ON public.organizations FOR ALL TO authenticated USING(true) WITH CHECK(true);
      CREATE POLICY base_profile ON public.profiles FOR ALL TO authenticated USING(true) WITH CHECK(true);
      CREATE POLICY base_products ON public.products FOR ALL TO authenticated USING(true) WITH CHECK(true);
      CREATE POLICY base_conv ON public.conversations FOR ALL TO authenticated USING(true) WITH CHECK(true);
      CREATE POLICY base_msg ON public.messages FOR ALL TO authenticated USING(true) WITH CHECK(true);
      CREATE POLICY base_leads ON public.leads FOR ALL TO authenticated USING(true) WITH CHECK(true);
      CREATE POLICY base_storage ON storage.objects FOR ALL TO anon, authenticated USING(true) WITH CHECK(true);

      GRANT ALL ON ALL TABLES IN SCHEMA public, storage TO anon, authenticated, service_role;
    `);

    // 2. Apply the staging migration (test idempotency by running twice as postgres/migration owner)
    const migrationSql = await readFile(new URL('../migrations/20261105_staging_security_hardening.sql', import.meta.url), 'utf8');
    await pglite.exec(migrationSql);
    await pglite.exec(migrationSql); // must succeed without duplicate policy/trigger errors

    // 3. Test as authenticated Tenant A user
    await pglite.exec('SET ROLE authenticated');

    // 3a. Profile privilege guard verification
    await pglite.exec("UPDATE public.profiles SET full_name = 'Updated Name' WHERE id = '00000000-0000-4000-8000-000000000002'");
    await assert.rejects(
      pglite.exec("UPDATE public.profiles SET role = 'superadmin' WHERE id = '00000000-0000-4000-8000-000000000002'"),
      /server managed/,
      'Privilege escalation to superadmin must be rejected'
    );
    await assert.rejects(
      pglite.exec("UPDATE public.profiles SET org_id = '00000000-0000-4000-8000-000000000009' WHERE id = '00000000-0000-4000-8000-000000000002'"),
      /server managed/,
      'Tenant jumping must be rejected'
    );

    // 3b. Product mutation guard: client cannot directly INSERT, UPDATE, or DELETE products
    await assert.rejects(
      pglite.exec("INSERT INTO public.products VALUES ('00000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000001', 'Direct Product', '100')"),
      /row-level security/,
      'Direct client product insertion must be denied by restrictive policy'
    );
    
    // UPDATE is blocked by USING (false) which causes 0 rows affected
    await pglite.exec("UPDATE public.products SET price_raw = '999' WHERE id = '00000000-0000-4000-8000-000000000041'");
    // Verify product price remained untouched
    await pglite.exec('RESET ROLE; SET ROLE service_role');
    const prodRes = await pglite.query("SELECT price_raw FROM public.products WHERE id = '00000000-0000-4000-8000-000000000041'");
    assert.equal(prodRes.rows[0].price_raw, '100', 'Direct client product update must NOT modify product records');

    await pglite.exec('RESET ROLE; SET ROLE authenticated');

    // 3c. Storage guard: direct mutation in 'catalogs' bucket is denied
    await assert.rejects(
      pglite.exec("INSERT INTO storage.objects VALUES ('00000000-0000-4000-8000-000000000051', 'catalogs', 'exploit.pdf')"),
      /row-level security/,
      'Direct client catalog storage insertion must be denied'
    );
    // Other buckets remain accessible
    await pglite.exec("INSERT INTO storage.objects VALUES ('00000000-0000-4000-8000-000000000052', 'user-avatars', 'avatar.png')");

    // 3d. Sensitive organization credentials protection
    await assert.rejects(
      pglite.exec("UPDATE public.organizations SET webhook_key = 'hacked' WHERE id = '00000000-0000-4000-8000-000000000001'"),
      /Sensitive organization credentials/,
      'Tampering with webhook_key must be blocked'
    );
    await assert.rejects(
      pglite.exec("UPDATE public.organizations SET wa_command = 'restart' WHERE id = '00000000-0000-4000-8000-000000000001'"),
      /Sensitive organization credentials/,
      'Tampering with wa_command must be blocked'
    );

    // 4. Test Catalogue Manager Inbox Privacy Isolation
    // Switch to service_role to insert a catalog_management_grant for user 0002 on Tenant A
    await pglite.exec('RESET ROLE; SET ROLE service_role');
    await pglite.exec(`
      INSERT INTO public.catalog_management_grants (org_id, user_id, granted_by)
      VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'admin');
    `);

    // Now switch back to authenticated user 0002 (who now holds a catalogue grant)
    await pglite.exec('RESET ROLE; SET ROLE authenticated');
    const convResult = await pglite.query('SELECT count(*)::int AS count FROM public.conversations');
    assert.equal(convResult.rows[0].count, 0, 'User with catalog grant must NOT be able to view client conversations');

    const msgResult = await pglite.query('SELECT count(*)::int AS count FROM public.messages');
    assert.equal(msgResult.rows[0].count, 0, 'User with catalog grant must NOT be able to view client messages');

    const leadResult = await pglite.query('SELECT count(*)::int AS count FROM public.leads');
    assert.equal(leadResult.rows[0].count, 0, 'User with catalog grant must NOT be able to view client leads');

    // 5. Test Rollback Script as migration owner (RESET ROLE)
    await pglite.exec('RESET ROLE');
    const rollbackSql = await readFile(new URL('../migrations/20261105_staging_security_hardening_rollback.sql', import.meta.url), 'utf8');
    await pglite.exec(rollbackSql);

    // Verify triggers and restrictive policies were removed
    await pglite.exec('SET ROLE authenticated');
    // Without the restrictive storage policy, insert into catalogs succeeds under base policy
    await pglite.exec("INSERT INTO storage.objects VALUES ('00000000-0000-4000-8000-000000000053', 'catalogs', 'rollback_test.pdf')");
  } finally {
    await pglite.close();
  }
});

test('SYNTHETIC VERIFICATION: Auth Service signup, login, and session token verification', async () => {
  const email = `synth_${Date.now()}@martflow-demo.test`;
  const signupResult = await signUp({
    email,
    password: 'SecurePassword123!',
    fullName: 'Synthetic Agent Test',
    companyName: 'Synthetic Corp',
    phone: '9876543210'
  });

  assert.ok(signupResult.token, 'Signup should issue valid token');
  assert.ok(signupResult.organization?.id, 'Signup should create workspace');
  assert.ok(signupResult.user?.id, 'Signup should create user profile');

  // Verify token validation
  const session = verifySessionToken(signupResult.token);
  assert.equal(session.userId, signupResult.user.id);
  assert.equal(session.organizationId, signupResult.organization.id);
  assert.equal(session.role, 'owner');

  // Test synthetic user login
  const loginResult = await login({ email, password: 'SecurePassword123!' });
  assert.ok(loginResult.token, 'Login should succeed with correct credentials');
  assert.equal(loginResult.user.email, email);

  // Verify wrong password rejection
  await assert.rejects(
    login({ email, password: 'WrongPassword123!' }),
    /Invalid email or password/
  );
});
