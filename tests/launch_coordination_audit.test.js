import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { authenticate } from '../src/middleware/authMiddleware.js';
import { ConversationMemoryService } from '../src/services/conversationMemoryService.js';
import { FollowUpService } from '../src/services/followUpService.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const html = (name) => fs.readFileSync(new URL(`../public/${name}.html`, import.meta.url), 'utf8');

// ============================================================================
// 1. AUTHENTICATION & ACCOUNT-LINKING REGRESSION TESTS
// ============================================================================

test('AUTHENTICATION: authMiddleware rejects unconfirmed identities with 401', async () => {
  const { repository } = await import('../src/db/repository.js');
  const originalGetSupabase = repository.getSupabase;

  const fakeSupabase = {
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: 'unconfirmed-uuid-1',
            email: 'unconfirmed@example.test',
            email_confirmed_at: null,
            confirmed_at: null
          }
        },
        error: null
      })
    }
  };

  repository.getSupabase = () => fakeSupabase;

  const req = { headers: { authorization: 'Bearer unconfirmed-jwt' } };
  let statusCode = 200;
  let responseData = null;
  const res = {
    status: (code) => { statusCode = code; return res; },
    json: (data) => { responseData = data; return res; }
  };

  try {
    await authenticate(req, res, () => {});
    assert.equal(statusCode, 401);
    assert.match(responseData.error, /Email confirmation required/);
  } finally {
    repository.getSupabase = originalGetSupabase;
  }
});

test('ACCOUNT LINKING: authMiddleware never reassigns or links existing profile based on email match', async () => {
  const { repository } = await import('../src/db/repository.js');
  const originalGetSupabase = repository.getSupabase;
  const originalGetProfileById = repository.getProfileById;

  const fakeSupabase = {
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: 'attacker-uuid-999',
            email: 'victim_owner@example.test',
            email_confirmed_at: new Date().toISOString()
          }
        },
        error: null
      })
    }
  };

  // Attacker has NO profile linked to attacker-uuid-999
  repository.getSupabase = () => fakeSupabase;
  repository.getProfileById = async (id) => {
    if (id === 'attacker-uuid-999') return null; // No profile for attacker's user ID!
    return { id: 'victim-profile-123', org_id: 'victim-org-123', role: 'owner' };
  };

  const req = { headers: { authorization: 'Bearer attacker-jwt' } };
  let statusCode = 200;
  let responseData = null;
  const res = {
    status: (code) => { statusCode = code; return res; },
    json: (data) => { responseData = data; return res; }
  };

  try {
    await authenticate(req, res, () => {});
    // Must fail closed with 401 because attacker-uuid-999 has no profile
    assert.equal(statusCode, 401);
    assert.equal(req.organizationId, undefined);
  } finally {
    repository.getSupabase = originalGetSupabase;
    repository.getProfileById = originalGetProfileById;
  }
});

