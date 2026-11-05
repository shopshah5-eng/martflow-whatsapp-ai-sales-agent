process.env.NODE_ENV = 'test';
process.env.USE_LOCAL_DB = 'true';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { createSessionToken } from '../src/auth/authService.js';

test('email admin workflow enforces approval, limits, isolation and revocation', async () => {
  db.persist = () => {};
  const create = (label, role = 'owner') => {
    const org = db.insert('organizations', { name: label });
    const user = db.insert('profiles', { email: `${label}-${crypto.randomUUID()}@example.test`, org_id: org.id, role, full_name: label });
    db.insert('organization_members', { user_id: user.id, organization_id: org.id, role });
    return { org, user, token: createSessionToken(user.id, org.id, role) };
  };
  const superadmin = create('platform', 'superadmin');
  const admin = create('agency');
  const client = create('client');
  const other = create('other');
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (who, path, method='GET', body) => {
    const res = await fetch(base+path,{method,headers:{authorization:`Bearer ${who.token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await request(client,'/catalog-admin/context')).status, 403);
    assert.equal((await request(client,'/catalog-admin/search?email=cli')).status, 403);
    assert.equal((await request(admin,'/auth/me')).body.permissions.canAccessCatalogAdmin, false);
    assert.equal((await request(superadmin,'/catalog-admin/admins','POST',{email:admin.user.email,maxClients:1,enabled:true})).status, 200);
    assert.equal((await request(admin,'/auth/me')).body.permissions.canAccessCatalogAdmin, true);
    assert.equal((await request(admin,'/catalog-admin/requests','POST',{clientEmail:client.user.email})).status, 200);
    assert.equal((await request(admin,`/catalog/products?org_id=${client.org.id}`)).status, 403);
    assert.equal((await request(admin,'/catalog-admin/requests','POST',{clientEmail:other.user.email})).status, 409);
    assert.equal((await request(client,'/catalog-admin/review','POST',{adminId:admin.user.id,orgId:client.org.id,approve:true})).status, 403);
    const pending = await request(superadmin,'/catalog-admin/context');
    assert.equal(pending.body.requests[0].client.email,client.user.email);
    assert.equal((await request(superadmin,'/catalog-admin/review','POST',{adminId:admin.user.id,orgId:client.org.id,approve:true})).status,200);
    const ctx = await request(admin,'/catalog-admin/context'); assert.equal(ctx.body.clients.length,1); assert.equal(ctx.body.clients[0].id,client.org.id);
    const supctx=await request(superadmin,'/catalog-admin/context'); assert.equal(supctx.body.admins[0].clients[0].id,client.org.id);
    const add = await request(admin,'/catalog/quick-add','POST',{orgId:client.org.id,name:'Scoped product',priceRaw:'10'}); assert.equal(add.status,200);
    assert.equal((await request(admin,`/catalog/products?org_id=${client.org.id}`)).body.products.length,1);
    assert.equal((await request(admin,`/catalog/products?org_id=${other.org.id}`)).status,403);
    assert.equal((await request(admin,'/catalog/quick-add','POST',{orgId:other.org.id,name:'Not authorized'})).status,403);
    assert.equal((await request(admin,'/catalog-admin/review','POST',{adminId:admin.user.id,orgId:other.org.id,approve:true})).status,403);
    assert.equal((await request(superadmin,'/admin/catalog-permissions','POST',{orgId:other.org.id,userId:admin.user.id,allow:true})).status,410);
    assert.equal((await request(superadmin,`/catalog-admin/assignments/${client.org.id}`,'DELETE',{adminId:admin.user.id})).status,200);
    assert.equal((await request(admin,`/catalog/products?org_id=${client.org.id}`)).status,403);
    assert.equal((await request(admin,'/catalog-admin/requests','POST',{clientEmail:other.user.email})).status,200);
    assert.equal((await request(superadmin,'/catalog-admin/admins','POST',{email:admin.user.email,maxClients:1,enabled:false})).status,200);
    assert.equal((await request(admin,'/catalog-admin/context')).status,403);
    assert.equal((await request(admin,'/auth/me')).body.permissions.canAccessCatalogAdmin,false);
    // A forged query parameter must not bypass the inbox block for a catalogue-only member.
    db.insert('catalog_management_grants',{user_id:client.user.id,org_id:client.org.id,organization_id:client.org.id});
    assert.equal((await request(client,`/conversations?org_id=${other.org.id}`)).status,403);
  } finally { await new Promise(r=>server.close(r)); }
});
