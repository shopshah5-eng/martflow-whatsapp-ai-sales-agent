-- Apply in the Supabase SQL editor using an administrator, after taking a backup.
-- Service-only transactional catalog and quota operations.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS quota_admitted BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS requirement TEXT;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS wa_worker_id TEXT;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS wa_worker_heartbeat TIMESTAMPTZ;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS quote_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_org_buyer_phone ON public.leads (org_id, buyer_phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_razorpay_payment_id ON public.payments (razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_razorpay_order_id ON public.payments (razorpay_order_id);

DROP FUNCTION IF EXISTS public.increment_leads_used(UUID);
CREATE OR REPLACE FUNCTION public.reserve_lead_quota(p_org_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id UUID;
BEGIN
  UPDATE public.organizations
     SET leads_used = COALESCE(leads_used, 0) + 1, updated_at = now()
   WHERE id = p_org_id
     AND (
       (plan_status = 'active' AND COALESCE(leads_used, 0) < COALESCE(monthly_lead_limit, 999999))
       OR
       (plan_status = 'trial' AND (trial_ends_at IS NULL OR trial_ends_at > now()) AND COALESCE(leads_used, 0) < COALESCE(monthly_lead_limit, 25))
     )
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION public.reserve_lead_quota(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_lead_quota(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_and_create_lead(
  p_org_id UUID,
  p_buyer_phone TEXT,
  p_buyer_name TEXT,
  p_query_message TEXT DEFAULT NULL,
  p_requirement TEXT DEFAULT NULL,
  p_bypass_quota BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(lead_id UUID, quota_admitted BOOLEAN, is_new BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_lead_id UUID;
  v_admitted BOOLEAN;
  v_leads_used INT;
  v_limit INT;
  v_trial_ends TIMESTAMPTZ;
  v_plan_status TEXT;
  v_digits TEXT;
BEGIN
  v_digits := right(regexp_replace(COALESCE(p_buyer_phone, ''), '\D', '', 'g'), 10);

  -- 1. Check if lead already exists for this org and phone (last 10 digits match)
  SELECT id, leads.quota_admitted INTO v_lead_id, v_admitted
  FROM public.leads
  WHERE org_id = p_org_id
    AND (buyer_phone = p_buyer_phone OR (length(v_digits) >= 10 AND right(regexp_replace(buyer_phone, '\D', '', 'g'), 10) = v_digits))
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_lead_id IS NOT NULL THEN
    IF v_admitted = FALSE THEN
      IF p_bypass_quota THEN
        v_admitted := TRUE;
        UPDATE public.leads SET quota_admitted = TRUE WHERE id = v_lead_id;
      ELSE
        SELECT o.leads_used, o.monthly_lead_limit, o.trial_ends_at, o.plan_status
        INTO v_leads_used, v_limit, v_trial_ends, v_plan_status
        FROM public.organizations o
        WHERE o.id = p_org_id
        FOR UPDATE;

        IF FOUND THEN
          IF (v_plan_status = 'active' AND COALESCE(v_leads_used, 0) < COALESCE(v_limit, 999999))
             OR (v_plan_status = 'trial' AND (v_trial_ends IS NULL OR v_trial_ends > now()) AND COALESCE(v_leads_used, 0) < COALESCE(v_limit, 25)) THEN
            UPDATE public.organizations
            SET leads_used = COALESCE(leads_used, 0) + 1, updated_at = now()
            WHERE id = p_org_id;
            v_admitted := TRUE;
            UPDATE public.leads SET quota_admitted = TRUE WHERE id = v_lead_id;
          END IF;
        END IF;
      END IF;
    END IF;

    RETURN QUERY SELECT v_lead_id, v_admitted, FALSE;
    RETURN;
  END IF;

  -- 2. Brand new lead: Check and reserve quota atomically
  IF p_bypass_quota THEN
    v_admitted := TRUE;
  ELSE
    SELECT o.leads_used, o.monthly_lead_limit, o.trial_ends_at, o.plan_status
    INTO v_leads_used, v_limit, v_trial_ends, v_plan_status
    FROM public.organizations o
    WHERE o.id = p_org_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Organization not found';
    END IF;

    IF (v_plan_status = 'active' AND COALESCE(v_leads_used, 0) < COALESCE(v_limit, 999999))
       OR (v_plan_status = 'trial' AND (v_trial_ends IS NULL OR v_trial_ends > now()) AND COALESCE(v_leads_used, 0) < COALESCE(v_limit, 25)) THEN
      UPDATE public.organizations
      SET leads_used = COALESCE(leads_used, 0) + 1, updated_at = now()
      WHERE id = p_org_id;
      v_admitted := TRUE;
    ELSE
      v_admitted := FALSE;
    END IF;
  END IF;

  -- 3. Insert new lead with conflict resolution
  INSERT INTO public.leads (
    org_id, buyer_name, buyer_phone, query_message, requirement, status, quota_admitted
  ) VALUES (
    p_org_id,
    COALESCE(p_buyer_name, 'Customer'),
    p_buyer_phone,
    p_query_message,
    COALESCE(p_requirement, p_query_message),
    'Hot Lead',
    v_admitted
  )
  ON CONFLICT (org_id, buyer_phone) DO UPDATE
    SET updated_at = now()
  RETURNING id, quota_admitted INTO v_lead_id, v_admitted;

  RETURN QUERY SELECT v_lead_id, v_admitted, TRUE;
END $$;
REVOKE ALL ON FUNCTION public.reserve_and_create_lead(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_and_create_lead(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO service_role;

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
    name = CASE
      WHEN p_org_updates ? 'name' AND NULLIF(trim(p_org_updates->>'name'), '') IS NOT NULL
      THEN p_org_updates->>'name'
      ELSE name
    END,
    business_type = CASE
      WHEN p_org_updates ? 'business_type' AND NULLIF(trim(p_org_updates->>'business_type'), '') IS NOT NULL
      THEN p_org_updates->>'business_type'
      ELSE business_type
    END,
    website_knowledge = CASE
      WHEN p_org_updates ? 'website_knowledge' AND NULLIF(trim(p_org_updates->>'website_knowledge'), '') IS NOT NULL
      THEN p_org_updates->>'website_knowledge'
      ELSE website_knowledge
    END,
    catalog_pdf_name = CASE
      WHEN p_org_updates ? 'catalog_pdf_name' AND NULLIF(trim(p_org_updates->>'catalog_pdf_name'), '') IS NOT NULL
      THEN p_org_updates->>'catalog_pdf_name'
      ELSE catalog_pdf_name
    END,
    updated_at = now()
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
