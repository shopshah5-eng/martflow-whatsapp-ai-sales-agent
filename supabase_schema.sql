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
    plan_status TEXT NOT NULL DEFAULT 'trial' CHECK (plan_status IN ('trial', 'active', 'expired')),
    trial_ends_at TIMESTAMPTZ DEFAULT (now() + interval '48 hours'),
    monthly_lead_limit INT DEFAULT 25,
    leads_used INT DEFAULT 0,
    custom_quote_inr INT DEFAULT NULL,
    company_city TEXT DEFAULT 'Ahmedabad, Gujarat',
    escalation_phone TEXT DEFAULT '919825012345',
    wa_mode TEXT DEFAULT 'qr' CHECK (wa_mode IN ('qr', 'cloud_api')),
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
    price_raw TEXT,
    brochure_url TEXT,
    brochure_filename TEXT,
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
    mode TEXT DEFAULT 'auto' CHECK (mode IN ('auto', 'human')),
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
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 9. Indexes for Multi-Tenant Query Speed
CREATE INDEX IF NOT EXISTS idx_profiles_org_id ON public.profiles(org_id);
CREATE INDEX IF NOT EXISTS idx_products_org_id ON public.products(org_id);
CREATE INDEX IF NOT EXISTS idx_leads_org_id ON public.leads(org_id);
CREATE INDEX IF NOT EXISTS idx_conversations_org_id ON public.conversations(org_id);
CREATE INDEX IF NOT EXISTS idx_messages_org_id ON public.messages(org_id);
CREATE INDEX IF NOT EXISTS idx_payments_org_id ON public.payments(org_id);
CREATE INDEX IF NOT EXISTS idx_orgs_webhook_key ON public.organizations(webhook_key);

-- 10. Helper Function to Get Current User's Tenant Org ID
CREATE OR REPLACE FUNCTION public.current_user_org_id()
RETURNS UUID AS $$
    SELECT org_id FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 11. Enable Row-Level Security (RLS) on ALL Multi-Tenant Tables
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- 12. RLS Policies: STRICT ZERO-OVERLAP TENANT ISOLATION

-- Organizations Policy: Users can only select/update their own organization
DROP POLICY IF EXISTS org_isolation_select ON public.organizations;
CREATE POLICY org_isolation_select ON public.organizations
    FOR SELECT USING (id = public.current_user_org_id());

DROP POLICY IF EXISTS org_isolation_update ON public.organizations;
CREATE POLICY org_isolation_update ON public.organizations
    FOR UPDATE USING (id = public.current_user_org_id());

-- Profiles Policy: Users see profiles in their own tenant
DROP POLICY IF EXISTS profile_isolation ON public.profiles;
CREATE POLICY profile_isolation ON public.profiles
    FOR ALL USING (org_id = public.current_user_org_id() OR id = auth.uid());

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

-- 13. Auto-Provisioning Trigger on New User Signup (Google OAuth / Email Magic Link)
CREATE OR REPLACE FUNCTION public.handle_new_user_provisioning()
RETURNS TRIGGER AS $$
DECLARE
    new_org_id UUID;
    clean_company_name TEXT;
    user_name TEXT;
BEGIN
    -- Derive initial company name from email domain or metadata
    user_name := COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1));
    clean_company_name := COALESCE(NEW.raw_user_meta_data->>'company_name', user_name || ' Manufacturing');

    -- Auto-create new isolated Organization with 48h Live Trial & 25 Leads
    INSERT INTO public.organizations (
        name,
        slug,
        webhook_key,
        plan_status,
        trial_ends_at,
        monthly_lead_limit,
        leads_used
    ) VALUES (
        clean_company_name,
        lower(regexp_replace(user_name, '[^a-zA-Z0-9]', '', 'g')) || '-' || substr(md5(random()::text), 1, 6),
        encode(gen_random_bytes(16), 'hex'),
        'trial',
        now() + interval '48 hours',
        25,
        0
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

DROP POLICY IF EXISTS "Tenant Catalog Read Isolation" ON storage.objects;
CREATE POLICY "Tenant Catalog Read Isolation" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'catalogs'
        AND (storage.foldername(name))[1] = public.current_user_org_id()::text
    );

