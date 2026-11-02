# Production Readiness & Security Hardening Status

## Status: Hardened for Staging Verification (Do not merge or deploy to production yet)

This patch resolves critical security vulnerabilities, establishes an authoritative Supabase backend, provides atomic quota and lead management, adds durable payment replay protection, and hardens multi-worker WhatsApp queue processing.

All 51 automated tests (`npm test`) pass cleanly. The database migrations and application changes must be verified against a backed-up staging Supabase clone before production deployment.

---

### Completed Engineering Work in this Patch

1. **Authoritative Supabase Authentication & Token Compatibility**:
   - Implemented server-side Supabase Auth JWT token validation in `src/middleware/authMiddleware.js` via `sb.auth.getUser()`, resolving profile and authoritative tenant membership.
   - Refactored `signUp` and `login` in `src/auth/authService.js` to execute against Supabase Auth (`sb.auth.admin.createUser` and `sb.auth.signInWithPassword`) and PostgreSQL tables when running in production (`NODE_ENV === 'production'` and `USE_LOCAL_DB !== 'true'`).
   - Removed all caller-supplied `supabaseId` account takeover vectors; only verified identity credentials from the auth provider are trusted.
   - Eliminated stale local fallback in production: revoked or non-existent memberships strictly fail closed (401/403/503).

2. **Strict Quota Enforcement Across Plan Boundaries**:
   - `active`: Verified with `COALESCE(leads_used, 0) < COALESCE(monthly_lead_limit, 999999)`. When the monthly limit is reached, quota reservation is strictly rejected (`quota_admitted = false`).
   - `trial`: Enforces both active trial timeframe (`trial_ends_at IS NULL OR trial_ends_at > now()`) AND volume threshold (`leads_used < monthly_lead_limit`, default 25). Expired trials are rejected.
   - `expired`: Strictly fails closed without exception.
   - Idempotent and transactional: implemented in `reserve_lead_quota` and `reserve_and_create_lead` stored procedures with row-level locking (`SELECT ... FOR UPDATE`).

3. **Concurrency-Safe Lead Creation & Deduplication**:
   - Added unique database constraint `idx_leads_org_buyer_phone ON public.leads (org_id, buyer_phone)` in both `scripts/production_safety_migration.sql` and `supabase_schema.sql`.
   - `reserve_and_create_lead` utilizes `ON CONFLICT (org_id, buyer_phone) DO UPDATE` to prevent race conditions across concurrent webhook workers, guaranteeing that duplicate calls resolve the existing lead without double-deducting lead quota.

4. **Schema Completeness & Demo Knowledge Preservation**:
   - Added missing columns to existing-database migration (`scripts/production_safety_migration.sql`):
     * `ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS requirement TEXT;`
     * `ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS wa_worker_id TEXT;`
     * `ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS wa_worker_heartbeat TIMESTAMPTZ;`
     * `ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS quote_code TEXT;`
   - Updated `replace_tenant_catalog` stored procedure and `/api/catalog/sync` to preserve existing `website_knowledge` and demo catalog assets when optional fields are omitted or blank.

5. **Durable Payment Storage & Replay Attack Prevention**:
   - Routed Razorpay order creation (`/payments/razorpay/create-order`) and verification (`/payments/razorpay/verify`) through durable repository storage (`public.payments`).
   - Added unique constraint `idx_payments_razorpay_payment_id ON public.payments (razorpay_payment_id)` and durable lookup checks to guarantee replay protection: repeated payment verifications return HTTP 409 Conflict.

6. **Multi-Worker WhatsApp Outbound Queue & Distributed Heartbeat**:
   - Transitioned `pollOutboundQueue` in `server.js` to atomic claiming:
     ```javascript
     .update({ status: 'processing' })
     .eq('id', item.id)
     .eq('status', 'pending')
     ```
     ensuring that exactly one worker process can claim and dispatch a queued message.
   - Added worker lease claiming in `pollCommands` and per-worker ID tracking (`wa_worker_id`, `wa_worker_heartbeat`) to prevent conflicting session operations.

7. **Comprehensive Integration Test Suite**:
   - Added `tests/database_and_production_integration.test.js` covering:
     * Old-schema upgrade DDL verification and column presence
     * Quota boundaries across active (under/at limit), trial (valid/expired), and expired plans
     * Concurrent lead deduplication without double quota deductions
     * End-to-end Supabase Auth JWT token validation and revoked user 403 enforcement
     * Durable Razorpay order creation, verification, and HTTP 409 replay attack rejection
     * Multi-worker outbound queue atomic claiming

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
2. **Execute Safety Migration**:
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
   - **Razorpay Sandbox**: Execute a test payment with Razorpay test keys; verify `public.payments` record is updated to `verified`, workspace is activated, and repeating the verify call returns 409 Conflict.
4. **Deploy Application**:
   - Once all staging checks succeed, deploy application workers alongside the schema update.
