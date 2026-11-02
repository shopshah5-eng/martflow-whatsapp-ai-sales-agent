const { Client } = require('pg');
require('dotenv').config();

async function run() {
  let client;
  if (process.env.DATABASE_URL) {
    client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  } else {
    client = new Client({
      user: process.env.SUPABASE_DB_USER || 'postgres.uriqhusalcdgdlgzgasp',
      password: process.env.SUPABASE_DB_PASSWORD,
      host: process.env.SUPABASE_DB_HOST || 'aws-0-ap-south-1.pooler.supabase.com',
      port: Number(process.env.SUPABASE_DB_PORT) || 6543,
      database: 'postgres',
      ssl: { rejectUnauthorized: false }
    });
  }

  await client.connect();
  console.log('Connected to Supabase PostgreSQL.');

  const sql = `
-- 1. Track creator so new signups can create & view their own org safely
alter table public.organizations
  add column if not exists created_by uuid default auth.uid();

-- 2. Helper returning ONLY the logged-in user's own org_id(s)
create or replace function public.my_org_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select org_id from public.profiles where id = auth.uid() and org_id is not null
  union
  select id from public.organizations where created_by = auth.uid();
$$;

-- 3. Drop ALL old open/public policies and enable strict RLS on every table
do $$
declare
  t text;
  pol record;
begin
  foreach t in array array['organizations','profiles','products','leads','conversations','messages','call_requests','wa_outbound_queue','payments']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
        execute format('drop policy if exists %I on public.%I', pol.policyname, t);
      end loop;
    end if;
  end loop;
end $$;

-- 4. Strict Owner-Only Policies (0 public/anon access — blocks all leaks!)
create policy "profiles_self_only" on public.profiles
  for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "orgs_select_own" on public.organizations
  for select to authenticated using (id in (select public.my_org_ids()));

create policy "orgs_insert_auth" on public.organizations
  for insert to authenticated with check (true);

create policy "orgs_update_own" on public.organizations
  for update to authenticated using (id in (select public.my_org_ids())) with check (id in (select public.my_org_ids()));

do $$
declare
  t text;
begin
  foreach t in array array['products','leads','conversations','messages','call_requests','wa_outbound_queue','payments']
  loop
    if to_regclass('public.' || t) is not null then
      execute format(
        'create policy %I on public.%I for all to authenticated using (org_id in (select public.my_org_ids())) with check (org_id in (select public.my_org_ids()))',
        t || '_tenant_isolation', t
      );
    end if;
  end loop;
end $$;

-- 5. Clean remaining live org phone, hide old packing machines & attach PDF to ₹999/Plan SKUs
update public.organizations
set name = 'MartFlow AI',
    company_city = 'Pan-India',
    owner_alert_number = '919781018975'
where id = '6fd354d9-3437-412d-856e-28bc19d44268';

update public.products
set is_active = false
where org_id = '6fd354d9-3437-412d-856e-28bc19d44268'
  and sku in ('IN-701C', 'IN-701D');

update public.products
set brochure_url = sub.url,
    brochure_filename = 'MartFlow_Real_Multi_Industry_Catalog.pdf'
from (
  select brochure_url as url from public.products
  where org_id = '6fd354d9-3437-412d-856e-28bc19d44268' and brochure_url is not null
  limit 1
) sub
where org_id = '6fd354d9-3437-412d-856e-28bc19d44268'
  and sku in ('MF-801', 'MF-801A', 'MF-801B', 'MF-801C', 'MF-801D');
  `;

  await client.query(sql);
  console.log('✅ Supabase Privacy Lock & RLS Policies successfully executed!');
  await client.end();
}

run().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
