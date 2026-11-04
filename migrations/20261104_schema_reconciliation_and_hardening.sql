-- ==============================================================================
-- MartFlow AI — Staged Schema Reconciliation & Security Hardening Migration
-- Date: 2026-11-04
-- Target: Staging validation before production execution
-- ==============================================================================

BEGIN;

-- 1. Organizations: Reconcile schema drift for missing columns
ALTER TABLE IF EXISTS public.organizations ADD COLUMN IF NOT EXISTS wa_worker_id TEXT;
ALTER TABLE IF EXISTS public.organizations ADD COLUMN IF NOT EXISTS wa_worker_heartbeat TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.organizations ADD COLUMN IF NOT EXISTS catalog_pdf_name TEXT;

-- 2. Stored Procedure: reserve_and_create_lead
-- Eliminates PostgreSQL Error 42702 (ambiguous column reference) by qualifying all columns.
CREATE OR REPLACE FUNCTION public.reserve_and_create_lead(
    p_org_id UUID,
    p_name TEXT,
    p_phone TEXT,
    p_product TEXT,
    p_message TEXT,
    p_pdf_sent BOOLEAN DEFAULT FALSE
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
    v_existing_id UUID;
    v_existing_admitted BOOLEAN;
    v_limit INT;
    v_used INT;
    v_plan_status TEXT;
    v_admitted BOOLEAN := FALSE;
    v_new_lead_id UUID;
BEGIN
    v_clean_phone := regexp_replace(p_phone, '\D', '', 'g');

    -- Deduplication: Check if lead already exists for this tenant & phone
    SELECT l.id, l.quota_admitted INTO v_existing_id, v_existing_admitted
    FROM public.leads l
    WHERE (l.org_id = p_org_id OR l.organization_id = p_org_id)
      AND l.buyer_phone = v_clean_phone
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
        RETURN QUERY SELECT v_existing_id, COALESCE(v_existing_admitted, TRUE), FALSE;
        RETURN;
    END IF;

    -- Lock organization record for atomic quota evaluation
    SELECT o.monthly_lead_limit, o.leads_used, o.plan_status
    INTO v_limit, v_used, v_plan_status
    FROM public.organizations o
    WHERE o.id = p_org_id
    FOR UPDATE;

    IF v_plan_status IN ('active', 'trial', 'custom') AND (v_limit IS NULL OR v_used < v_limit) THEN
        v_admitted := TRUE;
        UPDATE public.organizations
        SET leads_used = leads_used + 1
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
        pdf_brochure_sent,
        quota_admitted,
        status,
        created_at
    ) VALUES (
        p_org_id,
        p_name,
        v_clean_phone,
        p_product,
        p_message,
        p_pdf_sent,
        v_admitted,
        'new',
        NOW()
    )
    RETURNING leads.id INTO v_new_lead_id;

    RETURN QUERY SELECT v_new_lead_id, v_admitted, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_and_create_lead(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_and_create_lead(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO service_role;

-- 3. Stored Procedure: reserve_lead_quota
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
BEGIN
    SELECT monthly_lead_limit, leads_used, plan_status
    INTO v_limit, v_used, v_plan
    FROM public.organizations
    WHERE id = p_org_id
    FOR UPDATE;

    IF v_plan IN ('active', 'trial', 'custom') AND (v_limit IS NULL OR v_used < v_limit) THEN
        UPDATE public.organizations SET leads_used = leads_used + 1 WHERE id = p_org_id;
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_lead_quota(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_lead_quota(UUID) TO service_role;

-- 4. Conversation Memories Table (Private Tenant-Scoped Context)
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
        SELECT COALESCE(p.org_id, p.organization_id)
        FROM public.profiles p
        WHERE p.id = auth.uid()
    ));

DROP POLICY IF EXISTS conversation_memories_no_client_write ON public.conversation_memories;
CREATE POLICY conversation_memories_no_client_write ON public.conversation_memories
    AS RESTRICTIVE FOR INSERT TO anon, authenticated WITH CHECK (false);

-- 5. Follow-Up Schedules Table (One-Time Consent-Based Lifecycle)
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
        SELECT COALESCE(p.org_id, p.organization_id)
        FROM public.profiles p
        WHERE p.id = auth.uid()
    ));

DROP POLICY IF EXISTS follow_up_schedules_no_client_write ON public.follow_up_schedules;
CREATE POLICY follow_up_schedules_no_client_write ON public.follow_up_schedules
    AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

COMMIT;
