process.env.NODE_ENV = 'test';
process.env.USE_LOCAL_DB = 'true';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { createSessionToken } from '../src/auth/authService.js';

test('ADMIN QUOTA & DASHBOARD CATALOGUE SUITE: Quota bounds (3-20) and scoped management', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // Synthetic Test IDs
    const superAdminId = '00000000-0000-4000-a000-000000000001';
    const superAdminOrgId = '00000000-0000-4000-b000-000000000001';

    const agencyAdminId = '00000000-0000-4000-a000-000000000002';
    const agencyAdminOrgId = '00000000-0000-4000-b000-000000000002';

    const clientOrg1 = '00000000-0000-4000-c000-000000000001';
    const clientOrg2 = '00000000-0000-4000-c000-000000000002';
    const clientOrg3 = '00000000-0000-4000-c000-000000000003';
    const clientOrg4 = '00000000-0000-4000-c000-000000000004';
    const unauthorizedOrg = '00000000-0000-4000-c000-000000000099';

    // Clean and seed DB
    db.tables.catalog_management_grants.clear();
    db.tables.admin_quotas.clear();
    db.tables.products.clear();
    db.insert('organizations', { id: superAdminOrgId, name: 'Super Admin HQ' });
    db.insert('organizations', { id: agencyAdminOrgId, name: 'Agency Partner Co' });
    db.insert('organizations', { id: clientOrg1, name: 'Client Alfa Garments' });
    db.insert('organizations', { id: clientOrg2, name: 'Client Beta Spices' });
    db.insert('organizations', { id: clientOrg3, name: 'Client Gamma Tools' });
    db.insert('organizations', { id: clientOrg4, name: 'Client Delta Motors' });
    db.insert('organizations', { id: unauthorizedOrg, name: 'Client Secret Pharma' });

    db.insert('profiles', { id: superAdminId, email: 'super@leadsy.ai', role: 'superadmin', org_id: superAdminOrgId });
    db.insert('profiles', { id: agencyAdminId, email: 'agency@partner.com', role: 'admin', org_id: agencyAdminOrgId });

    db.insert('organization_members', { user_id: superAdminId, organization_id: superAdminOrgId, role: 'superadmin' });
    db.insert('organization_members', { user_id: agencyAdminId, organization_id: agencyAdminOrgId, role: 'admin' });

    for (const cId of [clientOrg1, clientOrg2, clientOrg3, clientOrg4]) {
      db.insert('organization_members', { user_id: agencyAdminId, organization_id: cId, role: 'member' });
    }

    const superToken = createSessionToken(superAdminId, superAdminOrgId, 'superadmin');
    const agencyToken = createSessionToken(agencyAdminId, agencyAdminOrgId, 'admin');

    const superHeaders = {
      'Authorization': `Bearer ${superToken}`,
      'Content-Type': 'application/json'
    };
    const agencyHeaders = {
      'Authorization': `Bearer ${agencyToken}`,
      'Content-Type': 'application/json'
    };

    // 1. Super Admin sets quota bounded between 3 and 20 (defaults clamped)
    const resLow = await fetch(`${baseUrl}/api/admin/catalog-permissions`, {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({ orgId: clientOrg1, userId: agencyAdminId, allow: true, quota: 1 })
    });
    assert.equal(resLow.status, 200);
    const dataLow = await resLow.json();
    assert.equal(dataLow.quota, 3, 'Quota clamped to minimum 3');

    const resHigh = await fetch(`${baseUrl}/api/admin/catalog-permissions`, {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({ orgId: clientOrg1, userId: agencyAdminId, allow: true, quota: 99 })
    });
    assert.equal(resHigh.status, 200);
    const dataHigh = await resHigh.json();
    assert.equal(dataHigh.quota, 20, 'Quota clamped to maximum 20');

    // Set quota to 3
    const resExact = await fetch(`${baseUrl}/api/admin/catalog-permissions`, {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({ orgId: clientOrg1, userId: agencyAdminId, allow: true, quota: 3 })
    });
    assert.equal(resExact.status, 200);
    const dataExact = await resExact.json();
    assert.equal(dataExact.quota, 3);

    // 2. Quota enforcement: Admin cannot exceed allowed account limit (3)
    const res2 = await fetch(`${baseUrl}/api/admin/catalog-permissions`, {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({ orgId: clientOrg2, userId: agencyAdminId, allow: true, quota: 3 })
    });
    assert.equal(res2.status, 200);

    const res3 = await fetch(`${baseUrl}/api/admin/catalog-permissions`, {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({ orgId: clientOrg3, userId: agencyAdminId, allow: true, quota: 3 })
    });
    assert.equal(res3.status, 200);

    // 4th grant must fail with 400 because limit is 3
    const res4 = await fetch(`${baseUrl}/api/admin/catalog-permissions`, {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({ orgId: clientOrg4, userId: agencyAdminId, allow: true, quota: 3 })
    });
    assert.equal(res4.status, 400);
    const data4 = await res4.json();
    assert.match(data4.error, /quota limit reached/i);

    // Super Admin increases quota to 5; grant succeeds
    const resIncrease = await fetch(`${baseUrl}/api/admin/catalog-permissions`, {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({ orgId: clientOrg4, userId: agencyAdminId, allow: true, quota: 5 })
    });
    assert.equal(resIncrease.status, 200);
    const dataInc = await resIncrease.json();
    assert.equal(dataInc.canManageCatalog, true);
    assert.equal(dataInc.quota, 5);

    // 3. GET /admin/clients returns quota info and granted flags
    const clientsRes = await fetch(`${baseUrl}/api/admin/clients`, { headers: agencyHeaders });
    assert.equal(clientsRes.status, 200);
    const clientsData = await clientsRes.json();
    assert.equal(clientsData.ok, true);
    assert.ok(Array.isArray(clientsData.clients));
    assert.equal(clientsData.quota.max_accounts, 5);
    assert.equal(clientsData.quota.assigned_count, 4);
    assert.equal(clientsData.quota.min_accounts, 3);
    assert.equal(clientsData.quota.max_limit, 20);

    // 4. Agency Admin can manage products for granted client account from dashboard
    const addRes = await fetch(`${baseUrl}/api/catalog/quick-add`, {
      method: 'POST',
      headers: agencyHeaders,
      body: JSON.stringify({
        name: 'Industrial Sewing Machine RX-9',
        sku: 'SKU-RX9',
        priceRaw: '₹45,000 + GST',
        model: 'Heavy Duty 2026 Edition',
        orgId: clientOrg1
      })
    });
    const addData = await addRes.json();
    assert.equal(addRes.status, 200);
    assert.equal(addData.ok, true);
    assert.equal(addData.product.name, 'Industrial Sewing Machine RX-9');

    // Fetch products for clientOrg1
    const listRes = await fetch(`${baseUrl}/api/catalog/products?org_id=${clientOrg1}`, { headers: agencyHeaders });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    const prod = listData.products.find(p => p.sku === 'SKU-RX9');
    assert.ok(prod, 'Added product found in clientOrg1 catalog');

    // Update specs
    const patchRes = await fetch(`${baseUrl}/api/catalog/products/${prod.id}?org_id=${clientOrg1}`, {
      method: 'PATCH',
      headers: agencyHeaders,
      body: JSON.stringify({ price_raw: '₹42,000 + GST' })
    });
    assert.equal(patchRes.status, 200);

    // Delete product
    const delRes = await fetch(`${baseUrl}/api/catalog/products/${prod.id}?org_id=${clientOrg1}`, {
      method: 'DELETE',
      headers: agencyHeaders
    });
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.equal(delData.deleted, true);

    // 5. Unauthorized access rejected when attempting to touch non-granted client catalogue
    const unauthAdd = await fetch(`${baseUrl}/api/catalog/quick-add`, {
      method: 'POST',
      headers: agencyHeaders,
      body: JSON.stringify({
        name: 'Secret Drug Formulation',
        priceRaw: '₹1,00,000',
        orgId: unauthorizedOrg
      })
    });
    assert.equal(unauthAdd.status, 403);

    const unauthGet = await fetch(`${baseUrl}/api/catalog/products?org_id=${unauthorizedOrg}`, { headers: agencyHeaders });
    assert.equal(unauthGet.status, 403);

    // 6. Super Admin can revoke client access; revocation takes effect immediately
    const revokeRes = await fetch(`${baseUrl}/api/admin/catalog-permissions`, {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({ orgId: clientOrg1, userId: agencyAdminId, allow: false })
    });
    assert.equal(revokeRes.status, 200);
    const revokeData = await revokeRes.json();
    assert.equal(revokeData.canManageCatalog, false);

    // Blocked from managing clientOrg1 now
    const blockedRes = await fetch(`${baseUrl}/api/catalog/quick-add`, {
      method: 'POST',
      headers: agencyHeaders,
      body: JSON.stringify({
        name: 'Denied Machine',
        orgId: clientOrg1
      })
    });
    assert.equal(blockedRes.status, 403);
  } finally {
    server.close();
  }
});
