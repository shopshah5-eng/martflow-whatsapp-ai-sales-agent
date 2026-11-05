import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('staged catalogue admin SQL enforces grants, approval, quotas and revocation', async () => {
  const db = new PGlite();
  const admin = '00000000-0000-4000-8000-000000000001';
  const client1 = '00000000-0000-4000-8000-000000000011';
  const client2 = '00000000-0000-4000-8000-000000000012';
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.profiles (id uuid PRIMARY KEY);
      CREATE TABLE public.organizations (id uuid PRIMARY KEY);
      CREATE TABLE public.catalog_management_grants (org_id uuid NOT NULL REFERENCES public.organizations(id), user_id uuid NOT NULL REFERENCES public.profiles(id), granted_by text NOT NULL, PRIMARY KEY(org_id,user_id));
      INSERT INTO public.profiles VALUES ('${admin}');
      INSERT INTO public.organizations VALUES ('${client1}'), ('${client2}');`);
    await db.exec(await readFile(new URL('../migrations/20261105_catalog_admin_workflow_STAGING.sql', import.meta.url), 'utf8'));
    let q = await db.query("SELECT has_function_privilege('authenticated','public.catalog_admin_review(uuid,uuid,boolean,text)','EXECUTE') AS allowed, has_function_privilege('service_role','public.catalog_admin_review(uuid,uuid,boolean,text)','EXECUTE') AS service_allowed");
    assert.deepEqual(q.rows[0], { allowed: false, service_allowed: true });
    await db.exec(`SELECT public.catalog_admin_set('${admin}',1,true); SELECT public.catalog_admin_request('${admin}','${client1}','client1@example.test');`);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.catalog_management_grants')).rows[0].n, 0);
    await assert.rejects(db.exec(`SELECT public.catalog_admin_request('${admin}','${client2}','client2@example.test')`), /Client limit reached/);
    await db.exec(`SELECT public.catalog_admin_review('${admin}','${client1}',true,'platform');`);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.catalog_management_grants')).rows[0].n, 1);
    await assert.rejects(db.exec(`SELECT public.catalog_admin_review('${admin}','${client1}',true,'platform')`), /Pending request not found/);
    await db.exec(`SELECT public.catalog_admin_remove('${admin}','${client1}'); SELECT public.catalog_admin_request('${admin}','${client2}','client2@example.test'); SELECT public.catalog_admin_review('${admin}','${client2}',true,'platform'); SELECT public.catalog_admin_set('${admin}',1,false);`);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.catalog_management_grants')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.catalog_assignment_requests')).rows[0].n, 0);
  } finally { await db.close(); }
});
