import test from 'node:test';
import assert from 'node:assert/strict';
import { TenantBaileysInstance } from '../src/integrations/whatsapp/baileysManager.js';

test('LID resolution requires a tenant-scoped mapping or a real phone JID', () => {
  const a=new TenantBaileysInstance('lid-test-a'),b=new TenantBaileysInstance('lid-test-b');
  const lid='148004724064491@lid';
  assert.equal(a.resolvePhoneFromJid(lid,''),'');
  assert.equal(a.resolvePhoneFromJid(lid,'919876543210@lid'),'');
  assert.equal(a.resolvePhoneFromJid(lid,'919876543210@s.whatsapp.net'),'919876543210');
  assert.equal(a.resolvePhoneFromJid(lid,''),'919876543210');
  assert.equal(b.resolvePhoneFromJid(lid,''),'');
  assert.equal(b.resolvePhoneFromJid('9876543210@s.whatsapp.net',''),'919876543210');
});
