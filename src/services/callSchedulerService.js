/**
 * MartFlow AI — Two-Way Factory Call Scheduler Service
 * Manages 2-way call booking between buyer and factory owner with Asia/Kolkata timezone support.
 */

import db from '../db/index.js';

export class CallSchedulerService {
  // Record incoming call request from buyer
  static requestCall(organizationId, { leadId, ownerPhone }) {
    if (!organizationId) throw new Error('organization_id is required');
    const lead = db.findById('leads', leadId);
    if (!lead || lead.organization_id !== organizationId) throw new Error('Lead not found');

    const cleanOwnerPhone = ownerPhone || process.env.OWNER_ALERT_PHONE || '919876543210';
    const existing = db.findOne('call_requests', (cr) => cr.lead_id === leadId);

    if (existing) {
      return db.updateScoped('call_requests', existing.id, organizationId, {
        status: 'awaiting_owner',
        owner_phone: cleanOwnerPhone
      });
    }

    const callReq = db.insert('call_requests', {
      organization_id: organizationId,
      lead_id: leadId,
      requested_by: 'buyer',
      owner_phone: cleanOwnerPhone,
      status: 'awaiting_owner'
    });

    db.updateScoped('leads', leadId, organizationId, { status: 'awaiting_call' });

    db.insert('audit_logs', {
      organization_id: organizationId,
      action: 'CALL_REQUESTED',
      resource_type: 'call_requests',
      resource_id: callReq.id,
      metadata: { buyerPhone: lead.buyer_phone, ownerPhone: cleanOwnerPhone }
    });

    return callReq;
  }

  // Owner or Agent confirms call time slot
  static confirmCallSlot(organizationId, { callRequestId, confirmedTime, confirmedBy = 'owner' }) {
    if (!organizationId) throw new Error('organization_id is required');
    const callReq = db.findById('call_requests', callRequestId);
    if (!callReq || callReq.organization_id !== organizationId) {
      throw new Error('Call request not found or unauthorized');
    }

    const lead = db.findById('leads', callReq.lead_id);
    const timeStr = String(confirmedTime).trim();

    const updated = db.updateScoped('call_requests', callRequestId, organizationId, {
      status: 'confirmed',
      proposed_time_raw: timeStr,
      confirmed_by: confirmedBy,
      lead_dossier_sent: true
    });

    if (lead) {
      db.updateScoped('leads', lead.id, organizationId, { status: 'call_booked' });
    }

    db.insert('audit_logs', {
      organization_id: organizationId,
      action: 'CALL_CONFIRMED',
      resource_type: 'call_requests',
      resource_id: callRequestId,
      metadata: { confirmedTime: timeStr, confirmedBy }
    });

    return {
      callRequest: updated,
      lead,
      confirmationMessageBuyer: `Namaste Ji! Factory director sahab se baat ho gayi hai. Aapki call ${timeStr} par schedule ho gayi hai. Humare director sahab aapse is number par call karenge!`,
      dossierMessageOwner: `🔔 *CALL CONFIRMED (${timeStr})*\nBuyer: ${lead?.buyer_name || 'B2B Buyer'}\nMobile: +${lead?.buyer_phone}\nProduct: ${lead?.product_inquired}\nCity: ${lead?.buyer_city || 'Not specified'}\nOne-Tap Call Link: https://wa.me/${lead?.buyer_phone}`
    };
  }

  // List upcoming calls for organization
  static listCalls(organizationId, { status = '' } = {}) {
    let calls = db.findScoped('call_requests', organizationId);
    if (status) {
      calls = calls.filter((c) => c.status === status);
    }

    return calls.map((c) => {
      const lead = db.findById('leads', c.lead_id);
      return {
        ...c,
        lead: lead ? {
          id: lead.id,
          name: lead.buyer_name,
          phone: lead.buyer_phone,
          product: lead.product_inquired,
          city: lead.buyer_city
        } : null
      };
    });
  }
}

export default CallSchedulerService;

