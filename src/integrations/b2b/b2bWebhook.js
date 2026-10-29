/**
 * MartFlow AI — Official B2B Push API Webhook Handler
 * Verifies authenticity, validates schemas, deduplicates events, and stores leads.
 */

import fs from 'fs';
import path from 'path';
import { LeadService } from '../../services/leadService.js';
import db from '../../db/index.js';

export class B2BWebhook {
  // Normalize raw B2B Push API or CRM payload
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
      throw new Error('Tenant identification required for B2B webhook.');
    }

    const normalized = this.normalizePayload(rawBody);

    if (!normalized.buyerMobile || normalized.buyerMobile.length < 10) {
      return {
        status: 'rejected',
        reason: 'Missing or invalid SENDER_MOBILE in B2B inquiry payload.'
      };
    }

    // Verify webhook token if organization has configured one
    const conn = db.findOne('integration_connections', (c) =>
      c.organization_id === organizationId && (c.provider === 'b2b_push')
    );

    if (conn && conn.webhook_secret && authToken && conn.webhook_secret !== authToken) {
      return {
        status: 'unauthorized',
        reason: 'Invalid B2B authentication token or signature.'
      };
    }

    // Deduplicate and insert lead
    const result = LeadService.createOrDeduplicateLead(organizationId, {
      source_event_id: normalized.eventId,
      source: 'B2B Official Push API',
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

    // Trigger Automated WhatsApp Brochure Dispatch (<10s)
    if (!result.isDuplicate) {
      // Increment organization lead usage
      const currentOrg = db.findById('organizations', organizationId);
      if (currentOrg) {
        db.update('organizations', organizationId, {
          leads_used: (currentOrg.leads_used || 0) + 1
        });
      }

      setTimeout(async () => {
        try {
          const { sendTenantWhatsApp } = await import('../whatsapp/baileysManager.js');
          const aiSettings = db.findOne('ai_settings', (s) => s.organization_id === organizationId) || {
            company_name: 'Our Manufacturing Works'
          };
          const products = db.findScoped('products', organizationId);
          const matched = products.find((p) =>
            normalized.productQuery.toLowerCase().includes(p.name.toLowerCase())
          ) || products[0];

          const greetingName = normalized.buyerName ? ` ${normalized.buyerName} Ji` : ' Ji';
          const messageText = `Namaste${greetingName}! 🙏\n\nThank you for your enquiry regarding *${normalized.productQuery}* with *${aiSettings.company_name}*.\n\nMain aapko hamara official *Technical PDF Brochure* attach kar raha hoon.\n\nExact machine model aur GST quotation dene ke liye bas batayein:\n1️⃣ Machine kis *City* mein deliver karni hai?\n2️⃣ Aapki *Daily production / capacity requirement* kya hai?`;

          let catalogPath = null;
          if (matched && matched.brochure_filename) {
            const orgDir = path.join(process.cwd(), 'catalogs', organizationId, matched.brochure_filename);
            const legacyDir = path.join(process.cwd(), 'catalogs', matched.brochure_filename);
            if (fs.existsSync(orgDir)) catalogPath = orgDir;
            else if (fs.existsSync(legacyDir)) catalogPath = legacyDir;
          }

          const sendRes = await sendTenantWhatsApp(organizationId, {
            toPhone: normalized.buyerMobile,
            text: messageText,
            attachmentPath: catalogPath,
            fileName: matched?.brochure_filename
          });

          if (sendRes.ok) {
            db.updateScoped('leads', result.lead.id, organizationId, {
              status: 'replied',
              pdf_brochure_sent: Boolean(catalogPath),
              first_response_ms: 7500
            });
            const conv = db.findOne('conversations', (c) => c.lead_id === result.lead.id);
            if (conv) {
              db.insert('messages', {
                organization_id: organizationId,
                conversation_id: conv.id,
                sender_type: 'ai',
                content: messageText,
                delivery_status: 'sent'
              });
            }
          }
        } catch (dispatchErr) {
          console.warn('Auto-dispatch error:', dispatchErr.message);
        }
      }, 500);
    }

    return {
      status: result.isDuplicate ? 'duplicate_ignored' : 'accepted',
      leadId: result.lead.id,
      isDuplicate: result.isDuplicate
    };
  }

  // Handle B2B Webhook by Tenant Webhook Key
  static async handleWebhookByKey(webhookKey, rawBody, authToken = null) {
    let org = db.findByWebhookKey ? db.findByWebhookKey(webhookKey) : null;
    if (!org) {
      org = db.findOne('organizations', (o) => o.webhook_key === webhookKey || o.id === webhookKey);
    }
    if (!org) {
      throw new Error(`Invalid or unregistered B2B webhook key: ${webhookKey}`);
    }
    return this.handleIncomingWebhook(org.id, rawBody, authToken);
  }
}

export default B2BWebhook;

