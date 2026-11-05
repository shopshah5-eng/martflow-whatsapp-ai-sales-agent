import { repository } from '../../db/repository.js';

// Best-effort event deduplication within this process, shared by both socket
// implementations. This is not a distributed or durable delivery guarantee.
const callReservations = new Map();
const DEDUP_MS = 15 * 60 * 1000;
const MAX_RESERVATIONS = 10000;

function normalizedPhone(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\+?[\d ()-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) {
    if (!/^[6-9]/.test(digits)) return null;
    digits = `91${digits}`;
  }
  return /^[1-9]\d{10,14}$/.test(digits) ? digits : null;
}

function phoneFromJid(value, allowBare = false) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{10,15})(?::\d+)?@(s\.whatsapp\.net|c\.us)$/i);
  return match ? normalizedPhone(match[1]) : (allowBare ? normalizedPhone(value) : null);
}

function reserveCall(key, now) {
  for (const [id, timestamp] of callReservations) {
    if (now - timestamp >= DEDUP_MS) callReservations.delete(id);
  }
  if (callReservations.has(key)) return false;
  if (callReservations.size >= MAX_RESERVATIONS) return false;
  callReservations.set(key, now);
  return true;
}

/** Send an informational WhatsApp message to this workspace's main number.
 * Never answer, reject, forward, or send a message to the caller.
 */
export async function alertOnIncomingCall({ orgId, socket, call, getOrganization = id => repository.getOrganizationById(id), getSettings = id => repository.getAiSettings(id), dryRun = process.env.ALERTS_DRY_RUN === 'true' }) {
  if (!orgId || !socket || typeof socket.sendMessage !== 'function' || !call || call.status !== 'offer' || call.isGroup || call.offline) return { sent: false, reason: 'not_live_direct_offer' };
  if (typeof call.id !== 'string' || !call.id || call.id.length > 256) return { sent: false, reason: 'missing_call_id' };
  const key = JSON.stringify([orgId, call.id]);
  if (!reserveCall(key, Date.now())) return { sent: false, reason: 'duplicate_or_capacity' };

  try {
    // No global or cross-tenant fallback: wrong recipients would expose caller data.
    const org = await getOrganization(orgId);
    if (!org || org.id !== orgId || org.wa_owner_alerts === false) {
      callReservations.delete(key);
      return { sent: false, reason: 'alerts_disabled_or_workspace_missing' };
    }
    let rawTarget = org.owner_alert_number;
    if (!rawTarget) rawTarget = (await getSettings(orgId))?.escalation_phone;
    const owner = normalizedPhone(rawTarget);
    if (!owner) {
      callReservations.delete(key);
      return { sent: false, reason: 'main_number_missing' };
    }
    const caller = phoneFromJid(call.callerPn, true) || phoneFromJid(call.from) || phoneFromJid(call.chatId);
    const self = phoneFromJid(socket.user?.id);
    if ((caller && (caller === owner || caller === self)) || (call.from && call.from === socket.user?.lid)) {
      callReservations.delete(key);
      return { sent: false, reason: 'self_or_main_number_call' };
    }
    if (dryRun) return { sent: false, reason: 'dry_run' };

    const kind = call.isVideo ? 'video' : 'voice';
    const details = caller
      ? `Caller: +${caller}\nChat: https://wa.me/${caller}`
      : 'Caller number unavailable. Check WhatsApp for the call details.';
    await socket.sendMessage(`${owner}@s.whatsapp.net`, {
      text: `📞 Incoming WhatsApp ${kind} call on your business number.\n${details}\n\nThe bot has not answered or rejected the call.`
    });
    return { sent: true };
  } catch (_) {
    // Delivery may be ambiguous. Keep the reservation to avoid duplicate alerts.
    // No caller data or exception text is written to shared logs.
    return { sent: false, reason: 'lookup_or_delivery_failed' };
  }
}

export function attachIncomingCallAlerts(socket, orgId, { log = () => {}, ...options } = {}) {
  socket.ev.on('call', events => {
    if (!Array.isArray(events)) return;
    for (const call of events) {
      void alertOnIncomingCall({ ...options, orgId, socket, call }).then(result => {
        if (result.reason === 'main_number_missing' || result.reason === 'lookup_or_delivery_failed') {
          log(`Incoming call alert not delivered (${result.reason}).`);
        }
      }).catch(() => log('Incoming call alert failed.'));
    }
  });
}
