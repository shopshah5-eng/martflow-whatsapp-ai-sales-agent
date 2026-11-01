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
  const res = await client.query(`
    SELECT tablename, policyname, roles, cmd, qual 
    FROM pg_policies 
    WHERE schemaname = 'public';
  `);
  console.log('POLICIES COUNT:', res.rows.length);
  for (const r of res.rows) {
    console.log(`${r.tablename} -> ${r.policyname} (${r.cmd}): qual=${r.qual}`);
  }
  await client.end();
}
run();

