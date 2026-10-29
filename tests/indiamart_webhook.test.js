import test from 'node:test';
import assert from 'node:assert/strict';
import { signUp } from '../src/auth/authService.js';
import { IndiaMartWebhook } from '../src/integrations/indiamart/indiamartWebhook.js';
import { LeadService } from '../src/services/leadService.js';

test('INDIAMART WEBHOOK: Ingests valid payload, rejects missing phone, and deduplicates repeated events', async () => {
  const org = await signUp({
    email: `webhook_test_${Date.now()}@mfg.in`,
    password: 'Password123!',
    fullName: 'Harpreet Singh',
    companyName: 'Harpreet Granule Machines'
  });

  const uniqueQueryId = `IM_TEST_${Date.now()}`;
  const validPayload = {
    UNIQUE_QUERY_ID: uniqueQueryId,
    SENDER_NAME: 'Sandeep Kumar',
    SENDER_MOBILE: '+91 98765 43210',
    QUERY_PRODUCT_NAME: 'Automatic Collar Type Pouch Packing Machine',
    SENDER_CITY: 'Ludhiana',
    QUERY_MESSAGE: 'Need machine for 50g-100g turmeric powder packing.'
  };

  // 1. Initial Webhook Ingestion
  const res1 = await IndiaMartWebhook.handleIncomingWebhook(org.organization.id, validPayload);
  assert.equal(res1.status, 'accepted');
  assert.equal(res1.isDuplicate, false);
  assert.ok(res1.leadId);

  // Verify lead details stored correctly
  const leadDetail = LeadService.getLeadDetail(org.organization.id, res1.leadId);
  assert.equal(leadDetail.lead.buyer_name, 'Sandeep Kumar');
  assert.equal(leadDetail.lead.buyer_phone, '919876543210');
  assert.equal(leadDetail.lead.buyer_city, 'Ludhiana');

  // 2. Idempotency & Deduplication Check: Same event ID sent again
  const res2 = await IndiaMartWebhook.handleIncomingWebhook(org.organization.id, validPayload);
  assert.equal(res2.status, 'duplicate_ignored');
  assert.equal(res2.isDuplicate, true);
  assert.equal(res2.leadId, res1.leadId, 'Must return same lead ID for duplicate event');

  // 3. Reject Malformed Payload (Missing mobile number)
  const malformedPayload = {
    SENDER_NAME: 'Anonymous Buyer',
    QUERY_PRODUCT_NAME: 'Blender'
  };
  const res3 = await IndiaMartWebhook.handleIncomingWebhook(org.organization.id, malformedPayload);
  assert.equal(res3.status, 'rejected');
});
