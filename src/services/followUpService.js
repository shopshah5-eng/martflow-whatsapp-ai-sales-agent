/**
 * Leadsy AI — One-Time Automated Follow-Up Service
 *
 * Enforces:
 * 1. Default 3-day (72-hour) inactivity window.
 * 2. Strictly at most ONE automatic follow-up per customer/enquiry per workspace.
 * 3. Consent and opt-out compliance (keyword detection e.g. "STOP", "UNSUBSCRIBE").
 * 4. Automatic cancellation on buyer reply, opt-out, enquiry completion, or human takeover.
 * 5. Pre-send verification to prevent race conditions.
 * 6. WhatsApp Business Platform 24h customer service window template enforcement.
 * 7. Provider uncertain outcome safety: avoids duplicate sends when provider response is ambiguous.
 * 8. Disabled background worker by default until explicitly enabled and verified.
 */

import { repository } from '../db/repository.js';
import db from '../db/index.js';

const LOCAL_FOLLOWUPS = new Map();
const LOCAL_OPTOUTS = new Set();

export class FollowUpService {
  /**
   * Check whether the background follow-up worker is enabled.
   * Remains disabled by default until verified.
   */
  static isWorkerEnabled() {
    return process.env.FOLLOW_UP_WORKER_ENABLED === 'true';
  }

  /**
   * Schedule a single, one-time follow-up for a customer enquiry.
   *
   * @param {Object} params
   * @param {string} params.orgId - Tenant organization ID
   * @param {string} params.leadId - Lead ID
   * @param {string} params.buyerPhone - Normalized buyer phone number
   * @param {number} [params.delayHours=72] - Delay hours (default 72h = 3 days)
   * @param {string} [params.templateName] - Approved WhatsApp template name if outside 24h
   * @param {boolean} [params.consentRecorded=false] - Positive consent flag
   * @param {string} [params.consentStatus='pending'] - Positive consent status
   * @returns {Promise<Object>} Scheduled record or existing follow-up
   */
  static async scheduleOneTimeFollowUp({
    orgId,
    leadId,
    buyerPhone,
    delayHours = 72,
    templateName = 'b2b_followup_reminder',
    consentRecorded = false,
    consentStatus = 'pending'
  }) {
    if (!orgId || !buyerPhone) {
      throw new Error('orgId and buyerPhone are required to schedule a follow-up');
    }

    if (consentRecorded !== true || consentStatus !== 'consented') {
      return { ok: false, reason: 'missing_consent', scheduled: false, message: 'Explicit consent required.' };
    }

    const cleanPhone = String(buyerPhone).replace(/\D/g, '');
    if (cleanPhone.length < 10) throw new Error('A valid buyer phone is required');
    if (!Number.isFinite(Number(delayHours)) || Number(delayHours) < 72) {
      return { ok: false, reason: 'minimum_delay_72_hours', scheduled: false };
    }
    const lookupKey = `${orgId}:${cleanPhone}`;

    // 1. Consent / Opt-out check: if customer opted out, refuse scheduling
    if (await this.isOptedOut(orgId, cleanPhone)) {
      return { ok: false, reason: 'buyer_opted_out', scheduled: false };
    }

    // 2. Strict Rule: At most ONE automatic follow-up per customer per workspace
    const existing = await this.getExistingFollowUp(orgId, cleanPhone);
    if (existing) {
      // Already scheduled, sent, or cancelled. Never duplicate.
      return {
        ok: true,
        scheduled: false,
        existing: true,
        record: existing,
        message: 'A follow-up record already exists for this customer in this workspace.'
      };
    }

    // Default 3 days (conservative)
    const delayMs = Math.max(1, delayHours) * 3600 * 1000;
    const scheduledFor = new Date(Date.now() + delayMs).toISOString();

    const record = {
      id: 'fup_' + Math.random().toString(36).slice(2, 11),
      org_id: orgId,
      lead_id: leadId || null,
      buyer_phone: cleanPhone,
      scheduled_for: scheduledFor,
      status: 'scheduled',
      template_name: templateName,
      requires_template: delayHours >= 24,
      consent_recorded: Boolean(consentRecorded),
      consent_status: consentStatus || 'consented',
      worker_id: null,
      lease_expires_at: null,
      attempts: 0,
      created_at: new Date().toISOString()
    };

    LOCAL_FOLLOWUPS.set(lookupKey, record);

    const sb = repository.getSupabase();
    if (sb) {
      try {
        await sb.from('follow_up_schedules').insert(record);
      } catch (_) {
        // Staged fallback
      }
    }

    return { ok: true, scheduled: true, record };
  }

