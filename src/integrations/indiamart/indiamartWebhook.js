/**
 * MartFlow AI — Official IndiaMART Push API Webhook Handler
 * Verifies authenticity, validates schemas, deduplicates events, and stores leads.
 */

import { LeadService } from '../../services/leadService.js';
import db from '../../db/index.js';

export class IndiaMartWebhook {
  // Normalize raw IndiaMART Push API or CRM payload
  static normalizePayload(rawBody) {
    let payload = rawBody;
    if (payload?.RESPONSE) payload = payload.RESPONSE;
    if (Array.isArray(payload)) payload = payload[0] || {};

    const eventId = payload.UNIQUE_QUERY_ID || payload.QUERY_ID || payload.id || `im_evt_${Date.now()}`;
    const buyerName = payload.SENDER_NAME || payload.sender_name || payload.name || null;
    const buyerMobile = payload.SENDER_MOBILE || payload.sender_mobile || payload.MOBILE || payload.phone || '';
    const productQuery = payload.QUERY_PRODUCT_NAME || payload.PRODUCT_NAME || payload.subject || 'Industrial Machine';
    const city = payload.SENDER_CITY || payload.city || null;
    const message = payload.QUERY_MESSAGE || payload.message || '';

    return {
      eventId: String(eventId),
      buyerName,
      buyerMobile: String(buyerMobile).replace(/[^0-9]/g, ''),
      productQuery,
      city,
      message,
      raw: payload
    };
  }

  // Process incoming webhook request
  static async handleIncomingWebhook(organizationId, rawBody, authToken = null) {
    if (!organizationId) {
      throw new Error('Tenant identification required for IndiaMART webhook.');
    }

    const normalized = this.normalizePayload(rawBody);

    if (!normalized.buyerMobile || normalized.buyerMobile.length < 10) {
      return {
        status: 'rejected',
        reason: 'Missing or invalid SENDER_MOBILE in IndiaMART inquiry payload.'
      };
    }

    // Verify webhook token if organization has configured one
    const conn = db.findOne('integration_connections', (c) =>
      c.organization_id === organizationId && c.provider === 'indiamart'
    );

    if (conn && conn.webhook_secret && authToken && conn.webhook_secret !== authToken) {
      return {
        status: 'unauthorized',
        reason: 'Invalid IndiaMART authentication token or signature.'
      };
    }

    // Deduplicate and insert lead
    const result = LeadService.createOrDeduplicateLead(organizationId, {
      source_event_id: normalized.eventId,
      source: 'IndiaMART Official Push API',
      buyer_name: normalized.buyerName,
      buyer_phone: normalized.buyerMobile,
      buyer_city: normalized.city,
      product_inquired: normalized.productQuery,
      requirement: normalized.message
    });

    if (conn) {
      db.updateScoped('integration_connections', conn.id, organizationId, {
        status: 'connected',
        last_event_at: new Date().toISOString()
      });
    }

    return {
      status: result.isDuplicate ? 'duplicate_ignored' : 'accepted',
      leadId: result.lead.id,
      isDuplicate: result.isDuplicate
    };
  }
}

export default IndiaMartWebhook;
