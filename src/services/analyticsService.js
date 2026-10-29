/**
 * MartFlow AI — Genuine Analytics Service
 * Derives all business intelligence and metrics strictly from authorized database records.
 * STRICT POLICY: Zero synthetic data, zero fake numbers.
 */

import db from '../db/index.js';

export class AnalyticsService {
  static getDashboardMetrics(organizationId) {
    if (!organizationId) throw new Error('organization_id is required');

    const leads = db.findScoped('leads', organizationId);
    const calls = db.findScoped('call_requests', organizationId);
    const products = db.findScoped('products', organizationId);

    const totalLeads = leads.length;

    // Leads today (IST)
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const leadsToday = leads.filter((l) => {
      const leadDate = new Date(l.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      return leadDate === todayStr;
    }).length;

    // Response times calculation
    const responseTimes = leads.filter((l) => l.first_response_ms).map((l) => l.first_response_ms);
    const medianResponseTimeMs = responseTimes.length
      ? responseTimes.sort((a, b) => a - b)[Math.floor(responseTimes.length / 2)]
      : null;

    // Qualified leads count
    const qualifiedLeads = leads.filter((l) =>
      ['qualified', 'awaiting_call', 'call_booked', 'converted'].includes(l.status)
    ).length;

    // Confirmed calls count
    const confirmedCalls = calls.filter((c) => c.status === 'confirmed').length;

    // Converted leads count
    const convertedCount = leads.filter((l) => l.status === 'converted').length;

    // Qualification rate
    const qualificationRate = totalLeads > 0
      ? Math.round((qualifiedLeads / totalLeads) * 100)
      : 0;

    // Call booking rate
    const callBookingRate = totalLeads > 0
      ? Math.round((confirmedCalls / totalLeads) * 100)
      : 0;

    return {
      totalLeads,
      leadsToday,
      medianResponseTimeMs,
      medianResponseTimeFormatted: medianResponseTimeMs ? `${(medianResponseTimeMs / 1000).toFixed(1)}s` : 'N/A',
      qualifiedLeads,
      qualificationRate: `${qualificationRate}%`,
      confirmedCalls,
      callBookingRate: `${callBookingRate}%`,
      convertedCount,
      totalCatalogProducts: products.length,
      hasRealData: totalLeads > 0
    };
  }
}

export default AnalyticsService;
