const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
require('dotenv').config();

async function run() {
  const dbUrl = process.env.DATABASE_URL || '';
  let client;

  let host = 'aws-0-ap-south-1.pooler.supabase.com';
  let port = 6543;
  let database = 'postgres';
  let user = 'postgres.uriqhusalcdgdlgzgasp';
  let password = '';

  if (dbUrl.includes('@')) {
    client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  } else {
    const parts = dbUrl.split(':');
    if (parts.length >= 3) {
      user = parts[1].replace('//', '');
      password = parts.slice(2).join(':'); // in case password has colons
    }
    client = new Client({
      user,
      password,
      host,
      port,
      database,
      ssl: { rejectUnauthorized: false }
    });
  }

  await client.connect();
  console.log('Connected to Postgres.');

  // 1. Create table whatsapp_sessions if not exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.whatsapp_sessions (
      org_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
      session_data TEXT NOT NULL,
      connected_number TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE public.whatsapp_sessions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "whatsapp_sessions_allow_all" ON public.whatsapp_sessions;
    CREATE POLICY "whatsapp_sessions_allow_all" ON public.whatsapp_sessions FOR ALL USING (true);
  `);
  console.log('Table public.whatsapp_sessions created or verified.');

  // 2. Back up current active org session if it exists on disk
  const orgId = '6fd354d9-3437-412d-856e-28bc19d44268';
  const sessionDir = path.join(__dirname, '..', 'auth_info', orgId);

  if (fs.existsSync(sessionDir)) {
    const files = fs.readdirSync(sessionDir);
    const map = {};
    for (const f of files) {
      map[f] = fs.readFileSync(path.join(sessionDir, f), 'utf8');
    }
    const jsonStr = JSON.stringify(map);
    const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
    const b64 = compressed.toString('base64');

    let connectedNumber = '919115748457';
    if (map['creds.json']) {
      try {
        const creds = JSON.parse(map['creds.json']);
        if (creds.me && creds.me.id) {
          connectedNumber = creds.me.id.split(':')[0].split('@')[0];
        }
      } catch (e) {}
    }

    await client.query(`
      INSERT INTO public.whatsapp_sessions (org_id, session_data, connected_number, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (org_id) DO UPDATE SET
        session_data = EXCLUDED.session_data,
        connected_number = EXCLUDED.connected_number,
        updated_at = NOW()
    `, [orgId, b64, connectedNumber]);

    console.log(`Successfully backed up session for org ${orgId} (${files.length} files, ${b64.length} base64 bytes, number: ${connectedNumber})`);
  } else {
    console.log(`No local session found at ${sessionDir}`);
  }

  await client.end();
}

run().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
