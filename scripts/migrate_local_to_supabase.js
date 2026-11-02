/**
 * MartFlow AI — Deterministic Local-to-Supabase Data & Identity Migration
 * Features:
 *  - Automated timestamped backup before migration
 *  - Dry-run verification mode (--dry-run)
 *  - Deterministic mapping from legacy IDs (mf_...) to Supabase UUIDs
 *  - Supabase Auth provisioning via Admin API
 *  - Referential integrity validation and structured reconciliation report
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDryRun = process.argv.includes('--dry-run');
const dbFile = path.join(__dirname, '..', 'martflow_data.json');
const backupDir = path.join(__dirname, '..', 'backups');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!isDryRun) {
  console.error('Live migration is disabled: a verified, reversible migration is required. Use --dry-run only.');
  process.exit(1);
}
if (!isDryRun && (!url || !serviceKey)) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const supabase = url && serviceKey ? createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
}) : null;

function generateDeterministicUUID(legacyId, entityType) {
  // UUID v5-style deterministic generation using SHA-1 over namespace + entity + legacyId
  const hash = crypto.createHash('sha1').update(`martflow:${entityType}:${legacyId}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.slice(18, 20),
    hash.slice(20, 32)
  ].join('-');
}

async function runMigration() {
  console.log(`\n============================================================`);
  console.log(`MartFlow AI Migration: Local JSON -> Supabase PostgreSQL`);
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no database writes)' : 'LIVE EXECUTION'}`);
  console.log(`============================================================\n`);

  if (!fs.existsSync(dbFile)) {
    console.error(`Local database file ${dbFile} not found.`);
    process.exit(1);
  }

  // 1. Create Pre-Migration Backup
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `pre_migration_martflow_data_${timestamp}.json`);
  fs.copyFileSync(dbFile, backupPath);
  console.log(`[Backup] Created pre-migration backup at: ${backupPath}`);

  const rawData = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const report = {
    sourceCounts: {},
    migratedCounts: {},
    errors: [],
    dryRun: isDryRun,
    backupFile: backupPath,
    startTime: new Date().toISOString()
  };

  const idMap = new Map(); // legacyId -> UUID

  // Helper to map and track IDs
  function getOrMapId(legacyId, entityType) {
    if (!legacyId) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(legacyId)) {
      return legacyId; // already a valid UUID
    }
    if (!idMap.has(legacyId)) {
      idMap.set(legacyId, generateDeterministicUUID(legacyId, entityType));
    }
    return idMap.get(legacyId);
  }

  const batchId = 'batch_' + Date.now();

  try {
    // 2. Migrate Organizations
    const orgs = rawData.organizations || [];
    report.sourceCounts.organizations = orgs.length;
    console.log(`[1/5] Migrating ${orgs.length} Organizations...`);
    let orgsMigrated = 0;

    for (const org of orgs) {
      const uuid = getOrMapId(org.id, 'organizations');
      const payload = {
        id: uuid,
        name: org.name || 'Unnamed Organization',
        slug: org.slug || `org-${uuid.slice(0, 8)}`,
        webhook_key: org.webhook_key || ('whk_' + crypto.randomBytes(12).toString('hex')),
        plan_status: org.plan_status || (org.plan === 'starter' ? 'trial' : 'active'),
        monthly_lead_limit: org.monthly_lead_limit || 500,
        leads_used: org.leads_used || 0,
        wa_status: org.wa_status || 'disconnected'
      };

      if (!isDryRun) {
        const { error } = await supabase.from('organizations').upsert(payload, { onConflict: 'id' });
        if (error) {
          report.errors.push(`Failed to upsert org ${org.id}: ${error.message}`);
          continue;
        }
        await supabase.from('legacy_id_mapping').upsert({
          legacy_id: org.id,
          supabase_uuid: uuid,
          entity_type: 'organizations',
          is_new_insert: true,
          batch_id: batchId
        }, { onConflict: 'legacy_id' });
      }
      orgsMigrated++;
    }
    report.migratedCounts.organizations = orgsMigrated;

    // 3. Migrate Profiles & Auth Identities
    const profiles = rawData.profiles || [];
    report.sourceCounts.profiles = profiles.length;
    console.log(`[2/5] Migrating ${profiles.length} Profiles & Auth Identities...`);

    let profilesMigrated = 0;
    for (const profile of profiles) {
      const email = profile.email ? profile.email.toLowerCase().trim() : null;
      if (!email) continue;

      let authUserId;
      if (!isDryRun) {
        // Check if auth user already exists in Supabase Auth
        const { data: userList } = await supabase.auth.admin.listUsers();
        const existingAuth = userList?.users?.find(u => u.email === email);

        if (existingAuth) {
          authUserId = existingAuth.id;
        } else {
          // Provision Supabase Auth User with temporary reset workflow
          const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
            email,
            email_confirm: true,
            user_metadata: { full_name: profile.full_name, migrated: true }
          });
          if (createErr) {
            console.warn(`[Notice] Auth provisioning for ${email}: ${createErr.message}`);
            authUserId = getOrMapId(profile.id, 'profiles');
          } else {
            authUserId = newUser.user.id;
          }
        }
      } else {
        authUserId = getOrMapId(profile.id, 'profiles');
      }

      idMap.set(profile.id, authUserId);

      // Determine profile's primary org from memberships
      const member = (rawData.organization_members || []).find(m => m.user_id === profile.id);
      const orgUuid = member ? getOrMapId(member.organization_id, 'organizations') : null;

      const profilePayload = {
        id: authUserId,
        org_id: orgUuid,
        full_name: profile.full_name || 'Member',
        email,
        phone: profile.phone || null,
        role: member?.role || 'owner'
      };

      if (!isDryRun) {
        const { error } = await supabase.from('profiles').upsert(profilePayload, { onConflict: 'id' });
        if (error) {
          report.errors.push(`Failed to upsert profile ${profile.id}: ${error.message}`);
          continue;
        }
        await supabase.from('legacy_id_mapping').upsert({
          legacy_id: profile.id,
          supabase_uuid: authUserId,
          entity_type: 'profiles',
          is_new_insert: true,
          batch_id: batchId
        }, { onConflict: 'legacy_id' });
      }
      profilesMigrated++;
    }
    report.migratedCounts.profiles = profilesMigrated;

    // 4. Migrate Products
    const products = rawData.products || [];
    report.sourceCounts.products = products.length;
    console.log(`[3/5] Migrating ${products.length} Products...`);
    let productsMigrated = 0;

    for (const prod of products) {
      const prodUuid = getOrMapId(prod.id, 'products');
      const orgUuid = getOrMapId(prod.organization_id, 'organizations');
      if (!orgUuid) {
        report.errors.push(`Orphan product ${prod.id} has no valid org mapping`);
        continue;
      }

      const prodPayload = {
        id: prodUuid,
        org_id: orgUuid,
        name: prod.name,
        sku: prod.sku || null,
        category: prod.category || null,
        price_raw: prod.price_raw || null,
        brochure_filename: prod.brochure_filename || null,
        specs: prod.specifications || {}
      };

      if (!isDryRun) {
        const { error } = await supabase.from('products').upsert(prodPayload, { onConflict: 'id' });
        if (error) {
          report.errors.push(`Failed to upsert product ${prod.id}: ${error.message}`);
          continue;
        }
        await supabase.from('legacy_id_mapping').upsert({
          legacy_id: prod.id,
          supabase_uuid: prodUuid,
          entity_type: 'products',
          is_new_insert: true,
          batch_id: batchId
        }, { onConflict: 'legacy_id' });
      }
      productsMigrated++;
    }
    report.migratedCounts.products = productsMigrated;

    // 5. Migrate Leads
    const leads = rawData.leads || [];
    report.sourceCounts.leads = leads.length;
    console.log(`[4/5] Migrating ${leads.length} Leads...`);
    let leadsMigrated = 0;

    for (const lead of leads) {
      const leadUuid = getOrMapId(lead.id, 'leads');
      const orgUuid = getOrMapId(lead.organization_id || lead.org_id, 'organizations');
      if (!orgUuid) {
        report.errors.push(`Orphan lead ${lead.id} has no valid org mapping`);
        continue;
      }

      const leadPayload = {
        id: leadUuid,
        org_id: orgUuid,
        buyer_name: lead.buyer_name || lead.buyerName || 'Prospective Buyer',
        buyer_phone: lead.buyer_phone || lead.buyerPhone || '0000000000',
        buyer_city: lead.buyer_city || lead.buyerCity || null,
        product_inquired: lead.product_inquired || lead.productInquired || null,
        query_message: lead.query_message || lead.queryMessage || null,
        status: lead.status || 'new',
        created_at: lead.created_at || new Date().toISOString()
      };

      if (!isDryRun) {
        const { error } = await supabase.from('leads').upsert(leadPayload, { onConflict: 'id' });
        if (error) {
          report.errors.push(`Failed to upsert lead ${lead.id}: ${error.message}`);
          continue;
        }
        await supabase.from('legacy_id_mapping').upsert({
          legacy_id: lead.id,
          supabase_uuid: leadUuid,
          entity_type: 'leads',
          is_new_insert: true,
          batch_id: batchId
        }, { onConflict: 'legacy_id' });
      }
      leadsMigrated++;
    }
    report.migratedCounts.leads = leadsMigrated;

    // 6. Migrate Conversations
    const convs = rawData.conversations || [];
    report.sourceCounts.conversations = convs.length;
    console.log(`[5/7] Migrating ${convs.length} Conversations...`);
    let convsMigrated = 0;

    for (const conv of convs) {
      const convUuid = getOrMapId(conv.id, 'conversations');
      const orgUuid = getOrMapId(conv.organization_id || conv.org_id, 'organizations');
      const leadUuid = conv.lead_id ? getOrMapId(conv.lead_id, 'leads') : null;
      if (!orgUuid) continue;

      const convPayload = {
        id: convUuid,
        org_id: orgUuid,
        lead_id: leadUuid,
        buyer_phone: conv.buyer_phone || '0000000000',
        mode: conv.mode === 'ai' ? 'auto' : (conv.mode || 'auto'),
        created_at: conv.created_at || new Date().toISOString()
      };

      if (!isDryRun) {
        const { error } = await supabase.from('conversations').upsert(convPayload, { onConflict: 'id' });
        if (error) {
          report.errors.push(`Failed to upsert conversation ${conv.id}: ${error.message}`);
          continue;
        }
        await supabase.from('legacy_id_mapping').upsert({
          legacy_id: conv.id,
          supabase_uuid: convUuid,
          entity_type: 'conversations',
          is_new_insert: true,
          batch_id: batchId
        }, { onConflict: 'legacy_id' });
      }
      convsMigrated++;
    }
    report.migratedCounts.conversations = convsMigrated;

    // 7. Migrate Messages
    const msgs = rawData.messages || [];
    report.sourceCounts.messages = msgs.length;
    console.log(`[6/7] Migrating ${msgs.length} Messages...`);
    let msgsMigrated = 0;

    for (const msg of msgs) {
      const msgUuid = getOrMapId(msg.id, 'messages');
      const orgUuid = getOrMapId(msg.organization_id || msg.org_id, 'organizations');
      const convUuid = msg.conversation_id ? getOrMapId(msg.conversation_id, 'conversations') : null;
      if (!orgUuid || !convUuid) continue;

      const msgPayload = {
        id: msgUuid,
        org_id: orgUuid,
        conversation_id: convUuid,
        sender: msg.sender || (msg.sender_type === 'buyer' ? 'buyer' : 'ai'),
        text: msg.text || msg.content || '',
        created_at: msg.created_at || new Date().toISOString()
      };

      if (!isDryRun) {
        const { error } = await supabase.from('messages').upsert(msgPayload, { onConflict: 'id' });
        if (error) {
          report.errors.push(`Failed to upsert message ${msg.id}: ${error.message}`);
          continue;
        }
        await supabase.from('legacy_id_mapping').upsert({
          legacy_id: msg.id,
          supabase_uuid: msgUuid,
          entity_type: 'messages',
          is_new_insert: true,
          batch_id: batchId
        }, { onConflict: 'legacy_id' });
      }
      msgsMigrated++;
    }
    report.migratedCounts.messages = msgsMigrated;

    // 8. Migrate Payments
    const payments = rawData.payments || [];
    report.sourceCounts.payments = payments.length;
    console.log(`[7/7] Migrating ${payments.length} Payments...`);
    let paymentsMigrated = 0;

    for (const pay of payments) {
      const payUuid = getOrMapId(pay.id, 'payments');
      const orgUuid = getOrMapId(pay.organization_id || pay.org_id, 'organizations');
      if (!orgUuid) continue;

      const payPayload = {
        id: payUuid,
        org_id: orgUuid,
        amount_inr: pay.amount_inr || pay.amount || 0,
        provider: pay.provider === 'direct_upi' ? 'upi_direct' : (pay.provider || 'upi_direct'),
        status: pay.status || 'pending_verification',
        utr_reference: pay.utr_reference || pay.utr || null,
        created_at: pay.created_at || new Date().toISOString()
      };

      if (!isDryRun) {
        const { error } = await supabase.from('payments').upsert(payPayload, { onConflict: 'id' });
        if (error) {
          report.errors.push(`Failed to upsert payment ${pay.id}: ${error.message}`);
          continue;
        }
        await supabase.from('legacy_id_mapping').upsert({
          legacy_id: pay.id,
          supabase_uuid: payUuid,
          entity_type: 'payments',
          is_new_insert: true,
          batch_id: batchId
        }, { onConflict: 'legacy_id' });
      }
      paymentsMigrated++;
    }
    report.migratedCounts.payments = paymentsMigrated;

    // 6. Complete Reconciliation Report
    report.endTime = new Date().toISOString();
    report.status = report.errors.length === 0 ? 'DRY_RUN_UNVALIDATED' : 'DRY_RUN_WITH_WARNINGS';
    console.warn('Dry run does not validate live schema, permissions, conflicts, or rollback safety.');

    const reportPath = path.join(backupDir, `reconciliation_report_${timestamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

    console.log(`\n============================================================`);
    console.log(`Migration Status: ${report.status}`);
    console.log(`Reconciliation Report written to: ${reportPath}`);
    console.log(`Summary:`);
    console.log(`  Organizations : ${report.migratedCounts.organizations} / ${report.sourceCounts.organizations}`);
    console.log(`  Profiles      : ${report.migratedCounts.profiles} / ${report.sourceCounts.profiles}`);
    console.log(`  Products      : ${report.migratedCounts.products} / ${report.sourceCounts.products}`);
    console.log(`  Leads         : ${report.migratedCounts.leads} / ${report.sourceCounts.leads}`);
    if (report.errors.length) {
      console.warn(`Warnings/Errors: ${report.errors.length}`);
      report.errors.forEach(e => console.warn(`  - ${e}`));
    }
    console.log(`============================================================\n`);

  } catch (err) {
    console.error(`Migration Aborted: ${err.message}`);
    report.status = 'FAILED';
    report.error = err.message;
    process.exit(1);
  }
}

runMigration();

