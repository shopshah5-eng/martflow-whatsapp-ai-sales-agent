# Security Audit Notes & Dependency Review

## 1. Spreadsheet Parser Remediation
- **Prior State**: The project used `xlsx` (SheetJS) `<=0.18.5`, which had two high-severity advisories:
  - GHSA-4r6h-8v6p-xvw6 (Prototype Pollution)
  - GHSA-5pgg-2g8v-p4x9 (Regular Expression Denial of Service - ReDoS)
- **Remediation**:
  - Uninstalled `xlsx`.
  - Installed `exceljs` (^4.4.0) to parse modern `.xlsx` workbooks and `.csv` files safely in memory via stream pipelines.
  - Legacy `.xls` (BIFF8 binary format) is explicitly rejected at upload time with an informative user-facing message instructing the user to upload modern `.xlsx` or `.csv`. This completely mitigates legacy binary parser vulnerabilities.
- **Transitive Dependency Advisories**:
  - `npm audit` reports 9 moderate advisories originating transitively through `exceljs -> archiver -> glob -> minimatch` and `exceljs -> uuid`.
  - Remediation via `npm audit fix --force` would downgrade `exceljs` to version `3.4.0` (a breaking change that lacks modern Node stream and ESM support).
  - In our architecture, ExcelJS is only used for read-only workbook and CSV parsing; the archive/zip generation features that invoke `glob` and `minimatch` are not executed by our catalog parser.
  - These advisories are tracked and documented rather than forcing a breaking downgrade.

## 2. HTTP Hardening Dependencies
- Installed `helmet` for default security headers (CSP, HSTS, X-Content-Type-Options, Frameguard).
- Installed `express-rate-limit` to protect public webhook endpoints and authentication routes from automated brute force and denial of service.

## 3. Dynamic Multi-Industry Catalog Sync & Anti-Hallucination
- **Prior State**: Uploading a new catalog (e.g., Astrology, Solar, Coaching) in the frontend failed to update the live WhatsApp bot because client-side Supabase writes to `demoOrgId` were blocked by Row-Level Security (RLS). Furthermore, past conversation messages about machinery remained in the database, causing Gemini to hallucinate previous products (liquid filling machines).
- **Remediation**:
  - Implemented atomic server-side `/api/catalog/sync` using `supabaseAdmin` service role to update tenant catalog products, business knowledge, and live demo bot state.
  - Automatically clears stale conversation messages upon new catalog upload so the AI conversation history starts clean.
  - Corrected Gemini model fallback chain from non-existent `gemini-3.8-flash` to active models: `['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-lite-latest']`.
  - Added anti-hallucination prompt instructions to immediately pivot away from past discussion topics when a customer inquires about their actual need.

## 4. WhatsApp Inbound Queueing & Reconnect Idempotency
- Replaced the dropping `inFlightSenders` lock with an async per-sender promise queue (`senderQueues`), ensuring rapid sequential messages from customers are processed in order and never dropped.
- Bound tenant WhatsApp instances to their respective organizations, removing cross-tenant socket fallbacks.

## 5. Billing & Reconciliation Authorization
- Direct UPI payments default to `pending_verification`. Approval is strictly restricted to platform superadmins via `x-platform-admin-key`, preventing self-approval by tenant owners.
- Razorpay payments verify orders server-side, validate HMAC SHA256 signatures with constant-time equality checks (`crypto.timingSafeEqual`), and prevent replay attacks.

## 6. Deterministic Data Migration & Rollback
- Comprehensive data migration script (`scripts/migrate_local_to_supabase.js`) migrates organizations, profiles, products, leads, conversations, messages, and payments with deterministic UUID mapping and pre-migration backups. Only successful inserts are tallied in report counts; errors are tracked without breaking batches.
- Migrated records are tagged with `is_new_insert: true` and `batch_id` in `legacy_id_mapping`.
- Rollback script (`scripts/rollback_migration.js`) selectively deletes only `is_new_insert: true` records, ensuring pre-existing Supabase production data is preserved.

## 7. Review Finding Remediations (PR #1 Verification)
- **Catalog Sync Authentication & Persistence**: Secured `/api/catalog/sync` behind `authenticate` middleware, preventing cross-tenant mutations. Implemented `MultiTenantDB.deleteScoped`, integrated `getSupabaseAdmin`, and ensured catalog and knowledge updates persist to both Supabase and local DB stores.
- **Baileys Lifecycle & Reconnect Loop**: Refactored `baileysManager.getInstance` to use dynamic property getters for `sock`, `isConnected`, and `state`, eliminating stale status reads. Prevented self-calling recursion on `disconnect`. Guarded `syncConnectedStatus` against triggering reconnects while already connecting.
- **Razorpay Order Capture Verification**: Added server-side verification against the Razorpay REST API (`/v1/payments/{id}`) when live keys are configured to verify `status === 'captured'`, order ID match, amount in paise, and currency (`INR`).
- **Media Attachment SSRF Defense**: Corrected `isPrivateOrReservedIP` to check `net.isIP` so valid domain names proceed to DNS pin checks rather than being falsely rejected as invalid IP literals. Routed all outbound media attachments through `getSafeAttachmentBuffer`.
- **Truthful Outbound Status**: Prevented fake `delivery_status: 'sent'` records in `WhatsAppAdapter`. Dispatches fail truthfully with clear error reporting if no provider or socket is active.
- **Call Scheduler Dossier**: Implemented `CallSchedulerService.generateLeadDossier` formatting buyer name, phone, location, product requirement, and confirmed appointment slot.
- **Schema & Quota Accounting**: Added idempotent `increment_leads_used` stored procedure to `supabase_schema.sql` and handled Supabase RPC `{ error }` objects without failing silently. Added fallback retry for `leads.requirement` column.
- **Frontend Initialization Integrity**: Declared `let sb` prior to `fetchPublicConfig()` to prevent JavaScript temporal dead zone errors.