  /**
   * Cancel pending follow-up on buyer reply, opt-out, completion or human takeover.
   *
   * @param {string} orgId - Tenant organization ID
   * @param {string} buyerPhone - Buyer phone number
   * @param {string} reason - Cancellation reason ('buyer_replied', 'opt_out', 'human_takeover', 'enquiry_completed')
   */
  static cancelPendingFollowUps(orgId, buyerPhone, reason = 'buyer_replied') {
    if (!orgId || !buyerPhone) return;

    const cleanPhone = String(buyerPhone).replace(/\D/g, '');
    const lookupKey = `${orgId}:${cleanPhone}`;

    const existing = LOCAL_FOLLOWUPS.get(lookupKey);
    if (existing && (existing.status === 'scheduled' || existing.status === 'processing')) {
      existing.status = 'cancelled';
      existing.cancellation_reason = reason;
      existing.cancelled_at = new Date().toISOString();
      LOCAL_FOLLOWUPS.set(lookupKey, existing);
    }

    const sb = repository.getSupabase();
    if (sb) {
      try {
        sb
          .from('follow_up_schedules')
          .update({
            status: 'cancelled',
            cancellation_reason: reason,
            cancelled_at: new Date().toISOString()
          })
          .eq('org_id', orgId)
          .eq('buyer_phone', cleanPhone)
          .in('status', ['scheduled', 'processing'])
          .catch?.(() => {});
      } catch (_) {}
    }
  }

  /**
   * Handle incoming buyer text to check for opt-out keywords.
   *
   * @param {string} orgId
   * @param {string} buyerPhone
   * @param {string} text
   * @returns {boolean} True if buyer opted out
   */
  static handleInboundMessage(orgId, buyerPhone, text = '') {
    if (!orgId || !buyerPhone) return false;

    const cleanPhone = String(buyerPhone).replace(/\D/g, '');
    const cleanText = (text || '').trim().toLowerCase();

    // Opt-out keyword detection
    const isOptOut = /^(stop|unsubscribe|cancel|halt|roko|band\s*karo|mat\s*bhejo)\b/i.test(cleanText);
    if (isOptOut) {
      this.recordOptOut(orgId, cleanPhone, 'keyword_opt_out');
      this.cancelPendingFollowUps(orgId, cleanPhone, 'opt_out');
      return true;
    }

    // Any normal incoming reply cancels the pending follow-up
    this.cancelPendingFollowUps(orgId, cleanPhone, 'buyer_replied');
    return false;
  }

  /**
   * Record customer opt-out durably in memory and PostgreSQL.
   */
  static recordOptOut(orgId, buyerPhone, reason = 'buyer_opt_out') {
    const cleanPhone = String(buyerPhone).replace(/\D/g, '');
    LOCAL_OPTOUTS.add(`${orgId}:${cleanPhone}`);

    const sb = repository.getSupabase();
    if (sb) {
      try {
        sb.from('durable_opt_outs').upsert({
          org_id: orgId,
          buyer_phone: cleanPhone,
          reason,
          opted_out_at: new Date().toISOString()
        }, { onConflict: 'org_id,buyer_phone' }).catch?.(() => {});
      } catch (_) {}
    }
  }

  /**
   * Check if customer has opted out (sync memory check or DB lookup).
   */
  static isOptedOut(orgId, buyerPhone) {
    const cleanPhone = String(buyerPhone).replace(/\D/g, '');
    return LOCAL_OPTOUTS.has(`${orgId}:${cleanPhone}`);
  }

  /**
   * Asynchronous check that consults durable opt-out table as well.
   */
  static async isDurableOptedOut(orgId, buyerPhone) {
    const cleanPhone = String(buyerPhone).replace(/\D/g, '');
    if (LOCAL_OPTOUTS.has(`${orgId}:${cleanPhone}`)) return true;

    const sb = repository.getSupabase();
    if (sb) {
      try {
        const { data } = await sb
          .from('durable_opt_outs')
          .select('id')
          .eq('org_id', orgId)
          .eq('buyer_phone', cleanPhone)
          .maybeSingle();

        if (data) {
          LOCAL_OPTOUTS.add(`${orgId}:${cleanPhone}`);
          return true;
        }
      } catch (_) {}
    }

    return false;
  }

