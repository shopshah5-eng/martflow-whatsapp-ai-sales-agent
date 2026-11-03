/**
 * MartFlow AI — Modular SaaS API Router
 * Fully authenticated, tenant-isolated REST endpoints with live WhatsApp & B2B integration.
 */

import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { signUp, login, demoLogin, handleGoogleAuth, sendPhoneOtp, verifyPhoneOtp } from '../auth/authService.js';
import { authenticate, requireRole } from '../middleware/authMiddleware.js';
import { LeadService } from '../services/leadService.js';
import { CatalogService } from '../services/catalogService.js';
import { CallSchedulerService } from '../services/callSchedulerService.js';
import { AnalyticsService } from '../services/analyticsService.js';
import { AIService, invalidateCache, getSupabaseAdmin } from '../services/aiService.js';
import { WhatsAppAdapter } from '../integrations/whatsapp/whatsappAdapter.js';
import { B2BWebhook } from '../integrations/b2b/b2bWebhook.js';
import { baileysManager } from '../integrations/whatsapp/baileysManager.js';
import { LearningService } from '../services/learningService.js';
import db from '../db/index.js';
import { repository } from '../db/repository.js';

const router = express.Router();

// ==========================================
// 1. PUBLIC AUTHENTICATION ENDPOINTS
// ==========================================
router.post('/auth/signup', async (req, res) => {
  try {
    const result = await signUp(req.body);
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const result = await login(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

// 1-Click Demo / Local Admin Workspace Auto-Login
router.post('/auth/demo-login', async (req, res) => {
  if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEMO_LOGIN !== 'true') {
    return res.status(403).json({
      ok: false,
      error: 'Demo auto-login is disabled. Please sign in with valid credentials.'
    });
  }
  try {
    const result = await demoLogin();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// Google / Gmail OAuth Auto-Provisioning
router.post('/auth/google', async (req, res) => {
  try {
    const { token, idToken, credential, email, fullName } = req.body || {};
    const result = await handleGoogleAuth({ token, idToken, credential, email, fullName });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/auth/otp/send', async (req, res) => {
  try {
    const result = await sendPhoneOtp(req.body.phone);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/auth/otp/verify', (req, res) => {
  try {
    const result = verifyPhoneOtp(req.body.phone, req.body.otp);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/health', (req, res) => {
  res.json({ ok: true, status: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

router.get('/ready', async (req, res) => {
  let dbOk = false;
  const isProduction = process.env.NODE_ENV === 'production';
  const useLocal = process.env.USE_LOCAL_DB === 'true';

  try {
    if (isProduction && !useLocal) {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        dbOk = false;
      } else {
        const admin = getSupabaseAdmin();
        if (admin) {
          const { error } = await admin.from('organizations').select('id').limit(1);
          dbOk = !error;
        } else {
          dbOk = false;
        }
      }
    } else {
      dbOk = db !== null;
    }
  } catch (e) {
    dbOk = false;
  }
  const isReady = dbOk;
  res.status(isReady ? 200 : 503).json({
    ok: isReady,
    status: isReady ? 'ready' : 'degraded',
    checks: { database: dbOk, uptime: process.uptime() },
    timestamp: new Date().toISOString()
  });
});

router.get('/auth/me', authenticate, async (req, res) => {
  let profile = null;
  if (repository.getSupabase()) {
    try {
      profile = await repository.getProfileById(req.userId);
    } catch (e) {}
  }
  if (!profile) {
    profile = db.findById('profiles', req.userId);
  }
  res.json({
    ok: true,
    user: profile ? { id: profile.id, email: profile.email, fullName: profile.full_name || profile.fullName, phone: profile.phone } : null,
    organization: req.organization,
    role: req.role
  });
});

// ==========================================
// 2. LEAD MANAGEMENT ENDPOINTS (TENANT SCOPED)
// ==========================================
router.get('/leads', authenticate, (req, res) => {
  const { page, limit, search, status, city, sortBy, sortOrder } = req.query;
  const result = LeadService.listLeads(req.organizationId, { page, limit, search, status, city, sortBy, sortOrder });
  res.json({ ok: true, ...result });
});

// Simulate Inbound Lead Modal
router.post('/leads/simulate', authenticate, async (req, res) => {
  try {
    const buyerPhone = req.body.buyerPhone || req.body.senderMobile;
    const buyerName = req.body.buyerName || req.body.senderName || 'Simulated Buyer';
    const productQuery = req.body.productQuery || req.body.productName || 'Packaging Machine';
    const city = req.body.city || req.body.senderCity || 'Delhi NCR';
    const message = req.body.message || req.body.queryMessage || 'Please send machine specifications, price quotation, and video.';

    if (!buyerPhone) {
      return res.status(400).json({ ok: false, error: 'Buyer WhatsApp mobile number is required.' });
    }

    const payload = {
      UNIQUE_QUERY_ID: `sim_${Date.now()}`,
      SENDER_NAME: buyerName,
      SENDER_MOBILE: buyerPhone,
      QUERY_PRODUCT_NAME: productQuery,
      SENDER_CITY: city,
      QUERY_MESSAGE: message
    };

    const webhookRes = await B2BWebhook.handleIncomingWebhook(req.organizationId, payload);
    const lead = webhookRes.leadId ? db.findById('leads', webhookRes.leadId) : null;
    res.json({ ok: true, lead, leadId: webhookRes.leadId, ...webhookRes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/leads/export.csv', authenticate, (req, res) => {
  const csv = LeadService.exportLeadsCsv(req.organizationId);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="MartFlow_Leads_${Date.now()}.csv"`);
  res.send(csv);
});

router.get('/leads/:id', authenticate, (req, res) => {
  const detail = LeadService.getLeadDetail(req.organizationId, req.params.id);
  if (!detail) return res.status(404).json({ ok: false, error: 'Lead not found.' });
  res.json({ ok: true, ...detail });
});

router.post('/leads/:id/status', authenticate, (req, res) => {
  try {
    const updated = LeadService.updateLeadStatus(req.organizationId, req.params.id, req.body.status, req.userId);
    res.json({ ok: true, lead: updated });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/leads/:id/assign', authenticate, requireRole(['owner', 'admin', 'sales_manager']), (req, res) => {
  try {
    const updated = LeadService.assignLead(req.organizationId, req.params.id, req.body.agentId, req.userId);
    res.json({ ok: true, lead: updated });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/leads/:id/notes', authenticate, (req, res) => {
  try {
    const updated = LeadService.addNote(req.organizationId, req.params.id, req.body.note, req.userId);
    res.json({ ok: true, lead: updated });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 2b. CALLBACK SCHEDULING (TENANT-SCOPED)
// ==========================================
router.post('/callbacks/confirm-time', authenticate, async (req, res) => {
  try {
    if (!req.organizationId) {
      return res.status(401).json({ ok: false, error: 'Authentication required with valid organization' });
    }
    const { leadId, confirmedTime } = req.body;
    let targetLead = null;

    if (leadId) {
      let existingLead = await repository.getLeadById(req.organizationId, leadId) || db.findById('leads', leadId);
      if (!existingLead) {
        return res.status(404).json({ ok: false, error: 'Lead not found.' });
      }

      const leadOrg = existingLead.org_id || existingLead.organization_id;
      if (!leadOrg || leadOrg !== req.organizationId) {
        return res.status(403).json({ ok: false, error: 'Unauthorized: Cannot access lead belonging to another organization.' });
      }
      targetLead = existingLead;
    } else {
      targetLead = db.findOne('leads', (l) => (l.org_id === req.organizationId || l.organization_id === req.organizationId) && l.callbackStatus === 'awaiting_client_time');
    }

    if (!targetLead) {
      return res.status(404).json({ ok: false, error: 'No lead awaiting callback found for this organization.' });
    }

    const cleanTime = (confirmedTime || 'Today at 4:00 PM').trim();
    targetLead.callbackStatus = 'scheduled';
    targetLead.scheduledCallTime = cleanTime;
    targetLead.status = `⏰ Call Scheduled: ${cleanTime}`;
    targetLead.updatedAt = new Date().toISOString();

    await repository.updateLeadScoped(req.organizationId, targetLead.id, {
      callbackStatus: targetLead.callbackStatus,
      scheduledCallTime: targetLead.scheduledCallTime,
      status: targetLead.status
    });
    db.updateScoped('leads', targetLead.id, req.organizationId, {
      callbackStatus: targetLead.callbackStatus,
      scheduledCallTime: targetLead.scheduledCallTime,
      status: targetLead.status
    });

    res.json({ ok: true, lead: targetLead, confirmedTime: cleanTime });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/callbacks/request-demo', authenticate, async (req, res) => {
  try {
    if (!req.organizationId) {
      return res.status(401).json({ ok: false, error: 'Authentication required with valid organization' });
    }
    const org = await repository.getOrganizationById(req.organizationId) || db.findById('organizations', req.organizationId) || {};
    const settings = await repository.getAiSettings(req.organizationId) || db.findOne('ai_settings', (s) => s.organization_id === req.organizationId) || {};
    const ownerDigits = (org.owner_alert_number || settings.escalation_phone || '').replace(/\D/g, '');

    let lead = db.findOne('leads', (l) => (l.org_id === req.organizationId || l.organization_id === req.organizationId) && (l.phone || l.buyer_phone || '').replace(/\D/g, '') !== ownerDigits);
    if (!lead) {
      lead = db.insert('leads', {
        id: 'IM-' + Date.now().toString().slice(-6),
        org_id: req.organizationId,
        organization_id: req.organizationId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        name: 'Rajesh Verma (Demo Buyer)',
        phone: '919781018975',
        buyer_phone: '919781018975',
        productName: 'Automatic Pouch Packing Machine',
        requirement: 'BPT-500 Collar Type PLC Pouch Machine (50g spices)',
        source: 'Live Demo Simulation',
        status: '⏳ Awaiting Client Call Time',
        callbackStatus: 'awaiting_client_time',
        callbackRequestedAt: new Date().toISOString()
      });
    } else {
      lead = db.updateScoped('leads', lead.id, req.organizationId, {
        callbackStatus: 'awaiting_client_time',
        callbackRequestedAt: new Date().toISOString(),
        status: '⏳ Awaiting Client Call Time'
      });
    }

    res.json({
      ok: true,
      message: ownerDigits
        ? `Demo call request sent to Owner WhatsApp (+${ownerDigits}). Reply to WhatsApp to confirm time!`
        : `Demo lead created. Enter available time below to confirm call.`,
      lead
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 3. CONVERSATIONS INBOX ENDPOINTS
// ==========================================
router.get('/conversations', authenticate, (req, res) => {
  const conversations = db.findScoped('conversations', req.organizationId);
  const threads = conversations.map((conv) => {
    const lead = db.findById('leads', conv.lead_id);
    const messages = db.findScoped('messages', req.organizationId, (m) => m.conversation_id === conv.id)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const lastMsg = messages[messages.length - 1];

    return {
      id: conv.id,
      leadId: conv.lead_id,
      mode: conv.mode || 'ai',
      isUnread: conv.is_unread,
      buyerName: lead?.buyer_name || 'B2B Buyer',
      buyerPhone: lead?.buyer_phone || '',
      buyerCity: lead?.buyer_city || '',
      productInquired: lead?.product_inquired || '',
      status: lead?.status || 'new',
      lastMessage: lastMsg ? lastMsg.content : 'No messages yet',
      lastMessageAt: lastMsg ? lastMsg.created_at : conv.created_at
    };
  }).sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

  res.json({ ok: true, threads, conversations: threads });
});

router.get('/conversations/:id/messages', authenticate, (req, res) => {
  const conv = db.findById('conversations', req.params.id);
  if (!conv || conv.organization_id !== req.organizationId) {
    return res.status(404).json({ ok: false, error: 'Conversation not found.' });
  }

  const messages = db.findScoped('messages', req.organizationId, (m) => m.conversation_id === conv.id)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const lead = db.findById('leads', conv.lead_id);
  res.json({ ok: true, conversation: conv, lead, messages });
});

router.post('/conversations/:id/mode', authenticate, (req, res) => {
  const { mode } = req.body;
  if (!['ai', 'human'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'Mode must be "ai" or "human".' });
  }
  const updated = db.updateScoped('conversations', req.params.id, req.organizationId, { mode });
  if (!updated) return res.status(404).json({ ok: false, error: 'Conversation not found.' });
  res.json({ ok: true, conversation: updated });
});

router.post('/conversations/:id/reply', authenticate, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'Message text is required.' });
    }

    const conv = db.findById('conversations', req.params.id);
    if (!conv || conv.organization_id !== req.organizationId) {
      return res.status(404).json({ ok: false, error: 'Conversation not found.' });
    }

    const lead = db.findById('leads', conv.lead_id);
    if (!lead || !lead.buyer_phone) {
      return res.status(400).json({ ok: false, error: 'No phone number linked to this lead.' });
    }

    // Send strictly via live Baileys socket belonging to this tenant
    const sendResult = await baileysManager.sendMessage(req.organizationId, lead.buyer_phone, message.trim());
    if (!sendResult.ok) {
      return res.status(500).json({ ok: false, error: sendResult.error || 'Failed to dispatch via WhatsApp.' });
    }

    // Save message record
    const msgRecord = db.insert('messages', {
      organization_id: req.organizationId,
      conversation_id: conv.id,
      sender_type: 'agent',
      sender_id: req.userId,
      content: message.trim(),
      delivery_status: 'sent',
      provider_message_id: sendResult.messageId
    });

    // If tenant is opted in to conversational learning, propose verified facts from this human agent turn
    if (LearningService.isLearningOptedIn(req.organizationId)) {
      try {
        const convMessages = db.findScoped('messages', req.organizationId, (m) => m.conversation_id === conv.id) || [];
        LearningService.proposeFactsFromConversation({
          organizationId: req.organizationId,
          conversationId: conv.id,
          messages: convMessages
        });
      } catch (learnErr) {
        console.warn('Learning proposal extraction error:', learnErr.message);
      }
    }

    res.json({ ok: true, message: msgRecord });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 4. WHATSAPP CONNECTION & QR MANAGEMENT (AUTHENTICATED & TENANT ISOLATED)
// ==========================================
router.get('/whatsapp/status', authenticate, (req, res) => {
  const orgId = req.organizationId;
  const state = baileysManager.getState(orgId);
  res.json({ ok: true, status: state.status, phoneNumber: state.connectedNumber, waState: state });
});

router.post('/whatsapp/connect', authenticate, requireRole(['owner', 'admin']), async (req, res) => {
  try {
    const orgId = req.organizationId;
    await baileysManager.init(orgId);
    res.json({ ok: true, waState: baileysManager.getState(orgId) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/whatsapp/disconnect', authenticate, requireRole(['owner', 'admin']), async (req, res) => {
  try {
    const orgId = req.organizationId;
    await baileysManager.disconnect(orgId);
    res.json({ ok: true, waState: baileysManager.getState(orgId) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 5. PRODUCT CATALOG ENDPOINTS (TENANT SCOPED)
// ==========================================
router.get('/catalog/products', authenticate, (req, res) => {
  const products = CatalogService.listProducts(req.organizationId, req.query);
  res.json({ ok: true, products });
});

router.post('/catalog/upload', authenticate, requireRole(['owner', 'admin']), async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body;
    if (!filename || !fileBase64) {
      return res.status(400).json({ ok: false, error: 'filename and fileBase64 required.' });
    }
    const cleanBase64 = fileBase64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    const result = await CatalogService.ingestCatalog(req.organizationId, {
      filename,
      buffer,
      uploadedBy: req.userId
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Quick-Add SKU (10-second manual product addition)
router.post('/catalog/quick-add', authenticate, (req, res) => {
  try {
    const { name, priceRaw, model, specifications } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, error: 'Product name is required.' });
    }

    const kw = name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const product = db.insert('products', {
      organization_id: req.organizationId,
      name: name.trim(),
      sku: `SKU-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      category: 'Machinery Equipment',
      model: model || 'Standard Industrial',
      price_raw: priceRaw || 'Contact factory for GST quote',
      keywords: kw,
      specifications: specifications || { note: 'Direct factory entry' },
      confidence_score: 1.0
    });

    res.json({ ok: true, product });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/catalog/products/:id', authenticate, requireRole(['owner', 'admin']), (req, res) => {
  try {
    CatalogService.deleteProduct(req.organizationId, req.params.id);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Real-Time Catalog Cache Invalidation & Instant AI Sync Endpoint
router.post('/catalog/sync', authenticate, requireRole(['owner', 'admin', 'superadmin']), async (req, res) => {
  try {
    const { orgId, products, companyName, businessType, websiteKnowledge, catalogPdfName } = req.body || {};
    const targetOrgId = req.role === 'superadmin' && orgId ? orgId : req.organizationId;
    if (orgId && orgId !== targetOrgId && req.role !== 'superadmin') {
      return res.status(403).json({ ok: false, error: 'Cannot modify another organization' });
    }
    if (products !== undefined && (!Array.isArray(products) || products.length > 10000 || products.some(p => !p || typeof p.name !== 'string' || !p.name.trim()))) {
      return res.status(400).json({ ok: false, error: 'Products must be an array of named products (maximum 10000).' });
    }
    const rows = products?.map((p, idx) => ({
      sku: String(p.sku || p.sku_code || `ITEM-${101 + idx}`).slice(0, 200),
      name: p.name.trim().slice(0, 500), category: p.category || 'Commercial Products',
      model_specs: String(p.model_specs || '').slice(0, 600),
      price_raw: String(p.price_raw || 'Ask for Price').slice(0, 80),
      image_url: p.image_url || '', brochure_url: p.brochure_url || '',
      brochure_filename: p.brochure_filename || catalogPdfName || '', is_active: true
    }));
    const updates = {};
    if (companyName) updates.name = String(companyName).slice(0, 500);
    if (businessType && businessType !== 'auto') updates.business_type = businessType;
    if (websiteKnowledge !== undefined && websiteKnowledge !== null && String(websiteKnowledge).trim().length > 0) {
      updates.website_knowledge = String(websiteKnowledge).slice(0, 50000);
    }
    if (catalogPdfName) updates.catalog_pdf_name = String(catalogPdfName).slice(0, 500);

    const admin = getSupabaseAdmin();
    if (admin) {
      // RPC runs delete, insert, and organization update as a single transaction.
      const { error } = await admin.rpc('replace_tenant_catalog', {
        p_org_id: targetOrgId, p_products: rows ?? null, p_org_updates: updates
      });
      if (error) {
        throw new Error(`Catalog transaction failed: ${error.message}`);
      }
    } else if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_DB !== 'true') {
      return res.status(503).json({ ok: false, error: 'Catalog database unavailable.' });
    }
    // Legacy local mirror. No conversation history or takeover state is touched.
    if (rows) {
      db.deleteScoped('products', targetOrgId);
      rows.forEach(p => db.insert('products', { ...p, organization_id: targetOrgId }));
    }
    if (Object.keys(updates).length) db.update('organizations', targetOrgId, updates);
    invalidateCache(targetOrgId);
    invalidateCache(null);

    // Keep local fallback files in sync for default demo org
    if (targetOrgId === '6fd354d9-3437-412d-856e-28bc19d44268') {
      try {
        const CONFIG_FILE = path.join(process.cwd(), 'config.json');
        if (fs.existsSync(CONFIG_FILE)) {
          const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          if (companyName) cfg.companyName = companyName;
          if (businessType && businessType !== 'auto') cfg.businessType = businessType;
          if (Array.isArray(rows)) {
            cfg.products = rows.map((p, idx) => ({
              id: p.sku || `prod_${idx}`,
              name: p.name,
              priceRange: p.price_raw || 'Ask for Price',
              keywords: (p.name || '').toLowerCase().split(/\s+/).filter(w => w.length > 2),
              catalogFile: catalogPdfName || 'Brochure.pdf',
              model_specs: p.model_specs || ''
            }));
          }
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
        }
      } catch (e) {}

      try {
        const KNOWLEDGE_FILE = path.join(process.cwd(), 'catalog_knowledge.json');
        if (fs.existsSync(KNOWLEDGE_FILE)) {
          const catK = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
          if (!catK.demoKnowledge && catK.textKnowledge && catK.textKnowledge.includes('BHARAT PACKTECH')) {
            catK.demoKnowledge = catK.textKnowledge;
          }
          if (websiteKnowledge !== undefined && String(websiteKnowledge).trim()) {
            catK.uploadedKnowledge = `=== UPLOADED CATALOG KNOWLEDGE ===\n${String(websiteKnowledge).slice(0, 30000)}`;
            catK.textKnowledge = `${catK.demoKnowledge || ''}\n\n${catK.uploadedKnowledge}`.trim();
          } else if (catK.uploadedKnowledge) {
            catK.textKnowledge = `${catK.demoKnowledge || ''}\n\n${catK.uploadedKnowledge}`.trim();
          } else if (catK.demoKnowledge) {
            catK.textKnowledge = catK.demoKnowledge;
          }
          fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(catK, null, 2), 'utf8');
        }
      } catch (e) {}
    }
    return res.json({ ok: true, count: rows?.length ?? null, message: 'Catalog synced; conversation history preserved.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 6. TWO-WAY CALL SCHEDULER ENDPOINTS
// ==========================================
router.get('/calls', authenticate, (req, res) => {
  const calls = CallSchedulerService.listCalls(req.organizationId, req.query);
  res.json({ ok: true, calls });
});

router.post('/calls/request', authenticate, (req, res) => {
  try {
    const callReq = CallSchedulerService.requestCall(req.organizationId, {
      leadId: req.body.leadId,
      ownerPhone: req.body.ownerPhone
    });
    res.json({ ok: true, callRequest: callReq });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/calls/confirm', authenticate, async (req, res) => {
  try {
    const result = await CallSchedulerService.confirmCallSlot(req.organizationId, {
      callRequestId: req.body.callRequestId || req.body.callId,
      confirmedTime: req.body.confirmedTime,
      confirmedBy: req.body.confirmedBy || req.role
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 7. GENUINE ANALYTICS ENDPOINT (REAL DB RECORDS)
// ==========================================
router.get('/analytics', authenticate, (req, res) => {
  const metrics = AnalyticsService.getDashboardMetrics(req.organizationId);
  res.json({ ok: true, metrics });
});

// ==========================================
// 8. SETTINGS & TEAM MANAGEMENT ENDPOINTS
// ==========================================
router.get('/settings', authenticate, async (req, res) => {
  try {
    const org = await repository.getOrganizationById(req.organizationId) || req.organization || {};
    const settings = await repository.getAiSettings(req.organizationId) || db.findOne('ai_settings', (s) => s.organization_id === req.organizationId) || {};
    res.json({
      ok: true,
      organization: org,
      settings
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/settings', authenticate, requireRole(['owner', 'admin']), async (req, res) => {
  try {
    const { companyName, cityBase, ownerAlertPhone, geminiApiKey } = req.body;

    if (companyName && companyName.trim()) {
      await repository.updateOrganizationScoped(req.organizationId, { name: companyName.trim() });
      db.update('organizations', req.organizationId, { name: companyName.trim() });
    }

    const existing = await repository.getAiSettings(req.organizationId) || db.findOne('ai_settings', (s) => s.organization_id === req.organizationId);
    const updates = {
      company_name: companyName ? companyName.trim() : (existing?.company_name || 'Bharat Machinery'),
      city_base: cityBase ? cityBase.trim() : (existing?.city_base || 'Delhi NCR'),
      escalation_phone: ownerAlertPhone ? ownerAlertPhone.trim() : (existing?.escalation_phone || '')
    };

    const saved = await repository.upsertAiSettings(req.organizationId, updates);
    if (existing?.id) {
      db.updateScoped('ai_settings', existing.id, req.organizationId, updates);
    } else {
      db.insert('ai_settings', { organization_id: req.organizationId, ...updates });
    }

    res.json({ ok: true, settings: saved });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/settings/whatsapp', authenticate, requireRole(['owner', 'admin']), async (req, res) => {
  try {
    const { wabaId, phoneId, token } = req.body;
    const existing = db.findOne('integration_connections', (c) =>
      c.organization_id === req.organizationId && c.provider === 'whatsapp_cloud'
    );

    const creds = { wabaId, phoneNumberId: phoneId, token };
    if (existing) {
      db.updateScoped('integration_connections', existing.id, req.organizationId, {
        credentials_encrypted: creds,
        status: token ? 'connected' : 'disconnected'
      });
    } else {
      db.insert('integration_connections', {
        organization_id: req.organizationId,
        provider: 'whatsapp_cloud',
        credentials_encrypted: creds,
        status: token ? 'connected' : 'disconnected'
      });
    }

    // Update organization WhatsApp settings
    const orgUpdates = {
      waba_phone_id: phoneId || null,
      waba_token: token || null,
      wa_mode: phoneId && token ? 'cloud_api' : 'qr'
    };
    await repository.updateOrganizationScoped(req.organizationId, orgUpdates);
    db.update('organizations', req.organizationId, orgUpdates);

    res.json({ ok: true, message: 'WhatsApp Cloud API settings saved successfully.' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.get('/settings/team', authenticate, (req, res) => {
  const memberships = db.findScoped('organization_members', req.organizationId);
  const team = memberships.map((m) => {
    const profile = db.findById('profiles', m.user_id);
    return {
      id: m.id,
      userId: m.user_id,
      role: m.role,
      fullName: profile?.full_name || 'Team Member',
      email: profile?.email || '',
      joinedAt: m.created_at
    };
  });
  res.json({ ok: true, team });
});

// ==========================================
// 9. REAL WEBHOOK INGESTION ENDPOINTS (B2B Marketplace & Backward-Compatible Aliases)
// ==========================================
router.post(['/webhook/b2b/:webhookKey', '/webhook/indiamart/:webhookKey', '/webhook/indiamart/:key'], async (req, res) => {
  try {
    const key = req.params.webhookKey || req.params.key;
    const token = req.headers['x-b2b-token'] || req.headers['x-indiamart-token'] || req.query.token;
    const result = await B2BWebhook.handleWebhookByKey(key, req.body, token);
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post(['/webhook/b2b', '/webhook/indiamart'], async (req, res) => {
  try {
    const token = req.headers['x-b2b-token'] || req.headers['x-indiamart-token'] || req.headers['x-webhook-key'] || req.query.b2b_secret;
    if (!token) {
      return res.status(401).json({ status: 'unauthorized', error: 'Authentication required: Missing valid tenant webhook key or token.' });
    }

    const org = db.findByWebhookKey(token);
    if (!org) {
      return res.status(401).json({ status: 'unauthorized', error: 'Invalid tenant webhook token or key.' });
    }

    const result = await B2BWebhook.handleIncomingWebhook(org.id, req.body, token);
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const secret = process.env.WHATSAPP_VERIFY_TOKEN || 'martflow_verify_secret';
  const result = WhatsAppAdapter.verifyCloudWebhook(mode, token, challenge, secret);
  if (result.verified) {
    return res.status(200).send(result.challenge);
  }
  res.sendStatus(403);
});

router.post('/webhook/whatsapp', async (req, res) => {
  // Validate Meta raw body signature
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret && process.env.NODE_ENV === 'production') {
    return res.status(503).json({ ok: false, error: 'META_APP_SECRET is not configured on this server.' });
  }
  if (appSecret) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      return res.status(401).json({ ok: false, error: 'Missing X-Hub-Signature-256 header' });
    }
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const expectedSig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    try {
      const isSigValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
      if (!isSigValid) {
        return res.status(401).json({ ok: false, error: 'Invalid Meta webhook signature' });
      }
    } catch (e) {
      return res.status(401).json({ ok: false, error: 'Malformed signature header' });
    }
  }

  const result = await WhatsAppAdapter.handleCloudWebhook(req.body);
  res.json(result);
});

// ==========================================
// 10. WORKSPACE MEMBERSHIP & DUAL PAYMENT ENGINE
// ==========================================
router.get('/membership/status', authenticate, (req, res) => {
  const org = db.findById('organizations', req.organizationId) || req.organization;
  const leads = db.findScoped('leads', req.organizationId);
  const leadsUsed = org.leads_used || leads.length;
  res.json({
    ok: true,
    membership: {
      planStatus: org.plan_status || 'trial',
      trialEndsAt: org.trial_ends_at || null,
      monthlyLeadLimit: org.monthly_lead_limit || 25,
      leadsUsed,
      customQuoteInr: org.custom_quote_inr || null,
      companyName: org.name,
      currency: 'INR',
      merchantUpiId: process.env.MERCHANT_UPI_ID || 'YOUR_REAL_UPI_ID',
      merchantName: process.env.MERCHANT_NAME || 'MartFlow AI',
      isRazorpayConfigured: false,
      razorpayKeyId: null
    }
  });
});

router.get('/billing', authenticate, (req, res) => {
  const org = db.findById('organizations', req.organizationId) || req.organization;
  const leads = db.findScoped('leads', req.organizationId);
  const leadsUsed = org.leads_used || leads.length;
  res.json({
    ok: true,
    billing: {
      planStatus: org.plan_status || 'trial',
      monthlyLeadLimit: org.monthly_lead_limit || 25,
      currentUsage: leadsUsed,
      customQuoteInr: org.custom_quote_inr || null,
      merchantUpiId: process.env.MERCHANT_UPI_ID || 'YOUR_REAL_UPI_ID',
      merchantName: process.env.MERCHANT_NAME || 'MartFlow AI',
      isConfigured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      currency: 'INR'
    }
  });
});

router.get('/public-config', (req, res) => {
  res.json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL || 'https://uriqhusalcdgdlgzgasp.supabase.co',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVyaXFodXNhbGNkZ2RsZ3pnYXNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzMzYwNDQsImV4cCI6MjEwODkxMjA0NH0.UTB-Ykce-bcxTrhhKvk1kNjxCH5uWsmB3yAyGJeZXkE',
    merchantUpiId: process.env.MERCHANT_UPI_ID || 'YOUR_REAL_UPI_ID',
    merchantName: process.env.MERCHANT_NAME || 'MartFlow AI Sales',
    supportWhatsapp: process.env.SUPPORT_WHATSAPP || process.env.OWNER_PHONE || 'YOUR_REAL_WHATSAPP_91XXXXXXXXXX'
  });
});

router.post('/membership/unlock-code', authenticate, async (req, res) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ ok: false, error: 'Activation code is required.' });

    const COUPONS = {
      'PILOT999': { amount: 999, description: '48-Hour VIP Engineer Setup Deposit — Adjusted in Plan' },
      'VIP999': { amount: 999, description: '48-Hour VIP Engineer Setup Deposit — Adjusted in Plan' },
      'ADJUST999': { amount: 9000, description: '₹999 Deposit Adjusted — Pay ₹9,000 Balance for Full 1-Month Pro' },
      'SETUP5K': { amount: 5000, description: 'One-Time Factory Setup & Catalog AI Training' },
      'START75': { amount: 7499, description: '₹5,000 Setup + ₹2,499 First Month — 400 Leads/mo' },
      'PRO12K': { amount: 12499, description: '₹7,500 Setup + ₹4,999 First Month — 1,500 Leads/mo' },
      'ANNUAL18K': { amount: 18000, description: 'Full 1-Year Factory License — ₹5,000 Setup Waived FREE!' }
    };

    let coupon = COUPONS[code];
    if (!coupon) return res.status(400).json({ ok: false, error: 'Invalid activation code.' });

    db.update('organizations', req.organizationId, {
      custom_quote_inr: coupon.amount,
      quote_code: code
    });

    const admin = getSupabaseAdmin();
    if (admin) {
      try {
        await admin.from('organizations').update({
          custom_quote_inr: coupon.amount,
          quote_code: code
        }).eq('id', req.organizationId);
      } catch (e) {}
    }

    res.json({
      ok: true,
      code,
      customQuoteInr: coupon.amount,
      planDescription: coupon.description,
      message: `Unlocked: ${coupon.description} for ₹${coupon.amount.toLocaleString('en-IN')}`
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Dual Payment: Tab 1 — Instant Direct UPI QR + UTR Submission (Pending Reconciliation)
router.post('/payments/upi-verify', authenticate, async (req, res) => {
  try {
    const utr = String(req.body.utrReference || req.body.utr || '').trim();
    const amount = parseInt(req.body.amountInr || req.body.amount || 999, 10);
    if (!utr || !/^[0-9A-Za-z]{10,22}$/.test(utr)) {
      return res.status(400).json({ ok: false, error: 'Valid 10-22 character alphanumeric UTR/Bank Reference is required.' });
    }

    // Check if UTR was already recorded
    const existing = db.findOne('payments', (p) => p.utr_reference === utr);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'This UTR reference has already been submitted.' });
    }

    // Check Supabase if configured
    const admin = getSupabaseAdmin();
    let supabasePaymentId = null;
    if (admin) {
      const { data: existingSupabase } = await admin.from('payments').select('id').eq('utr_reference', utr).maybeSingle();
      if (existingSupabase) {
        return res.status(409).json({ ok: false, error: 'This UTR reference has already been submitted.' });
      }
      const { data: nPay } = await admin.from('payments').insert({
        org_id: req.organizationId,
        amount_inr: amount,
        provider: 'upi_direct',
        utr_reference: utr,
        status: 'pending_verification',
        submitted_by: req.userId
      }).select('id').single();
      supabasePaymentId = nPay?.id;
      await admin.from('organizations').update({ plan_status: 'pending_verification' }).eq('id', req.organizationId);
    }

    // Save payment as 'pending_verification' in local mirror
    const payment = db.insert('payments', {
      id: supabasePaymentId || undefined,
      organization_id: req.organizationId,
      amount_inr: amount,
      provider: 'upi_direct',
      utr_reference: utr,
      status: 'pending_verification',
      submitted_by: req.userId
    });

    res.json({
      ok: true,
      status: 'pending_verification',
      message: 'UTR submitted successfully. Payment is pending verification by finance; plan will activate upon bank reconciliation.',
      paymentId: payment.id
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Platform Finance / Superadmin UPI Reconciliation Endpoint
router.post('/admin/payments/reconcile', authenticate, async (req, res) => {
  try {
    const adminKey = req.headers['x-platform-admin-key'];
    const expectedKey = process.env.PLATFORM_ADMIN_SECRET || process.env.SESSION_SECRET;
    const isPlatformAdmin = (req.role === 'superadmin') || (adminKey && adminKey === expectedKey);

    if (!isPlatformAdmin) {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden: Platform finance or superadmin authorization is required to reconcile payments.'
      });
    }

    const { paymentId, status = 'verified', notes = '' } = req.body;
    if (!paymentId) {
      return res.status(400).json({ ok: false, error: 'paymentId is required.' });
    }

    const payment = db.findById('payments', paymentId);
    if (!payment) {
      return res.status(404).json({ ok: false, error: 'Payment record not found.' });
    }

    if (payment.status === 'verified') {
      return res.status(400).json({ ok: false, error: 'Payment is already verified.' });
    }

    db.update('payments', payment.id, {
      status,
      reconciled_by: req.userId || 'platform_admin',
      reconciled_at: new Date().toISOString(),
      reconciliation_notes: notes
    });

    const activated = status === 'verified' && payment.amount_inr >= 7499;
    const quota = payment.amount_inr >= 9999 ? 2500 : 500;
    if (activated) {
      db.update('organizations', payment.organization_id, {
        plan_status: 'active',
        monthly_lead_limit: quota
      });

      db.insert('audit_logs', {
        organization_id: payment.organization_id,
        operator_id: req.userId || 'platform_admin',
        action: 'PAYMENT_RECONCILED',
        details: { paymentId: payment.id, amountInr: payment.amount_inr, notes }
      });
    }

    const admin = getSupabaseAdmin();
    if (admin) {
      try {
        await admin.from('payments').update({
          status,
          reconciled_by: req.userId || 'platform_admin',
          reconciled_at: new Date().toISOString(),
          reconciliation_notes: notes
        }).eq('id', paymentId);

        if (activated) {
          await admin.from('organizations').update({
            plan_status: 'active',
            monthly_lead_limit: quota
          }).eq('id', payment.organization_id || payment.org_id);

          await admin.from('audit_logs').insert({
            org_id: payment.organization_id || payment.org_id,
            operator_id: req.userId || 'platform_admin',
            action: 'PAYMENT_RECONCILED',
            details: { paymentId: payment.id, amountInr: payment.amount_inr, notes }
          });
        }
      } catch (sbReconcileErr) {
        console.warn('[Supabase Reconcile Warning]', sbReconcileErr.message);
      }
    }

    res.json({
      ok: true,
      message: `Payment ${paymentId} reconciled as ${status}. ${activated ? 'Organization activated.' : 'No subscription activated.'}`,
      activated, status
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Dual Payment: Tab 2 — Razorpay Official Checkout SDK
router.post('/payments/razorpay/create-order', authenticate, async (req, res) => {
  try {
    const hasKeys = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
    if (!hasKeys && process.env.NODE_ENV !== 'test') {
      return res.status(503).json({
        ok: false,
        error: 'Razorpay payment gateway is not configured on this instance. Please use Direct UPI.'
      });
    }

    const org = await repository.getOrganizationById(req.organizationId);
    if (!org) return res.status(404).json({ ok: false, error: 'Organization not found.' });
    // Only the server-side quote may determine the amount.
    const amountInr = Number(org.custom_quote_inr || process.env.RAZORPAY_DEFAULT_AMOUNT_INR || 9999);
    if (!Number.isSafeInteger(amountInr) || amountInr <= 0) return res.status(503).json({ ok: false, error: 'Invalid configured plan price.' });
    const amountPaise = amountInr * 100;
    let orderId = null;

    // If live keys exist, call real Razorpay Orders API
    if (hasKeys && !process.env.RAZORPAY_KEY_ID.includes('placeholder')) {
      try {
        const authHeader = 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
        const rzpResp = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            amount: amountPaise,
            currency: 'INR',
            receipt: `rcpt_${req.organizationId.slice(0, 10)}_${Date.now()}`
          })
        });
        const rzpData = await rzpResp.json();
        if (!rzpResp.ok || !rzpData?.id) return res.status(502).json({ ok: false, error: 'Razorpay order creation failed.' });
        orderId = rzpData.id;
      } catch (e) {
        return res.status(502).json({ ok: false, error: 'Razorpay order creation failed.' });
      }
    }

    if (!orderId) return res.status(503).json({ ok: false, error: 'Razorpay is not configured.' });
    const payment = await repository.createPayment(req.organizationId, {
      amount_inr: amountInr,
      provider: 'razorpay',
      razorpay_order_id: orderId,
      quote_code: org.quote_code || null,
      status: 'pending'
    });

    res.json({
      ok: true,
      orderId,
      amount: amountPaise,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
      paymentId: payment.id
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/payments/razorpay/verify', authenticate, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const secret = process.env.RAZORPAY_KEY_SECRET;

    if (!secret && process.env.NODE_ENV !== 'test') {
      return res.status(503).json({ ok: false, error: 'Razorpay payment gateway secret is not configured on this server. Please use Direct UPI.' });
    }

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: 'Missing razorpay_order_id, razorpay_payment_id, or razorpay_signature' });
    }

    // Verify order exists and belongs to caller's authenticated organization
    const payment = await repository.getPaymentByOrderId(razorpay_order_id, req.organizationId);
    if (!payment) {
      return res.status(404).json({ ok: false, error: 'Order not found or does not belong to this organization.' });
    }

    if (secret) {
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      try {
        const isSigValid = crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(razorpay_signature));
        if (!isSigValid) {
          return res.status(400).json({ ok: false, error: 'Invalid Razorpay payment signature.' });
        }
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'Malformed signature payload.' });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'Cannot verify payment without RAZORPAY_KEY_SECRET.' });
    }

    // Verify against Razorpay Payments API if live credentials exist
    const hasLiveKeys = Boolean(
      process.env.RAZORPAY_KEY_ID &&
      process.env.RAZORPAY_KEY_SECRET &&
      !process.env.RAZORPAY_KEY_ID.includes('placeholder')
    );
    if (!hasLiveKeys && process.env.NODE_ENV !== 'test') {
      return res.status(503).json({ ok: false, error: 'Razorpay verification is not configured.' });
    }
    if (hasLiveKeys) {
      try {
        const authHeader = 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
        const payResp = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpay_payment_id)}`, {
          headers: { Authorization: authHeader }
        });
        if (!payResp.ok) {
          return res.status(400).json({ ok: false, error: 'Could not fetch payment verification from Razorpay gateway.' });
        }
        const payData = await payResp.json();
        if (payData.status !== 'captured') {
          return res.status(400).json({ ok: false, error: `Payment not captured. Current gateway status: ${payData.status}` });
        }
        if (payData.order_id !== razorpay_order_id) {
          return res.status(400).json({ ok: false, error: 'Payment order_id does not match the active checkout session.' });
        }
        const expectedPaise = payment.amount_inr * 100;
        if (payData.currency !== 'INR') return res.status(400).json({ ok: false, error: 'Payment currency mismatch.' });
        if (Number(payData.amount) !== expectedPaise) {
          return res.status(400).json({ ok: false, error: `Payment amount mismatch: expected ₹${payment.amount_inr}, received ₹${payData.amount / 100}` });
        }
      } catch (gatewayErr) {
        return res.status(502).json({ ok: false, error: `Payment gateway verification failed: ${gatewayErr.message}` });
      }
    }

    // Check for replay attacks: payment_id must not already be verified
    const existing = await repository.getPaymentByRazorpayPaymentId(razorpay_payment_id);
    if (existing && existing.status === 'verified') {
      return res.status(409).json({ ok: false, error: 'Payment ID already credited (replay attack prevented).' });
    }

    await repository.updatePayment(payment.id, {
      razorpay_payment_id,
      status: 'verified'
    });

    const planPrices = { START75: 7499, PRO12K: 12499, ANNUAL18K: 18000 };
    const defaultPrice = Number(process.env.RAZORPAY_DEFAULT_AMOUNT_INR || 9999);
    const isFullPlan = payment.quote_code
      ? planPrices[payment.quote_code] === payment.amount_inr
      : defaultPrice >= 7499 && payment.amount_inr === defaultPrice;
    if (isFullPlan) {
      const quota = payment.quote_code === 'PRO12K' ? 1500 : payment.quote_code === 'START75' ? 400 : 500;
      await repository.updateOrganizationScoped(req.organizationId, { plan_status: 'active', monthly_lead_limit: quota });
    }
    res.json({
      ok: true,
      activated: isFullPlan,
      message: isFullPlan ? 'Payment verified and workspace activated.' : 'Payment verified; deposit/setup does not activate a subscription.'
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ==========================================
// 12. SAFE CONVERSATIONAL LEARNING & REVIEW QUEUE
// ==========================================
router.get('/learning/proposals', authenticate, (req, res) => {
  try {
    const proposals = LearningService.listProposals(req.organizationId, req.query);
    res.json({ ok: true, proposals });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/learning/proposals/:id/approve', authenticate, requireRole(['owner', 'admin']), (req, res) => {
  try {
    const result = LearningService.approveProposal(req.organizationId, req.params.id, req.userId);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/learning/proposals/:id/reject', authenticate, requireRole(['owner', 'admin']), (req, res) => {
  try {
    const result = LearningService.rejectProposal(req.organizationId, req.params.id, req.userId, req.body?.reason);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.get('/learning/facts', authenticate, (req, res) => {
  try {
    const facts = LearningService.listApprovedFacts(req.organizationId);
    res.json({ ok: true, facts });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.delete('/learning/facts/:id', authenticate, requireRole(['owner', 'admin']), (req, res) => {
  try {
    const result = LearningService.deleteApprovedFact(req.organizationId, req.params.id);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/learning/opt-out', authenticate, requireRole(['owner', 'admin']), (req, res) => {
  try {
    const result = LearningService.optOut(req.organizationId);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

export default router;
