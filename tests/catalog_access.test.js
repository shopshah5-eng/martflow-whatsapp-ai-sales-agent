import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { repository } from '../src/db/repository.js';
import { signUp, createSessionToken } from '../src/auth/authService.js';

test('catalogue grants are explicit, tenant-scoped, revocable and fail closed', async () => {
  process.env.NODE_ENV = 'test'; process.env.USE_LOCAL_DB = 'true';
  process.env.PLATFORM_ADMIN_SECRET = 'catalog-test-platform-key';
  db.persist = () => {};
  const newUser = name => signUp({ email: `${name}-${crypto.randomUUID()}@example.test`, password: 'Password123!', fullName: name, companyName: name });
  const client = await newUser('client-owner');
  const other = await newUser('other-tenant');
  const agency = db.insert('profiles', { email: 'agency@example.test', full_name: 'Agency' });
  const member = db.insert('organization_members', { organization_id: client.organization.id, user_id: agency.id, role: 'member' });
  const agencyToken = createSessionToken(agency.id, client.organization.id, 'superadmin'); // forged role is ignored
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, token, method = 'GET', body, platform = false) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (platform) headers['x-platform-admin-key'] = process.env.PLATFORM_ADMIN_SECRET;
    const res = await fetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const orgId = client.organization.id, userId = agency.id;
    assert.equal((await request('/catalog/products', client.token)).status, 200);
    assert.equal((await request('/auth/me', client.token)).body.permissions.canManageCatalog, false);
    for (const token of [client.token, agencyToken]) {
      assert.equal((await request('/catalog/quick-add', token, 'POST', { name: 'Unauthorised' })).status, 403);
      assert.equal((await request('/catalog/sync', token, 'POST', { products: [] })).status, 403);
      assert.equal((await request('/catalog/upload', token, 'POST', {})).status, 403);
      assert.equal((await request('/catalog/knowledge', token, 'PATCH', { websiteKnowledge: 'Forged' })).status, 403);
      assert.equal((await request('/admin/catalog-permissions', token, 'POST', { orgId, userId, allow: true })).status, 403);
    }
    assert.equal((await request('/admin/catalog-permissions', null, 'POST', { orgId, userId: other.user.id, allow: true }, true)).status, 400);
    assert.equal((await request('/admin/catalog-permissions', null, 'POST', { orgId, userId, allow: true }, true)).status, 200);
    assert.equal((await request('/auth/me', agencyToken)).body.permissions.canManageCatalog, true);
    assert.equal((await request('/conversations', agencyToken)).status, 403);
    assert.equal((await request('/leads', agencyToken)).status, 403);
    assert.equal((await request('/learning/proposals', agencyToken)).status, 403);
    assert.equal((await request('/leads/export.csv', agencyToken)).status, 403);
    assert.equal((await request('/conversations', null, 'GET', undefined, true)).status, 403);
    assert.equal((await request('/conversations', client.token)).status, 200);
    assert.equal((await request('/catalog/knowledge', agencyToken, 'PATCH', { websiteKnowledge: 'Agency setup', businessType: 'machinery' })).status, 200);
    assert.equal(db.findById('organizations', orgId).website_knowledge, 'Agency setup');
    assert.equal((await request('/catalog/knowledge', agencyToken, 'PATCH', { websiteKnowledge: '' })).status, 200);
    assert.equal(db.findById('organizations', orgId).website_knowledge, '');
    const added = await request('/catalog/quick-add', agencyToken, 'POST', { name: 'Example', sku: 'A-1', priceRaw: '100', model: 'Size 5' });
    assert.equal(added.status, 200); assert.equal(added.body.product.model_specs, 'Size 5');
    const id = added.body.product.id;
    assert.equal((await request(`/catalog/products/${id}`, agencyToken, 'PATCH', { price_raw: '200', model_specs: 'Size 6', org_id: other.organization.id })).status, 200);
    assert.equal((await request('/catalog/products', client.token)).body.products[0].price_raw, '200');
    assert.equal((await request('/catalog/products', other.token)).body.products.length, 0);
    assert.equal((await request('/catalog/sync', agencyToken, 'POST', { orgId: other.organization.id, products: [] })).status, 403);
    assert.equal((await request('/catalog/products/' + id, other.token, 'PATCH', { name: 'Cross tenant' })).status, 403);
    assert.equal((await request('/admin/catalog-permissions', null, 'POST', { orgId: other.organization.id, userId: other.user.id, allow: true }, true)).status, 200);
    assert.equal((await request('/catalog/products/' + id, other.token, 'PATCH', { name: 'Cross tenant' })).status, 404);
    assert.notEqual((await request('/catalog/products/' + id, other.token, 'DELETE')).status, 200);
    assert.equal(db.findById('products', id).name, 'Example');
    assert.equal((await request('/admin/catalog-permissions', null, 'POST', { orgId, userId, allow: false }, true)).status, 200);
    assert.equal((await request('/catalog/products/' + id, agencyToken, 'DELETE')).status, 403);
    assert.equal((await request('/admin/catalog-permissions', null, 'POST', { orgId, userId, allow: true }, true)).status, 200);
    db.delete('organization_members', member.id);
    assert.equal((await request('/catalog/quick-add', agencyToken, 'POST', { name: 'Revoked member' })).status, 403);
    db.insert('organization_members', { organization_id: orgId, user_id: agency.id, role: 'member' });
    assert.equal((await request('/catalog/quick-add', agencyToken, 'POST', { name: 'Rejoined' })).status, 403);
    assert.equal((await request('/admin/catalog-permissions', null, 'POST', { orgId, userId, allow: true }, true)).status, 200);
    const oldGet = repository.getSupabase;
    try {
      repository.getSupabase = () => { throw new Error('permissions database unavailable'); };
      assert.equal((await request('/catalog/quick-add', agencyToken, 'POST', { name: 'Outage' })).status, 503);
      assert.equal((await request('/auth/me', agencyToken)).body.permissions.canManageCatalog, false);
    } finally { repository.getSupabase = oldGet; }
  } finally { await new Promise(r => server.close(r)); }
});
