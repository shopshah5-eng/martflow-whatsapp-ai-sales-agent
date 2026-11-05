import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db/index.js';
import { handleOrgIncomingMessage, server } from '../server.js';

test.after(async () => { await new Promise(resolve => server.close(resolve)); });

test('inbound alerts ignore greetings and lone price, then send once on meaningful details and preserve human escalation', async () => {
  const org = 'owner-alert-qualify-a', owner = '919812345670', buyer = '919812345671';
  db.insert('organizations', { id: org, name: 'Synthetic test', owner_alert_number: owner, wa_owner_alerts: true });
  const sent = [];
  const sock = { user: { id: '919812345672:1@s.whatsapp.net' }, sendPresenceUpdate: async () => {}, readMessages: async () => {}, sendMessage: async (jid, content) => { sent.push({ jid, text: content.text }); return { key: { id: `out-${sent.length}` } }; } };
  const send = async (id, text) => handleOrgIncomingMessage(org, { key: { remoteJid: `${buyer}@s.whatsapp.net`, fromMe: false, id }, message: { conversation: text } }, sock);
  const ownerMessages = () => sent.filter(x => x.jid === `${owner}@s.whatsapp.net`);
  await handleOrgIncomingMessage(org, { key: { remoteJid: `${buyer}@s.whatsapp.net`, fromMe: false, id: 'in-voice' }, message: { audioMessage: { seconds: 3, ptt: true } } }, sock);
  assert.equal(ownerMessages().length, 0, 'untranscribed voice note is not a confirmed buyer');
  await send('in-hello', 'hello');
  await send('in-price', 'price?');
  assert.equal(ownerMessages().length, 0);
  await send('in-details', '5 pieces');
  assert.equal(ownerMessages().length, 1);
  assert.match(ownerMessages()[0].text, /Buyer interest with details/);
  assert.match(ownerMessages()[0].text, /5 pieces/);
  await send('in-again', 'price for 10 pieces');
  assert.equal(ownerMessages().length, 1, 'repeat buying signals are cooled down');
  await send('in-human', 'please call me');
  assert.equal(ownerMessages().length, 2, 'explicit human request is not suppressed by lead cooldown');
  assert.match(ownerMessages()[1].text, /Human assistance requested/);
  assert.ok(sent.some(x => x.jid === `${buyer}@s.whatsapp.net`), 'normal buyer replies continue');
});

test('disabled owner alerts and failed delivery do not create misleading success or suppress retry', async () => {
  const owner = '919812345680', buyer = '919812345681';
  const disabled = 'owner-alert-disabled';
  db.insert('organizations',{ id: disabled, name: 'Disabled', owner_alert_number: owner, wa_owner_alerts: false });
  let ownerSends = 0, fail = true;
  const sock = { user: { id: '919812345682:1@s.whatsapp.net' }, sendPresenceUpdate: async () => {}, readMessages: async () => {}, sendMessage: async (jid) => { if (jid === `${owner}@s.whatsapp.net`) { ownerSends++; if (fail) throw new Error('synthetic send error'); } return { key: { id: 'out' } }; } };
  const send = async (org,id,text) => handleOrgIncomingMessage(org,{ key:{remoteJid:`${buyer}@s.whatsapp.net`,fromMe:false,id},message:{conversation:text} },sock);
  await send(disabled,'disabled-order','I want to order');
  assert.equal(ownerSends, 0);
  const enabled = 'owner-alert-retry';
  db.insert('organizations',{ id: enabled, name: 'Enabled', owner_alert_number: owner, wa_owner_alerts: true });
  await send(enabled,'failed-order','I want to order');
  assert.equal(ownerSends, 1);
  fail = false;
  await send(enabled,'retry-order','I want to buy');
  assert.equal(ownerSends, 2);
});
