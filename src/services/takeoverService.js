/**
 * MartFlow AI — Manual Takeover & Alert Dedup Service
 * 
 * Manages per-customer human takeover state, auto-expiration,
 * owner command parsing, and persistent alert deduplication.
 * 
 * Persistence Architecture:
 * - Supabase is the single source of truth (tables: manual_takeovers, alert_dedup, conversations).
 * - In-memory Maps act as high-speed read caches.
 * - If Supabase and local cache disagree, Supabase ALWAYS wins.
 * - Local file fallback is restricted to local dev (NODE_ENV !== 'production').
 */

import db from '../db/index.js';

// Default auto-expiration: 4 hours (14,400,000 ms)
export const DEFAULT_MANUAL_MODE_MS = parseInt(process.env.MANUAL_MODE_MS || '14400000', 10);
// Hot alert cooldown: 30 minutes (1,800,000 ms)
export const DEFAULT_HOT_COOLDOWN_MS = 30 * 60 * 1000;

// High-speed in-memory caches
const activeTakeoversCache = new Map(); // key: `${orgId}:${cleanPhone}` -> { expiresAt, takenAt, takenBy }
const alertDedupCache = new Map();      // key: `${orgId}:${cleanPhone}:${kind}` -> timestamp (ms)

/**
 * Normalizes Indian phone number to 12 digits (91XXXXXXXXXX)
 */
export function normalizeIndianPhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (digits.length === 10) {
    digits = '91' + digits;
  }
  return digits;
}

/**
 * Mask phone number for security in logs (e.g. 9197****8975)
 */
export function maskPhone(phone) {
  const p = normalizeIndianPhone(phone);
  if (!p || p.length < 8) return '****';
  return `${p.slice(0, 4)}****${p.slice(-4)}`;
}

/**
 * Take over a customer conversation into Manual Mode
 */
export async function takeoverCustomer({ orgId, buyerPhone, takenBy = 'owner', durationMs = DEFAULT_MANUAL_MODE_MS, supabaseAdmin = null }) {
  const cleanPhone = normalizeIndianPhone(buyerPhone);
  if (!orgId || !cleanPhone) return { ok: false, error: 'Missing orgId or buyerPhone' };

  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);
  const cacheKey = `${orgId}:${cleanPhone}`;

  // 1. Update In-Memory Cache immediately
  activeTakeoversCache.set(cacheKey, {
    orgId,
    buyerPhone: cleanPhone,
    takenAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    takenBy
  });

  // 2. Persist to Supabase (Single Source of Truth)
  if (supabaseAdmin) {
    try {
      await supabaseAdmin.from('manual_takeovers').upsert({
        org_id: orgId,
        buyer_phone: cleanPhone,
        taken_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        taken_by: takenBy
      }, { onConflict: 'org_id,buyer_phone' });

      // Update conversations table mode to 'human'
      await supabaseAdmin.from('conversations')
        .update({ mode: 'human', updated_at: now.toISOString() })
        .eq('org_id', orgId)
        .ilike('buyer_phone', `%${cleanPhone.slice(-10)}`);
    } catch (e) {
      console.warn(`[TakeoverService] Supabase takeover error for ${maskPhone(cleanPhone)}:`, e.message);
      if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_DB !== 'true') {
        return { ok: false, error: 'Database service unavailable to persist manual takeover.' };
      }
    }
  }

  // 3. Local fallback (Dev only)
  if (process.env.NODE_ENV !== 'production') {
    try {
      const existing = db.findOne('conversations', (c) => c.organization_id === orgId && c.buyer_phone?.includes(cleanPhone.slice(-10)));
      if (existing) {
        db.updateScoped('conversations', existing.id, orgId, { mode: 'human' });
      }
    } catch (e) {}
  }

  return {
    ok: true,
    cleanPhone,
    expiresAt: expiresAt.toISOString(),
    durationMinutes: Math.round(durationMs / 60000)
  };
}

/**
 * Release a customer back to AI Mode
 */
