import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('growth feature staged schema limits direct privileges and deduplicates by workspace and customer', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE public.organizations (id uuid primary key);
      CREATE TABLE public.profiles (id uuid primary key);
      CREATE TABLE public.leads (id uuid primary key);`);
    const sql=fs.readFileSync(new URL('../migrations/20261106_growth_features_STAGING.sql',import.meta.url),'utf8');
    await pg.exec(sql); await pg.exec(sql);
    const result=await pg.query(`SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('review_request_settings','review_request_queue','custom_website_integrations')`);
    assert.equal(result.rows.length,3);assert.ok(result.rows.every(r=>r.relrowsecurity));
    for (const table of ['review_request_settings','review_request_queue','custom_website_integrations']) {
      const q=await pg.query(`SELECT has_table_privilege('authenticated', 'public.${table}', 'SELECT') AS can_select,has_table_privilege('anon','public.${table}','INSERT') AS can_insert`);
      assert.equal(q.rows[0].can_select,false);assert.equal(q.rows[0].can_insert,false);
    }
    const org='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', user='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', lead='cccccccc-cccc-cccc-cccc-cccccccccccc';
    await pg.exec(`INSERT INTO organizations VALUES ('${org}'); INSERT INTO profiles VALUES ('${user}'); INSERT INTO leads VALUES ('${lead}');`);
    const insert=`INSERT INTO review_request_queue(org_id,lead_id,buyer_phone,status,confirmed_by,consent_confirmed_at) VALUES ('${org}','${lead}','919876543210','awaiting_delivery_setup','${user}',now())`;
    await pg.exec(insert);await assert.rejects(pg.exec(insert),/duplicate key/i);
    await assert.rejects(pg.exec(`UPDATE review_request_queue SET status='sent'`),/check constraint/i);
  } finally { await pg.close(); }
});
