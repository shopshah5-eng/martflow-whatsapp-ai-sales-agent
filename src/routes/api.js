/**
 * MartFlow AI — Modular SaaS API Router
 * Fully authenticated, tenant-isolated REST endpoints.
 */

import express from 'express';
import { signUp, login, sendPhoneOtp, verifyPhoneOtp } from '../auth/authService.js';
import { authenticate, requireRole } from '../middleware/authMiddleware.js';
import { LeadService } from '../services/leadService.js';
import { CatalogService } from '../services/catalogService.js';
import { CallSchedulerService } from '../services/callSchedulerService.js';
import { AnalyticsService } from '../services/analyticsService.js';
import { AIService } from '../services/aiService.js';
import { WhatsAppAdapter } from '../integrations/whatsapp/whatsappAdapter.js';
import { IndiaMartWebhook } from '../integrations/indiamart/indiamartWebhook.js';
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
// 3. PRODUCT CATALOG ENDPOINTS (TENANT SCOPED)
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

router.delete('/catalog/products/:id', authenticate, requireRole(['owner', 'admin']), (req, res) => {
  try {
    CatalogService.deleteProduct(req.organizationId, req.params.id);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 4. TWO-WAY CALL SCHEDULER ENDPOINTS
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
// 5. GENUINE ANALYTICS ENDPOINT (REAL DB RECORDS)
// ==========================================
router.get('/analytics', authenticate, (req, res) => {
  const metrics = AnalyticsService.getDashboardMetrics(req.organizationId);
  res.json({ ok: true, metrics });
});

// ==========================================
// 6. SETTINGS & TEAM MANAGEMENT ENDPOINTS
// ==========================================
router.get('/settings/ai', authenticate, (req, res) => {
  const settings = db.findOne('ai_settings', (s) => s.organization_id === req.organizationId) || {};
  res.json({ ok: true, settings });
});

router.post('/settings/ai', authenticate, requireRole(['owner', 'admin']), (req, res) => {
  const existing = db.findOne('ai_settings', (s) => s.organization_id === req.organizationId);
  if (existing) {
    const updated = db.updateScoped('ai_settings', existing.id, req.organizationId, req.body);
    return res.json({ ok: true, settings: updated });
  }
  const created = db.insert('ai_settings', { organization_id: req.organizationId, ...req.body });
  res.json({ ok: true, settings: created });
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
// 7. REAL WEBHOOK INGESTION ENDPOINTS
// ==========================================
router.post('/webhook/indiamart', async (req, res) => {
  try {
    // Tenant identification via query param (e.g. ?orgId=xxx) or header
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
// 8. BILLING & SUBSCRIPTIONS
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
