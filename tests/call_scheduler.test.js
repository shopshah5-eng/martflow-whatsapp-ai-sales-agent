import test from 'node:test';
import assert from 'node:assert/strict';
import { signUp } from '../src/auth/authService.js';
import { LeadService } from '../src/services/leadService.js';
import { CallSchedulerService } from '../src/services/callSchedulerService.js';

test('CALL SCHEDULER: 2-way call request, slot confirmation, status transition, and dossier generation', async () => {
  const org = await signUp({
    email: `calls_test_${Date.now()}@conveyors.in`,
    password: 'Password123!',
    fullName: 'Sunil Mehta',
    companyName: 'Mehta Conveyor Systems'
  });

  const lead = LeadService.createOrDeduplicateLead(org.organization.id, {
    buyer_name: 'Gurpreet Singh',
    buyer_phone: '919814012345',
    product_inquired: 'Modular Slat Chain Conveyor',
    buyer_city: 'Jalandhar'
  }).lead;

  // 1. Buyer Requests Call
  const callReq = CallSchedulerService.requestCall(org.organization.id, {
    leadId: lead.id,
    ownerPhone: '919876543210'
  });

  assert.equal(callReq.status, 'awaiting_owner');

  // Verify lead status moved to 'awaiting_call'
  const updatedLead1 = LeadService.getLeadDetail(org.organization.id, lead.id).lead;
  assert.equal(updatedLead1.status, 'awaiting_call');

  // 2. Factory Owner Confirms Slot (e.g. "Tomorrow at 4:30 PM")
  const confirmed = CallSchedulerService.confirmCallSlot(org.organization.id, {
    callRequestId: callReq.id,
    confirmedTime: 'Tomorrow at 4:30 PM',
    confirmedBy: 'Owner via WhatsApp'
  });

  assert.equal(confirmed.callRequest.status, 'confirmed');
  assert.equal(confirmed.callRequest.proposed_time_raw, 'Tomorrow at 4:30 PM');
  assert.ok(confirmed.confirmationMessageBuyer.includes('Tomorrow at 4:30 PM'));
  assert.ok(confirmed.dossierMessageOwner.includes('wa.me/919814012345'));

  // Verify lead status moved to 'call_booked'
  const updatedLead2 = LeadService.getLeadDetail(org.organization.id, lead.id).lead;
  assert.equal(updatedLead2.status, 'call_booked');
});

