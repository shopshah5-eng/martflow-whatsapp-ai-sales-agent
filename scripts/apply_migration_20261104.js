import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envText = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const lines = envText.split(/\r?\n/);
const dbLine = lines.find(l => l.startsWith('DATABASE_URL='));
if (!dbLine) {
  console.error('DATABASE_URL not found in .env');
  process.exit(1);
}

const rawUrl = dbLine.replace('DATABASE_URL=', '').trim();
const firstColon = rawUrl.indexOf(':', 11);
const atIdx = rawUrl.lastIndexOf('@');
const user = rawUrl.slice(rawUrl.indexOf('//') + 2, firstColon);
const password = rawUrl.slice(firstColon + 1, atIdx);
const rest = rawUrl.slice(atIdx + 1);
const slashIdx = rest.indexOf('/');
const hostPort = (slashIdx !== -1 ? rest.slice(0, slashIdx) : rest).split(':');
const database = slashIdx !== -1 ? rest.slice(slashIdx + 1) : 'postgres';

const client = new pg.Client({
  host: hostPort[0],
  port: parseInt(hostPort[1] || '6543', 10),
  database,
  user,
  password,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log(`Connecting to Supabase PostgreSQL at ${hostPort[0]}:${hostPort[1] || '6543'}...`);
  await client.connect();
  console.log('Connected successfully!');

  const sqlPath = path.join(__dirname, '../migrations/20261104_schema_reconciliation_and_hardening.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Executing migrations/20261104_schema_reconciliation_and_hardening.sql...');
  await client.query(sql);

  console.log('Migration executed successfully!');

  // Verify the new columns and functions exist
  const resCol = await client.query(`
    SELECT column_name, table_name 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'organizations' 
      AND column_name = 'wa_worker_id';
  `);
  console.log('Verification: organizations.wa_worker_id present =', resCol.rows.length > 0);

  const resFunc = await client.query(`
    SELECT routine_name 
    FROM information_schema.routines 
    WHERE routine_schema = 'public' 
      AND routine_name = 'reserve_and_create_lead';
  `);
  console.log('Verification: reserve_and_create_lead routine present =', resFunc.rows.length > 0);

  const resMem = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_name = 'conversation_memories';
  `);
  console.log('Verification: conversation_memories table present =', resMem.rows.length > 0);

  await client.end();
  console.log('Database connection closed.');
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
