-- STAGING ONLY: review against the actual schema and existing grants first.
-- Requires the profile, storage, product and conversation protections from the
-- security handoff. Never apply to production without explicit approval.
BEGIN;
CREATE TABLE IF NOT EXISTS public.catalog_admin_accounts (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  max_clients integer NOT NULL DEFAULT 5 CHECK (max_clients BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.catalog_assignment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES public.catalog_admin_accounts(user_id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  requested_email text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admin_id, org_id)
);
ALTER TABLE public.catalog_admin_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_assignment_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_admin_accounts, public.catalog_assignment_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.catalog_admin_accounts, public.catalog_assignment_requests TO service_role;

CREATE OR REPLACE FUNCTION public.catalog_admin_set(p_user_id uuid, p_max_clients integer, p_enabled boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_count integer;
BEGIN
  IF p_user_id IS NULL OR p_enabled IS NULL OR (p_max_clients IS NULL OR p_max_clients NOT BETWEEN 1 AND 100) THEN RAISE EXCEPTION 'Invalid admin configuration'; END IF;
  IF NOT p_enabled THEN
    PERFORM 1 FROM public.catalog_admin_accounts WHERE user_id=p_user_id FOR UPDATE;
    DELETE FROM public.catalog_management_grants WHERE user_id=p_user_id;
    DELETE FROM public.catalog_admin_accounts WHERE user_id=p_user_id;
    RETURN;
  END IF;
  INSERT INTO public.catalog_admin_accounts(user_id,max_clients) VALUES(p_user_id,p_max_clients)
  ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM public.catalog_admin_accounts WHERE user_id=p_user_id FOR UPDATE;
  SELECT (SELECT count(*) FROM public.catalog_management_grants WHERE user_id=p_user_id) + (SELECT count(*) FROM public.catalog_assignment_requests WHERE admin_id=p_user_id AND status='pending') INTO v_count;
  IF v_count > p_max_clients THEN RAISE EXCEPTION 'Limit is below assigned and pending clients'; END IF;
  UPDATE public.catalog_admin_accounts SET max_clients=p_max_clients WHERE user_id=p_user_id;
END $$;

CREATE OR REPLACE FUNCTION public.catalog_admin_request(p_admin_id uuid, p_org_id uuid, p_client_email text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_limit integer; v_count integer;
BEGIN
  IF p_client_email IS NULL OR length(p_client_email) > 254 THEN RAISE EXCEPTION 'Invalid client email'; END IF;
  SELECT max_clients INTO v_limit FROM public.catalog_admin_accounts WHERE user_id=p_admin_id FOR UPDATE;
  IF v_limit IS NULL THEN RAISE EXCEPTION 'Admin access is unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM public.catalog_management_grants WHERE user_id=p_admin_id AND org_id=p_org_id) THEN RAISE EXCEPTION 'Already assigned'; END IF;
  SELECT (SELECT count(*) FROM public.catalog_management_grants WHERE user_id=p_admin_id) +
         (SELECT count(*) FROM public.catalog_assignment_requests WHERE admin_id=p_admin_id AND status='pending' AND org_id<>p_org_id) INTO v_count;
  IF v_count >= v_limit THEN RAISE EXCEPTION 'Client limit reached'; END IF;
  INSERT INTO public.catalog_assignment_requests(admin_id,org_id,status,requested_email) VALUES(p_admin_id,p_org_id,'pending',p_client_email)
  ON CONFLICT (admin_id,org_id) DO UPDATE SET status='pending',requested_email=EXCLUDED.requested_email,created_at=now();
END $$;

CREATE OR REPLACE FUNCTION public.catalog_admin_review(p_admin_id uuid, p_org_id uuid, p_approve boolean, p_actor text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_limit integer; v_count integer; v_status text;
BEGIN
  IF p_approve IS NULL OR p_actor IS NULL THEN RAISE EXCEPTION 'Invalid review'; END IF;
  SELECT max_clients INTO v_limit FROM public.catalog_admin_accounts WHERE user_id=p_admin_id FOR UPDATE;
  IF v_limit IS NULL THEN RAISE EXCEPTION 'Admin access is unavailable'; END IF;
  SELECT status INTO v_status FROM public.catalog_assignment_requests WHERE admin_id=p_admin_id AND org_id=p_org_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'pending' THEN RAISE EXCEPTION 'Pending request not found'; END IF;
  IF p_approve THEN
    SELECT count(*) INTO v_count FROM public.catalog_management_grants WHERE user_id=p_admin_id;
    IF v_count >= v_limit AND NOT EXISTS (SELECT 1 FROM public.catalog_management_grants WHERE user_id=p_admin_id AND org_id=p_org_id) THEN RAISE EXCEPTION 'Client limit reached'; END IF;
    INSERT INTO public.catalog_management_grants(user_id,org_id,granted_by) VALUES(p_admin_id,p_org_id,p_actor) ON CONFLICT (org_id,user_id) DO NOTHING;
  END IF;
  UPDATE public.catalog_assignment_requests SET status=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END WHERE admin_id=p_admin_id AND org_id=p_org_id;
END $$;

CREATE OR REPLACE FUNCTION public.catalog_admin_remove(p_admin_id uuid, p_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.catalog_admin_accounts WHERE user_id=p_admin_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Admin access is unavailable'; END IF;
  DELETE FROM public.catalog_management_grants WHERE user_id=p_admin_id AND org_id=p_org_id;
  DELETE FROM public.catalog_assignment_requests WHERE admin_id=p_admin_id AND org_id=p_org_id;
END $$;
REVOKE ALL ON FUNCTION public.catalog_admin_set(uuid,integer,boolean), public.catalog_admin_request(uuid,uuid,text), public.catalog_admin_review(uuid,uuid,boolean,text), public.catalog_admin_remove(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.catalog_admin_set(uuid,integer,boolean), public.catalog_admin_request(uuid,uuid,text), public.catalog_admin_review(uuid,uuid,boolean,text), public.catalog_admin_remove(uuid,uuid) TO service_role;
COMMIT;
