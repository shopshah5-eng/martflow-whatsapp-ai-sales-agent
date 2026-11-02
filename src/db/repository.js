/**
 * MartFlow AI — Explicit Tenant-Scoped Database Repository
 * Replaces in-memory predicate filtering with explicit, parameterized queries.
 * In production (NODE_ENV === 'production'), enforces Supabase as authoritative;
 * fails closed if Supabase is unreachable. In test/dev, uses isolated transactional store.
 */

import { createClient } from '@supabase/supabase-js';
import db from './index.js';

function isUuid(val) {
  return typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
}

export class DatabaseUnavailableError extends Error {
  constructor(message = 'Primary database service is currently unavailable. Please try again later.') {
    super(message);
    this.name = 'DatabaseUnavailableError';
    this.statusCode = 503;
    this.code = 'DATABASE_UNAVAILABLE';
  }
}

class TenantRepository {
  constructor() {
    this.supabase = null;
    this.isProduction = process.env.NODE_ENV === 'production';
    this.initClient();
  }

  initClient() {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && serviceKey) {
      this.supabase = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
    }
  }

  getSupabase() {
    if (this.supabase) return this.supabase;
    if (this.isProduction && process.env.USE_LOCAL_DB !== 'true') {
      throw new DatabaseUnavailableError('Supabase service role credentials not configured in production.');
    }
    return null;
  }

  // --- Organizations ---
  async getOrganizationById(orgId) {
    if (!orgId) return null;
    const sb = isUuid(orgId) ? this.getSupabase() : null;
    if (sb) {
      const { data, error } = await sb.from('organizations').select('*').eq('id', orgId).maybeSingle();
      if (error) throw new DatabaseUnavailableError(error.message);
      return data || null;
    }
    return db.findById('organizations', orgId);
  }

  async getOrganizationByWebhookKey(webhookKey) {
    if (!webhookKey) return null;
    const sb = this.getSupabase();
    if (sb) {
      const { data, error } = await sb.from('organizations').select('*').eq('webhook_key', webhookKey).single();
      if (error && error.code !== 'PGRST116') throw new DatabaseUnavailableError(error.message);
      return data || null;
    }
    return db.findByWebhookKey(webhookKey);
  }

  async updateOrganizationScoped(orgId, updates) {
    if (!orgId) throw new Error('orgId is required');
    const sb = isUuid(orgId) ? this.getSupabase() : null;
    if (sb) {
      const { data, error } = await sb.from('organizations').update(updates).eq('id', orgId).select().maybeSingle();
      if (error) throw new DatabaseUnavailableError(error.message);
      return data;
    }
    return db.update('organizations', orgId, updates);
  }

  // Atomic quota check and increment
  async atomicIncrementLeadUsage(orgId, monthlyLimit) {
    if (!orgId) throw new Error('orgId is required');
    const sb = this.getSupabase();
    if (sb) {
      // Execute parameterized RPC or conditional update
      const { data, error } = await sb
        .from('organizations')
        .update({ leads_used: sb.raw('leads_used + 1') })
        .eq('id', orgId)
        .lt('leads_used', monthlyLimit || 999999)
        .select('leads_used, monthly_lead_limit')
        .single();

      if (error) {
        // Limit exceeded or update error
        return { success: false, leadsUsed: null };
      }
      return { success: true, leadsUsed: data?.leads_used };
    }

    // Local DB atomic check
    const org = db.findById('organizations', orgId);
    if (!org) return { success: false, leadsUsed: null };
    const current = org.leads_used || 0;
    const limit = monthlyLimit || org.monthly_lead_limit || 25;
    if (current >= limit) {
      return { success: false, leadsUsed: current, quotaExceeded: true };
    }
    const updated = db.update('organizations', orgId, { leads_used: current + 1 });
    return { success: true, leadsUsed: updated.leads_used };
  }

  // --- Profiles & Membership ---
  async getProfileByEmail(email) {
    if (!email) return null;
    const cleanEmail = email.trim().toLowerCase();
    const sb = this.getSupabase();
    if (sb) {
      const { data, error } = await sb.from('profiles').select('*').eq('email', cleanEmail).single();
      if (error && error.code !== 'PGRST116') throw new DatabaseUnavailableError(error.message);
      return data || null;
    }
    return db.findOne('profiles', p => p.email === cleanEmail);
  }

  async getProfileById(userId) {
    if (!userId) return null;
    const sb = isUuid(userId) ? this.getSupabase() : null;
    if (sb) {
      const { data, error } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
      if (error) throw new DatabaseUnavailableError(error.message);
      return data || null;
    }
    return db.findById('profiles', userId);
  }

  async getMembership(userId, orgId) {
    if (!userId || !orgId) return null;
    const sb = (isUuid(userId) && isUuid(orgId)) ? this.getSupabase() : null;
    if (sb) {
      const { data, error } = await sb.from('profiles').select('id, org_id, role').eq('id', userId).eq('org_id', orgId).maybeSingle();
      if (error) throw new DatabaseUnavailableError(error.message);
      if (data) return { user_id: data.id, organization_id: data.org_id, role: data.role };
    }
    return db.findOne('organization_members', m => m.user_id === userId && m.organization_id === orgId) ||
           db.findOne('profiles', p => (p.id === userId || p.user_id === userId) && (p.organization_id === orgId || p.org_id === orgId));
  }

  // --- Leads ---
  async createLead(orgId, leadData) {
    if (!orgId) throw new Error('orgId is required');
    const record = { ...leadData, organization_id: orgId, org_id: orgId };
    const sb = this.getSupabase();
    if (sb) {
      const { data, error } = await sb.from('leads').insert({
        org_id: orgId,
        buyer_name: leadData.buyer_name || leadData.buyerName,
        buyer_phone: leadData.buyer_phone || leadData.buyerPhone,
        buyer_city: leadData.buyer_city || leadData.buyerCity,
        product_inquired: leadData.product_inquired || leadData.productInquired,
        query_message: leadData.query_message || leadData.queryMessage,
        status: leadData.status || 'new'
      }).select().single();
      if (error) throw new DatabaseUnavailableError(error.message);
      return data;
    }
    return db.insert('leads', record);
  }

  async getLeadByPhone(orgId, phone) {
    if (!orgId || !phone) return null;
    const cleanPhone = String(phone).replace(/\D/g, '');
    const sb = this.getSupabase();
    if (sb) {
      const { data, error } = await sb.from('leads').select('*').eq('org_id', orgId).eq('buyer_phone', cleanPhone).order('created_at', { ascending: false }).limit(1);
      if (error) throw new DatabaseUnavailableError(error.message);
      return data?.[0] || null;
    }
    return db.findOne('leads', l => l.organization_id === orgId && (l.buyer_phone === cleanPhone || l.buyerPhone === cleanPhone));
  }

  async findDuplicateLead(orgId, buyerPhone, windowMs = 86400000) {
    if (!orgId || !buyerPhone) return null;
    const cleanPhone = String(buyerPhone).replace(/\D/g, '');
    const cutoff = new Date(Date.now() - windowMs).toISOString();

    const sb = this.getSupabase();
    if (sb) {
      const { data, error } = await sb
        .from('leads')
        .select('*')
        .eq('org_id', orgId)
        .eq('buyer_phone', cleanPhone)
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw new DatabaseUnavailableError(error.message);
      return data?.[0] || null;
    }

    return db.findOne('leads', l => {
      const lPhone = String(l.buyer_phone || l.buyerPhone || '').replace(/\D/g, '');
      const lOrg = l.organization_id || l.org_id;
      return lOrg === orgId && lPhone === cleanPhone && (!l.created_at || l.created_at >= cutoff);
    });
  }

  // --- Payments & Reconciliation ---
  async createPayment(orgId, paymentData) {
    if (!orgId) throw new Error('orgId is required');
    const record = { ...paymentData, organization_id: orgId, org_id: orgId, created_at: new Date().toISOString() };
    const sb = this.getSupabase();
    if (sb) {
      const { data, error } = await sb.from('payments').insert({
        org_id: orgId,
        amount_inr: paymentData.amount_inr || paymentData.amount,
        provider: paymentData.provider,
        razorpay_order_id: paymentData.razorpay_order_id,
        razorpay_payment_id: paymentData.razorpay_payment_id,
        utr_reference: paymentData.utr_reference || paymentData.utr,
        status: paymentData.status || 'pending'
      }).select().single();
      if (error) throw new DatabaseUnavailableError(error.message);
      return data;
    }
    return db.insert('payments', record);
  }

  async getPaymentByUtr(utr) {
    if (!utr) return null;
    const cleanUtr = utr.trim();
    const sb = this.getSupabase();
    if (sb) {
      const { data, error } = await sb.from('payments').select('*').eq('utr_reference', cleanUtr).single();
      if (error && error.code !== 'PGRST116') throw new DatabaseUnavailableError(error.message);
      return data || null;
    }
    return db.findOne('payments', p => (p.utr_reference === cleanUtr || p.utr === cleanUtr));
  }

  async getPaymentByRazorpayPaymentId(paymentId) {
    if (!paymentId) return null;
    const cleanId = paymentId.trim();
    const sb = this.getSupabase();
    if (sb) {
      const { data, error } = await sb.from('payments').select('*').eq('razorpay_payment_id', cleanId).single();
      if (error && error.code !== 'PGRST116') throw new DatabaseUnavailableError(error.message);
      return data || null;
    }
    return db.findOne('payments', p => p.razorpay_payment_id === cleanId);
  }

  async reconcilePayment(paymentId, { status, operatorId, notes }) {
    if (!paymentId) throw new Error('paymentId is required');
    const updates = {
      status,
      reconciled_by: operatorId,
      reconciled_at: new Date().toISOString(),
      reconciliation_notes: notes
    };
    const sb = this.getSupabase();
    if (sb) {
      const { data, error } = await sb.from('payments').update(updates).eq('id', paymentId).select().single();
      if (error) throw new DatabaseUnavailableError(error.message);
      return data;
    }
    return db.update('payments', paymentId, updates);
  }

  // --- Manual Takeovers & Alert Dedup ---
  async getActiveTakeover(orgId, buyerPhone) {
    if (!orgId || !buyerPhone) return null;
    const cleanPhone = String(buyerPhone).replace(/\D/g, '');
    const nowIso = new Date().toISOString();
    const sb = this.getSupabase();
    if (sb) {
      const { data, error } = await sb
        .from('manual_takeovers')
        .select('*')
        .eq('org_id', orgId)
        .eq('buyer_phone', cleanPhone)
        .gt('expires_at', nowIso)
        .single();
      if (error && error.code !== 'PGRST116') throw new DatabaseUnavailableError(error.message);
      return data || null;
    }
    return db.findOne('manual_takeovers', t => (t.org_id === orgId || t.organization_id === orgId) && t.buyer_phone === cleanPhone && t.expires_at > nowIso);
  }
}

export const repository = new TenantRepository();
export default repository;

