-- Catalogue management is a platform-assigned capability, not workspace ownership.
-- Apply in staging first; validate existing policies before any production rollout.
BEGIN;
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

-- Restrictive policies also close bypasses through older permissive policies.
-- Service-role operations go through the authenticated, capability-checked API.
DROP POLICY IF EXISTS catalog_no_client_insert ON public.products;
CREATE POLICY catalog_no_client_insert ON public.products AS RESTRICTIVE FOR INSERT TO anon, authenticated WITH CHECK (false);
DROP POLICY IF EXISTS catalog_no_client_update ON public.products;
CREATE POLICY catalog_no_client_update ON public.products AS RESTRICTIVE FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS catalog_no_client_delete ON public.products;
CREATE POLICY catalog_no_client_delete ON public.products AS RESTRICTIVE FOR DELETE TO anon, authenticated USING (false);

-- A legacy privileged RPC must never remain callable directly by tenant clients.
DO $$
BEGIN
  IF to_regprocedure('public.replace_tenant_catalog(uuid,jsonb,jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.replace_tenant_catalog(UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.replace_tenant_catalog(UUID, JSONB, JSONB) TO service_role;
  END IF;
END $$;

-- Catalogue attachments cannot be written directly until a secure private-asset
-- pipeline is deployed; this restriction does not affect other storage buckets.
DROP POLICY IF EXISTS "Tenant Catalog Upload Isolation" ON storage.objects;
DROP POLICY IF EXISTS catalog_storage_no_client_insert ON storage.objects;
CREATE POLICY catalog_storage_no_client_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO anon, authenticated WITH CHECK (bucket_id <> 'catalogs');
DROP POLICY IF EXISTS catalog_storage_no_client_update ON storage.objects;
CREATE POLICY catalog_storage_no_client_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon, authenticated USING (bucket_id <> 'catalogs') WITH CHECK (bucket_id <> 'catalogs');
DROP POLICY IF EXISTS catalog_storage_no_client_delete ON storage.objects;
CREATE POLICY catalog_storage_no_client_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO anon, authenticated USING (bucket_id <> 'catalogs');

-- Tenants may edit other business settings, but not managed catalogue knowledge.
CREATE OR REPLACE FUNCTION public.protect_managed_catalog_fields()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (auth.jwt() ->> 'role') IN ('anon', 'authenticated') AND (
    to_jsonb(NEW)->'website_knowledge' IS DISTINCT FROM to_jsonb(OLD)->'website_knowledge' OR
    to_jsonb(NEW)->'business_type' IS DISTINCT FROM to_jsonb(OLD)->'business_type' OR
    to_jsonb(NEW)->'website_url' IS DISTINCT FROM to_jsonb(OLD)->'website_url' OR
    to_jsonb(NEW)->'website_synced_at' IS DISTINCT FROM to_jsonb(OLD)->'website_synced_at' OR
    to_jsonb(NEW)->'catalog_pdf_name' IS DISTINCT FROM to_jsonb(OLD)->'catalog_pdf_name'
  ) THEN
    RAISE EXCEPTION 'Catalogue knowledge is managed by the agency';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_managed_catalog_fields ON public.organizations;
CREATE TRIGGER protect_managed_catalog_fields BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.protect_managed_catalog_fields();

CREATE OR REPLACE FUNCTION public.revoke_catalog_grants_on_tenant_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    DELETE FROM public.catalog_management_grants WHERE user_id = OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS revoke_catalog_grants_on_tenant_change ON public.profiles;
CREATE TRIGGER revoke_catalog_grants_on_tenant_change AFTER UPDATE OF org_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.revoke_catalog_grants_on_tenant_change();
COMMIT;
