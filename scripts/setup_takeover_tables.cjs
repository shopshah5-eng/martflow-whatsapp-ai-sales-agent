const pg = require('pg');
const fs = require('fs');
const path = require('path');

const envText = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const lines = envText.split(/\r?\n/);
const dbLine = lines.find(l => l.startsWith('DATABASE_URL='));
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

const sql = `
CREATE TABLE IF NOT EXISTS public.manual_takeovers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    buyer_phone TEXT NOT NULL,
    taken_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    taken_by TEXT DEFAULT 'owner',
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_takeover_org_phone UNIQUE (org_id, buyer_phone)
);

CREATE TABLE IF NOT EXISTS public.alert_dedup (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    buyer_phone TEXT NOT NULL,
    kind TEXT NOT NULL,
    last_sent_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_alert_org_phone_kind UNIQUE (org_id, buyer_phone, kind)
);

CREATE INDEX IF NOT EXISTS idx_manual_takeovers_lookup ON public.manual_takeovers(org_id, buyer_phone);
CREATE INDEX IF NOT EXISTS idx_alert_dedup_lookup ON public.alert_dedup(org_id, buyer_phone, kind);
`;

async function main() {
  try {
    await client.connect();
    await client.query(sql);
    console.log('✅ Tables manual_takeovers and alert_dedup successfully created in Supabase PostgreSQL!');
    await client.end();
  } catch (err) {
    console.error('Migration error:', err.message);
    process.exit(1);
  }
}

main();
