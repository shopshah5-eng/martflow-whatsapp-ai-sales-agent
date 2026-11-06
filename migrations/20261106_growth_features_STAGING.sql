-- STAGING ONLY: review existing schema, grants, RLS and backup before applying.
-- There is deliberately no outbound-message worker in this migration.
BEGIN;
CREATE TABLE IF NOT EXISTS public.review_request_settings (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  review_url text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.review_request_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  buyer_phone text NOT NULL, status text NOT NULL CHECK (status = 'awaiting_delivery_setup'),
  confirmed_by uuid NOT NULL REFERENCES public.profiles(id), consent_confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id, buyer_phone)
);
CREATE TABLE IF NOT EXISTS public.custom_website_integrations (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, issued_by uuid NOT NULL REFERENCES public.profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.review_request_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_request_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_website_integrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_request_settings, public.review_request_queue, public.custom_website_integrations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_request_settings, public.review_request_queue, public.custom_website_integrations TO service_role;
COMMIT;
