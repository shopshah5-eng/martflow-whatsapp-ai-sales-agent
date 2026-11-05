-- ==============================================================================
-- MARTFLOW AI / LEADSY AI — STAGING SECURITY HARDENING ROLLBACK SCRIPT
-- Safely reverses triggers, restrictive policies, and function guards.
-- ==============================================================================

BEGIN;

-- 1. Remove profile privilege trigger & function
DROP TRIGGER IF EXISTS protect_profile_membership_fields ON public.profiles;
DROP FUNCTION IF EXISTS public.protect_profile_membership_fields();

-- 2. Remove product mutation restrictions
DROP POLICY IF EXISTS catalog_no_client_insert ON public.products;
DROP POLICY IF EXISTS catalog_no_client_update ON public.products;
DROP POLICY IF EXISTS catalog_no_client_delete ON public.products;

-- 3. Remove conversation/message/lead restrictions for catalog managers
DROP POLICY IF EXISTS catalog_managers_no_conversations ON public.conversations;
DROP POLICY IF EXISTS catalog_managers_no_messages ON public.messages;
DROP POLICY IF EXISTS catalog_managers_no_leads ON public.leads;
DROP FUNCTION IF EXISTS public.user_has_catalog_grant(UUID, UUID);
DROP FUNCTION IF EXISTS public.message_is_in_granted_catalog_org(UUID, UUID);

-- 4. Remove storage restrictions for catalogs bucket
DROP POLICY IF EXISTS catalog_storage_no_client_insert ON storage.objects;
DROP POLICY IF EXISTS catalog_storage_no_client_update ON storage.objects;
DROP POLICY IF EXISTS catalog_storage_no_client_delete ON storage.objects;

-- 5. Remove sensitive org fields trigger & function
DROP TRIGGER IF EXISTS protect_sensitive_org_fields ON public.organizations;
DROP FUNCTION IF EXISTS public.protect_sensitive_org_fields();

COMMIT;
