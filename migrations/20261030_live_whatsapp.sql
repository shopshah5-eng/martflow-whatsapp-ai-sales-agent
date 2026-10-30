-- 1. Ensure organizations has all live WhatsApp and automation columns
ALTER TABLE public.organizations 
  ADD COLUMN IF NOT EXISTS bot_whatsapp_number text,
  ADD COLUMN IF NOT EXISTS owner_alert_number text,
  ADD COLUMN IF NOT EXISTS wa_pairing_method text DEFAULT 'qr',
  ADD COLUMN IF NOT EXISTS wa_command text,
  ADD COLUMN IF NOT EXISTS wa_command_payload jsonb,
  ADD COLUMN IF NOT EXISTS wa_status text DEFAULT 'disconnected',
  ADD COLUMN IF NOT EXISTS wa_connected_number text,
  ADD COLUMN IF NOT EXISTS wa_qr_data_url text,
  ADD COLUMN IF NOT EXISTS wa_pairing_code text,
  ADD COLUMN IF NOT EXISTS wa_worker_heartbeat timestamptz,
  ADD COLUMN IF NOT EXISTS wa_auto_reply boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS wa_auto_pdf boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS wa_owner_alerts boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS wa_welcome_message text;

-- 2. Create wa_outbound_queue table
CREATE TABLE IF NOT EXISTS public.wa_outbound_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  to_phone text NOT NULL,
  message_text text,
  pdf_url text,
  pdf_name text,
  status text DEFAULT 'pending',
  error_text text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_outbound_org ON public.wa_outbound_queue(org_id);
CREATE INDEX IF NOT EXISTS idx_wa_outbound_status ON public.wa_outbound_queue(status);

-- 3. Enable RLS on wa_outbound_queue
ALTER TABLE public.wa_outbound_queue ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'wa_outbound_queue' AND policyname = 'wa_outbound_queue_isolation'
  ) THEN
    CREATE POLICY wa_outbound_queue_isolation ON public.wa_outbound_queue
      FOR ALL
      USING (org_id = current_user_org_id())
      WITH CHECK (org_id = current_user_org_id());
  END IF;
END
$$;

-- 4. Enable Realtime on tables
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.organizations;
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.leads;
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.wa_outbound_queue;
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.call_requests;
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

-- 5. Set replica identity to FULL for realtime tables so updates contain all columns
ALTER TABLE public.organizations REPLICA IDENTITY FULL;
ALTER TABLE public.leads REPLICA IDENTITY FULL;
ALTER TABLE public.conversations REPLICA IDENTITY FULL;
ALTER TABLE public.messages REPLICA IDENTITY FULL;
ALTER TABLE public.wa_outbound_queue REPLICA IDENTITY FULL;
ALTER TABLE public.call_requests REPLICA IDENTITY FULL;
