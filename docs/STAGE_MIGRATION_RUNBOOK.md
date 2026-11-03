# MartFlow AI — Staging Database Migration & Rollback Runbook

**Environment:** Staging / Production Pre-Flight  
**Classification:** Operational Security & Database Reliability  
**Target Schema:** `scripts/production_safety_migration.sql`  
**Migration Tool:** `scripts/migrate_local_to_supabase.js`  
**Rollback Safeguard:** `scripts/rollback_migration.js` (Fail-Closed Safety Gate)  

---

## 1. Prerequisites & Safety Pre-Flight

> [!CAUTION]
> **NEVER** apply migration scripts directly to production without completing the staging validation steps and verifying an immutable backup snapshot.

1. **Verify Environment Variables:**
   ```bash
   # Ensure target environment is explicitly configured
   echo $SUPABASE_URL
   echo $SUPABASE_SERVICE_ROLE_KEY
   ```
2. **Take an Immutable Staging/Production Snapshot:**
   ```bash
   # Create a timestamped logical backup of PostgreSQL / Supabase
   pg_dump --clean --if-exists --no-owner --no-privileges \
     -h <db-host> -U postgres -d postgres > backups/pre_migration_backup_$(date +%Y%m%d_%H%M%S).sql
   ```
3. **Verify Local Data File Backup:**
   `scripts/migrate_local_to_supabase.js` automatically creates a timestamped JSON backup in the `backups/` directory before any operation.

---

## 2. Dry-Run Verification

Before applying any DDL or data migration, run the migration in non-destructive `--dry-run` mode:

```bash
node scripts/migrate_local_to_supabase.js --dry-run
```

### Verification Criteria:
- [ ] Schema validation reports 0 syntax errors.
- [ ] ID mapping table maps all legacy `mf_...` entities to UUIDs with referential integrity.
- [ ] Lead deduplication cleanly merges conversation foreign keys with tie-breaking rules.
- [ ] No unhandled rejections or foreign key violations reported.

---

## 3. SQL Schema Migration Execution Order

Apply `scripts/production_safety_migration.sql` via Supabase SQL Editor or `psql` using administrative credentials:

### Key Operational Steps within the Migration:
1. **Mandatory Column Provisioning:**
   - `leads.quota_admitted` (BOOLEAN, default `true`)
   - `leads.requirement` (TEXT)
   - `organizations.wa_worker_id` (TEXT)
   - `organizations.wa_worker_heartbeat` (TIMESTAMPTZ)
   - `organizations.quote_code` (TEXT) — *Critical for billing immutability trigger*
   - `payments.quote_code` (TEXT)
2. **Referential-Integrity Safe Lead Deduplication:**
   - Re-maps `conversations.lead_id` and `call_requests.lead_id` from duplicate leads to the newest surviving lead using deterministic timestamp + UUID tie-breakers.
   - Deletes redundant lead records safely.
   - Applies unique index `idx_leads_org_buyer_phone ON public.leads (org_id, buyer_phone)`.
3. **Legacy Permissive Policy Cleanup:**
   - Drops `whatsapp_sessions_allow_all`, `Allow all wa_outbound_queue access`, and permissive catalog storage policies.
4. **Atomic RPC Deployment:**
   - `reserve_and_create_lead` with distinct output column aliases (`out_lead_id`, `out_quota_admitted`, `out_is_new`) to prevent PostgreSQL 42702 ambiguous column errors.
   - `reserve_lead_quota` with strict trial vs. active plan limits.
   - Immutability trigger `trg_org_billing_immutability` protecting `plan_status`, `monthly_lead_limit`, and `quote_code`.

---

## 4. Post-Migration Verification Checklist

Execute the automated integration suite against the staging database:

```bash
NODE_ENV=test node --test tests/database_and_production_integration.test.js
```

Verify the following:
- [ ] `reserve_and_create_lead` successfully handles concurrent inserts for the same phone without duplicate errors.
- [ ] RLS policies strictly isolate Tenant A from Tenant B (`leads`, `products`, `conversations`, `payments`).
- [ ] Unauthenticated or forged `supabaseId` tokens fail closed with 401/403.
- [ ] Webhook requests lacking valid `webhook_key` are rejected with 401.
- [ ] Manual takeover state pauses AI replies immediately.

---

## 5. Rollback & Emergency Disaster Recovery Plan

If unexpected regressions or unrecoverable schema conflicts occur during staging or an approved maintenance window:

1. **Safety Notice on `scripts/rollback_migration.js`:**
   By design, automated script-based rollback is disabled (`fail-closed`) to prevent accidental destruction of production data.
2. **Point-In-Time Restore Procedure:**
   Restore from the verified snapshot created in Step 1:
   ```bash
   psql -h <db-host> -U postgres -d postgres -f backups/pre_migration_backup_<TIMESTAMP>.sql
   ```
3. **Application Redeployment:**
   Revert the application deployment to the previous stable release commit.
4. **Post-Restore Integrity Check:**
   Run `npm test` and verify that the database connection and core WhatsApp workers resume with clean socket credentials.
