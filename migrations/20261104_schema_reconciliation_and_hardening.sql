-- ==============================================================================
-- Leadsy AI — Staged Schema Reconciliation & Security Hardening Migration
-- Date: 2026-11-04
-- Target: Staging validation before production execution
-- ==============================================================================

BEGIN;

-- 1. Organizations: Reconcile schema drift for missing columns
ALTER TABLE IF EXISTS public.organizations ADD COLUMN IF NOT EXISTS wa_worker_id TEXT;
ALTER TABLE IF EXISTS public.organizations ADD COLUMN IF NOT EXISTS wa_worker_heartbeat TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.organizations ADD COLUMN IF NOT EXISTS catalog_pdf_name TEXT;

-- 2. Profiles: Reconcile schema drift for missing columns
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member';

-- 3. Leads: Reconcile schema drift for missing columns
ALTER TABLE IF EXISTS public.leads ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE IF EXISTS public.leads ADD COLUMN IF NOT EXISTS quota_admitted BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE IF EXISTS public.leads ADD COLUMN IF NOT EXISTS requirement TEXT;
ALTER TABLE IF EXISTS public.leads ADD COLUMN IF NOT EXISTS query_message TEXT;
ALTER TABLE IF EXISTS public.leads ADD COLUMN IF NOT EXISTS product_inquired TEXT;
ALTER TABLE IF EXISTS public.leads ADD COLUMN IF NOT EXISTS pdf_brochure_sent BOOLEAN DEFAULT FALSE;
ALTER TABLE IF EXISTS public.leads ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'organization_id'
  ) THEN
    UPDATE public.leads SET org_id = organization_id WHERE org_id IS NULL;
  END IF;
END $$;