export async function releaseCustomer({ orgId, buyerPhone, supabaseAdmin = null }) {
  const cleanPhone = normalizeIndianPhone(buyerPhone);
  if (!orgId || !cleanPhone) return { ok: false, error: 'Missing orgId or buyerPhone' };

  const cacheKey = `${orgId}:${cleanPhone}`;
  activeTakeoversCache.delete(cacheKey);

  if (supabaseAdmin) {
    try {
      await supabaseAdmin.from('manual_takeovers')
        .delete()
        .eq('org_id', orgId)
        .ilike('buyer_phone', `%${cleanPhone.slice(-10)}`);

      await supabaseAdmin.from('conversations')
        .update({ mode: 'auto', updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .ilike('buyer_phone', `%${cleanPhone.slice(-10)}`);
    } catch (e) {
      console.warn(`[TakeoverService] Supabase release error for ${maskPhone(cleanPhone)}:`, e.message);
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    try {
      const existing = db.findOne('conversations', (c) => c.organization_id === orgId && c.buyer_phone?.includes(cleanPhone.slice(-10)));
      if (existing) {
        db.updateScoped('conversations', existing.id, orgId, { mode: 'auto' });
      }
    } catch (e) {}
  }

  return { ok: true, cleanPhone };
}

/**
 * Check if a customer is currently in active Manual Mode
 */
export async function isCustomerInManualMode({ orgId, buyerPhone, supabaseAdmin = null }) {
  const cleanPhone = normalizeIndianPhone(buyerPhone);
  if (!orgId || !cleanPhone) return { inManualMode: false };

  const cacheKey = `${orgId}:${cleanPhone}`;
  const now = Date.now();

  // 1. Check in-memory cache
  if (activeTakeoversCache.has(cacheKey)) {
    const entry = activeTakeoversCache.get(cacheKey);
    const expMs = new Date(entry.expiresAt).getTime();
    if (expMs > now) {
      const remainingMin = Math.max(1, Math.round((expMs - now) / 60000));
      return { inManualMode: true, expiresAt: entry.expiresAt, remainingMinutes: remainingMin };
    }
    // Expired in cache -> purge
    activeTakeoversCache.delete(cacheKey);
  }

  // 2. Query Supabase (Single Source of Truth)
  if (supabaseAdmin) {
    try {
      const { data } = await supabaseAdmin.from('manual_takeovers')
        .select('expires_at, taken_at')
        .eq('org_id', orgId)
        .ilike('buyer_phone', `%${cleanPhone.slice(-10)}`)
        .maybeSingle();

      if (data && data.expires_at) {
        const expMs = new Date(data.expires_at).getTime();
        if (expMs > now) {
          // Re-populate cache from Supabase
          activeTakeoversCache.set(cacheKey, {
            orgId,
            buyerPhone: cleanPhone,
            takenAt: data.taken_at,
            expiresAt: data.expires_at
          });
          const remainingMin = Math.max(1, Math.round((expMs - now) / 60000));
          return { inManualMode: true, expiresAt: data.expires_at, remainingMinutes: remainingMin };
        } else {
          // Auto-expired in DB -> cleanup
          await releaseCustomer({ orgId, buyerPhone: cleanPhone, supabaseAdmin });
        }
      }
    } catch (e) {
      console.warn(`[TakeoverService] Supabase check error for ${maskPhone(cleanPhone)}:`, e.message);
      // FAIL CLOSED: If takeover verification fails due to database outage, gate customer from AI auto-reply
      return { inManualMode: true, unknownMode: true, error: e.message };
    }
  }

  return { inManualMode: false };
}

/**
 * List all active takeovers for an organization
 */
export async function getActiveTakeovers({ orgId, supabaseAdmin = null }) {
  if (!orgId) return [];
  const now = Date.now();
  const list = [];

  if (supabaseAdmin) {
    try {
      const { data } = await supabaseAdmin.from('manual_takeovers')
        .select('*')
        .eq('org_id', orgId)
        .gt('expires_at', new Date().toISOString())
        .order('taken_at', { ascending: false });

      if (data) {
        return data.map(item => {
          const expMs = new Date(item.expires_at).getTime();
          return {
            buyerPhone: item.buyer_phone,
            takenAt: item.taken_at,
            expiresAt: item.expires_at,
            remainingMinutes: Math.max(1, Math.round((expMs - now) / 60000))
          };
        });
      }
    } catch (e) {}
  }

  // Fallback to in-memory cache
  for (const [key, item] of activeTakeoversCache.entries()) {
    if (key.startsWith(`${orgId}:`)) {
      const expMs = new Date(item.expiresAt).getTime();
      if (expMs > now) {
        list.push({
          buyerPhone: item.buyerPhone,
          takenAt: item.takenAt,
          expiresAt: item.expiresAt,
          remainingMinutes: Math.max(1, Math.round((expMs - now) / 60000))
        });
      }
    }
  }
  return list;
}

/**
 * Check if alert should be sent under deduplication & anti-flood rules
 * @param {string} kind - 'new_lead' | 'hot_lead'
 * @param {number} cooldownMs - Cooldown window in ms (for hot_lead)
 */
export async function shouldSendAlert({ orgId, buyerPhone, kind, cooldownMs = DEFAULT_HOT_COOLDOWN_MS, supabaseAdmin = null }) {
  const cleanPhone = normalizeIndianPhone(buyerPhone);
  if (!orgId || !cleanPhone || !kind) return false;

  const cacheKey = `${orgId}:${cleanPhone}:${kind}`;
  const now = Date.now();

  // 1. Check in-memory cache first
  if (alertDedupCache.has(cacheKey)) {
    const lastSent = alertDedupCache.get(cacheKey);
    if (kind === 'new_lead') {
      return false; // At most ONE new_lead alert ever
    }
    if (kind === 'hot_lead' && (now - lastSent) < cooldownMs) {
      return false; // Still within 30-min cooldown
    }
  }

  // 2. Check Supabase (Single Source of Truth across deploys)
  if (supabaseAdmin) {
    try {
      const { data } = await supabaseAdmin.from('alert_dedup')
        .select('last_sent_at')
        .eq('org_id', orgId)
        .ilike('buyer_phone', `%${cleanPhone.slice(-10)}`)
        .eq('kind', kind)
        .maybeSingle();

      if (data && data.last_sent_at) {
        const lastSentMs = new Date(data.last_sent_at).getTime();
        alertDedupCache.set(cacheKey, lastSentMs);

        if (kind === 'new_lead') {
          return false;
        }
        if (kind === 'hot_lead' && (now - lastSentMs) < cooldownMs) {
          return false;
        }
      }
    } catch (e) {
      console.warn(`[TakeoverService] Supabase dedup check error for ${maskPhone(cleanPhone)}:`, e.message);
    }
  }

  return true;
}

/**
 * Record that an alert was dispatched (persists to Supabase & cache)
 */
export async function recordAlertSent({ orgId, buyerPhone, kind, supabaseAdmin = null }) {
  const cleanPhone = normalizeIndianPhone(buyerPhone);
  if (!orgId || !cleanPhone || !kind) return;

  const now = new Date();
  const cacheKey = `${orgId}:${cleanPhone}:${kind}`;
  alertDedupCache.set(cacheKey, now.getTime());

  if (supabaseAdmin) {
    try {
      await supabaseAdmin.from('alert_dedup').upsert({
        org_id: orgId,
        buyer_phone: cleanPhone,
        kind,
        last_sent_at: now.toISOString()
      }, { onConflict: 'org_id,buyer_phone,kind' });
    } catch (e) {
      console.warn(`[TakeoverService] Supabase dedup record error for ${maskPhone(cleanPhone)}:`, e.message);
    }
  }
}

/**
 * Parse Owner WhatsApp Commands
 * ONLY commands sent by valid ownerTarget are executed.
 * Buyers typing "TAKE", "SEND", etc. are NEVER treated as commands!
 */
export function parseOwnerCommand(text, senderPhone, ownerTarget) {
  if (!text || !senderPhone || !ownerTarget) {
    return { isOwnerCommand: false };
  }

  const cleanSender = normalizeIndianPhone(senderPhone);
  const cleanOwner = normalizeIndianPhone(ownerTarget);

  // Security: Sender MUST match verified owner phone
  if (cleanSender !== cleanOwner) {
    return { isOwnerCommand: false };
  }

  const raw = text.trim();

  // 1. TAKE <phone> (alias: MANUAL <phone>)
  const takeMatch = raw.match(/^(?:TAKE|MANUAL)\s+([+0-9\s-]{8,15})$/i);
  if (takeMatch) {
    return {
      isOwnerCommand: true,
      action: 'TAKE',
      targetPhone: normalizeIndianPhone(takeMatch[1])
    };
  }

  // 2. SEND <phone> <message>
  const sendMatch = raw.match(/^SEND\s+([+0-9\s-]{8,15})\s+([\s\S]+)$/i);
  if (sendMatch) {
    return {
      isOwnerCommand: true,
      action: 'SEND',
      targetPhone: normalizeIndianPhone(sendMatch[1]),
      message: sendMatch[2].trim()
    };
  }

  // 3. AI <phone> (alias: AUTO <phone>)
  const aiMatch = raw.match(/^(?:AI|AUTO)\s+([+0-9\s-]{8,15})$/i);
  if (aiMatch) {
    return {
      isOwnerCommand: true,
      action: 'AI',
      targetPhone: normalizeIndianPhone(aiMatch[1])
    };
  }

  // 4. STATUS
  if (/^STATUS$/i.test(raw)) {
    return {
      isOwnerCommand: true,
      action: 'STATUS'
    };
  }

  // 5. MUTE <phone> <duration_minutes>
  const muteMatch = raw.match(/^MUTE\s+([+0-9\s-]{8,15})(?:\s+(\d+))?$/i);
  if (muteMatch) {
    const minutes = parseInt(muteMatch[2] || '60', 10);
    return {
      isOwnerCommand: true,
      action: 'MUTE',
      targetPhone: normalizeIndianPhone(muteMatch[1]),
      minutes: Math.max(5, Math.min(minutes, 1440)) // 5 mins to 24 hours
    };
  }

  return { isOwnerCommand: false };
}

export default {
  DEFAULT_MANUAL_MODE_MS,
  DEFAULT_HOT_COOLDOWN_MS,
  normalizeIndianPhone,
  maskPhone,
  takeoverCustomer,
  releaseCustomer,
  isCustomerInManualMode,
  getActiveTakeovers,
  shouldSendAlert,
  recordAlertSent,
  parseOwnerCommand
};
