# Production readiness and deployment notes

## Status: hardening in progress (do not merge or deploy to production yet)

This patch resolves critical security vulnerabilities and hardens multi-tenant isolation, but the production backend requires deployment coordination and staging verification. Local regression tests now pass (45/45), but live Supabase, payments, and WhatsApp providers require staging testing before production deployment.

### Completed engineering work in this patch

1. **Account Takeover Elimination**:
   - Removed caller-controlled `supabaseId` parameter from `handleGoogleAuth` and `/api/auth/google`.
   - Strictly enforced verified provider identity (`data.user.id`) from `sb.auth.getUser()`.
   - Eliminated stale local membership fallbacks in production: `repository.getMembership`, `getOrganizationById`, and profile lookups fail closed (403/503) without resurrecting legacy local JSON state.

2. **Atomic & Idempotent Lead Creation & Quota Reservation**:
   - Replaced multi-step quota reservation and separate lead insertion with transactional `public.reserve_and_create_lead` RPC in PostgreSQL (`scripts/production_safety_migration.sql` and `supabase_schema.sql`).
   - Uses `FOR UPDATE` row lock on `organizations` to prevent concurrency races across multiple workers.
   - Guaranteed idempotency: repeated messages from the same buyer resolve existing lead records without double-deducting quota.
   - Fails closed: missing RPCs or database errors withhold AI replies and log clear error diagnostics.

3. **Transactional Catalog Sync & Demo Knowledge Preservation**:
   - Removed non-transactional table-level delete/insert fallback in `/api/catalog/sync`; RPC errors fail visibly (500/503).
   - Preserves base demo catalog knowledge in `catalog_knowledge.json` when new catalog knowledge is synced.
   - Added automatic RAM cache invalidation across `CatalogService` operations (`ingestCatalog`, `updateProduct`, `deleteProduct`).

4. **Security Regression Suite**:
   - Added regression tests in `tests/regression_safety.test.js` covering:
     * Forged `supabaseId` account takeover rejection
     * Revoked tenant membership 403 enforcement
     * Missing Supabase in production fail-closed (503) behavior
     * Visible failure on catalog transaction errors
     * Quota RPC error fail-closed behavior

### Remaining engineering work

1. **Authoritative Backend Migration**:
   - Unify remaining legacy local signup/login endpoints with Supabase Auth to eliminate dual-write stores.
2. **Reversible Data Migration**:
   - Complete and verify an idempotent, batch-scoped migration of existing local identities and data to Supabase.
   - **Live migration and rollback remain deliberately disabled** in this patch until executed against a backed-up staging Supabase clone.
3. **Multi-Worker WhatsApp Queue**:
   - Make WhatsApp session ownership and queue claiming safe across multiple server instances with distributed locks.
4. **Durable Payment Storage**:
   - Move payment orders, verification, and webhook replay protection to durable transactional Supabase tables with Razorpay sandbox verification.
5. **Browser-Direct Writes Audit**:
   - Complete inventory of frontend Supabase client writes to ensure all mutations route through authenticated API endpoints.
6. **Network & SSRF Verification**:
   - Validate media retrieval and SSRF protections in IPv4/IPv6 dual-stack cloud environments.

## SQL and deployment precautions

`scripts/production_safety_migration.sql` contains database changes for an **existing** Supabase deployment; the equivalent changes are also in `supabase_schema.sql` for fresh installations. The SQL must be reviewed and tested on a disposable clone first, with a verified backup and rollback plan. Applying only the code without the SQL will cause catalog sync and WhatsApp quota checks to fail closed. Coordinate and deploy schema and application changes together only after completing staging verification.

Local regression tests: `npm test` (45/45 passing). Tests use mocks/local storage and do not prove live Supabase RLS, payment capture, Meta Cloud, or live WhatsApp behavior.
