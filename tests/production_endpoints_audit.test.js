import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import { repository } from '../src/db/repository.js';
import { createSessionToken } from '../src/auth/authService.js';

test('PRODUCTION ENDPOINTS AUDIT: Durable tenant-scoped Supabase reads and writes', async (t) => {
  const previousEnv = { nodeEnv: process.env.NODE_ENV, useLocal: process.env.USE_LOCAL_DB, sb: repository.supabase };
  process.env.NODE_ENV = 'production';
  delete process.env.USE_LOCAL_DB;

  const testOrgId = 'a1b2c3d4-e5f6-4a1b-8c2d-112233445566';
  const otherOrgId = 'f9e8d7c6-b5a4-4f9e-8d7c-998877665544';
  const testUserId = '11111111-2222-4a1b-8c2d-998877665544';
  const validToken = createSessionToken(testUserId, testOrgId, 'owner');
  const otherToken = createSessionToken(testUserId, otherOrgId, 'owner');

  const mockLeads = [
    { id: 'lead-1', org_id: testOrgId, buyer_name: 'Alpha Buyer', buyer_phone: '9811100001', product_inquired: 'Pouch Packer', buyer_city: 'Delhi', status: 'new', created_at: new Date().toISOString() },
    { id: 'lead-2', org_id: testOrgId, buyer_name: 'Beta Buyer', buyer_phone: '9811100002', product_inquired: 'Liquid Filler', buyer_city: 'Mumbai', status: 'qualified', first_response_ms: 1500, created_at: new Date().toISOString() },
    { id: 'lead-other', org_id: otherOrgId, buyer_name: 'Cross Tenant Buyer', buyer_phone: '9811100009', product_inquired: 'Secret Machine', buyer_city: 'Goa', status: 'new', created_at: new Date().toISOString() }
  ];

  const mockConversations = [
    { id: 'conv-1', org_id: testOrgId, lead_id: 'lead-1', mode: 'ai', is_unread: false, last_message_preview: 'Hello factory', updated_at: new Date().toISOString(), created_at: new Date().toISOString() },
    { id: 'conv-other', org_id: otherOrgId, lead_id: 'lead-other', mode: 'human', is_unread: true, last_message_preview: 'Other tenant secret', updated_at: new Date().toISOString(), created_at: new Date().toISOString() }
  ];

  const mockMessages = [
    { id: 'msg-1', conversation_id: 'conv-1', sender_type: 'buyer', content: 'What is the price?', created_at: new Date(Date.now() - 5000).toISOString() },
    { id: 'msg-2', conversation_id: 'conv-1', sender_type: 'agent', content: 'Quote shared on WhatsApp', created_at: new Date().toISOString() }
  ];

  const mockProducts = [
    { id: 'prod-1', org_id: testOrgId, name: 'Rotary Pouch Packaging Unit', category: 'Machinery', price_raw: '₹4,50,000', is_active: true, created_at: new Date().toISOString() },
    { id: 'prod-other', org_id: otherOrgId, name: 'Other Tenant SKU', category: 'Machinery', price_raw: '₹9,99,999', is_active: true, created_at: new Date().toISOString() }
  ];

  const mockCalls = [
    { id: 'call-1', org_id: testOrgId, status: 'confirmed', created_at: new Date().toISOString() }
  ];

  // Build a chainable mock Supabase client that filters strictly by org_id
  function createMockSupabase(simulatedOutage = false) {
    if (simulatedOutage) {
      return {
        from: () => ({
          select: () => { throw new Error('Simulated Supabase connection timeout'); },
          insert: () => { throw new Error('Simulated Supabase connection timeout'); },
          update: () => { throw new Error('Simulated Supabase connection timeout'); },
          delete: () => { throw new Error('Simulated Supabase connection timeout'); }
        }),
        auth: {
          getUser: async () => { throw new Error('Auth service timeout'); }
        }
      };
    }

    return {
      auth: {
        getUser: async (token) => {
          if (token === validToken) return { data: { user: { id: testUserId } }, error: null };
          return { data: { user: null }, error: { message: 'Invalid token' } };
        }
      },
      from: (table) => {
        let filters = [];
        let rangeParams = null;
        let isCountExact = false;
        let updateValues = null;
        let insertedValues = null;

        const chain = {
          select: (fields, options) => {
            if (options?.count === 'exact') isCountExact = true;
            return chain;
          },
          eq: (field, value) => {
            filters.push({ field, op: 'eq', value });
            return chain;
          },
          neq: (field, value) => {
            filters.push({ field, op: 'neq', value });
            return chain;
          },
          ilike: (field, value) => {
            filters.push({ field, op: 'ilike', value });
            return chain;
          },
          or: (expr) => {
            filters.push({ field: 'or', op: 'or', expr });
            return chain;
          },
          order: () => chain,
          range: (from, to) => {
            rangeParams = { from, to };
            return chain;
          },
          limit: (n) => {
            rangeParams = { from: 0, to: n - 1 };
            return chain;
          },
          maybeSingle: async () => {
            const res = executeSelect();
            return { data: res.data?.[0] || null, error: null };
          },
          single: async () => {
            const res = executeSelect();
            if (!res.data || res.data.length === 0) return { data: null, error: { code: 'PGRST116', message: 'No rows' } };
            return { data: res.data[0], error: null };
          },
          insert: (val) => {
            insertedValues = val;
            return chain;
          },
          update: (val) => {
            updateValues = val;
            return chain;
          },
          delete: () => {
            return chain;
          },
          then: (resolve, reject) => {
            try {
              if (insertedValues) {
                const row = { id: `inserted-${Date.now()}`, ...insertedValues };
                return resolve({ data: row, error: null });
              }
              if (updateValues) {
                const target = getDataSource().find(r => matchesFilters(r));
                const updated = target ? { ...target, ...updateValues } : null;
                return resolve({ data: updated, error: null });
              }
              return resolve(executeSelect());
            } catch (err) {
              reject(err);
            }
          }
        };

        function getDataSource() {
          if (table === 'organizations') return [{ id: testOrgId, name: 'Alpha Enterprises', plan_status: 'active' }, { id: otherOrgId, name: 'Other Org' }];
          if (table === 'profiles') return [{ id: testUserId, org_id: testOrgId, role: 'owner' }];
          if (table === 'leads') return mockLeads;
          if (table === 'conversations') return mockConversations;
          if (table === 'messages') return mockMessages;
          if (table === 'products') return mockProducts;
          if (table === 'call_requests') return mockCalls;
          return [];
        }

        function matchesFilters(row) {
          for (const f of filters) {
            if (f.op === 'eq' && row[f.field] !== f.value) return false;
            if (f.op === 'neq' && row[f.field] === f.value) return false;
          }
          return true;
        }

        function executeSelect() {
          let rows = getDataSource().filter(matchesFilters);
          const total = rows.length;
          if (rangeParams) {
            rows = rows.slice(rangeParams.from, rangeParams.to + 1);
          }
          return { data: rows, count: total, error: null };
        }

        return chain;
      }
    };
  }

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Authoritative Leads query strictly tenant-isolated
    await t.test('1. Authoritative Leads GET /api/leads returns tenant leads and excludes other org leads', async () => {
      repository.supabase = createMockSupabase(false);
      const res = await fetch(`${baseUrl}/api/leads`, {
        headers: { Authorization: `Bearer ${validToken}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.leads.length, 2);
      assert.ok(body.leads.every(l => l.org_id === testOrgId));
      assert.ok(!body.leads.some(l => l.org_id === otherOrgId));
    });

    // 2. Authoritative Conversations query strictly tenant-isolated
    await t.test('2. Authoritative Conversations GET /api/conversations excludes cross-tenant threads', async () => {
      repository.supabase = createMockSupabase(false);
      const res = await fetch(`${baseUrl}/api/conversations`, {
        headers: { Authorization: `Bearer ${validToken}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.threads.length, 1);
      assert.equal(body.threads[0].id, 'conv-1');
    });

    // 3. Authoritative Products query strictly tenant-isolated
    await t.test('3. Authoritative Catalog GET /api/catalog/products returns only tenant products', async () => {
      repository.supabase = createMockSupabase(false);
      const res = await fetch(`${baseUrl}/api/catalog/products`, {
        headers: { Authorization: `Bearer ${validToken}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.products.length, 1);
      assert.equal(body.products[0].id, 'prod-1');
    });

    // 4. Authoritative Analytics query derives metrics from genuine DB records
    await t.test('4. Authoritative Analytics GET /api/analytics derives metrics from Supabase', async () => {
      repository.supabase = createMockSupabase(false);
      const res = await fetch(`${baseUrl}/api/analytics`, {
        headers: { Authorization: `Bearer ${validToken}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.metrics.totalLeads, 2);
      assert.equal(body.metrics.confirmedCalls, 1);
      assert.equal(body.metrics.callBookingRate, '50%');
    });

    // 5. Database Outage Fail-Closed: Outage must return 503 rather than falling back to local memory DB
    await t.test('5. Database Outage returns 503 and fails closed without silent fallback', async () => {
      repository.supabase = createMockSupabase(true);
      for (const path of ['/api/leads', '/api/conversations', '/api/catalog/products', '/api/analytics']) {
        const res = await fetch(`${baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${validToken}` }
        });
        assert.equal(res.status, 503, `Endpoint ${path} should return 503 on database outage`);
        const body = await res.json();
        assert.equal(body.ok, false);
      }
    });

    // 6. Revoked Membership Fail-Closed: Revoked user cannot access tenant endpoints
    await t.test('6. Revoked membership rejects access with 403', async () => {
      // Mock client returns null membership for revoked user
      const revokedClient = createMockSupabase(false);
      revokedClient.from = (table) => {
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) })
              })
            })
          };
        }
        if (table === 'organizations') {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: testOrgId }, error: null }) }) })
          };
        }
        return createMockSupabase(false).from(table);
      };
      repository.supabase = revokedClient;

      const res = await fetch(`${baseUrl}/api/leads`, {
        headers: { Authorization: `Bearer ${validToken}` }
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(body.error, /revoked|member|denied/i);
    });

  } finally {
    repository.supabase = previousEnv.sb;
    process.env.NODE_ENV = previousEnv.nodeEnv;
    if (previousEnv.useLocal !== undefined) process.env.USE_LOCAL_DB = previousEnv.useLocal;
    await new Promise(resolve => server.close(resolve));
  }
});
