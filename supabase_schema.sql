-- ==============================================================================
-- MartFlow AI — Production Multi-Tenant Supabase Schema & Row-Level Security (RLS)
-- Enables strict zero-overlap tenant isolation, Google Auth, per-tenant WhatsApp,
-- product catalogs, B2B leads, and dual payment transactions.
-- ==============================================================================

-- 1. Enable necessary cryptographic and UUID extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Organizations Table (Tenants)
CREATE TABLE IF NOT EXISTS public.organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    webhook_key TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
    plan_status TEXT NOT NULL DEFAULT 'active' CHECK (plan_status IN ('trial', 'active', 'expired')),
    trial_ends_at TIMESTAMPTZ DEFAULT NULL,
    monthly_lead_limit INT DEFAULT 999999,
    leads_used INT DEFAULT 0,
    custom_quote_inr INT DEFAULT NULL,
    company_city TEXT DEFAULT 'Ahmedabad, Gujarat',
    escalation_phone TEXT DEFAULT NULL,
    bot_whatsapp_number TEXT DEFAULT NULL,
    owner_alert_number TEXT DEFAULT NULL,
    wa_mode TEXT DEFAULT 'qr' CHECK (wa_mode IN ('qr', 'cloud_api')),
    wa_pairing_method TEXT DEFAULT 'qr',
    wa_command TEXT DEFAULT NULL,
    wa_command_payload JSONB DEFAULT NULL,
    wa_status TEXT DEFAULT 'disconnected',
    wa_connected_number TEXT DEFAULT NULL,
    wa_qr_data_url TEXT DEFAULT NULL,
    wa_pairing_code TEXT DEFAULT NULL,
    wa_worker_heartbeat TIMESTAMPTZ DEFAULT NULL,
    wa_auto_reply BOOLEAN DEFAULT true,
    wa_auto_pdf BOOLEAN DEFAULT true,
    wa_owner_alerts BOOLEAN DEFAULT true,
    wa_welcome_message TEXT DEFAULT NULL,
    business_type TEXT DEFAULT 'auto',
    catalog_pdf_name TEXT DEFAULT NULL,
    website_url TEXT DEFAULT NULL,
    website_knowledge TEXT DEFAULT NULL,
    website_synced_at TIMESTAMPTZ DEFAULT NULL,
    waba_phone_id TEXT DEFAULT NULL,
    waba_token TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. User Profiles (Linked to Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    full_name TEXT,
    email TEXT,
    phone TEXT,
    role TEXT DEFAULT 'owner' CHECK (role IN ('owner', 'member', 'superadmin')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Products & Catalogs Table
CREATE TABLE IF NOT EXISTS public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    sku TEXT,
    name TEXT NOT NULL,
    category TEXT,
    description TEXT,
    price_raw TEXT,
    brochure_url TEXT,
    brochure_filename TEXT,
    image_url TEXT,
    model_specs TEXT,
    specs JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 5. B2B & WhatsApp Leads Table
CREATE TABLE IF NOT EXISTS public.leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    buyer_name TEXT,
    buyer_phone TEXT NOT NULL,
    buyer_city TEXT,
    product_inquired TEXT,
    query_message TEXT,
    requirement TEXT,
    status TEXT DEFAULT 'new',
    pdf_brochure_sent BOOLEAN DEFAULT false,
    response_ms INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 6. WhatsApp Conversation Threads
CREATE TABLE IF NOT EXISTS public.conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES public.leads(id) ON DELETE SET NULL,
    buyer_phone TEXT NOT NULL,
    mode TEXT DEFAULT 'auto' CHECK (mode IN ('auto', 'human', 'manual')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 7. Chat Messages
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('buyer', 'ai', 'agent')),
    text TEXT NOT NULL,
    media_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. Payments & Billing Transactions
CREATE TABLE IF NOT EXISTS public.payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    amount_inr INT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('upi_direct', 'razorpay')),
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    utr_reference TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'pending_verification', 'verified', 'failed')),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 9. Call Requests (2-Way Call Booking Engine)
CREATE TABLE IF NOT EXISTS public.call_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES public.leads(id) ON DELETE SET NULL,
    buyer_name TEXT,
    buyer_phone TEXT,
    product_interest TEXT,
    requested_by TEXT DEFAULT 'buyer',
    owner_phone TEXT,
    status TEXT DEFAULT 'requested' CHECK (status IN ('requested', 'awaiting_owner', 'proposed', 'confirmed', 'completed', 'cancelled', 'reschedule_requested')),
    proposed_time_raw TEXT,
    confirmed_time TIMESTAMPTZ,
    confirmed_by TEXT,
    lead_dossier_sent BOOLEAN DEFAULT false,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 10. WhatsApp Outbound Queue (Realtime Message & Brochure Dispatch)
