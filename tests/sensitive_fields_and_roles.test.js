process.env.NODE_ENV = 'test';
process.env.USE_LOCAL_DB = 'true';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import apiRouter, { sanitizeOrganization } from '../src/routes/api.js';
import db from '../src/db/index.js';
import { createSessionToken } from '../src/auth/authService.js';
import fs from 'fs';
import path from 'path';

test('SECURITY & PRIVACY: Sensitive organization fields and role-based capability boundaries', async (t) => {
  const rawOrg = {
    id: 'a1b2c3d4-e5f6-4a1b-8c2d-112233445566',
    name: 'Acme Test Corp',
    slug: 'acme-test',
    plan_status: 'active',
    webhook_key: 'whk_super_secret_key_123',
    waba_token: 'secret_meta_waba_bearer_token_xyz',
    wa_command: 'start_qr',
    wa_command_payload: { sensitive: true },
    monthly_lead_limit: 100,
    leads_used: 15,
    business_type: 'machinery',
    wa_qr_data_url: 'data:image/png;base64,c2VjcmV0',
    wa_pairing_code: 'secret-code',
    wa_status: 'connected',
    wa_connected_number: '919876543210'
  };

  await t.test('1. sanitizeOrganization strips waba_token and commands from all roles', () => {
    const sanitizedOwner = sanitizeOrganization(rawOrg, 'owner');
    assert.equal(sanitizedOwner.waba_token, undefined);
    assert.equal(sanitizedOwner.wa_command, undefined);
    assert.equal(sanitizedOwner.wa_command_payload, undefined);
    assert.equal(sanitizedOwner.webhook_key, 'whk_super_secret_key_123');
    assert.equal(sanitizedOwner.wa_pairing_code, 'secret-code');
    assert.equal(sanitizedOwner.name, 'Acme Test Corp');
    assert.equal(sanitizedOwner.wa_connected_number, '919876543210');

    const sanitizedMember = sanitizeOrganization(rawOrg, 'member');
    assert.equal(sanitizedMember.waba_token, undefined);
    assert.equal(sanitizedMember.wa_command, undefined);
    assert.equal(sanitizedMember.wa_pairing_code, undefined);
    assert.equal(sanitizedMember.wa_qr_data_url, undefined);
    assert.equal(sanitizedMember.webhook_key, undefined); // non-admin does not get webhook_key
    assert.equal(sanitizedMember.name, 'Acme Test Corp');
  });

  await t.test('2. /api/auth/me returns sanitized organization without secrets', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const orgId = rawOrg.id;
      db.insert('organizations', rawOrg);
      const ownerUser = db.insert('profiles', { email: 'owner@acme.test', org_id: orgId, role: 'owner' });
      db.insert('organization_members', { organization_id: orgId, user_id: ownerUser.id, role: 'owner' });
      const ownerToken = createSessionToken(ownerUser.id, orgId, 'owner');

      const memberUser = db.insert('profiles', { email: 'member@acme.test', org_id: orgId, role: 'member' });
      db.insert('organization_members', { organization_id: orgId, user_id: memberUser.id, role: 'member' });
      const memberToken = createSessionToken(memberUser.id, orgId, 'member');

      // Owner request
      const resOwner = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      assert.equal(resOwner.status, 200);
      const dataOwner = await resOwner.json();
      assert.equal(dataOwner.organization.waba_token, undefined);
      assert.equal(dataOwner.organization.wa_command, undefined);
      assert.equal(dataOwner.organization.webhook_key, 'whk_super_secret_key_123');

      // Member request
      const resMember = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${memberToken}` }
      });
      assert.equal(resMember.status, 200);
      const dataMember = await resMember.json();
      assert.equal(dataMember.organization.waba_token, undefined);
      assert.equal(dataMember.organization.webhook_key, undefined);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('3. /api/conversations/:id/mode and reply reject member role with 403', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const orgId = rawOrg.id;
      const memberUser = db.insert('profiles', { email: 'member2@acme.test', org_id: orgId, role: 'member' });
      db.insert('organization_members', { organization_id: orgId, user_id: memberUser.id, role: 'member' });
      const memberToken = createSessionToken(memberUser.id, orgId, 'member');

      const conv = db.insert('conversations', { organization_id: orgId, mode: 'ai' });

      // Member attempts to toggle conversation mode
      const resMode = await fetch(`${baseUrl}/api/conversations/${conv.id}/mode`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'human' })
      });
      assert.equal(resMode.status, 403, 'Member role must be forbidden from changing conversation mode');

      // Member attempts to send conversation reply
      const resReply = await fetch(`${baseUrl}/api/conversations/${conv.id}/reply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Unauthorized reply attempt' })
      });
      assert.equal(resReply.status, 403, 'Member role must be forbidden from dispatching conversation replies');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('4. Schema trigger does not reference non-existent quote_code column', () => {
    const schemaSql = fs.readFileSync(path.join(process.cwd(), 'supabase_schema.sql'), 'utf8');
    assert.equal(schemaSql.includes('NEW.quote_code'), false, 'quote_code must not be referenced in billing immutability trigger');
  });
});
