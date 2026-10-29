/**
 * MartFlow AI — Lead Management Service
 * Multi-tenant lead management, deduplication, filtering, assignment, status tracking, and CSV export.
 */

import db from '../db/index.js';

export class LeadService {
  // Create or deduplicate an incoming lead
  static createOrDeduplicateLead(organizationId, leadData) {
    if (!organizationId) throw new Error('organization_id is required');
    if (!leadData.buyer_phone) throw new Error('buyer_phone is required');

    // Deduplication via source_event_id
    if (leadData.source_event_id) {
      const existing = db.findOne('leads', (l) =>
        l.organization_id === organizationId && l.source_event_id === leadData.source_event_id
      );
      if (existing) {
        return { lead: existing, isDuplicate: true };
      }
    }

    const cleanPhone = String(leadData.buyer_phone).replace(/[^0-9]/g, '');
    const newLead = db.insert('leads', {
      organization_id: organizationId,
      source_event_id: leadData.source_event_id || `lead_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      source: leadData.source || 'B2B Portal',
      buyer_name: leadData.buyer_name ? leadData.buyer_name.trim() : null,
      buyer_phone: cleanPhone,
      buyer_city: leadData.buyer_city ? leadData.buyer_city.trim() : null,
      product_inquired: leadData.product_inquired || 'General Machinery Inquiry',
      matched_product_id: leadData.matched_product_id || null,
      requirement: leadData.requirement || '',
      status: 'new',
      pdf_brochure_sent: false,
      first_response_ms: null,
      notes: leadData.notes || null
    });

    // Automatically create linked conversation for the lead
    db.insert('conversations', {
      organization_id: organizationId,
      lead_id: newLead.id,
      channel: 'whatsapp',
      mode: 'ai',
      is_unread: true
    });

    // Record audit log
    db.insert('audit_logs', {
      organization_id: organizationId,
      action: 'LEAD_CREATED',
      resource_type: 'leads',
      resource_id: newLead.id,
      metadata: { source: newLead.source, phone: newLead.buyer_phone }
    });

    return { lead: newLead, isDuplicate: false };
  }

  // List leads with pagination, search, and filters
  static listLeads(organizationId, { page = 1, limit = 20, search = '', status = '', city = '', sortBy = 'created_at', sortOrder = 'desc' } = {}) {
    let leads = db.findScoped('leads', organizationId);

    // Filter by Search (name, phone, product, city)
    if (search) {
      const q = search.toLowerCase().trim();
      leads = leads.filter((l) =>
        (l.buyer_name && l.buyer_name.toLowerCase().includes(q)) ||
        (l.buyer_phone && l.buyer_phone.includes(q)) ||
        (l.product_inquired && l.product_inquired.toLowerCase().includes(q)) ||
        (l.buyer_city && l.buyer_city.toLowerCase().includes(q))
      );
    }

    // Filter by Status
    if (status) {
      leads = leads.filter((l) => l.status === status);
    }

    // Filter by City
    if (city) {
      leads = leads.filter((l) => l.buyer_city && l.buyer_city.toLowerCase() === city.toLowerCase());
    }

    // Sort
    leads.sort((a, b) => {
      const valA = a[sortBy] || '';
      const valB = b[sortBy] || '';
      return sortOrder === 'asc' ? (valA > valB ? 1 : -1) : (valA < valB ? 1 : -1);
    });

    const total = leads.length;
    const startIndex = (page - 1) * limit;
    const paginated = leads.slice(startIndex, startIndex + limit);

    return {
      leads: paginated,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / limit) || 1
      }
    };
  }

  // Get lead detail with full conversation history and matched product
  static getLeadDetail(organizationId, leadId) {
    const lead = db.findById('leads', leadId);
    if (!lead || lead.organization_id !== organizationId) {
      return null;
    }

    const conversation = db.findOne('conversations', (c) => c.lead_id === leadId);
    const messages = conversation
      ? db.findScoped('messages', organizationId, (m) => m.conversation_id === conversation.id)
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      : [];

    const matchedProduct = lead.matched_product_id ? db.findById('products', lead.matched_product_id) : null;
    const callRequest = db.findOne('call_requests', (cr) => cr.lead_id === leadId);

    return {
      lead,
      conversation,
      messages,
      matchedProduct,
      callRequest
    };
  }

  // Update lead status
  static updateLeadStatus(organizationId, leadId, newStatus, userId = null) {
    const validStatuses = ['new', 'processing', 'replied', 'qualified', 'awaiting_call', 'call_booked', 'converted', 'lost', 'failed'];
    if (!validStatuses.includes(newStatus)) {
      throw new Error(`Invalid lead status: ${newStatus}`);
    }

    const updated = db.updateScoped('leads', leadId, organizationId, { status: newStatus });
    if (!updated) throw new Error('Lead not found or unauthorized');

    db.insert('audit_logs', {
      organization_id: organizationId,
      user_id: userId,
      action: 'LEAD_STATUS_UPDATED',
      resource_type: 'leads',
      resource_id: leadId,
      metadata: { newStatus }
    });

    return updated;
  }

  // Assign lead to sales agent
  static assignLead(organizationId, leadId, agentId, userId = null) {
    const updated = db.updateScoped('leads', leadId, organizationId, { assigned_to: agentId });
    if (!updated) throw new Error('Lead not found or unauthorized');

    db.insert('audit_logs', {
      organization_id: organizationId,
      user_id: userId,
      action: 'LEAD_ASSIGNED',
      resource_type: 'leads',
      resource_id: leadId,
      metadata: { assignedTo: agentId }
    });

    return updated;
  }

  // Add internal note
  static addNote(organizationId, leadId, noteText, userId = null) {
    const lead = db.findById('leads', leadId);
    if (!lead || lead.organization_id !== organizationId) throw new Error('Lead not found');

    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const noteEntry = `[${timestamp}] ${noteText.trim()}`;
    const newNotes = lead.notes ? `${lead.notes}\n${noteEntry}` : noteEntry;

    return db.updateScoped('leads', leadId, organizationId, { notes: newNotes });
  }

  // Export leads to CSV
  static exportLeadsCsv(organizationId) {
    const leads = db.findScoped('leads', organizationId);
    const headers = [
      'Lead ID',
      'Created At (IST)',
      'Buyer Name',
      'Phone Number',
      'City',
      'Product Inquired',
      'Status',
      'PDF Brochure Sent',
      'First Response Time (ms)',
      'Source'
    ];

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = leads.map((l) => [
      l.id,
      new Date(l.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      l.buyer_name || 'Unspecified',
      l.buyer_phone,
      l.buyer_city || '',
      l.product_inquired || '',
      l.status,
      l.pdf_brochure_sent ? 'YES' : 'NO',
      l.first_response_ms || '',
      l.source
    ].map(esc).join(','));

    return [headers.join(','), ...rows].join('\n');
  }
}

export default LeadService;

