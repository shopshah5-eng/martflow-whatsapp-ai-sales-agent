# Production readiness and deployment notes

## Status: not ready to deploy

This patch reduces several risks but does **not** complete the production backend. Do not merge or deploy solely on the basis of the local tests. In particular, the frontend uses Supabase Auth while the API expects a custom token; signup, most services and payments use a local JSON database, while the WhatsApp worker uses Supabase. These are not a single durable source of truth. Middleware now fails closed when its authoritative lookup fails, so legacy local signup/login tokens may be rejected when Supabase is enabled. Do not work around that by re-enabling fallback authorization.

### Remaining engineering work

1. Migrate signup, login, profile provisioning, lead/catalog/conversation/payment services and both WhatsApp providers to one authoritative Supabase repository. Verify Supabase access tokens server-side and derive tenant and role from trusted membership records. Remove production reliance on local JSON and eliminate the dual-write mirror. Preserve local development explicitly and separately.
2. Complete and verify an idempotent, batch-scoped migration of existing data and identities. Reconcile every record against the target schema and preserve before-images; implement and test batch-specific rollback. **Live migration and rollback are deliberately disabled** in this patch. The dry run does not validate Supabase schema, permissions or conflicts.
3. Make quota reservation, lead creation, and quota admission one transaction with idempotency for concurrent workers and repeated buyer messages. The current reservation is atomic, but separate from lead insert; a failed insert may consume quota and multiple workers may create duplicate leads.
4. Make WhatsApp session ownership and queue claiming safe across multiple server instances. Verify lifecycle, manual takeover, quota, delivery failure handling, and credential backup/delete races across workers. QR-linked WhatsApp and Meta Cloud both need real end-to-end tests; no automatic reply guarantee can be made from unit tests.
5. Move payment orders, verification, activation and replay protection to durable, transactional storage. Confirm the business's actual plan prices, deposit handling and entitlements; run Razorpay sandbox tests including callback failures and replay. The local payment records still cannot safely coordinate multiple processes.
6. Inventory all browser-direct Supabase writes and SQL grants/RLS, especially organization settings, payment history and catalog editing. This patch restricts direct product/payment writes and self-assignment of profile tenants; existing frontend paths may need to be replaced with authenticated API calls.
7. Test media retrieval, IPv6 behavior, tenant isolation and SSRF defenses in the intended hosting environment. The secure fetcher currently requires a public IPv4 address. Review direct file/media handling in legacy paths too.

## SQL and deployment precautions

`scripts/production_safety_migration.sql` contains database changes for an **existing** Supabase deployment; the equivalent changes are also in `supabase_schema.sql` for fresh installations. The SQL has not been run against a live or staging Supabase instance in this review. It changes RLS and signup defaults, and introduces required catalog/quota RPCs and `leads.quota_admitted`. It must be reviewed and tested on a disposable clone first, with a verified backup and rollback plan. Applying only the code without the SQL can cause catalog sync and WhatsApp quota checks to fail closed. Applying the SQL without adapting existing clients can stop their direct writes. Coordinate and deploy schema and application changes together only after completing the backend work above.

Local regression tests: `npm test`. They use mocks/local storage and do not prove live Supabase RLS, payment capture, Meta Cloud or WhatsApp behavior.
