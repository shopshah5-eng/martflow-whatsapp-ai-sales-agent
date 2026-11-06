// Safe foundations for review requests and future custom website integration.
// No worker in this module sends messages, and no website is contacted.
import express from 'express';
import crypto from 'crypto';
import db from '../db/index.js';
import { repository } from '../db/repository.js';
import { authenticate, requireRole } from '../middleware/authMiddleware.js';
import { canManageCatalog, requireCatalogManager, requireConversationAccess } from '../middleware/catalogAccess.js';
import { FollowUpService } from '../services/followUpService.js';
import { normalizeIndianPhone } from '../services/takeoverService.js';
import { invalidateCache } from '../services/aiService.js';

const router = express.Router();
const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
const failure = (res) => res.status(503).json({ ok: false, error: 'Feature storage unavailable. Deployment setup may be required.' });
const owner = [authenticate, requireConversationAccess, requireRole(['owner', 'admin'])];
const digest = key => crypto.createHash('sha256').update(key).digest('hex');
const scoped = (table, orgId) => db.findOne(table, r => r.org_id === orgId);

export function validateReviewUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const domains = new Set(['google.com', 'www.google.com', 'google.co.in', 'www.google.co.in', 'maps.google.com', 'maps.app.goo.gl', 'g.page', 'search.google.com']);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && domains.has(url.hostname.toLowerCase());
  } catch { return false; }
}

router.get('/review-requests/settings', noStore, ...owner, async (req, res) => {
  try {
    const sb = repository.getSupabase();
    let settings;
    if (sb) {
      const r = await sb.from('review_request_settings').select('review_url,enabled').eq('org_id', req.organizationId).maybeSingle();
      if (r.error) throw r.error;
      settings = r.data;
    } else settings = scoped('review_request_settings', req.organizationId);
    res.json({ ok: true, settings: { reviewUrl: settings?.review_url || '', enabled: settings?.enabled === true }, deliveryAvailable: false });
  } catch { return failure(res); }
});
router.put('/review-requests/settings', noStore, ...owner, async (req, res) => {
  const { reviewUrl, enabled } = req.body || {};
  if (typeof enabled !== 'boolean' || typeof reviewUrl !== 'string' || (reviewUrl && !validateReviewUrl(reviewUrl)) || (enabled && !validateReviewUrl(reviewUrl))) {
    return res.status(400).json({ ok: false, error: 'Enter a valid HTTPS Google review link before enabling.' });
  }
  try {
    const sb = repository.getSupabase();
    const row = { org_id: req.organizationId, review_url: reviewUrl || '', enabled, updated_at: new Date().toISOString() };
    if (sb) {
      const r = await sb.from('review_request_settings').upsert(row, { onConflict: 'org_id' });
      if (r.error) throw r.error;
    } else {
      const existing = scoped('review_request_settings', req.organizationId);
      if (existing) db.update('review_request_settings', existing.id, row); else db.insert('review_request_settings', row);
    }
    return res.json({ ok: true, deliveryAvailable: false });
  } catch { return failure(res); }
});
router.get('/review-requests', noStore, ...owner, async (req, res) => {
  try {
    const sb = repository.getSupabase(); let records;
    if (sb) {
      const r = await sb.from('review_request_queue').select('id,lead_id,buyer_phone,status,created_at').eq('org_id', req.organizationId).order('created_at', { ascending: false }).limit(100);
      if (r.error) throw r.error; records = r.data || [];
    } else records = db.find('review_request_queue', x => x.org_id === req.organizationId).slice(-100).reverse();
    res.json({ ok: true, requests: records, deliveryAvailable: false });
  } catch { return failure(res); }
});
router.post('/review-requests', noStore, ...owner, async (req, res) => {
  const { leadId, consentConfirmed, dealConfirmed } = req.body || {};
  if (typeof leadId !== 'string' || leadId.length > 100 || consentConfirmed !== true || dealConfirmed !== true) {
    return res.status(400).json({ ok: false, error: 'Confirm the completed deal and the customer’s permission to receive a review request.' });
  }
  try {
    const sb = repository.getSupabase();
    let settings;
    if (sb) {
      const r = await sb.from('review_request_settings').select('review_url,enabled').eq('org_id', req.organizationId).maybeSingle();
      if (r.error) throw r.error; settings = r.data;
    } else settings = scoped('review_request_settings', req.organizationId);
    if (!settings?.enabled || !validateReviewUrl(settings.review_url)) return res.status(409).json({ ok: false, error: 'Enable review requests and save a valid review link first.' });
    const lead = await repository.getLeadById(req.organizationId, leadId);
    if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found.' });
    if (!['won', 'completed', 'converted'].includes(String(lead.status || '').toLowerCase())) return res.status(409).json({ ok: false, error: 'Mark this lead as won or completed before confirming a review request.' });
    const phone = normalizeIndianPhone(lead.buyer_phone || lead.phone || '');
    if (!/^\d{10,15}$/.test(phone)) return res.status(400).json({ ok: false, error: 'A valid customer phone number is required.' });
    if (FollowUpService.isOptedOut(req.organizationId, phone)) return res.status(409).json({ ok: false, error: 'Customer has opted out.' });
    if (sb) {
      const opt = await sb.from('durable_opt_outs').select('id').eq('org_id', req.organizationId).eq('buyer_phone', phone).maybeSingle();
      if (opt.error) throw opt.error;
      if (opt.data) return res.status(409).json({ ok: false, error: 'Customer has opted out.' });
    }
    const row = { org_id: req.organizationId, lead_id: leadId, buyer_phone: phone, status: 'awaiting_delivery_setup', confirmed_by: req.userId, consent_confirmed_at: new Date().toISOString() };
    if (sb) {
      const result = await sb.from('review_request_queue').insert(row).select('id,status').single();
      if (result.error?.code === '23505') return res.status(409).json({ ok: false, error: 'A review request already exists for this customer.' });
      if (result.error) throw result.error;
      return res.status(201).json({ ok: true, request: result.data, deliveryAvailable: false });
    }
    if (db.findOne('review_request_queue', r => r.org_id === req.organizationId && r.buyer_phone === phone)) return res.status(409).json({ ok: false, error: 'A review request already exists for this customer.' });
    const record = db.insert('review_request_queue', row);
    return res.status(201).json({ ok: true, request: { id: record.id, status: record.status }, deliveryAvailable: false });
  } catch { return failure(res); }
});

