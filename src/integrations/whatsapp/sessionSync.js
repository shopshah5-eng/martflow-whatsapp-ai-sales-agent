import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createClient } from '@supabase/supabase-js';
import { getSafeTenantAuthDir } from '../../services/storageSecurity.js';

const BUCKET_NAME = 'wa-sessions';

let _supabaseAdmin = null;
function getSupabaseAdmin() {
  if (_supabaseAdmin) return _supabaseAdmin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (url && key) {
    _supabaseAdmin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return _supabaseAdmin;
}

const backupTimers = new Map();

/**
 * Backup an organization's auth_info directory to Supabase Storage (compressed gzip).
 */
export async function backupSessionToSupabase(orgId) {
  if (!orgId) return false;
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  const sessionDir = getSafeTenantAuthDir(orgId);
  const credsFile = path.join(sessionDir, 'creds.json');
  if (!fs.existsSync(credsFile)) {
    return false;
  }

  try {
    const files = fs.readdirSync(sessionDir);
    const map = {};
    for (const f of files) {
      try {
        map[f] = fs.readFileSync(path.join(sessionDir, f), 'utf8');
      } catch (readErr) {
        // Skip files that might be temporarily locked
      }
    }

    if (!map['creds.json']) return false;

    const jsonStr = JSON.stringify(map);
    const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));

    const filePath = `${orgId}/session.json.gz`;
    const { error } = await supabase.storage.from(BUCKET_NAME).upload(filePath, compressed, {
      contentType: 'application/gzip',
      upsert: true
    });

    if (error) {
      console.error(`[SessionSync] Backup failed for org ${orgId}:`, error.message);
      return false;
    }

    console.log(`[SessionSync] Cloud backup saved for org ${orgId} (${files.length} files, ${compressed.length} bytes)`);
    return true;
  } catch (err) {
    console.error(`[SessionSync] Backup error for org ${orgId}:`, err.message);
    return false;
  }
}

/**
 * Debounced backup to prevent excessive storage writes during rapid key exchanges.
 */
export function debouncedBackupSession(orgId, delayMs = 4000) {
  if (!orgId) return;
  if (backupTimers.has(orgId)) {
    clearTimeout(backupTimers.get(orgId));
  }
  const timer = setTimeout(() => {
    backupTimers.delete(orgId);
    backupSessionToSupabase(orgId);
  }, delayMs);
  backupTimers.set(orgId, timer);
}

/**
 * Restore an organization's auth_info directory from Supabase Storage.
 * Returns true if restored or already present, false otherwise.
 */
export async function restoreSessionFromSupabase(orgId, force = false) {
  if (!orgId) return false;
  const sessionDir = getSafeTenantAuthDir(orgId);
  const credsFile = path.join(sessionDir, 'creds.json');

  if (!force && fs.existsSync(credsFile)) {
    return true; // Already on disk
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  try {
    const filePath = `${orgId}/session.json.gz`;
    const { data, error } = await supabase.storage.from(BUCKET_NAME).download(filePath);
    if (error || !data) {
      return false;
    }

    const arrayBuffer = await data.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const uncompressed = zlib.gunzipSync(buf);
    const filesMap = JSON.parse(uncompressed.toString('utf8'));

    if (!filesMap || !filesMap['creds.json']) {
      return false;
    }

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    for (const [filename, content] of Object.entries(filesMap)) {
      const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
      const targetPath = path.resolve(sessionDir, safeFilename);
      if (!targetPath.startsWith(sessionDir + path.sep)) {
        throw new Error('Path traversal detected during session archive extraction.');
      }
      fs.writeFileSync(targetPath, content, 'utf8');
    }

    console.log(`[SessionSync] Cloud session restored successfully for org ${orgId} (${Object.keys(filesMap).length} files)`);
    return true;
  } catch (err) {
    console.error(`[SessionSync] Restore error for org ${orgId}:`, err.message);
    return false;
  }
}

/**
 * Delete session from Supabase Storage when user deliberately unlinks or disconnects.
 */
export async function deleteRemoteSession(orgId) {
  if (!orgId) return false;
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  try {
    const filePath = `${orgId}/session.json.gz`;
    await supabase.storage.from(BUCKET_NAME).remove([filePath]);
    console.log(`[SessionSync] Remote cloud session removed for org ${orgId}`);
    return true;
  } catch (err) {
    return false;
  }
}