CREATE TABLE IF NOT EXISTS public.wa_outbound_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    to_phone TEXT NOT NULL,
    message_text TEXT,
    pdf_url TEXT,
    pdf_name TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
    error_text TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 11. Indexes for Multi-Tenant Query Speed
CREATE INDEX IF NOT EXISTS idx_profiles_org_id ON public.profiles(org_id);
CREATE INDEX IF NOT EXISTS idx_products_org_id ON public.products(org_id);
CREATE INDEX IF NOT EXISTS idx_leads_org_id ON public.leads(org_id);
CREATE INDEX IF NOT EXISTS idx_conversations_org_id ON public.conversations(org_id);
CREATE INDEX IF NOT EXISTS idx_messages_org_id ON public.messages(org_id);
CREATE INDEX IF NOT EXISTS idx_payments_org_id ON public.payments(org_id);
CREATE INDEX IF NOT EXISTS idx_call_requests_org_id ON public.call_requests(org_id);
CREATE INDEX IF NOT EXISTS idx_wa_outbound_org ON public.wa_outbound_queue(org_id);
CREATE INDEX IF NOT EXISTS idx_wa_outbound_status ON public.wa_outbound_queue(status);
CREATE INDEX IF NOT EXISTS idx_orgs_webhook_key ON public.organizations(webhook_key);

-- 11. Helper Function to Get Current User's Tenant Org ID
CREATE OR REPLACE FUNCTION public.current_user_org_id()
RETURNS UUID AS $$
    SELECT org_id FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 12. Enable Row-Level Security (RLS) on ALL Multi-Tenant Tables
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_requests ENABLE ROW LEVEL SECURITY;

-- 13. RLS Policies: STRICT ZERO-OVERLAP TENANT ISOLATION

-- Organizations Policy: Users can only select/update their own organization
DROP POLICY IF EXISTS org_isolation_select ON public.organizations;
CREATE POLICY org_isolation_select ON public.organizations
    FOR SELECT USING (id = public.current_user_org_id());

DROP POLICY IF EXISTS org_isolation_update ON public.organizations;
CREATE POLICY org_isolation_update ON public.organizations
    FOR UPDATE USING (id = public.current_user_org_id());

-- Prevent privilege escalation / self-upgrading of plan and quotas by tenants
CREATE OR REPLACE FUNCTION public.check_org_billing_fields_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF (auth.jwt() ->> 'role') = 'authenticated' THEN
        IF NEW.plan_status IS DISTINCT FROM OLD.plan_status OR
           NEW.monthly_lead_limit IS DISTINCT FROM OLD.monthly_lead_limit OR
           NEW.leads_used IS DISTINCT FROM OLD.leads_used THEN
            RAISE EXCEPTION 'Unauthorized: Plan status and lead quotas can only be updated via verified billing reconciliation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_org_billing_immutability ON public.organizations;
CREATE TRIGGER trg_org_billing_immutability
    BEFORE UPDATE ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION public.check_org_billing_fields_immutability();

DROP POLICY IF EXISTS org_isolation_insert ON public.organizations;
CREATE POLICY org_isolation_insert ON public.organizations
    FOR INSERT WITH CHECK (true);

