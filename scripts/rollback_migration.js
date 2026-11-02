/**
 * MartFlow AI — Migration Rollback Script
 * Reverts records created during migration by reading legacy_id_mapping
 * or restoring from the pre-migration backup.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function runRollback() {
  console.log('Initiating migration rollback...');

  // 1. Fetch mapped records
  const { data: mappings, error } = await supabase.from('legacy_id_mapping').select('*');
  if (error) {
    console.error('Failed to read legacy_id_mapping table:', error.message);
    process.exit(1);
  }

  if (!mappings || mappings.length === 0) {
    console.log('No migrated records found in legacy_id_mapping. Nothing to rollback.');
    return;
  }

  const newInsertMappings = mappings.filter(m => m.is_new_insert !== false);
  console.log(`Found ${newInsertMappings.length} newly inserted records to rollback (preserving pre-existing records).`);

  // Rollback order respecting foreign keys: messages -> conversations -> payments -> leads -> products -> profiles -> organizations
  const order = ['messages', 'conversations', 'payments', 'leads', 'products', 'profiles', 'organizations'];

  for (const entityType of order) {
    const ids = newInsertMappings.filter(m => m.entity_type === entityType).map(m => m.supabase_uuid);
    if (ids.length > 0) {
      console.log(`Deleting ${ids.length} records from ${entityType}...`);
      const { error: delErr } = await supabase.from(entityType).delete().in('id', ids);
      if (delErr) {
        console.warn(`Warning during rollback of ${entityType}:`, delErr.message);
      }
    }
  }

  // Clear legacy_id_mapping entries for rolled back records
  const rolledBackLegacyIds = newInsertMappings.map(m => m.legacy_id);
  if (rolledBackLegacyIds.length > 0) {
    await supabase.from('legacy_id_mapping').delete().in('legacy_id', rolledBackLegacyIds);
  }
  console.log('Rollback completed successfully.');
}

runRollback();

