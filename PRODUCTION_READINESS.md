# Production Readiness & Security Hardening Status

## Status: Hardened for Staging Verification (Do not merge or deploy to production yet)

This patch resolves critical security vulnerabilities, establishes an authoritative Supabase backend, provides atomic quota and lead management, adds durable payment replay protection, hardens multi-worker WhatsApp processing, and configures the instance for **DIRECT UPI ONLY** launch mode (Razorpay deferred).

All automated integration and regression tests (`npm test`) pass cleanly. The database migrations and application changes must be verified against a backed-up staging Supabase clone before production deployment.

---

### Key Production Blockers Resolved in this Patch

1. **PostgreSQL RPC Ambiguous Column Error 42702 & Concurrency Race Fix**:
   - Resolved PL/pgSQL variable collision on `quota_admitted` in `reserve_and_create_lead` by declaring unambiguous return columns (`out_lead_id`, `out_quota_admitted`, `out_is_new`) and qualifying all table references (`leads.id`, `leads.quota_admitted`).
   - Implemented `SELECT ... FROM public.organizations FOR UPDATE` as Step 1 before checking existing leads or quota, eliminating concurrent webhook races where multiple simultaneous inbound messages could bypass quotas.
   - Normalized phone numbers consistently to 10-digit suffixes before conflict checks and inserts.
   - Added automated deduplication of duplicate historical leads before creating `idx_leads_org_buyer_phone`.

2. **Supabase WhatsApp Worker Startup & Resilience**:
   - Added `import crypto from 'crypto';` to `server.js` to eliminate unhandled promise rejections on default worker initialization when `WORKER_ID` is omitted.
   - Upgraded both `server.js` and `TenantBaileysInstance` to route inbound messages through the transactional `reserve_and_create_lead` RPC.
   - Honored manual takeover mode (`mode === 'manual' || mode === 'human'`) in Supabase and local state, muting AI auto-replies while takeover is active.

3. **Authoritative Supabase Auth & Client Isolation**:
   - Refactored `signUp` in `src/auth/authService.js` to adopt the trigger-provisioned tenant and profile from `handle_new_user_provisioning`, with robust fallback provisioning if the trigger is missing, and automatic cleanup (`auth.admin.deleteUser`) if downstream operations fail.
   - Isolated `login` in `src/auth/authService.js` by using a disposable Supabase client (`persistSession: false`) for password verification, guaranteeing `repository.supabase` service-role credentials and session headers are never mutated by tenant logins.
   - Made `/api/auth/me` authoritative and asynchronous via `repository.getProfileById(req.userId)`.

4. **Direct UPI Launch Mode & Deferred Razorpay**:
   - In accordance with launch strategy, **DIRECT UPI ONLY** is the active payment gateway.
   - Razorpay UI and checkout endpoints (`/payments/razorpay/create-order` and `/payments/razorpay/verify`) return `503 Service Unavailable` with instructions to use Direct UPI.
   - Direct UPI submissions (`/payments/upi-verify`) and admin reconciliation (`/admin/payments/reconcile`) persist transaction records durably in `public.payments` and `public.organizations` with audit logging.
   - Fixed `ADJUST999` coupon amount in UI and API to calculate the ₹9,000 payable balance (₹999 deposit adjusted against the ₹9,999 launch plan).
   - Removed premature `localStorage.removeItem('mf_pending_utr')`, preserving offline or pre-signup UTR submissions until the backend confirms HTTP 200.

5. **Cross-Tenant Secret Isolation & Immutability**:
   - Hardened `check_org_billing_fields_immutability()` in `supabase_schema.sql` and `scripts/production_safety_migration.sql` to block authenticated tenants from modifying `plan_status`, `trial_ends_at`, `custom_quote_inr`, `quote_code`, `monthly_lead_limit`, `leads_used`, `webhook_key`, `wa_worker_id`, and `wa_worker_heartbeat`.
   - Removed `geminiApiKey` from `/api/config` and `/api/settings` responses and eliminated cross-tenant process-global mutation of `process.env.GEMINI_API_KEY`.
   - Secured `/api/dry-run-chat` with `authenticate` and isolated session history per tenant/user in-memory rather than relying on a global singleton.
   - Added authentication middleware to `/api/catalog/extract-ai`, `/api/callbacks/confirm-time`, and `/api/callbacks/request-demo`.

6. **Storage Security, SSRF & XSS Hardening**:
   - Replaced plain `fetch(url)` in `baileysManager.js:getPdfBuffer` with `getSafeAttachmentBuffer` (enforcing DNS pinning, private/reserved IP egress blocks, and 10MB limits).
   - Replaced raw string concatenation of database strings in `public/index.html` with safe DOM APIs (`document.createElement('img')`, `textContent`).
   - Added `/api/*` rewrite rule and SPA routing in `netlify.toml`.

---

### Step-by-Step Staging Verification Instructions

Before applying `scripts/production_safety_migration.sql` or deploying to production:

1. **Staging Clone Setup**:
   - Clone your production Supabase project to a staging environment:
     ```bash
     # Take a fresh backup of the database
     pg_dump -h <production-host> -U postgres -d postgres > backup_prod.sql
     # Restore into isolated staging clone
     psql -h <staging-host> -U postgres -d postgres < backup_prod.sql
     ```
2. **Execute Safety Migration on Staging**:
   - Apply `scripts/production_safety_migration.sql` in the Supabase SQL editor on the staging clone.
   - Confirm that the tables, columns, indexes, and RPCs are created:
     ```sql
     SELECT column_name FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'requirement';
     SELECT indexname FROM pg_indexes WHERE tablename = 'leads' AND indexname = 'idx_leads_org_buyer_phone';
     SELECT proname FROM pg_proc WHERE proname IN ('reserve_lead_quota', 'reserve_and_create_lead', 'replace_tenant_catalog');
     ```
3. **Verify Staging Workflows**:
   - **Unknown Number WhatsApp Message**: Connect test WhatsApp number, send an inbound message from a previously unseen phone number, verify lead is created with `quota_admitted = true`, and AI reply is delivered.
   - **Disconnect / Reconnect**: Disconnect from dashboard, verify credentials and session are cleared, and reconnect via QR or pairing code.
   - **Catalog Upload**: Ingest a new catalog spreadsheet; verify RAM cache invalidation and database update while preserving `website_knowledge`.
   - **Direct UPI Flow**: Submit a test UTR reference; confirm payment is marked `pending_verification`. Reconcile payment using `/admin/payments/reconcile` with platform secret; verify organization is activated.
4. **Deploy Application**:
   - Once all staging checks succeed, deploy application workers alongside the schema update.
