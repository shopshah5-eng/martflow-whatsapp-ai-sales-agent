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
