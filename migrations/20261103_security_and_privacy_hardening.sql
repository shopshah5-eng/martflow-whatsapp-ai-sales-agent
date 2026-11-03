-- Migration: Security & Privacy Hardening
-- 1. Restrict direct client writes to WhatsApp outbound queue
-- 2. Restrict direct client mutation of sensitive credentials & worker commands
-- 3. Idempotent and safe to run in staging

BEGIN;

-- 1. WhatsApp outbound queue: only backend service role may enqueue or update messages.
-- Tenant members retain SELECT access to view outbound status.
ALTER TABLE IF EXISTS public.wa_outbound_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wa_outbound_queue_no_client_insert ON public.wa_outbound_queue;
CREATE POLICY wa_outbound_queue_no_client_insert ON public.wa_outbound_queue
  AS RESTRICTIVE FOR INSERT TO anon, authenticated WITH CHECK (false);

DROP POLICY IF EXISTS wa_outbound_queue_no_client_update ON public.wa_outbound_queue;
CREATE POLICY wa_outbound_queue_no_client_update ON public.wa_outbound_queue
  AS RESTRICTIVE FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS wa_outbound_queue_no_client_delete ON public.wa_outbound_queue;
CREATE POLICY wa_outbound_queue_no_client_delete ON public.wa_outbound_queue
  AS RESTRICTIVE FOR DELETE TO anon, authenticated USING (false);

-- 2. Organizations: prevent clients from modifying credentials, keys, or worker commands directly.
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