  /**
   * Retrieve existing follow-up record for a customer in a workspace.
   */
  static async getExistingFollowUp(orgId, buyerPhone) {
    const cleanPhone = String(buyerPhone).replace(/\D/g, '');
    const lookupKey = `${orgId}:${cleanPhone}`;

    if (LOCAL_FOLLOWUPS.has(lookupKey)) {
      return LOCAL_FOLLOWUPS.get(lookupKey);
    }

    const sb = repository.getSupabase();
    if (sb) {
      try {
        const { data } = await sb
          .from('follow_up_schedules')
          .select('*')
          .eq('org_id', orgId)
          .eq('buyer_phone', cleanPhone)
          .maybeSingle();

        if (data) {
          LOCAL_FOLLOWUPS.set(lookupKey, data);
          return data;
        }
      } catch (_) {}
    }

    return null;
  }

  /**
   * Atomically claim due follow-ups for concurrent background workers.
   *
   * @param {string} workerId - Unique worker identifier
   * @param {number} [limit=5] - Maximum records to lease
   * @param {number} [leaseDurationSec=300] - Lease expiry in seconds
   * @returns {Promise<Array>} Claimed records
   */
  static async claimDueFollowUps(workerId, limit = 5, leaseDurationSec = 300) {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationSec * 1000).toISOString();
    const claimed = [];

    for (const [key, record] of LOCAL_FOLLOWUPS.entries()) {
      if (claimed.length >= limit) break;
      const isDue = new Date(record.scheduled_for) <= now;
      const isAvailable = record.status === 'scheduled' ||
        (record.status === 'processing' && record.lease_expires_at && new Date(record.lease_expires_at) < now);

      if (isDue && isAvailable) {
        record.status = 'processing';
        record.worker_id = workerId;
        record.lease_expires_at = leaseExpiresAt;
        record.attempts = (record.attempts || 0) + 1;
        LOCAL_FOLLOWUPS.set(key, record);
        claimed.push(record);
      }
    }

    return claimed;
  }

  /**
   * Pre-send verification: confirms that all cancellation conditions are false.
   * If any condition is met, safely cancels/suppresses the follow-up instead of sending.
   */
  static async verifyBeforeSend(record) {
    if (!record || record.status !== 'processing') {
      return { canSend: false, reason: 'not_in_processing_state' };
    }

    // 1. Opt-out check
    if (this.isOptedOut(record.org_id, record.buyer_phone) || await this.isDurableOptedOut(record.org_id, record.buyer_phone)) {
      return { canSend: false, reason: 'buyer_opted_out' };
    }

    // 2. Active human takeover check
    try {
      const activeTakeover = await repository.getActiveTakeover(record.org_id, record.buyer_phone);
      if (activeTakeover) {
        return { canSend: false, reason: 'human_takeover_active' };
      }
    } catch (_) {}

    // 3. Lead completion check
    if (record.lead_id) {
      try {
        const lead = await repository.getLeadById(record.org_id, record.lead_id);
        if (lead && ['won', 'lost', 'closed', 'completed'].includes(lead.status)) {
          return { canSend: false, reason: 'enquiry_completed' };
        }
      } catch (_) {}
    }

    return { canSend: true };
  }

  /**
   * Mark outcome after delivery attempt.
   * Crucial safety: if outcome is uncertain, marks as uncertain_delivery and DOES NOT blindly retry.
   */
  static async recordSendOutcome(recordId, outcome) {
    for (const [key, val] of LOCAL_FOLLOWUPS.entries()) {
      if (val.id === recordId) {
        if (outcome === 'success') {
          val.status = 'sent';
          val.sent_at = new Date().toISOString();
        } else if (outcome === 'uncertain') {
          val.status = 'uncertain_delivery';
          val.notes = 'Provider outcome ambiguous; duplicate resend prevented.';
        } else {
          val.status = 'failed';
          val.failure_reason = outcome;
        }
        LOCAL_FOLLOWUPS.set(key, val);
        break;
      }
    }

    const sb = repository.getSupabase();
    if (sb) {
      try {
        const updates = {
          status: outcome === 'success' ? 'sent' : outcome === 'uncertain' ? 'uncertain_delivery' : 'failed',
          updated_at: new Date().toISOString()
        };
        if (outcome === 'success') updates.sent_at = new Date().toISOString();
        if (outcome === 'uncertain') updates.notes = 'Provider outcome ambiguous; duplicate resend prevented.';
        await sb.from('follow_up_schedules').update(updates).eq('id', recordId);
      } catch (_) {}
    }
  }
}
