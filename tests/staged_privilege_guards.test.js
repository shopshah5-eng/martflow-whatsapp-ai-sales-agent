import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Synthetic PostgreSQL schema intentionally lacks optional organization columns.
// This is not a substitute for testing against the real Supabase schema.
test('staged restrictive guards survive permissive legacy policies and missing optional columns', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE SCHEMA storage;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$
        SELECT jsonb_build_object('role', current_user)
      $$;
      GRANT USAGE ON SCHEMA public, storage, auth TO anon, authenticated, service_role;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY, name text, website_knowledge text, webhook_key text);
      CREATE TABLE public.profiles(id uuid PRIMARY KEY, org_id uuid, role text, full_name text);
      CREATE TABLE public.products(id uuid PRIMARY KEY, org_id uuid);
      CREATE TABLE public.wa_outbound_queue(id uuid PRIMARY KEY, org_id uuid);
      CREATE TABLE storage.objects(id uuid PRIMARY KEY, bucket_id text);
      INSERT INTO public.organizations VALUES ('00000000-0000-4000-8000-000000000001','Test','Original','secret');
      INSERT INTO public.profiles VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','member','Original');
      ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.wa_outbound_queue ENABLE ROW LEVEL SECURITY;
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE POLICY legacy_org ON public.organizations FOR ALL TO authenticated USING(true) WITH CHECK(true);
      CREATE POLICY legacy_profile ON public.profiles FOR ALL TO authenticated USING(true) WITH CHECK(true);
      CREATE POLICY legacy_products ON public.products FOR ALL TO authenticated USING(true) WITH CHECK(true);
      CREATE POLICY legacy_queue ON public.wa_outbound_queue FOR ALL TO authenticated USING(true) WITH CHECK(true);
      CREATE POLICY legacy_storage ON storage.objects FOR ALL TO anon, authenticated USING(true) WITH CHECK(true);
      GRANT ALL ON public.organizations, public.profiles, public.products, public.wa_outbound_queue, storage.objects TO anon, authenticated, service_role;
    `);
    for (let i = 0; i < 2; i++) {
      for (const name of ['20261103_catalog_management.sql', '20261103_security_and_privacy_hardening.sql', '20261103_profile_privilege_guard.sql']) {
        await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      }
    }
    await db.exec('SET ROLE authenticated');
    await db.exec("UPDATE public.profiles SET full_name='Allowed'");
    await assert.rejects(db.exec("UPDATE public.profiles SET role='owner'"), /server managed/);
    await assert.rejects(db.exec("UPDATE public.profiles SET org_id=NULL"), /server managed/);
    await assert.rejects(db.exec("INSERT INTO public.profiles(id,role) VALUES ('00000000-0000-4000-8000-000000000003','owner')"), /row-level security/);
    await db.exec("DELETE FROM public.profiles"); // restrictive USING hides the row
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.profiles')).rows[0].count, 1);
    await assert.rejects(db.exec("INSERT INTO public.products(id) VALUES ('00000000-0000-4000-8000-000000000004')"), /row-level security/);
    await assert.rejects(db.exec("INSERT INTO public.wa_outbound_queue(id) VALUES ('00000000-0000-4000-8000-000000000005')"), /row-level security/);
    await assert.rejects(db.exec("INSERT INTO storage.objects VALUES ('00000000-0000-4000-8000-000000000006','catalogs')"), /row-level security/);
    await db.exec("UPDATE public.organizations SET name='Allowed'");
    await assert.rejects(db.exec("UPDATE public.organizations SET website_knowledge='Forged'"), /managed by the agency/);
    await assert.rejects(db.exec("UPDATE public.organizations SET webhook_key='Forged'"), /cannot be modified directly/);
    await db.exec('RESET ROLE; SET ROLE service_role');
    await db.exec("UPDATE public.profiles SET role='owner'; UPDATE public.organizations SET website_knowledge='Managed'; INSERT INTO public.products(id) VALUES ('00000000-0000-4000-8000-000000000004')");
  } finally { await db.close(); }
});
