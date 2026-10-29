import test from 'node:test';
import assert from 'node:assert/strict';
import { signUp } from '../src/auth/authService.js';
import { LeadService } from '../src/services/leadService.js';
import { CatalogService } from '../src/services/catalogService.js';
import db from '../src/db/index.js';

test('MULTI-TENANT ISOLATION: Organization B cannot access Organization A leads or products', async () => {
  // 1. Create Organization A
  const orgA = await signUp({
    email: `tenant_a_${Date.now()}@alpha.com`,
    password: 'Password123!',
    fullName: 'Owner A',
    companyName: 'Alpha Machinery Corp'
  });

  // 2. Create Organization B
  const orgB = await signUp({
    email: `tenant_b_${Date.now()}@beta.com`,
    password: 'Password123!',
    fullName: 'Owner B',
    companyName: 'Beta Blenders Ltd'
  });

  assert.notEqual(orgA.organization.id, orgB.organization.id);

  // 3. Create Lead in Organization A
  const leadA = LeadService.createOrDeduplicateLead(orgA.organization.id, {
    buyer_name: 'Confidential Buyer A',
    buyer_phone: '919111111111',
    product_inquired: 'Proprietary Packaging Line',
    source_event_id: `evt_alpha_${Date.now()}`
  });

  // 4. Verify Org A sees the lead
  const orgAList = LeadService.listLeads(orgA.organization.id);
  const foundInA = orgAList.leads.find((l) => l.id === leadA.lead.id);
  assert.ok(foundInA, 'Organization A must see its own lead');

  // 5. SECURITY VERIFICATION: Org B MUST NOT see Org A lead in list
  const orgBList = LeadService.listLeads(orgB.organization.id);
  const foundInB = orgBList.leads.find((l) => l.id === leadA.lead.id);
  assert.equal(foundInB, undefined, 'CRITICAL SECURITY BREACH: Organization B saw Organization A lead!');

  // 6. SECURITY VERIFICATION: Org B cannot fetch Org A lead detail
  const directFetchByB = LeadService.getLeadDetail(orgB.organization.id, leadA.lead.id);
  assert.equal(directFetchByB, null, 'CRITICAL SECURITY BREACH: Organization B fetched Org A lead detail directly!');

  // 7. SECURITY VERIFICATION: Org B cannot mutate Org A lead status
  assert.throws(
    () => {
      LeadService.updateLeadStatus(orgB.organization.id, leadA.lead.id, 'converted');
    },
    /Unauthorized cross-tenant mutation|unauthorized/i,
    'CRITICAL SECURITY BREACH: Organization B mutated Organization A lead status!'
  );
});