-- Profiles Policies: Users see profiles in their own tenant, update own record, no direct deletion
DROP POLICY IF EXISTS profile_isolation ON public.profiles;
DROP POLICY IF EXISTS profile_select_isolation ON public.profiles;
CREATE POLICY profile_select_isolation ON public.profiles
    FOR SELECT USING (org_id = public.current_user_org_id() OR id = auth.uid());

DROP POLICY IF EXISTS profile_update_isolation ON public.profiles;
CREATE POLICY profile_update_isolation ON public.profiles
    FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS profile_insert_own ON public.profiles;
CREATE POLICY profile_insert_own ON public.profiles
    FOR INSERT WITH CHECK (id = auth.uid());

-- Prevent self-elevation of role or tenant switching in profiles on INSERT and UPDATE
CREATE OR REPLACE FUNCTION public.check_profile_role_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF (auth.jwt() ->> 'role') = 'authenticated' THEN
        IF TG_OP = 'UPDATE' THEN
            IF NEW.role IS DISTINCT FROM OLD.role OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
                RAISE EXCEPTION 'Unauthorized: User role and tenant organization cannot be altered directly';
            END IF;
        ELSIF TG_OP = 'INSERT' THEN
            IF NEW.role NOT IN ('member', 'agent') AND NEW.role IS NOT NULL THEN
                NEW.role := 'member';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_profile_immutability ON public.profiles;
CREATE TRIGGER trg_profile_immutability
    BEFORE INSERT OR UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.check_profile_role_immutability();

-- Products Policy: Tenant-scoped access only
DROP POLICY IF EXISTS products_isolation ON public.products;
CREATE POLICY products_isolation ON public.products
    FOR ALL USING (org_id = public.current_user_org_id())
    WITH CHECK (org_id = public.current_user_org_id());

-- Leads Policy: Tenant-scoped access only
DROP POLICY IF EXISTS leads_isolation ON public.leads;
CREATE POLICY leads_isolation ON public.leads
    FOR ALL USING (org_id = public.current_user_org_id())
    WITH CHECK (org_id = public.current_user_org_id());

-- Conversations Policy: Tenant-scoped access only
DROP POLICY IF EXISTS conversations_isolation ON public.conversations;
CREATE POLICY conversations_isolation ON public.conversations
    FOR ALL USING (org_id = public.current_user_org_id())
    WITH CHECK (org_id = public.current_user_org_id());

-- Messages Policy: Tenant-scoped access only
DROP POLICY IF EXISTS messages_isolation ON public.messages;
CREATE POLICY messages_isolation ON public.messages
    FOR ALL USING (org_id = public.current_user_org_id())
    WITH CHECK (org_id = public.current_user_org_id());

-- Payments Policy: Tenant-scoped access only
DROP POLICY IF EXISTS payments_isolation ON public.payments;
CREATE POLICY payments_isolation ON public.payments
    FOR ALL USING (org_id = public.current_user_org_id())
    WITH CHECK (org_id = public.current_user_org_id());

-- Call Requests Policy: Tenant-scoped access only
DROP POLICY IF EXISTS call_requests_isolation ON public.call_requests;
CREATE POLICY call_requests_isolation ON public.call_requests
    FOR ALL USING (org_id = public.current_user_org_id())
    WITH CHECK (org_id = public.current_user_org_id());

-- WhatsApp Outbound Queue Policy: Tenant-scoped access only
ALTER TABLE public.wa_outbound_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wa_outbound_queue_isolation ON public.wa_outbound_queue;
CREATE POLICY wa_outbound_queue_isolation ON public.wa_outbound_queue
    FOR ALL USING (org_id = public.current_user_org_id())
    WITH CHECK (org_id = public.current_user_org_id());

-- 13. Auto-Provisioning Trigger on New User Signup (Google OAuth / Email Magic Link)
CREATE OR REPLACE FUNCTION public.handle_new_user_provisioning()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    new_org_id UUID;
    clean_company_name TEXT;
    user_name TEXT;
