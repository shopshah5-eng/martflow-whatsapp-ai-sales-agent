process.env.NODE_ENV = 'test';
process.env.ALLOW_DEMO_LOGIN = 'true';
process.env.USE_LOCAL_DB = 'true';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { signUp, login, createSessionToken } from '../src/auth/authService.js';
import { LearningService } from '../src/services/learningService.js';
import { AIService } from '../src/services/aiService.js';
import { isCustomerInManualMode } from '../src/services/takeoverService.js';

test('PRODUCTION RELEASE SUITE: Security, Isolation, Learning & Health Verification', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  // Provision Tenant 1 (Acme Solar)
  const user1 = await signUp({
    email: `acme_solar_${Date.now()}@test.in`,
    password: 'Password123!',
    fullName: 'Ramesh Solar',
    companyName: 'Acme Solar Tech'
  });

  // Provision Tenant 2 (Apex Packaging)
  const user2 = await signUp({
    email: `apex_pack_${Date.now()}@test.in`,
    password: 'Password123!',
    fullName: 'Sunil Packaging',
    companyName: 'Apex Packaging Machines'
  });

  // Provision a regular 'member' user under Tenant 1 (restricted role)
  const memberProfile = db.insert('profiles', {
    email: `member_t1_${Date.now()}@test.in`,
    full_name: 'Junior Rep',
    role: 'member'
  });
  db.insert('organization_members', {
    organization_id: user1.organization.id,
    user_id: memberProfile.id,
    role: 'member'
  });
  const memberToken = createSessionToken(memberProfile.id, user1.organization.id, 'member');

  const ownerHeader1 = { 'Authorization': `Bearer ${user1.token}`, 'Content-Type': 'application/json' };
  const ownerHeader2 = { 'Authorization': `Bearer ${user2.token}`, 'Content-Type': 'application/json' };
  const memberHeader1 = { 'Authorization': `Bearer ${memberToken}`, 'Content-Type': 'application/json' };

  await t.test('1. Role matrix: regular member is blocked (403) from sensitive operations', async () => {
    // Member blocked from WhatsApp connect
    const waConnectRes = await fetch(`${baseUrl}/api/whatsapp/connect`, {
      method: 'POST',
      headers: memberHeader1
    });
    assert.equal(waConnectRes.status, 403, 'Member should not be able to connect WhatsApp');

    // Member blocked from WhatsApp disconnect
    const waDisconnectRes = await fetch(`${baseUrl}/api/whatsapp/disconnect`, {
      method: 'POST',
      headers: memberHeader1
    });
    assert.equal(waDisconnectRes.status, 403, 'Member should not be able to disconnect WhatsApp');

    // Member blocked from bulk catalog upload
    const uploadRes = await fetch(`${baseUrl}/api/catalog/upload`, {
      method: 'POST',
      headers: memberHeader1,
      body: JSON.stringify({ filename: 'catalog.csv', fileBase64: 'bmFtZSxwcmljZQ==' })
    });
    assert.equal(uploadRes.status, 403, 'Member should not be able to upload catalog');
  });

  await t.test('2. Role matrix: owner and admin succeed on sensitive operations', async () => {
    // Owner can disconnect / connect WhatsApp
    const waRes = await fetch(`${baseUrl}/api/whatsapp/disconnect`, {
      method: 'POST',
      headers: ownerHeader1
    });
    assert.equal(waRes.status, 200, 'Owner should be authorized to disconnect');
  });

  await t.test('3. Webhook security: public organization UUID is rejected as webhook secret', async () => {
    // Sending organization UUID instead of secret key must fail with 401
    const res = await fetch(`${baseUrl}/api/webhook/b2b`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-b2b-token': user1.organization.id // Public UUID, NOT the webhook secret!
      },
      body: JSON.stringify({
        SENDER_MOBILE: '919876543210',
        SENDER_NAME: 'Attack Payload',
        QUERY_PRODUCT_NAME: 'Industrial Machine'
      })
    });
    assert.equal(res.status, 401, 'Organization UUID should NOT be accepted as a webhook secret');

    // Sending valid webhook_key succeeds
    const validRes = await fetch(`${baseUrl}/api/webhook/b2b`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-b2b-token': user1.organization.webhook_key
      },
      body: JSON.stringify({
        SENDER_MOBILE: '919876543210',
        SENDER_NAME: 'Legitimate Buyer',
        QUERY_PRODUCT_NAME: 'Industrial Machine',
        UNIQUE_QUERY_ID: `whk_test_${Date.now()}`
      })
    });
    assert.equal(validRes.status, 200, 'Valid webhook_key must be accepted');
  });

  await t.test('4. Safe Conversational Learning: opt-in required, review queue, tenant isolation', async () => {
    const orgId = user1.organization.id;

    // Step A: When NOT opted in, extraction is bypassed
    const mockMessages = [
      { sender: 'buyer', text: 'Do you offer warranty on your solar inverters?' },
      { sender: 'seller', text: 'Yes, we provide 5 years comprehensive on-site warranty on all inverters.' }
    ];
    const skipped = LearningService.proposeFactsFromConversation({
      organizationId: orgId,
      conversationId: 'conv_1',
      messages: mockMessages
    });
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, 'opt_in_required');

    // Step B: Enable opt-in
    db.update('organizations', orgId, { learning_opt_in: true });

    // Step C: Propose facts
    const proposed = LearningService.proposeFactsFromConversation({
      organizationId: orgId,
      conversationId: 'conv_1',
      messages: mockMessages
    });
    assert.equal(proposed.skipped, false);
    assert.equal(proposed.proposedCount, 1);
    const proposalId = proposed.proposals[0].id;
    assert.equal(proposed.proposals[0].status, 'pending_review');

    // Unapproved proposal is NOT included in prompt
    let knowledgeStr = LearningService.getApprovedKnowledgeString(orgId);
    assert.equal(knowledgeStr, '', 'Unapproved proposals must never leak into prompt context');

    // Step D: Member cannot approve (requires owner/admin)
    const unauthApprove = await fetch(`${baseUrl}/api/learning/proposals/${proposalId}/approve`, {
      method: 'POST',
      headers: memberHeader1
    });
    assert.equal(unauthApprove.status, 403);

    // Step E: Owner approves proposal
    const approveRes = await fetch(`${baseUrl}/api/learning/proposals/${proposalId}/approve`, {
      method: 'POST',
      headers: ownerHeader1
    });
    assert.equal(approveRes.status, 200);
    const approveData = await approveRes.json();
    assert.equal(approveData.ok, true);
    assert.equal(approveData.proposal.status, 'approved');

    // Step F: Approved fact is now in tenant prompt
    knowledgeStr = LearningService.getApprovedKnowledgeString(orgId);
    assert.ok(knowledgeStr.includes('5 years comprehensive on-site warranty'));

    // Step G: Strict Tenant Isolation: Tenant 2 prompt must NOT have Tenant 1's fact
    const tenant2Knowledge = LearningService.getApprovedKnowledgeString(user2.organization.id);
    assert.equal(tenant2Knowledge, '', 'Tenant 2 must NOT receive facts learned from Tenant 1');

    // Step H: Instant Revocation: Delete fact
    const factId = approveData.approvedFact.id;
    const delRes = await fetch(`${baseUrl}/api/learning/facts/${factId}`, {
      method: 'DELETE',
      headers: ownerHeader1
    });
    assert.equal(delRes.status, 200);

    // Prompt is clean again
    knowledgeStr = LearningService.getApprovedKnowledgeString(orgId);
    assert.equal(knowledgeStr, '', 'Revoked fact must immediately disappear from prompt');
  });

  await t.test('5. Health probes: liveness (/api/health) and readiness (/api/ready) report operational', async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.equal(healthData.status, 'healthy');
    assert.ok(healthData.uptime >= 0);

    const readyRes = await fetch(`${baseUrl}/api/ready`);
    assert.equal(readyRes.status, 200);
    const readyData = await readyRes.json();
    assert.equal(readyData.ok, true);
    assert.equal(readyData.status, 'ready');
  });

  await t.test('6. Cross-Tenant Isolation: Call confirmation rejects other tenant leads and scopes requests', async () => {
    // Create a lead strictly belonging to Tenant 1
    const t1Lead = db.insert('leads', {
      id: `lead_t1_${Date.now()}`,
      org_id: user1.organization.id,
      organization_id: user1.organization.id,
      buyer_name: 'Confidential Client A',
      buyer_phone: '919111111111',
      requirement: 'Confidential 100kW Solar Farm Specs',
      callbackStatus: 'awaiting_client_time',
      status: '⏳ Awaiting Client Call Time'
    });

    // Tenant 2 attempts to confirm call for Tenant 1's lead: MUST BE 403 Forbidden
    const crossRes = await fetch(`${baseUrl}/api/callbacks/confirm-time`, {
      method: 'POST',
      headers: ownerHeader2,
      body: JSON.stringify({ leadId: t1Lead.id, confirmedTime: 'Today at 5 PM' })
    });
    assert.equal(crossRes.status, 403, 'Tenant 2 must be blocked from scheduling or viewing Tenant 1 lead');

    // Tenant 2 calls confirm-time without leadId: must not grab Tenant 1's awaiting lead (returns 404)
    const emptyLeadRes = await fetch(`${baseUrl}/api/callbacks/confirm-time`, {
      method: 'POST',
      headers: ownerHeader2,
      body: JSON.stringify({ confirmedTime: 'Today at 6 PM' })
    });
    assert.equal(emptyLeadRes.status, 404, 'Must not schedule leads from another organization');

    // Tenant 1 confirms their own lead: succeeds with 200
    const ownRes = await fetch(`${baseUrl}/api/callbacks/confirm-time`, {
      method: 'POST',
      headers: ownerHeader1,
      body: JSON.stringify({ leadId: t1Lead.id, confirmedTime: 'Tomorrow at 11 AM' })
    });
    assert.equal(ownRes.status, 200);
    const ownData = await ownRes.json();
    assert.equal(ownData.ok, true);
    assert.equal(ownData.lead.callbackStatus, 'scheduled');

    // Request demo callback generates lead strictly scoped to requesting organization
    const demoRes = await fetch(`${baseUrl}/api/callbacks/request-demo`, {
      method: 'POST',
      headers: ownerHeader1
    });
    assert.equal(demoRes.status, 200);
    const demoData = await demoRes.json();
    assert.equal(demoData.lead.org_id || demoData.lead.organization_id, user1.organization.id, 'Demo lead must belong to Tenant 1');
  });

  await t.test('7. Database migration deduplication uses deterministic CTE survivor remapping', async () => {
    const migrationSql = fs.readFileSync(path.resolve('scripts/production_safety_migration.sql'), 'utf8');
    assert.ok(migrationSql.includes('WITH ranked_leads AS'), 'Migration must use CTE to rank duplicates');
    assert.ok(migrationSql.includes('FIRST_VALUE(id) OVER'), 'Migration must determine single deterministic survivor');
    assert.ok(migrationSql.includes('PARTITION BY org_id, buyer_phone'), 'Must partition by tenant and phone');
    assert.ok(migrationSql.includes('ORDER BY created_at DESC, id DESC'), 'Must order newest first with id tiebreaker');
    assert.ok(migrationSql.includes('SET lead_id = d.survivor_id'), 'Must remap directly to survivor id');
  });

  await t.test('8. Settings persistence: /api/settings updates authoritative tenant storage', async () => {
    const settingsUpdate = {
      companyName: 'Acme Solar Technologies Pvt Ltd',
      cityBase: 'Ahmedabad Gujarat',
      ownerAlertPhone: '919876500000'
    };

    const postRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: ownerHeader1,
      body: JSON.stringify(settingsUpdate)
    });
    assert.equal(postRes.status, 200);

    const getRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'GET',
      headers: ownerHeader1
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.settings.company_name, 'Acme Solar Technologies Pvt Ltd');
    assert.equal(getData.settings.city_base, 'Ahmedabad Gujarat');
    assert.equal(getData.settings.escalation_phone, '919876500000');
  });

  await t.test('9. Safe Conversational Learning: supports human agent role and complete opt-out purge', async () => {
    const orgId = user2.organization.id;
    db.update('organizations', orgId, { learning_opt_in: true });

    // Propose facts from conversation where seller is marked with role 'agent'
    const agentMessages = [
      { sender: 'buyer', text: 'What is your delivery dispatch timeline for Pune?' },
      { sender: 'agent', text: 'We dispatch via V-Trans within 2 days with full transit insurance.' }
    ];
    const proposal = LearningService.proposeFactsFromConversation({
      organizationId: orgId,
      conversationId: 'conv_agent_test',
      messages: agentMessages
    });
    assert.equal(proposal.skipped, false);
    assert.equal(proposal.proposedCount, 1);
    assert.equal(proposal.proposals[0].topic, 'Delivery & Shipping');

    // Approve the proposal
    const approve = LearningService.approveProposal(orgId, proposal.proposals[0].id, user2.user.id);
    assert.equal(approve.ok, true);
    assert.ok(LearningService.getApprovedKnowledgeString(orgId).includes('V-Trans'));

    // Tenant Opt-Out: Immediately purges facts and proposals
    const optOutRes = await fetch(`${baseUrl}/api/learning/opt-out`, {
      method: 'POST',
      headers: ownerHeader2
    });
    assert.equal(optOutRes.status, 200);
    assert.equal(LearningService.isLearningOptedIn(orgId), false);
    assert.equal(LearningService.listApprovedFacts(orgId).length, 0, 'Approved facts must be purged');
    assert.equal(LearningService.listProposals(orgId).length, 0, 'Pending proposals must be purged');
    assert.equal(LearningService.getApprovedKnowledgeString(orgId), '', 'Knowledge string must be empty');
  });

  await t.test('10. WhatsApp manual takeover fails closed on database error', async () => {
    // Create a mock supabaseAdmin that throws an unexpected connection error
    const faultySupabase = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  ilike() {
                    return {
                      maybeSingle() {
                        throw new Error('PostgreSQL connection timeout: pool exhausted');
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
    };

    // When check fails, it must FAIL CLOSED: return inManualMode = true to prevent AI auto-reply
    const result = await isCustomerInManualMode({
      orgId: user1.organization.id,
      buyerPhone: '919999988888',
      supabaseAdmin: faultySupabase
    });
    assert.equal(result.inManualMode, true, 'Must fail closed to manual mode on DB error');
    assert.equal(result.unknownMode, true);
  });

  await t.test('11. Partner / Affiliate referral tracking (?ref= / ?partner=) in index.html', async () => {
    const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
    assert.ok(html.includes('initAffiliateTracking'), 'index.html must initialize affiliate tracking');
    assert.ok(html.includes('mf_affiliate_ref'), 'index.html must store affiliate ref in localStorage');
    assert.ok(html.includes('actPartnerBadge'), 'index.html must render partner badge container');
    assert.ok(html.includes('[Partner Ref:'), 'index.html must attach partner ref to UTR submission');
  });

  server.close();
});