-- 4. Stored Procedure: reserve_and_create_lead
-- Eliminates PostgreSQL Error 42702 (ambiguous column reference) by qualifying all columns.
-- Named arguments match both server.js and baileysManager.js callers.
CREATE OR REPLACE FUNCTION public.reserve_and_create_lead(
    p_org_id UUID,
    p_buyer_phone TEXT,
    p_buyer_name TEXT,
    p_query_message TEXT DEFAULT NULL,
    p_requirement TEXT DEFAULT NULL,
    p_bypass_quota BOOLEAN DEFAULT FALSE,
    p_product_inquired TEXT DEFAULT NULL,
    p_pdf_brochure_sent BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    out_lead_id UUID,
    out_quota_admitted BOOLEAN,
    out_is_new BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_clean_phone TEXT;
    v_digits TEXT;
    v_existing_id UUID;
    v_existing_admitted BOOLEAN;
    v_limit INT;
    v_used INT;
    v_plan_status TEXT;
    v_trial_ends TIMESTAMPTZ;
    v_admitted BOOLEAN := FALSE;
    v_new_lead_id UUID;
    v_product TEXT;
    v_message TEXT;
    v_pdf_sent BOOLEAN;
BEGIN
    v_clean_phone := regexp_replace(COALESCE(p_buyer_phone, ''), '\D', '', 'g');
    IF length(v_clean_phone) >= 10 THEN
        v_digits := right(v_clean_phone, 10);
    ELSE
        v_digits := v_clean_phone;
    END IF;

    v_product := COALESCE(p_product_inquired, p_requirement, 'General Inquiry');
    v_message := COALESCE(p_query_message, p_requirement, '');
    v_pdf_sent := COALESCE(p_pdf_brochure_sent, FALSE);

    -- Deduplication: Check if lead already exists for this tenant & phone
    SELECT l.id, l.quota_admitted INTO v_existing_id, v_existing_admitted
    FROM public.leads l
    WHERE l.org_id = p_org_id
      AND (
        l.buyer_phone = v_clean_phone
        OR l.buyer_phone = p_buyer_phone
        OR (length(v_digits) >= 10 AND right(regexp_replace(l.buyer_phone, '\D', '', 'g'), 10) = v_digits)
      )
    ORDER BY l.created_at DESC
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
        RETURN QUERY SELECT v_existing_id, COALESCE(v_existing_admitted, TRUE), FALSE;
        RETURN;
    END IF;

    -- Lock organization record for atomic quota evaluation
    SELECT o.monthly_lead_limit, o.leads_used, o.plan_status, o.trial_ends_at
    INTO v_limit, v_used, v_plan_status, v_trial_ends
    FROM public.organizations o
    WHERE o.id = p_org_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Organization not found';
    END IF;

    IF p_bypass_quota THEN
        v_admitted := TRUE;
    ELSIF v_plan_status IN ('active', 'custom') AND (v_limit IS NULL OR COALESCE(v_used, 0) < v_limit) THEN
        v_admitted := TRUE;
        UPDATE public.organizations
        SET leads_used = COALESCE(leads_used, 0) + 1, updated_at = NOW()
        WHERE id = p_org_id;
    ELSIF v_plan_status = 'trial' AND (v_trial_ends IS NULL OR v_trial_ends > NOW()) AND (COALESCE(v_used, 0) < COALESCE(v_limit, 25)) THEN
        v_admitted := TRUE;
        UPDATE public.organizations
        SET leads_used = COALESCE(leads_used, 0) + 1, updated_at = NOW()
        WHERE id = p_org_id;
    ELSE
        v_admitted := FALSE;
    END IF;

    INSERT INTO public.leads (
        org_id,
        buyer_name,
        buyer_phone,
        product_inquired,
        query_message,
        requirement,
        pdf_brochure_sent,
        quota_admitted,
        status,
        created_at
    ) VALUES (
        p_org_id,
        p_buyer_name,
        v_clean_phone,
        v_product,
        v_message,
        COALESCE(p_requirement, v_message),
        v_pdf_sent,
        v_admitted,
        'new',
        NOW()
    )
    RETURNING leads.id INTO v_new_lead_id;

    RETURN QUERY SELECT v_new_lead_id, v_admitted, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_and_create_lead FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_and_create_lead TO service_role;

-- 5. Stored Procedure: reserve_lead_quota
CREATE OR REPLACE FUNCTION public.reserve_lead_quota(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_limit INT;
    v_used INT;
    v_plan TEXT;
    v_trial_ends TIMESTAMPTZ;
BEGIN
    SELECT monthly_lead_limit, leads_used, plan_status, trial_ends_at
    INTO v_limit, v_used, v_plan, v_trial_ends
    FROM public.organizations
    WHERE id = p_org_id
    FOR UPDATE;

    IF v_plan IN ('active', 'custom') AND (v_limit IS NULL OR COALESCE(v_used, 0) < v_limit) THEN
        UPDATE public.organizations SET leads_used = COALESCE(leads_used, 0) + 1, updated_at = NOW() WHERE id = p_org_id;
        RETURN TRUE;
    ELSIF v_plan = 'trial' AND (v_trial_ends IS NULL OR v_trial_ends > NOW()) AND (COALESCE(v_used, 0) < COALESCE(v_limit, 25)) THEN
        UPDATE public.organizations SET leads_used = COALESCE(leads_used, 0) + 1, updated_at = NOW() WHERE id = p_org_id;
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_lead_quota(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_lead_quota(UUID) TO service_role;

-- 6. Conversation Memories Table (Private Tenant-Scoped Context)
CREATE TABLE IF NOT EXISTS public.conversation_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL,
    buyer_requirements TEXT,
    answered_questions JSONB DEFAULT '[]'::jsonb,
    consent_status TEXT DEFAULT 'pending',
    summary_text TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_conversation_memories_tenant_conv UNIQUE (org_id, conversation_id)
);

ALTER TABLE public.conversation_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_memories_tenant_select ON public.conversation_memories;
CREATE POLICY conversation_memories_tenant_select ON public.conversation_memories
    FOR SELECT TO authenticated
    USING (org_id IN (
        SELECT p.org_id
        FROM public.profiles p
        WHERE p.id = auth.uid()
    ));

DROP POLICY IF EXISTS conversation_memories_no_client_write ON public.conversation_memories;
CREATE POLICY conversation_memories_no_client_write ON public.conversation_memories
    AS RESTRICTIVE FOR INSERT TO anon, authenticated WITH CHECK (false);

-- 7. Follow-Up Schedules Table (One-Time Consent-Based Lifecycle)
CREATE TABLE IF NOT EXISTS public.follow_up_schedules (
    id TEXT PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    lead_id UUID,
    buyer_phone TEXT NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    template_name TEXT,
    requires_template BOOLEAN DEFAULT TRUE,
    attempts INT DEFAULT 0,
    cancellation_reason TEXT,
    cancelled_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_follow_up_schedules_tenant_phone UNIQUE (org_id, buyer_phone)
);

ALTER TABLE public.follow_up_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS follow_up_schedules_tenant_select ON public.follow_up_schedules;
CREATE POLICY follow_up_schedules_tenant_select ON public.follow_up_schedules
    FOR SELECT TO authenticated
    USING (org_id IN (
        SELECT p.org_id
        FROM public.profiles p
        WHERE p.id = auth.uid()
    ));

DROP POLICY IF EXISTS follow_up_schedules_no_client_write ON public.follow_up_schedules;
CREATE POLICY follow_up_schedules_no_client_write ON public.follow_up_schedules
    AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

COMMIT;
