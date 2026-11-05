import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOrganization } from '../src/routes/api.js';

test('CATALOGUE MANAGER PRIVACY: Sensitive credentials, alert phone, and pairing keys are masked from catalogue managers', async () => {
  const fullOrg = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Test Machinery Corp',
    slug: 'test-machinery',
    plan_status: 'active',
    escalation_phone: '+919999988888',
    owner_alert_number: '+918888877777',
    wa_status: 'connected',
    wa_connected_number: '+917777766666',
    bot_whatsapp_number: '+916666655555',
    wa_qr_data_url: 'data:image/png;base64,SECRET_QR',
    wa_pairing_code: 'PAIR1234',
    webhook_key: 'whsec_verysecretkey'
  };

  // 1. Catalogue manager (role 'member' or 'admin' with canManageCatalog = true) must NOT see sensitive fields
  const catalogManagerView = sanitizeOrganization(fullOrg, 'member', { canManageCatalog: true });
  assert.equal(catalogManagerView.id, fullOrg.id);
  assert.equal(catalogManagerView.name, fullOrg.name);
  assert.equal(catalogManagerView.escalation_phone, undefined, 'escalation_phone must be hidden from catalogue manager');
  assert.equal(catalogManagerView.owner_alert_number, undefined, 'owner_alert_number must be hidden from catalogue manager');
  assert.equal(catalogManagerView.wa_status, undefined, 'wa_status must be hidden from catalogue manager');
  assert.equal(catalogManagerView.wa_connected_number, undefined, 'wa_connected_number must be hidden from catalogue manager');
  assert.equal(catalogManagerView.bot_whatsapp_number, undefined, 'bot_whatsapp_number must be hidden from catalogue manager');
  assert.equal(catalogManagerView.wa_qr_data_url, undefined, 'wa_qr_data_url must be hidden from catalogue manager');
  assert.equal(catalogManagerView.wa_pairing_code, undefined, 'wa_pairing_code must be hidden from catalogue manager');
  assert.equal(catalogManagerView.webhook_key, undefined, 'webhook_key must be hidden from catalogue manager');

  // 2. Verified workspace owner sees all their own settings and credentials
  const ownerView = sanitizeOrganization(fullOrg, 'owner');
  assert.equal(ownerView.escalation_phone, '+919999988888');
  assert.equal(ownerView.owner_alert_number, '+918888877777');
  assert.equal(ownerView.wa_status, 'connected');
  assert.equal(ownerView.wa_connected_number, '+917777766666');
  assert.equal(ownerView.bot_whatsapp_number, '+916666655555');
  assert.equal(ownerView.wa_qr_data_url, 'data:image/png;base64,SECRET_QR');
  assert.equal(ownerView.wa_pairing_code, 'PAIR1234');
  assert.equal(ownerView.webhook_key, 'whsec_verysecretkey');

  // 3. Platform superadmin also has access to troubleshoot infrastructure
  const superadminView = sanitizeOrganization(fullOrg, 'superadmin');
  assert.equal(superadminView.owner_alert_number, '+918888877777');
  assert.equal(superadminView.wa_pairing_code, 'PAIR1234');
});

