-- ==============================================================================
-- MARTFLOW AI / LEADSY AI — STAGING SECURITY & PRIVACY HARDENING
-- Target: Supabase Postgres (AWS ap-south-1)
-- Reconciles:
--   1. Profile Privilege Guard (Prevents role/tenant escalation by clients)
--   2. Catalogue Management Grants & Restrictive Product Mutation Policies
--   3. Client Inbox Privacy Isolation (Blocks catalogue managers from viewing client conversations & leads)
--   4. Storage Object Protection (Restricts direct public mutations on 'catalogs' bucket)
--   5. Sensitive Organization Credentials Protection Trigger
-- Safe & Idempotent: Can be run safely in Staging or Production.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. PROFILE PRIVILEGE GUARD (Prevents Self-Escalation & Tenant Hopping)
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.profiles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.protect_profile_membership_fields()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') AND (
    to_jsonb(NEW)->'id' IS DISTINCT FROM to_jsonb(OLD)->'id' OR
    to_jsonb(NEW)->'org_id' IS DISTINCT FROM to_jsonb(OLD)->'org_id' OR
    to_jsonb(NEW)->'organization_id' IS DISTINCT FROM to_jsonb(OLD)->'organization_id' OR
    to_jsonb(NEW)->'role' IS DISTINCT FROM to_jsonb(OLD)->'role'
  ) THEN
    RAISE EXCEPTION 'Profile identity, workspace and role are server managed and cannot be modified directly';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_membership_fields ON public.profiles;
CREATE TRIGGER protect_profile_membership_fields BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_membership_fields();


-- ------------------------------------------------------------------------------
-- 2. CATALOGUE MANAGEMENT GRANTS & RESTRICTIVE PRODUCT MUTATION POLICIES
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.catalog_management_grants (
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

ALTER TABLE public.catalog_management_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_management_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.catalog_management_grants TO service_role;

-- Secure helper functions: check catalogue grant with SECURITY DEFINER
-- This avoids granting direct table SELECT on catalog_management_grants to authenticated users,
-- and prevents recursive RLS subquery suppression.
CREATE OR REPLACE FUNCTION public.user_has_catalog_grant(p_user_id UUID, p_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.catalog_management_grants
    WHERE user_id = p_user_id AND org_id = p_org_id
  );
$$;

REVOKE ALL ON FUNCTION public.user_has_catalog_grant(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_has_catalog_grant(UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.message_is_in_granted_catalog_org(p_conversation_id UUID, p_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.catalog_management_grants g ON g.org_id = c.org_id
    WHERE c.id = p_conversation_id AND g.user_id = p_user_id
  );
$$;

REVOKE ALL ON FUNCTION public.message_is_in_granted_catalog_org(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.message_is_in_granted_catalog_org(UUID, UUID) TO authenticated, service_role;

-- Restrictive policies: Ordinary client authenticated users cannot directly mutate products in DB
-- All mutations must go through the authenticated server API which checks catalog_management_grants.
DROP POLICY IF EXISTS catalog_no_client_insert ON public.products;
CREATE POLICY catalog_no_client_insert ON public.products AS RESTRICTIVE FOR INSERT TO anon, authenticated WITH CHECK (false);

DROP POLICY IF EXISTS catalog_no_client_update ON public.products;
CREATE POLICY catalog_no_client_update ON public.products AS RESTRICTIVE FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS catalog_no_client_delete ON public.products;
CREATE POLICY catalog_no_client_delete ON public.products AS RESTRICTIVE FOR DELETE TO anon, authenticated USING (false);

-- Revoke legacy privileged RPC from clients if present
DO $$
BEGIN
  IF to_regprocedure('public.replace_tenant_catalog(uuid,jsonb,jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.replace_tenant_catalog(UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.replace_tenant_catalog(UUID, JSONB, JSONB) TO service_role;
  END IF;
END $$;


-- ------------------------------------------------------------------------------
-- 3. CLIENT INBOX PRIVACY ISOLATION (Conversations, Messages, Leads)
-- External catalogue managers (granted via catalog_management_grants) must NOT
-- be able to read or query client inboxes, messages, or leads.
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS catalog_managers_no_conversations ON public.conversations;
CREATE POLICY catalog_managers_no_conversations ON public.conversations AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    NOT public.user_has_catalog_grant(auth.uid(), public.conversations.org_id)
  );

DROP POLICY IF EXISTS catalog_managers_no_messages ON public.messages;
CREATE POLICY catalog_managers_no_messages ON public.messages AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    NOT public.message_is_in_granted_catalog_org(public.messages.conversation_id, auth.uid())
  );

DROP POLICY IF EXISTS catalog_managers_no_leads ON public.leads;
CREATE POLICY catalog_managers_no_leads ON public.leads AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    NOT public.user_has_catalog_grant(auth.uid(), COALESCE(public.leads.org_id, public.leads.organization_id))
  );


-- ------------------------------------------------------------------------------
-- 4. STORAGE OBJECT PROTECTION FOR 'catalogs' BUCKET
-- Deny direct client mutations (INSERT, UPDATE, DELETE) on the 'catalogs' bucket.
-- Storage writes must go through the verified server pipeline.
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow Uploads Catalogs" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Upload Catalogs" ON storage.objects;
DROP POLICY IF EXISTS "Allow Updates Catalogs" ON storage.objects;
DROP POLICY IF EXISTS "Allow Deletes Catalogs" ON storage.objects;

DROP POLICY IF EXISTS catalog_storage_no_client_insert ON storage.objects;
CREATE POLICY catalog_storage_no_client_insert ON storage.objects AS RESTRICTIVE
  FOR INSERT TO anon, authenticated WITH CHECK (bucket_id <> 'catalogs');

DROP POLICY IF EXISTS catalog_storage_no_client_update ON storage.objects;
CREATE POLICY catalog_storage_no_client_update ON storage.objects AS RESTRICTIVE
  FOR UPDATE TO anon, authenticated USING (bucket_id <> 'catalogs') WITH CHECK (bucket_id <> 'catalogs');

DROP POLICY IF EXISTS catalog_storage_no_client_delete ON storage.objects;
CREATE POLICY catalog_storage_no_client_delete ON storage.objects AS RESTRICTIVE
  FOR DELETE TO anon, authenticated USING (bucket_id <> 'catalogs');


-- ------------------------------------------------------------------------------
-- 5. SENSITIVE ORGANIZATION CREDENTIALS & WORKER COMMANDS PROTECTION
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_sensitive_org_fields()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (auth.jwt() ->> 'role') IN ('anon', 'authenticated') AND (
    to_jsonb(NEW)->'webhook_key' IS DISTINCT FROM to_jsonb(OLD)->'webhook_key' OR
    to_jsonb(NEW)->'waba_token' IS DISTINCT FROM to_jsonb(OLD)->'waba_token' OR
    to_jsonb(NEW)->'waba_phone_id' IS DISTINCT FROM to_jsonb(OLD)->'waba_phone_id' OR
    to_jsonb(NEW)->'wa_command' IS DISTINCT FROM to_jsonb(OLD)->'wa_command' OR
    to_jsonb(NEW)->'wa_command_payload' IS DISTINCT FROM to_jsonb(OLD)->'wa_command_payload'
  ) THEN
    RAISE EXCEPTION 'Sensitive organization credentials and worker commands cannot be modified directly';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_sensitive_org_fields ON public.organizations;
CREATE TRIGGER protect_sensitive_org_fields BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.protect_sensitive_org_fields();

COMMIT;
