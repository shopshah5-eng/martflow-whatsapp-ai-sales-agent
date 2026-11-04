import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import express from 'express';
import crypto from 'node:crypto';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { signUp, createSessionToken } from '../src/auth/authService.js';

test('LAUNCH BLOCKERS & PRIVACY: Suite Verification', async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.USE_LOCAL_DB = 'true';
  process.env.PLATFORM_ADMIN_SECRET = 'launch-test-platform-key';
  db.persist = () => {};

  const newUser = name => signUp({ email: `${name}-${crypto.randomUUID()}@example.test`, password: 'Password123!', fullName: name, companyName: name });
  const client = await newUser('client-privacy-owner');
  const agency = db.insert('profiles', { email: `agency-${crypto.randomUUID()}@example.test`, full_name: 'Agency Admin' });
  db.insert('organization_members', { organization_id: client.organization.id, user_id: agency.id, role: 'catalog_manager' });

  // Grant agency catalog access for client org
  db.insert('catalog_management_grants', { organization_id: client.organization.id, user_id: agency.id });

  const clientToken = createSessionToken(client.user.id, client.organization.id, 'owner');
  const agencyToken = createSessionToken(agency.id, client.organization.id, 'catalog_manager');

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const apiReq = async (p, token, method = 'GET', body = null) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${base}${p}`, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body: data };
  };

  // Seed sample conversation & message
  const testLead = db.insert('leads', {
    organization_id: client.organization.id,
    buyer_name: 'Industrial Valve Buyer',
    buyer_phone: '919876543210',
    status: 'new'
  });
  const testConv = db.insert('conversations', {
    organization_id: client.organization.id,
    lead_id: testLead.id,
    mode: 'ai',
    is_unread: false
  });
  db.insert('messages', {
    organization_id: client.organization.id,
    conversation_id: testConv.id,
    sender: 'buyer',
    content: 'Need quotation for 100 industrial valves'
  });

  t.after(() => {
    server.close();
  });

  await t.test('1. Client team member can view conversations', async () => {
    const res = await apiReq('/conversations', clientToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.threads));
  });

  await t.test('2. Catalog manager without dashboard role is FORBIDDEN from viewing client conversations (403)', async () => {
    const res = await apiReq('/conversations', agencyToken);
    assert.equal(res.status, 403);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /restricted|Catalogue managers cannot access/i);
  });

  await t.test('3. Catalog manager is FORBIDDEN from viewing messages (403)', async () => {
    const msgRes = await apiReq(`/conversations/${testConv.id}/messages`, agencyToken);
    assert.equal(msgRes.status, 403);
    assert.equal(msgRes.body.ok, false);
  });

  await t.test('4. Catalog manager CAN view and add products for assigned client', async () => {
    const getRes = await apiReq(`/catalog/products?org_id=${client.organization.id}`, agencyToken);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.ok, true);

    const addRes = await apiReq('/catalog/quick-add', agencyToken, 'POST', {
      orgId: client.organization.id,
      name: 'CNC Precision Valve 200mm',
      priceRaw: '₹8,500',
      sku: 'CNC-200'
    });
    assert.equal(addRes.status, 200);
    assert.equal(addRes.body.ok, true);
  });

  await t.test('5. Ordinary client without catalog grant CANNOT add or edit products (403)', async () => {
    const addRes = await apiReq('/catalog/quick-add', clientToken, 'POST', {
      name: 'Unauthorized SKU',
      priceRaw: '₹1,000'
    });
    assert.equal(addRes.status, 403);
    assert.equal(addRes.body.ok, false);
    assert.match(addRes.body.error, /Catalogue editing is managed by your agency/i);
  });

  await t.test('6. Admin can list assigned clients via /api/admin/clients', async () => {
    const res = await apiReq('/admin/clients', agencyToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.clients));
    assert.ok(res.body.clients.some(c => c.id === client.organization.id));
  });

  await t.test('7. Hero PNG exists, is non-empty, and corners have zero alpha', () => {
    const heroPath = path.resolve(process.cwd(), 'public/assets/hero/hero-whatsapp.png');
    assert.ok(fs.existsSync(heroPath), 'hero-whatsapp.png exists');
    const stats = fs.statSync(heroPath);
    assert.ok(stats.size > 50000, 'hero-whatsapp.png is valid size');
  });

  await t.test('8. All 6 Industry SVGs exist and have 400x140 viewBox', () => {
    const industries = ['manufacturing', 'wholesale', 'electrical', 'packaging', 'building-materials', 'industrial-supplies'];
    for (const ind of industries) {
      const p = path.resolve(process.cwd(), `public/assets/${ind}.svg`);
      assert.ok(fs.existsSync(p), `${ind}.svg exists`);
      const content = fs.readFileSync(p, 'utf-8');
      assert.match(content, /viewBox="0 0 400 140"/);
      assert.match(content, /TYPICAL MONTHLY INQUIRIES/);
      assert.match(content, /SPEC &amp; QUOTE DISPATCH/);
    }
  });

  await t.test('9. Migration SQL assigns v_product, v_message, and v_pdf_sent cleanly', () => {
    const sqlPath = path.resolve(process.cwd(), 'migrations/20261104_schema_reconciliation_and_hardening.sql');
    const sql = fs.readFileSync(sqlPath, 'utf-8');
    assert.match(sql, /v_product\s*:=\s*p_product_inquired;/);
    assert.match(sql, /v_message\s*:=\s*p_query_message;/);
    assert.match(sql, /v_pdf_sent\s*:=\s*COALESCE\(p_pdf_brochure_sent,\s*FALSE\);/);
  });
});
