import crypto from 'node:crypto';

const anonymousTrackingKeys = new WeakMap();
export function getConversationTrackingKey(orgId, lead) {
  // Do not strip letters from IDs or use names as identifiers: distinct
  // customers can share a name or the same digits in different UUIDs.
  const phone = lead?.phone || lead?.buyer_phone || lead?.senderPhone || lead?.customer_phone;
  if (phone) {
    const value = String(phone).trim();
    const normalized = /^[+\d\s().-]+$/.test(value) ? value.replace(/\D/g, '') : value;
    if (normalized) return JSON.stringify([orgId, 'phone', normalized]);
  }
  for (const field of ['id', 'conversation_id', 'sessionKey']) {
    const value = String(lead?.[field] || '').trim();
    if (value) return JSON.stringify([orgId, field, value]);
  }
  if (lead && typeof lead === 'object') {
    if (!anonymousTrackingKeys.has(lead)) anonymousTrackingKeys.set(lead, crypto.randomUUID());
    return JSON.stringify([orgId, 'anonymous', anonymousTrackingKeys.get(lead)]);
  }
  return JSON.stringify([orgId, 'anonymous', crypto.randomUUID()]);
}