BEGIN
    -- Derive initial company name from email domain or metadata
    user_name := COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1));
    clean_company_name := COALESCE(NEW.raw_user_meta_data->>'company_name', user_name || ' Manufacturing');

    -- Auto-create a new isolated organization on a limited trial
    INSERT INTO public.organizations (
        name,
        slug,
        webhook_key,
        plan_status,
        trial_ends_at,
        monthly_lead_limit,
        leads_used,
        wa_status
    ) VALUES (
        clean_company_name,
        lower(regexp_replace(clean_company_name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || substr(md5(random()::text), 1, 6),
        encode(extensions.gen_random_bytes(16), 'hex'),
        'trial',
        now() + interval '48 hours',
        25,
        0,
        'disconnected'
    ) RETURNING id INTO new_org_id;

    -- Create linked user profile as Owner
    INSERT INTO public.profiles (
        id,
        org_id,
        full_name,
        email,
        phone,
        role
    ) VALUES (
        NEW.id,
        new_org_id,
        user_name,
        NEW.email,
        NEW.phone,
        'owner'
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Bind trigger to Supabase auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_provisioning();

-- 14. Supabase Storage Bucket Setup: 'catalogs' with per-tenant path isolation
INSERT INTO storage.buckets (id, name, public)
VALUES ('catalogs', 'catalogs', false)
ON CONFLICT (id) DO NOTHING;

-- Storage Policy: Users can only upload & view catalog files inside their org folder: catalogs/{org_id}/*
DROP POLICY IF EXISTS "Tenant Catalog Upload Isolation" ON storage.objects;
CREATE POLICY "Tenant Catalog Upload Isolation" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'catalogs'
        AND (storage.foldername(name))[1] = public.current_user_org_id()::text
    );

-- 15. Manual Takeovers & Alert Deduplication (Survives Server Restarts)
CREATE TABLE IF NOT EXISTS public.manual_takeovers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    buyer_phone TEXT NOT NULL,
    taken_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    taken_by TEXT DEFAULT 'owner',
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_takeover_org_phone UNIQUE (org_id, buyer_phone)
);

CREATE TABLE IF NOT EXISTS public.alert_dedup (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    buyer_phone TEXT NOT NULL,
    kind TEXT NOT NULL,
    last_sent_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_alert_org_phone_kind UNIQUE (org_id, buyer_phone, kind)
);

CREATE INDEX IF NOT EXISTS idx_manual_takeovers_lookup ON public.manual_takeovers(org_id, buyer_phone);
CREATE INDEX IF NOT EXISTS idx_alert_dedup_lookup ON public.alert_dedup(org_id, buyer_phone, kind);

-- Enable RLS on manual_takeovers and alert_dedup
ALTER TABLE public.manual_takeovers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS manual_takeovers_isolation ON public.manual_takeovers;
CREATE POLICY manual_takeovers_isolation ON public.manual_takeovers
    FOR ALL USING (org_id = public.current_user_org_id())
    WITH CHECK (org_id = public.current_user_org_id());

ALTER TABLE public.alert_dedup ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alert_dedup_isolation ON public.alert_dedup;
CREATE POLICY alert_dedup_isolation ON public.alert_dedup
    FOR ALL USING (org_id = public.current_user_org_id())
    WITH CHECK (org_id = public.current_user_org_id());

-- 16. Legacy ID Mapping for Deterministic UUID Migration
CREATE TABLE IF NOT EXISTS public.legacy_id_mapping (
    legacy_id TEXT PRIMARY KEY,
    supabase_uuid UUID NOT NULL DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL,
    is_new_insert BOOLEAN DEFAULT true,
    batch_id TEXT,
    migrated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_legacy_mapping_uuid ON public.legacy_id_mapping(supabase_uuid);
ALTER TABLE public.legacy_id_mapping ADD COLUMN IF NOT EXISTS is_new_insert BOOLEAN DEFAULT true;
ALTER TABLE public.legacy_id_mapping ADD COLUMN IF NOT EXISTS batch_id TEXT;

-- Migration idempotency helper for requirement column
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS requirement TEXT;

-- Apply in the Supabase SQL editor using an administrator, after taking a backup.
-- Service-only transactional catalog and quota operations.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS quota_admitted BOOLEAN NOT NULL DEFAULT true;

DROP FUNCTION IF EXISTS public.increment_leads_used(UUID);
CREATE OR REPLACE FUNCTION public.reserve_lead_quota(p_org_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id UUID;
BEGIN
  UPDATE public.organizations
     SET leads_used = COALESCE(leads_used, 0) + 1, updated_at = now()
   WHERE id = p_org_id
     AND COALESCE(leads_used, 0) < COALESCE(monthly_lead_limit, 25)
     AND NOT (plan_status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at < now())
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION public.reserve_lead_quota(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_lead_quota(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.replace_tenant_catalog(p_org_id UUID, p_products JSONB, p_org_updates JSONB)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org_id) THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;
  IF p_products IS NOT NULL THEN
    IF jsonb_typeof(p_products) <> 'array' THEN RAISE EXCEPTION 'Products must be an array'; END IF;
    DELETE FROM public.products WHERE org_id = p_org_id;
    INSERT INTO public.products (org_id, sku, name, category, model_specs, price_raw, image_url, brochure_url, brochure_filename, is_active)
    SELECT p_org_id, p.sku, p.name, p.category, p.model_specs, p.price_raw, p.image_url, p.brochure_url, p.brochure_filename, COALESCE(p.is_active, true)
    FROM jsonb_to_recordset(p_products) AS p(sku text, name text, category text, model_specs text, price_raw text, image_url text, brochure_url text, brochure_filename text, is_active boolean);
  END IF;
  UPDATE public.organizations SET
    name = COALESCE(p_org_updates->>'name', name),
    business_type = COALESCE(p_org_updates->>'business_type', business_type),
    website_knowledge = COALESCE(p_org_updates->>'website_knowledge', website_knowledge),
    catalog_pdf_name = COALESCE(p_org_updates->>'catalog_pdf_name', catalog_pdf_name), updated_at = now()
  WHERE id = p_org_id;
END $$;
REVOKE ALL ON FUNCTION public.replace_tenant_catalog(UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_tenant_catalog(UUID, JSONB, JSONB) TO service_role;

-- Clients may not attach themselves to an arbitrary tenant. Provision profiles via a trusted backend.
DROP POLICY IF EXISTS profile_insert_own ON public.profiles;
CREATE POLICY profile_insert_own ON public.profiles FOR INSERT WITH CHECK (id = auth.uid() AND org_id IS NULL);

-- 17. Enable Supabase Realtime for Multi-Tenant Dashboard & WhatsApp Worker
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.organizations;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.leads;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.wa_outbound_queue;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.call_requests;
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;




-- Billing records can only be changed by trusted backend reconciliation.
DROP POLICY IF EXISTS payments_isolation ON public.payments;
DROP POLICY IF EXISTS payments_tenant_select ON public.payments;
CREATE POLICY payments_tenant_select ON public.payments FOR SELECT USING (org_id = public.current_user_org_id());
-- Catalog writes go through the server's role-checked transactional RPC.
DROP POLICY IF EXISTS products_isolation ON public.products;
DROP POLICY IF EXISTS products_tenant_select ON public.products;
CREATE POLICY products_tenant_select ON public.products FOR SELECT USING (org_id = public.current_user_org_id());
-- Provisioning is performed by the trusted auth trigger, not arbitrary clients.
DROP POLICY IF EXISTS org_isolation_insert ON public.organizations;
ALTER TABLE public.organizations ALTER COLUMN plan_status SET DEFAULT 'trial';
ALTER TABLE public.organizations ALTER COLUMN monthly_lead_limit SET DEFAULT 25;
