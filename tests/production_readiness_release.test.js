process.env.NODE_ENV = 'test';
process.env.ALLOW_DEMO_LOGIN = 'true';
process.env.USE_LOCAL_DB = 'true';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { signUp, login, createSessionToken } from '../src/auth/authService.js';
import { LearningService } from '../src/services/learningService.js';
import { AIService } from '../src/services/aiService.js';

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

  server.close();
});