// Each secret is scoped to a single workspace and its issuing human's live grants.
// It is shown once, never stored in plaintext, and must stay on the website server.
router.post('/website-integration/key', noStore, authenticate, requireCatalogManager, async (req, res) => {
  const orgId = req.query?.org_id || req.body?.orgId || req.organizationId;
  try {
    if (req.userId === 'platform_admin' || !await repository.getProfileById(req.userId) || !await repository.getOrganizationById(orgId)) return res.status(403).json({ ok: false, error: 'Use an authorized signed-in account and an existing workspace.' });
    const key = 'lsw_' + crypto.randomBytes(32).toString('base64url');
    const row = { org_id: orgId, token_hash: digest(key), issued_by: req.userId, updated_at: new Date().toISOString() };
    const sb = repository.getSupabase();
    if (sb) {
      const r = await sb.from('custom_website_integrations').upsert(row, { onConflict: 'org_id' });
      if (r.error) throw r.error;
    } else {
      const existing = scoped('custom_website_integrations', orgId);
      if (existing) db.update('custom_website_integrations', existing.id, row); else db.insert('custom_website_integrations', row);
    }
    res.json({ ok: true, key, message: 'Store this key on the website server only. It will not be shown again.' });
  } catch { return failure(res); }
});
router.delete('/website-integration/key', noStore, authenticate, requireCatalogManager, async (req, res) => {
  const orgId = req.query?.org_id || req.body?.orgId || req.organizationId;
  try {
    const sb = repository.getSupabase();
    if (sb) { const r = await sb.from('custom_website_integrations').delete().eq('org_id', orgId); if (r.error) throw r.error; }
    else { const existing = scoped('custom_website_integrations', orgId); if (existing) db.delete('custom_website_integrations', existing.id); }
    res.json({ ok: true });
  } catch { return failure(res); }
});
async function websiteAuth(req, res, next) {
  const key = req.get('x-website-key') || '';
  if (!/^lsw_[A-Za-z0-9_-]{43}$/.test(key)) return res.status(401).json({ ok: false, error: 'Invalid integration credentials.' });
  try {
    const hash = digest(key), sb = repository.getSupabase(); let record;
    if (sb) { const r = await sb.from('custom_website_integrations').select('org_id,issued_by').eq('token_hash', hash).maybeSingle(); if (r.error) throw r.error; record = r.data; }
    else record = db.findOne('custom_website_integrations', r => r.token_hash === hash);
    if (!record) return res.status(401).json({ ok: false, error: 'Invalid integration credentials.' });
    const profile = await repository.getProfileById(record.issued_by);
    const ownOrg = profile?.org_id || profile?.organization_id;
    const member = ownOrg && await repository.getMembership(record.issued_by, ownOrg);
    if (!member || !await canManageCatalog({ userId: record.issued_by, role: member.role, organizationId: ownOrg, query: { org_id: record.org_id }, body: {} })) {
      return res.status(403).json({ ok: false, error: 'Integration access has been revoked.' });
    }
    req.websiteOrgId = record.org_id; next();
  } catch { return failure(res); }
}
const fields = 'id,name,sku,category,model_specs,description,price_raw,image_url,is_active,updated_at';
const project = product => Object.fromEntries(fields.split(',').map(k => [k, product[k] ?? null]));
router.get('/website-integration/products', noStore, websiteAuth, async (req, res) => {
  try {
    const rawOffset = req.query.offset ?? '0';
    if (typeof rawOffset !== 'string' || !/^\d{1,6}$/.test(rawOffset) || Number(rawOffset) > 100000) return res.status(400).json({ ok: false, error: 'Invalid offset.' });
    const offset = Number(rawOffset), pageSize = 100;
    const sb = repository.getSupabase(); let products;
    if (sb) {
      const r = await sb.from('products').select(fields).eq('org_id', req.websiteOrgId).neq('is_active', false).order('id').range(offset, offset + pageSize);
      if (r.error) throw r.error; products = r.data || [];
    } else products = db.find('products', p => (p.org_id === req.websiteOrgId || p.organization_id === req.websiteOrgId) && p.is_active !== false).sort((a,b) => a.id.localeCompare(b.id)).slice(offset, offset + pageSize + 1).map(project);
    res.json({ ok: true, products: products.slice(0, pageSize), nextOffset: products.length > pageSize ? offset + pageSize : null });
  } catch { return failure(res); }
});
router.patch('/website-integration/products/:id', noStore, websiteAuth, async (req, res) => {
  const { expectedUpdatedAt, ...input } = req.body || {};
  const limits = { name: 500, category: 200, model_specs: 600, description: 3000, price_raw: 80 };
  if (typeof expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedUpdatedAt)) || !Object.keys(input).length || Object.keys(input).some(k => !Object.hasOwn(limits, k) || typeof input[k] !== 'string' || input[k].length > limits[k] || (k === 'name' && !input[k].trim()))) return res.status(400).json({ ok: false, error: 'Provide a valid version and supported product text fields.' });
  const updates = Object.fromEntries(Object.entries(input).map(([k,v]) => [k,v.trim()]));
  updates.updated_at = new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString();
  try {
    const sb = repository.getSupabase(); let product;
    if (sb) {
      const r = await sb.from('products').update(updates).eq('org_id', req.websiteOrgId).eq('id', req.params.id).eq('updated_at', expectedUpdatedAt).select(fields).maybeSingle();
      if (r.error) throw r.error; product = r.data;
    } else {
      const current = db.findOne('products', p => p.id === req.params.id && (p.org_id === req.websiteOrgId || p.organization_id === req.websiteOrgId));
      if (current && current.updated_at === expectedUpdatedAt) product = project(db.update('products', current.id, updates));
    }
    if (!product) return res.status(409).json({ ok: false, error: 'Product not found or changed. Reload before editing.' });
    invalidateCache(req.websiteOrgId);
    res.json({ ok: true, product });
  } catch { return failure(res); }
});
export default router;
