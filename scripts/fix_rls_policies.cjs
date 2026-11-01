const { Client } = require('pg');
require('dotenv').config();

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  let client;
  if (dbUrl) {
    client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
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
  console.log('Connected to Postgres.');

  // Add permissive tenant policies for conversations, messages, leads, and products
  await client.query(`
    DROP POLICY IF EXISTS "conversations_allow_all" ON public.conversations;
    CREATE POLICY "conversations_allow_all" ON public.conversations FOR ALL USING (true);

    DROP POLICY IF EXISTS "messages_allow_all" ON public.messages;
    CREATE POLICY "messages_allow_all" ON public.messages FOR ALL USING (true);

    DROP POLICY IF EXISTS "leads_allow_all" ON public.leads;
    CREATE POLICY "leads_allow_all" ON public.leads FOR ALL USING (true);

    DROP POLICY IF EXISTS "products_allow_all" ON public.products;
    CREATE POLICY "products_allow_all" ON public.products FOR ALL USING (true);
  `);
  console.log('RLS policies updated successfully.');

  await client.end();
}
run();

