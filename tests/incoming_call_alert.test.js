import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { alertOnIncomingCall, attachIncomingCallAlerts } from '../src/integrations/whatsapp/incomingCallAlert.js';

const event = (id, overrides = {}) => ({ id, status: 'offer', from: '919876543210@s.whatsapp.net', isGroup: false, offline: false, ...overrides });
function fakeSocket() {
  const sent = [];
  return { sent, user: { id: '919999000000:1@s.whatsapp.net', lid: '123456@lid' }, ev: new EventEmitter(), sendMessage: async (jid, content) => { sent.push({ jid, content }); } };
}
const orgA = 'synthetic-tenant-a', orgB = 'synthetic-tenant-b';
const orgs = { [orgA]: { id: orgA, owner_alert_number: '9876500001' }, [orgB]: { id: orgB, owner_alert_number: '919876500002' } };
const getOrganization = async id => orgs[id];
const getSettings = async () => null;
const opts = { getOrganization, getSettings, dryRun: false };

test('alerts only the configured workspace owner for incoming direct calls; no call controls', async () => {
  const a = fakeSocket(), b = fakeSocket();
  assert.equal((await alertOnIncomingCall({ orgId: orgA, socket: a, call: event('separate-org-id'), ...opts })).sent, true);
  assert.equal((await alertOnIncomingCall({ orgId: orgB, socket: b, call: event('separate-org-id', { isVideo: true }), ...opts })).sent, true);
  assert.equal(a.sent[0].jid, '919876500001@s.whatsapp.net');
  assert.equal(b.sent[0].jid, '919876500002@s.whatsapp.net');
  assert.match(a.sent[0].content.text, /Incoming WhatsApp voice call/);
  assert.match(a.sent[0].content.text, /https:\/\/wa.me\/919876543210/);
  assert.match(b.sent[0].content.text, /video call/);
  assert.equal((await alertOnIncomingCall({ orgId: orgA, socket: a, call: event('separate-org-id'), ...opts })).reason, 'duplicate_or_capacity');
  assert.equal(a.sent.length, 1);
});

test('only live offers, no group/offline/self call, and no LID mistaken for phone', async () => {
  const socket = fakeSocket();
  for (const call of [event('reject', {status:'reject'}), event('timeout', {status:'timeout'}), event('group', {isGroup:true}), event('offline', {offline:true})]) {
    assert.equal((await alertOnIncomingCall({orgId:orgA, socket, call, ...opts})).sent, false);
  }
  assert.equal((await alertOnIncomingCall({orgId:orgA, socket, call:event('self-owner', {from:'919876500001@s.whatsapp.net'}), ...opts})).reason, 'self_or_main_number_call');
  const unknown = event('lid-call', {from:'12345678912345@lid', chatId:'12345678912345@lid'});
  assert.equal((await alertOnIncomingCall({orgId:orgA, socket, call:unknown, ...opts})).sent, true);
  assert.match(socket.sent[0].content.text, /number unavailable/i);
  assert.doesNotMatch(socket.sent[0].content.text, /12345678912345/);
  assert.equal((await alertOnIncomingCall({orgId:orgA, socket, call:event('lid-known', {from:'12345678912345@lid', callerPn:'919111222333@s.whatsapp.net'}), ...opts})).sent, true);
  assert.match(socket.sent[1].content.text, /919111222333/);
});

test('fails closed on disabled alerts, missing number, bad workspace, lookup errors, and dry run', async () => {
  const socket=fakeSocket();
  const run=(id, override) => alertOnIncomingCall({orgId:orgA, socket, call:event(id), ...opts, ...override});
  assert.equal((await run('off',{getOrganization: async()=>({id:orgA,owner_alert_number:'919876500001',wa_owner_alerts:false})})).sent,false);
  assert.equal((await run('missing',{getOrganization: async()=>({id:orgA})})).reason,'main_number_missing');
  assert.equal((await run('bad-tenant',{getOrganization: async()=>orgs[orgB]})).sent,false);
  assert.equal((await run('error',{getOrganization: async()=>{throw Error('secret')}})).reason,'lookup_or_delivery_failed');
  assert.equal((await run('dry',{dryRun:true})).reason,'dry_run');
  assert.equal(socket.sent.length,0);
  assert.equal((await run('fallback',{getOrganization: async()=>({id:orgA}),getSettings:async()=>({escalation_phone:'9876500003'})})).sent,true);
  assert.equal(socket.sent[0].jid, '919876500003@s.whatsapp.net');
});

test('duplicate simultaneous events and registration do not send twice', async () => {
  const socket = fakeSocket();
  const call = event('concurrent-offer');
  const results = await Promise.all([alertOnIncomingCall({orgId:orgA,socket,call,...opts}),alertOnIncomingCall({orgId:orgA,socket,call,...opts})]);
  assert.equal(results.filter(r=>r.sent).length, 1);
  attachIncomingCallAlerts(socket, orgB, opts);
  socket.ev.emit('call', [event('event-listener')]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(socket.sent.length,2);
  assert.equal(socket.sent[1].jid,'919876500002@s.whatsapp.net');
});
