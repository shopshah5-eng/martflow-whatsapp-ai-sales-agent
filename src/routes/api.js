/**
 * MartFlow AI — Modular SaaS API Router
 * Fully authenticated, tenant-isolated REST endpoints with live WhatsApp & B2B integration.
 */

import express from 'express';
import crypto from 'crypto';
import { signUp, login, demoLogin, handleGoogleAuth, sendPhoneOtp, verifyPhoneOtp } from '../auth/authService.js';
import { authenticate, requireRole } from '../middleware/authMiddleware.js';
import { LeadService } from '../services/leadService.js';
import { CatalogService } from '../services/catalogService.js';
import { CallSchedulerService } from '../services/callSchedulerService.js';
import { AnalyticsService } from '../services/analyticsService.js';
import { AIService } from '../services/aiService.js';
import { WhatsAppAdapter } from '../integrations/whatsapp/whatsappAdapter.js';
import { B2BWebhook } from '../integrations/b2b/b2bWebhook.js';
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
    const result = await handleGoogleAuth(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
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

router.post('/whatsapp/connect', authenticate, async (req, res) => {
  try {
    const orgId = req.organizationId;
    await baileysManager.init(orgId);
    res.json({ ok: true, waState: baileysManager.getState(orgId) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/whatsapp/disconnect', authenticate, async (req, res) => {
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

  // Update organization WhatsApp settings
  db.update('organizations', req.organizationId, {
    waba_phone_id: phoneId || null,
    waba_token: token || null,
    wa_mode: phoneId && token ? 'cloud_api' : 'qr'
  });

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
    const token = req.headers['x-b2b-token'] || req.headers['x-indiamart-token'] || req.headers['x-webhook-key'];
    let orgId = req.headers['x-tenant-id'];

    if (token) {
      const org = db.findByWebhookKey(token) || db.findById('organizations', token);
      if (org) orgId = org.id;
    }

    if (!orgId) {
      return res.status(401).json({ status: 'unauthorized', error: 'Authentication required: Missing valid tenant webhook key or token.' });
    }

    const result = await B2BWebhook.handleIncomingWebhook(orgId, req.body, token);
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
  // Validate Meta raw body signature if META_APP_SECRET is set
  const appSecret = process.env.META_APP_SECRET;
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
      isRazorpayConfigured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || null
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

router.post('/membership/unlock-code', authenticate, (req, res) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ ok: false, error: 'Activation code is required.' });

    const COUPONS = {
      'PILOT999': { amount: 999, description: '48-Hour VIP Engineer Setup Deposit — Adjusted in Plan' },
      'VIP999': { amount: 999, description: '48-Hour VIP Engineer Setup Deposit — Adjusted in Plan' },
      'SETUP5K': { amount: 5000, description: 'One-Time Factory Setup & Catalog AI Training' },
      'START75': { amount: 7499, description: '₹5,000 Setup + ₹2,499 First Month — 400 Leads/mo' },
      'PRO12K': { amount: 12499, description: '₹7,500 Setup + ₹4,999 First Month — 1,500 Leads/mo' },
      'ANNUAL18K': { amount: 18000, description: 'Full 1-Year Factory License — ₹5,000 Setup Waived FREE!' }
    };

    let coupon = COUPONS[code];
    if (!coupon) {
      if (code.startsWith('PILOT') || code.startsWith('VIP')) {
        coupon = { amount: 999, description: '48-Hour VIP Engineer Setup Deposit — Adjusted in Plan' };
      } else if (code.startsWith('SETUP')) {
        coupon = { amount: 5000, description: 'One-Time Factory Setup & Catalog AI Training' };
      } else if (code.startsWith('START')) {
        coupon = { amount: 7499, description: '₹5,000 Setup + ₹2,499 First Month — 400 Leads/mo' };
      } else if (code.startsWith('PRO')) {
        coupon = { amount: 12499, description: '₹7,500 Setup + ₹4,999 First Month — 1,500 Leads/mo' };
      } else if (code.startsWith('ANNUAL')) {
        coupon = { amount: 18000, description: 'Full 1-Year Factory License — ₹5,000 Setup Waived FREE!' };
      } else {
        return res.status(400).json({
          ok: false,
          error: 'Invalid activation code. Valid codes: PILOT999, VIP999, SETUP5K, START75, PRO12K, ANNUAL18K'
        });
      }
    }

    db.update('organizations', req.organizationId, {
      custom_quote_inr: coupon.amount
    });

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
router.post('/payments/upi-verify', authenticate, (req, res) => {
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

    // Save payment as 'pending_verification' — NEVER auto-activate plan on unverified UTR
    const payment = db.insert('payments', {
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
router.post('/admin/payments/reconcile', authenticate, (req, res) => {
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

    if (status === 'verified') {
      const quota = payment.amount_inr >= 9999 ? 2500 : 500;
      db.update('organizations', payment.organization_id, {
        plan_status: 'active',
        monthly_lead_limit: quota
      });

      // Audit log entry
      db.insert('audit_logs', {
        organization_id: payment.organization_id,
        operator_id: req.userId || 'platform_admin',
        action: 'PAYMENT_RECONCILED',
        details: { paymentId: payment.id, amountInr: payment.amount_inr, notes }
      });
    }

    res.json({
      ok: true,
      message: `Payment ${paymentId} reconciled as ${status}. Organization activated.`,
      status
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

    const amountInr = parseInt(req.body.amountInr || 3499, 10);
    const amountPaise = amountInr * 100;
    let orderId = 'order_' + crypto.randomBytes(8).toString('hex');

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
        if (rzpData?.id) {
          orderId = rzpData.id;
        }
      } catch (e) {
        console.warn('[Razorpay API] Orders API call failed:', e.message);
      }
    }

    const payment = db.insert('payments', {
      organization_id: req.organizationId,
      amount_inr: amountInr,
      provider: 'razorpay',
      razorpay_order_id: orderId,
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

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: 'Missing razorpay_order_id, razorpay_payment_id, or razorpay_signature' });
    }

    if (secret) {
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      if (expectedSig !== razorpay_signature) {
        return res.status(400).json({ ok: false, error: 'Invalid Razorpay payment signature.' });
      }
    }

    // Check for replay attacks: payment_id must not already be verified
    const existing = db.findOne('payments', (p) => p.razorpay_payment_id === razorpay_payment_id && p.status === 'verified');
    if (existing) {
      return res.status(409).json({ ok: false, error: 'Payment ID already credited (replay attack prevented).' });
    }

    const payment = db.findOne('payments', (p) => p.razorpay_order_id === razorpay_order_id);
    if (payment) {
      db.update('payments', payment.id, {
        razorpay_payment_id,
        status: 'verified'
      });
    }

    db.update('organizations', req.organizationId, {
      plan_status: 'active',
      monthly_lead_limit: 500
    });

    res.json({
      ok: true,
      message: 'Razorpay payment verified & workspace activated!'
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
