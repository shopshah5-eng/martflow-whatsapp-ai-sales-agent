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
  console.log('Connecting to Supabase PostgreSQL at ' + hostPort[0] + '...');
  await client.connect();
  console.log('Connected! Executing migration...');

  try {
    // 1. Create catalogs storage bucket and RLS policies
    console.log('1. Ensuring public storage bucket "catalogs" exists...');
    await client.query(`
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES (
        'catalogs',
        'catalogs',
        true,
        26214400,
        ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
      )
      ON CONFLICT (id) DO UPDATE SET
        public = true,
        file_size_limit = 26214400;
    `);

    // Storage object policies
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Public Access Catalogs'
        ) THEN
          CREATE POLICY "Public Access Catalogs" ON storage.objects
          FOR SELECT USING (bucket_id = 'catalogs');
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Allow Uploads Catalogs'
        ) THEN
          CREATE POLICY "Allow Uploads Catalogs" ON storage.objects
          FOR INSERT WITH CHECK (bucket_id = 'catalogs');
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Allow Updates Catalogs'
        ) THEN
          CREATE POLICY "Allow Updates Catalogs" ON storage.objects
          FOR UPDATE USING (bucket_id = 'catalogs');
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Allow Deletes Catalogs'
        ) THEN
          CREATE POLICY "Allow Deletes Catalogs" ON storage.objects
          FOR DELETE USING (bucket_id = 'catalogs');
        END IF;
      END $$;
    `);

    // 2. Ensure public.products has all required columns
    console.log('2. Ensuring columns on public.products...');
    await client.query(`
      ALTER TABLE public.products
        ADD COLUMN IF NOT EXISTS category text,
        ADD COLUMN IF NOT EXISTS description text,
        ADD COLUMN IF NOT EXISTS model_specs text,
        ADD COLUMN IF NOT EXISTS image_url text,
        ADD COLUMN IF NOT EXISTS brochure_url text,
        ADD COLUMN IF NOT EXISTS brochure_filename text,
        ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
    `);

    // 3. Ensure public.call_requests table exists with RLS
    console.log('3. Ensuring public.call_requests table exists...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.call_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
        lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
        buyer_name text NOT NULL,
        buyer_phone text NOT NULL,
        preferred_time text,
        status text DEFAULT 'pending',
        notes text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );

      ALTER TABLE public.call_requests ENABLE ROW LEVEL SECURITY;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'call_requests' AND policyname = 'Allow all call_requests access'
        ) THEN
          CREATE POLICY "Allow all call_requests access" ON public.call_requests
          FOR ALL USING (true) WITH CHECK (true);
        END IF;
      END $$;
    `);

    // 4. Ensure public.organizations columns
    console.log('4. Ensuring columns on public.organizations...');
    await client.query(`
      ALTER TABLE public.organizations
        ADD COLUMN IF NOT EXISTS bot_whatsapp_number text,
        ADD COLUMN IF NOT EXISTS owner_alert_number text,
        ADD COLUMN IF NOT EXISTS auto_reply_enabled boolean DEFAULT true,
        ADD COLUMN IF NOT EXISTS auto_pdf_enabled boolean DEFAULT true,
        ADD COLUMN IF NOT EXISTS owner_alerts_enabled boolean DEFAULT true,
        ADD COLUMN IF NOT EXISTS welcome_message text DEFAULT 'Namaste! Welcome to our sales desk. How can we help you today?',
        ADD COLUMN IF NOT EXISTS business_type text DEFAULT 'Machinery',
        ADD COLUMN IF NOT EXISTS website_url text,
        ADD COLUMN IF NOT EXISTS website_knowledge text,
        ADD COLUMN IF NOT EXISTS website_synced_at timestamptz,
        ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
        ADD COLUMN IF NOT EXISTS is_unlimited boolean DEFAULT false;
    `);

    // 5. Ensure public.wa_outbound_queue table exists
    console.log('5. Ensuring public.wa_outbound_queue table exists...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.wa_outbound_queue (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
        to_phone text NOT NULL,
        message_text text NOT NULL,
        pdf_url text,
        status text DEFAULT 'queued',
        error text,
        created_at timestamptz DEFAULT now(),
        processed_at timestamptz
      );

      ALTER TABLE public.wa_outbound_queue ENABLE ROW LEVEL SECURITY;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'wa_outbound_queue' AND policyname = 'Allow all wa_outbound_queue access'
        ) THEN
          CREATE POLICY "Allow all wa_outbound_queue access" ON public.wa_outbound_queue
          FOR ALL USING (true) WITH CHECK (true);
        END IF;
      END $$;
    `);

    // 6. Reset any organizations rows with monthly_lead_limit >= 999999 back to trial
    console.log('6. Resetting free loophole organizations back to 48h trial (25 leads)...');
    const resetRes = await client.query(`
      UPDATE public.organizations
      SET
        plan_status = 'trial',
        monthly_lead_limit = 25,
        trial_ends_at = COALESCE(trial_ends_at, now() + interval '48 hours')
      WHERE monthly_lead_limit >= 999999 OR plan_status = 'active';
    `);
    console.log('Orgs reset count:', resetRes.rowCount);

    console.log('✅ ALL SUPABASE MIGRATIONS EXECUTED SUCCESSFULLY!');
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
