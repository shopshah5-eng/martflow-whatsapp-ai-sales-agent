-- STAGING ONLY until signup, membership and privileged RPCs are audited.
-- Restrictive policies compose with older permissive policies. Server-owned
-- provisioning must use a trusted role; this deliberately denies client inserts.
BEGIN;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profile_no_client_insert ON public.profiles;
CREATE POLICY profile_no_client_insert ON public.profiles AS RESTRICTIVE
  FOR INSERT TO anon, authenticated WITH CHECK (false);
DROP POLICY IF EXISTS profile_no_client_delete ON public.profiles;
CREATE POLICY profile_no_client_delete ON public.profiles AS RESTRICTIVE
  FOR DELETE TO anon, authenticated USING (false);

-- SECURITY INVOKER is intentional: a carefully audited SECURITY DEFINER
-- provisioning function runs under its owner; a direct client update does not.
CREATE OR REPLACE FUNCTION public.protect_profile_membership_fields()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') AND (
    to_jsonb(NEW)->'id' IS DISTINCT FROM to_jsonb(OLD)->'id' OR
    to_jsonb(NEW)->'org_id' IS DISTINCT FROM to_jsonb(OLD)->'org_id' OR
    to_jsonb(NEW)->'organization_id' IS DISTINCT FROM to_jsonb(OLD)->'organization_id' OR
    to_jsonb(NEW)->'role' IS DISTINCT FROM to_jsonb(OLD)->'role'
  ) THEN
    RAISE EXCEPTION 'Profile identity, workspace and role are server managed';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_profile_membership_fields ON public.profiles;
CREATE TRIGGER protect_profile_membership_fields BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_membership_fields();
COMMIT;
