/**
 * MartFlow AI — Modular SaaS API Router
 * Fully authenticated, tenant-isolated REST endpoints with live WhatsApp & IndiaMART integration.
 */

import express from 'express';
import { signUp, login, demoLogin, sendPhoneOtp, verifyPhoneOtp } from '../auth/authService.js';
import { authenticate, requireRole } from '../middleware/authMiddleware.js';
import { LeadService } from '../services/leadService.js';
import { CatalogService } from '../services/catalogService.js';
import { CallSchedulerService } from '../services/callSchedulerService.js';
import { AnalyticsService } from '../services/analyticsService.js';
import { AIService } from '../services/aiService.js';
import { WhatsAppAdapter } from '../integrations/whatsapp/whatsappAdapter.js';
import { IndiaMartWebhook } from '../integrations/indiamart/indiamartWebhook.js';
import { baileysManager } from '../integrations/whatsapp/baileysManager.js';
import db from '../db/index.js';

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
  try {
    const result = await demoLogin();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/auth/otp/send', (req, res) => {
  try {
    const result = sendPhoneOtp(req.body.phone);
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

router.get('/auth/me', authenticate, (req, res) => {
  const profile = db.findById('profiles', req.userId);
  res.json({
    ok: true,
    user: profile ? { id: profile.id, email: profile.email, fullName: profile.full_name, phone: profile.phone } : null,
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

    const webhookRes = await IndiaMartWebhook.handleIncomingWebhook(req.organizationId, payload);
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
      buyerName: lead?.buyer_name || 'IndiaMART Buyer',
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

    // Send via live Baileys socket
    const sendResult = await baileysManager.sendMessage(lead.buyer_phone, message.trim());
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

    res.json({ ok: true, message: msgRecord });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 4. WHATSAPP CONNECTION & QR MANAGEMENT
// ==========================================
router.get('/whatsapp/status', (req, res) => {
  const state = baileysManager.getState();
  res.json({ ok: true, status: state.status, phoneNumber: state.phoneNumber, waState: state });
});

router.post('/whatsapp/connect', async (req, res) => {
  try {
    await baileysManager.init();
    res.json({ ok: true, waState: baileysManager.getState() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/whatsapp/disconnect', async (req, res) => {
  try {
    await baileysManager.disconnect();
    res.json({ ok: true, waState: baileysManager.getState() });
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

router.post('/catalog/upload', authenticate, async (req, res) => {
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

router.post('/calls/confirm', authenticate, (req, res) => {
  try {
    const result = CallSchedulerService.confirmCallSlot(req.organizationId, {
      callRequestId: req.body.callRequestId,
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
router.get('/settings', authenticate, (req, res) => {
  const settings = db.findOne('ai_settings', (s) => s.organization_id === req.organizationId) || {};
  res.json({
    ok: true,
    organization: req.organization,
    settings
  });
});

router.post('/settings', authenticate, requireRole(['owner', 'admin']), (req, res) => {
  const { companyName, cityBase, ownerAlertPhone, geminiApiKey } = req.body;

  if (companyName && companyName.trim()) {
    db.update('organizations', req.organizationId, { name: companyName.trim() });
  }

  const existing = db.findOne('ai_settings', (s) => s.organization_id === req.organizationId);
  const updates = {
    company_name: companyName ? companyName.trim() : (existing?.company_name || 'Bharat Machinery'),
    city_base: cityBase ? cityBase.trim() : (existing?.city_base || 'Delhi NCR'),
    escalation_phone: ownerAlertPhone ? ownerAlertPhone.trim() : (existing?.escalation_phone || '')
  };

  if (geminiApiKey && typeof geminiApiKey === 'string' && !geminiApiKey.includes('...')) {
    process.env.GEMINI_API_KEY = geminiApiKey.trim();
  }

  let saved;
  if (existing) {
    saved = db.updateScoped('ai_settings', existing.id, req.organizationId, updates);
  } else {
    saved = db.insert('ai_settings', { organization_id: req.organizationId, ...updates });
  }

  res.json({ ok: true, settings: saved });
});

router.post('/settings/whatsapp', authenticate, requireRole(['owner', 'admin']), (req, res) => {
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

  res.json({ ok: true, message: 'WhatsApp Cloud API settings saved successfully.' });
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
// 9. REAL WEBHOOK INGESTION ENDPOINTS
// ==========================================
router.post('/webhook/indiamart/:webhookKey', async (req, res) => {
  try {
    const token = req.headers['x-indiamart-token'] || req.query.token;
    const result = await IndiaMartWebhook.handleWebhookByKey(req.params.webhookKey, req.body, token);
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/webhook/indiamart', async (req, res) => {
  try {
    let orgId = req.query.orgId || req.headers['x-tenant-id'];
    if (!orgId) {
      const defaultOrg = db.findOne('organizations', () => true);
      orgId = defaultOrg ? defaultOrg.id : null;
    }
    const token = req.headers['x-indiamart-token'] || req.query.token;
    const result = await IndiaMartWebhook.handleIncomingWebhook(orgId, req.body, token);
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
  const result = await WhatsAppAdapter.handleCloudWebhook(req.body);
  res.json(result);
});

// ==========================================
// 10. BILLING & SUBSCRIPTIONS
// ==========================================
router.get('/billing', authenticate, (req, res) => {
  const org = req.organization;
  const isRazorpayConfigured = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  res.json({
    ok: true,
    billing: {
      plan: org.plan || 'starter',
      monthlyLeadLimit: org.monthly_lead_limit || 500,
      currentUsage: db.findScoped('leads', org.id).length,
      isConfigured: isRazorpayConfigured,
      currency: 'INR',
      plansAvailable: [
        { name: 'Starter', price: '₹4,999/mo', leadLimit: 500 },
        { name: 'Growth', price: '₹12,499/mo', leadLimit: 2500 },
        { name: 'Enterprise', price: 'Custom', leadLimit: 'Unlimited' }
      ]
    }
  });
});

export default router;