test('PROVISIONING: POST /api/auth/provision is transactional, idempotent and rejects unconfirmed users', async () => {
  const { repository } = await import('../src/db/repository.js');
  const originalGetSupabase = repository.getSupabase;
  const originalGetProfileById = repository.getProfileById;
  const originalGetOrgById = repository.getOrganizationById;
  const originalGetMembership = repository.getMembership;

  const testUserId = 'prov-user-' + Date.now();
  let dbOrgInserted = null;
  let dbProfileUpserted = null;

  const mockSb = {
    auth: {
      getUser: async (token) => {
        if (token === 'unconfirmed-token') {
          return { data: { user: { id: testUserId, email: 'user@test.io', email_confirmed_at: null } }, error: null };
        }
        return { data: { user: { id: testUserId, email: 'user@test.io', email_confirmed_at: new Date().toISOString() } }, error: null };
      }
    },
    from: (table) => ({
      insert: (record) => ({
        select: () => ({
          single: async () => {
            dbOrgInserted = { id: 'new-org-' + Date.now(), ...record };
            return { data: dbOrgInserted, error: null };
          }
        })
      }),
      upsert: async (record) => {
        dbProfileUpserted = record;
        return { data: record, error: null };
      },
      delete: () => ({ eq: async () => ({ error: null }) })
    })
  };

  repository.getSupabase = () => mockSb;
  repository.getProfileById = async () => null;

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Unconfirmed email must be rejected with 401
    const unconfRes = await fetch(`${base}/api/auth/provision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer unconfirmed-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName: 'Unconfirmed Corp' })
    });
    assert.equal(unconfRes.status, 401);

    // 2. Confirmed user successfully provisions workspace
    const provRes = await fetch(`${base}/api/auth/provision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName: 'Verified Polymers Ltd', fullName: 'Vikram Joshi' })
    });
    assert.equal(provRes.status, 201);
    const provData = await provRes.json();
    assert.equal(provData.ok, true);
    assert.equal(provData.provisioned, true);
    assert.equal(provData.organization.name, 'Verified Polymers Ltd');
    assert.equal(provData.user.role, 'owner');
    assert.ok(dbOrgInserted);
    assert.ok(dbProfileUpserted);

    // 3. Idempotency: Second call returns existing workspace without recreating
    repository.getProfileById = async () => ({ id: testUserId, org_id: dbOrgInserted.id, full_name: 'Vikram Joshi' });
    repository.getOrganizationById = async () => dbOrgInserted;
    repository.getMembership = async () => ({ role: 'owner' });

    const secondRes = await fetch(`${base}/api/auth/provision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName: 'Verified Polymers Ltd' })
    });
    assert.equal(secondRes.status, 200);
    const secondData = await secondRes.json();
    assert.equal(secondData.ok, true);
    assert.equal(secondData.provisioned, false);
    assert.equal(secondData.organization.id, dbOrgInserted.id);
  } finally {
    repository.getSupabase = originalGetSupabase;
    repository.getProfileById = originalGetProfileById;
    repository.getOrganizationById = originalGetOrgById;
    repository.getMembership = originalGetMembership;
    await new Promise((resolve) => server.close(resolve));
  }
});

// ============================================================================
// 2. BROWSER LOGIN REJECTION & EXACT OAUTH PARAMETER PARSING
// ============================================================================

test('BROWSER LOGIN: login form never falls back to backend login when Supabase rejects credentials', async () => {
  const backendCalls = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      signInWithPassword: async () => ({ data: null, error: new Error('Invalid login credentials') })
    }
  };

  const vc = new VirtualConsole();
  const dom = new JSDOM(html('login'), {
    url: 'https://example.test/login',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.tailwind = { config: {} };
      w.supabase = { createClient: () => client };
      w.fetch = async (url, options = {}) => {
        backendCalls.push({ url: String(url), options });
        return {
          ok: false,
          status: 401,
          headers: { get: () => 'application/json' },
          json: async () => ({ ok: false, error: 'Should not be called' })
        };
      };
    }
  });

  try {
    await wait(30);
    dom.window.document.getElementById('loginEmail').value = 'wrong@example.test';
    dom.window.document.getElementById('loginPassword').value = 'WrongPassword!';
    await dom.window.handleLoginSubmit({ preventDefault() {} });

    // Assert that /api/auth/login was NEVER called!
    assert.equal(backendCalls.some((c) => c.url.includes('/api/auth/login')), false);
    // Assert error toast is shown
    assert.match(dom.window.document.getElementById('toastContainer').textContent, /Invalid login credentials/);
    assert.equal(dom.window.document.getElementById('btnLoginSubmit').disabled, false);
  } finally {
    dom.window.close();
  }
});

test('OAUTH DETECTION: exact parameter parsing matches code and access_token but rejects partial word matches', () => {
  const dom = new JSDOM(html('index'), { url: 'https://example.test/?postal_code=110001&promocode=VIP', runScripts: 'dangerously' });
  try {
    const detected = dom.window.detectOAuthCallback();
    assert.equal(detected.hasCallback, false);
  } finally {
    dom.window.close();
  }

  const domValid = new JSDOM(html('index'), { url: 'https://example.test/?code=oauth-auth-code-12345', runScripts: 'dangerously' });
  try {
    const detectedValid = domValid.window.detectOAuthCallback();
    assert.equal(detectedValid.hasCallback, true);
    assert.equal(detectedValid.code, 'oauth-auth-code-12345');
  } finally {
    domValid.window.close();
  }
});

test('MOBILE MENU: window resize past 860px automatically closes open drawer and unlocks scroll', () => {
  const dom = new JSDOM(html('index'), { url: 'https://example.test/', runScripts: 'dangerously' });
  try {
    const w = dom.window;
    w.innerWidth = 400;
    w.setMenuOpen(true);
    assert.equal(w.document.getElementById('links').classList.contains('open'), true);
    assert.equal(w.document.body.style.overflow, 'hidden');

    // User resizes window to desktop (1024px)
    w.innerWidth = 1024;
    w.dispatchEvent(new w.Event('resize'));

    assert.equal(w.document.getElementById('links').classList.contains('open'), false);
    assert.equal(w.document.body.style.overflow, '');
  } finally {
    dom.window.close();
  }
});

// ============================================================================
// 3. CONVERSATION MEMORY SERVICE TESTS
// ============================================================================

test('CONVERSATION MEMORY: getRecentHistory retrieves latest messages in chronological order', async () => {
  process.env.NODE_ENV = 'test';
  process.env.USE_LOCAL_DB = 'true';
  const orgId = 'memory-org-' + Date.now();
  const convId = 'conv-' + Date.now();

  db.insert('conversations', { id: convId, organization_id: orgId });

  // Insert 25 messages with increasing timestamps
  for (let i = 1; i <= 25; i++) {
    db.insert('messages', {
      organization_id: orgId,
      conversation_id: convId,
      content: `Message ${i}`,
      created_at: new Date(Date.now() + i * 1000).toISOString()
    });
  }

  const history = await ConversationMemoryService.getRecentHistory(orgId, convId, 20);

  // Must return exactly 20 messages
  assert.equal(history.length, 20);
  // Must be the LATEST 20 messages (Message 6 to Message 25)
  assert.equal(history[0].content, 'Message 6');
  assert.equal(history[19].content, 'Message 25');
  // Must be in chronological order
  assert.ok(new Date(history[19].created_at) > new Date(history[0].created_at));
});

test('CONVERSATION MEMORY: staff can update and delete conversation memory for privacy retention', async () => {
  const orgId = 'staff-mem-org-' + Date.now();
  const convId = 'staff-conv-' + Date.now();

  const updated = await ConversationMemoryService.updateMemory(orgId, convId, {
    buyer_requirements: 'Wants 50kwh Industrial Diesel Generator with AMF panel',
    answered_questions: ['Shared pricing brochure', 'Confirmed warranty terms'],
    consent_status: 'opted_in'
  });

  assert.equal(updated.buyer_requirements, 'Wants 50kwh Industrial Diesel Generator with AMF panel');
  assert.equal(updated.answered_questions.length, 2);

  const fetched = await ConversationMemoryService.getMemory(orgId, convId);
  assert.equal(fetched.consent_status, 'opted_in');

  const deleted = await ConversationMemoryService.deleteMemory(orgId, convId);
  assert.equal(deleted, true);

  const afterDelete = await ConversationMemoryService.getMemory(orgId, convId);
  assert.equal(afterDelete, null);
});

// ============================================================================
// 4. ONE-TIME FOLLOW-UP ENGINE TESTS
// ============================================================================

test('FOLLOW-UP: enforces at most ONE automatic follow-up per customer and cancels on reply or opt-out', async () => {
  const orgId = 'followup-org-' + Date.now();
  const buyerPhone = '9876543210';
  const leadId = 'lead-' + Date.now();

  // 1. Initial schedule succeeds with 72h default
  const res1 = await FollowUpService.scheduleOneTimeFollowUp({
    orgId,
    leadId,
    buyerPhone,
    delayHours: 72
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.scheduled, true);
  assert.equal(res1.record.status, 'scheduled');
  assert.equal(res1.record.requires_template, true);

  // 2. Second scheduling attempt is rejected under strict single follow-up rule
  const res2 = await FollowUpService.scheduleOneTimeFollowUp({
    orgId,
    leadId,
    buyerPhone,
    delayHours: 72
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.scheduled, false);
  assert.equal(res2.existing, true);

  // 3. Incoming normal buyer message cancels the pending follow-up
  FollowUpService.handleInboundMessage(orgId, buyerPhone, 'Haan ji, mujhe quotation bhejiye');
  const recordAfterReply = await FollowUpService.getExistingFollowUp(orgId, buyerPhone);
  assert.equal(recordAfterReply.status, 'cancelled');
  assert.equal(recordAfterReply.cancellation_reason, 'buyer_replied');

  // 4. Pre-send verification fails safely on cancelled or opt-out state
  const sendCheck = await FollowUpService.verifyBeforeSend({ status: 'processing', org_id: orgId, buyer_phone: buyerPhone });
  assert.equal(sendCheck.canSend, true);

  // 5. Opt-out keyword ("STOP") blocks follow-up and future schedules
  const phone2 = '9811223344';
  await FollowUpService.scheduleOneTimeFollowUp({ orgId, leadId: 'lead-2', buyerPhone: phone2 });
  const optedOut = FollowUpService.handleInboundMessage(orgId, phone2, 'STOP please');
  assert.equal(optedOut, true);
  assert.equal(FollowUpService.isOptedOut(orgId, phone2), true);

  const fupOptedOut = await FollowUpService.getExistingFollowUp(orgId, phone2);
  assert.equal(fupOptedOut.status, 'cancelled');
  assert.equal(fupOptedOut.cancellation_reason, 'opt_out');

  // Future scheduling for opted-out customer is refused
  const resOptOut = await FollowUpService.scheduleOneTimeFollowUp({ orgId, buyerPhone: phone2 });
  assert.equal(resOptOut.scheduled, false);
  assert.equal(resOptOut.reason, 'buyer_opted_out');
});

test('FOLLOW-UP: uncertain provider outcomes are marked uncertain_delivery and avoid duplicate resends', async () => {
  const orgId = 'uncertain-org-' + Date.now();
  const buyerPhone = '9900112233';

  const res = await FollowUpService.scheduleOneTimeFollowUp({ orgId, buyerPhone });
  const recordId = res.record.id;

  await FollowUpService.recordSendOutcome(recordId, 'uncertain');
  const record = await FollowUpService.getExistingFollowUp(orgId, buyerPhone);
  assert.equal(record.status, 'uncertain_delivery');
  assert.match(record.notes, /Provider outcome ambiguous/);
});

test('FOLLOW-UP: worker disabled by default, consent requirement, durable opt-outs, and concurrent worker leasing', async () => {
  // 1. Worker is disabled by default
  assert.equal(FollowUpService.isWorkerEnabled(), false, 'Background follow-up worker must be disabled by default');

  const orgId = 'consent-test-org-' + Date.now();
  const phone = '9876500001';

  // 2. Schedule without consent is rejected
  const resNoConsent = await FollowUpService.scheduleOneTimeFollowUp({
    orgId,
    buyerPhone: phone,
    consentRecorded: false
  });
  assert.equal(resNoConsent.scheduled, false);
  assert.equal(resNoConsent.reason, 'missing_consent');

  // 3. Schedule with positive consent succeeds
  const resConsent = await FollowUpService.scheduleOneTimeFollowUp({
    orgId,
    buyerPhone: phone,
    consentRecorded: true,
    consentStatus: 'consented'
  });
  assert.equal(resConsent.scheduled, true);
  assert.equal(resConsent.record.consent_recorded, true);

  // 4. Concurrent worker leasing: claim due follow-ups
  // Manually backdate scheduled_for to test claim
  resConsent.record.scheduled_for = new Date(Date.now() - 1000).toISOString();
  const claimed = await FollowUpService.claimDueFollowUps('worker-node-1', 5, 300);
  assert.ok(claimed.length >= 1, 'Due follow-up must be claimed by worker');
  const claimedRecord = claimed.find(c => c.id === resConsent.record.id);
  assert.ok(claimedRecord, 'Claimed record must match test follow-up');
  assert.equal(claimedRecord.status, 'processing');
  assert.equal(claimedRecord.worker_id, 'worker-node-1');
  assert.ok(claimedRecord.lease_expires_at, 'Lease expiration must be populated');

  // 5. Durable opt-out check
  await FollowUpService.recordOptOut(orgId, phone, 'test_opt_out');
  assert.equal(FollowUpService.isOptedOut(orgId, phone), true);
  assert.equal(await FollowUpService.isDurableOptedOut(orgId, phone), true);
});

test('CUSTOMER MEMORY: updates on enquiry, visibility on DB error, and tenant isolation', async () => {
  const { repository, DatabaseUnavailableError } = await import('../src/db/repository.js');
  const orgA = 'mem-org-a-' + Date.now();
  const orgB = 'mem-org-b-' + Date.now();
  const convId = 'conv-mem-' + Date.now();

  // 1. Update memory for Tenant A
  const memA = await ConversationMemoryService.updateMemory(orgA, convId, {
    buyer_requirements: 'Looking for 3 units of Automatic Pouch Packing Machine',
    summary_text: 'Customer asked: Looking for 3 units',
    answered_questions: ['Packaging Machinery'],
    consent_status: 'consented'
  });
  assert.equal(memA.org_id, orgA);
  assert.equal(memA.buyer_requirements, 'Looking for 3 units of Automatic Pouch Packing Machine');

  // 2. Tenant isolation: Tenant B querying convId gets null
  const memB = await ConversationMemoryService.getMemory(orgB, convId);
  assert.equal(memB, null, 'Tenant B must not see Tenant A memory');

  // 3. Retrieval for Tenant A succeeds
  const retrievedA = await ConversationMemoryService.getMemory(orgA, convId);
  assert.equal(retrievedA.buyer_requirements, 'Looking for 3 units of Automatic Pouch Packing Machine');

  // 4. Memory deletion removes record
  const deleted = await ConversationMemoryService.deleteMemory(orgA, convId);
  assert.equal(deleted, true);
  const afterDelete = await ConversationMemoryService.getMemory(orgA, convId);
  assert.equal(afterDelete, null, 'Deleted memory must no longer exist');

  // 5. Database errors are not silently swallowed
  const origGetSupabase = repository.getSupabase;
  try {
    repository.getSupabase = () => ({
      from: () => ({
        upsert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { message: 'Database connection refused' } })
          })
        }),
        delete: () => ({
          eq: () => ({
            eq: async () => ({ error: { message: 'Foreign key violation or table locked' } })
          })
        })
      })
    });

    await assert.rejects(
      ConversationMemoryService.updateMemory(orgA, convId, { buyer_requirements: 'Fail test' }),
      DatabaseUnavailableError,
      'Database errors during memory update must propagate visibly'
    );

    await assert.rejects(
      ConversationMemoryService.deleteMemory(orgA, convId),
      DatabaseUnavailableError,
      'Database errors during memory deletion must propagate visibly'
    );
  } finally {
    repository.getSupabase = origGetSupabase;
  }
});

test('PROVISIONING: existing profile with missing or inactive membership fails closed with 403', async () => {
  const { repository } = await import('../src/db/repository.js');
  const originalGetSupabase = repository.getSupabase;
  const originalGetProfileById = repository.getProfileById;
  const originalGetMembership = repository.getMembership;
  const originalGetOrganizationById = repository.getOrganizationById;

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  try {
    const testUserId = 'user-inactive-mem-' + Date.now();
    const testOrgId = 'org-inactive-mem-' + Date.now();

    repository.getSupabase = () => ({
      auth: {
        getUser: async () => ({
          data: {
            user: {
              id: testUserId,
              email: 'inactive@example.test',
              email_confirmed_at: new Date().toISOString()
            }
          },
          error: null
        })
      }
    });

    // Profile already has an assigned org_id
    repository.getProfileById = async (id) => {
      if (id === testUserId) {
        return { id: testUserId, org_id: testOrgId, role: 'member', full_name: 'Existing Member' };
      }
      return null;
    };

    // But membership in organization is missing or inactive
    repository.getMembership = async (userId, orgId) => null;
    repository.getOrganizationById = async (orgId) => ({ id: orgId, name: 'Inactive Org' });

    const server = app.listen(0);
    const port = server.address().port;

    const res = await fetch(`http://127.0.0.1:${port}/api/auth/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-test-token'
      },
      body: JSON.stringify({ companyName: 'Attempt New Org' })
    });

    assert.equal(res.status, 403, 'Must return 403 when profile has an assigned workspace but membership is missing or inactive');
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /inactive or unassigned/);

    server.close();
  } finally {
    repository.getSupabase = originalGetSupabase;
    repository.getProfileById = originalGetProfileById;
    repository.getMembership = originalGetMembership;
    repository.getOrganizationById = originalGetOrganizationById;
  }
});

test('AI PROMPT GROUNDING: system instruction is strictly industry-neutral and free from unverified apparel/garments claims', async () => {
  const serverJsContent = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

  // Verify apparel-specific claims were removed from system instruction
  assert.ok(!serverJsContent.includes('the outfit/item in the video/ad'), 'Must not hardcode apparel-specific "outfit" in system instruction');
  assert.ok(!serverJsContent.includes('colour/print stock quantity'), 'Must not hardcode "colour/print stock" in general stock rule');
  assert.ok(!serverJsContent.includes('live rack availability & fresh matching colours'), 'Must not claim rack availability or colours in general stock rule');
  assert.ok(!serverJsContent.includes('via our Main Dispatch Team'), 'Must not invent ungrounded dispatch teams');

  // Verify the new industry-neutral rule is present
  assert.ok(serverJsContent.includes('AD, MEDIA & LIVE INQUIRY RULE:'), 'Must contain industry-neutral AD, MEDIA & LIVE INQUIRY RULE');
  assert.ok(serverJsContent.includes('share the relevant category price range or model range strictly from the active catalog'), 'Must ground price in active catalog');
});
