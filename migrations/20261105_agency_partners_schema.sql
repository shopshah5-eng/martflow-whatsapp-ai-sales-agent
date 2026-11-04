-- ==============================================================================
-- MARTFLOW AI — AGENCY PARTNER & RESELLER TIER SCHEMA MIGRATION
-- Run manually in Supabase SQL Editor when ready.
-- ==============================================================================

-- 1. Agency Partners Table (Strict RLS enabled)
CREATE TABLE IF NOT EXISTS public.agency_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agency_name TEXT NOT NULL,
  agency_logo_url TEXT,
  support_whatsapp TEXT NOT NULL,
  support_email TEXT NOT NULL,
  max_slots INTEGER NOT NULL DEFAULT 5,
  plan_status TEXT NOT NULL DEFAULT 'active' CHECK (plan_status IN ('active', 'suspended', 'expired')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- 2. Strict Row-Level Security
ALTER TABLE public.agency_partners ENABLE ROW LEVEL SECURITY;

-- Agency users can ONLY select their own agency profile
DROP POLICY IF EXISTS agency_partner_select_own ON public.agency_partners;
CREATE POLICY agency_partner_select_own ON public.agency_partners
  FOR SELECT
  USING (user_id = auth.uid());

-- NOTE: No client INSERT, UPDATE, or DELETE policies exist.
-- All writes (slot adjustments, status changes) occur ONLY via server-side endpoints
-- using the Supabase Service Role Key on Render.

-- 3. Link Client Organizations to Agency
ALTER TABLE public.organizations 
ADD COLUMN IF NOT EXISTS parent_agency_id UUID REFERENCES public.agency_partners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orgs_parent_agency ON public.organizations(parent_agency_id);

-- 4. Rollback script (Keep for reference):
-- ALTER TABLE public.organizations DROP COLUMN IF EXISTS parent_agency_id;
-- DROP TABLE IF EXISTS public.agency_partners CASCADE;

