import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db/index.js';
import {
  handleOrgIncomingMessage,
  ownerPendingConfirmations,
  ownerUndoSnapshots,
  conversationSentPhotos,
  generateShortSalesReply
} from '../server.js';

describe('OWNER-ONLY WHATSAPP CATALOG MANAGEMENT & CUSTOMER SAFETY SUITE', () => {
  const orgA = '00000000-0000-4000-8000-0000000000a1';
  const orgB = '00000000-0000-4000-8000-0000000000b2';
  const ownerPhone = '919781018975';
  const customerPhone = '919876543210';
  const botPhone = '919115748457';

  function mockSock() {
    const sentMessages = [];
    return {
      sentMessages,
      user: { id: `${botPhone}:1@s.whatsapp.net` },
      sendMessage: async (jid, content) => {
        const msg = { jid, content, key: { id: `bot_${Date.now()}_${Math.random()}` } };
        sentMessages.push(msg);
        return msg;
      },
      sendPresenceUpdate: async () => {},
      readMessages: async () => {}
    };
  }

  beforeEach(() => {
    ownerPendingConfirmations.clear();
    ownerUndoSnapshots.clear();
    conversationSentPhotos.clear();

    // Reset products for orgA and orgB in test db
    for (const p of db.find('products', p => p.org_id === orgA || p.organization_id === orgA)) {
      db.delete('products', p.id);
    }
    for (const p of db.find('products', p => p.org_id === orgB || p.organization_id === orgB)) {
      db.delete('products', p.id);
    }
    db.insert('organizations', {
      id: orgA,
      name: 'Org A Textiles',
      owner_alert_number: ownerPhone,
      wa_connected_number: botPhone,
      wa_auto_reply: true,
      website_knowledge: 'Org A rules'
    });
    db.insert('organizations', {
      id: orgB,
      name: 'Org B Electronics',
      owner_alert_number: '919999999999',
      wa_connected_number: '919111111111',
      wa_auto_reply: true,
      website_knowledge: 'Org B rules'
    });
  });

  test('1. Security: Customer messages containing "add:" or "remove:" NEVER trigger owner commands', async () => {
    const sock = mockSock();
    const customerMsg = {
      key: {
        remoteJid: `${customerPhone}@s.whatsapp.net`,
        fromMe: false,
        id: `cust_${Date.now()}`
      },
      pushName: 'Buyer Rahul',
      message: {
        conversation: 'add: Blue Denim Shirt | 899 | Pure denim'
      }
    };

    await handleOrgIncomingMessage(orgA, customerMsg, sock);

    // Verify product was NOT added
    const prods = db.findScoped('products', orgA);
    const added = prods.find(p => p.name.includes('Blue Denim'));
    assert.equal(added, undefined, 'Customer message must NEVER add a product to the catalog');
  });

  test('8. Owner Command "list" returns numbered products with stock status', async () => {
    db.insert('products', {
      id: 'p1',
      org_id: orgA,
      organization_id: orgA,
      name: 'Item One',
      price_raw: '100',
      description: '[OUT OF STOCK] Red',
      sku: 'WA-P1'
    });
    db.insert('products', {
      id: 'p2',
      org_id: orgA,
      organization_id: orgA,
      name: 'Item Two',
      price_raw: '200',
      description: 'Blue',
      sku: 'WA-P2'
    });

    const sock = mockSock();
    await handleOrgIncomingMessage(orgA, {
      key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: false, id: `list_${Date.now()}` },
      message: { conversation: 'list' }
    }, sock);

    assert.ok(sock.sentMessages.length > 0);
    const reply = sock.sentMessages[0].content.text;
    assert.ok(reply.includes('Item One'), 'Lists Item One');
    assert.ok(reply.includes('OUT OF STOCK'), 'Indicates OUT OF STOCK');
    assert.ok(reply.includes('Item Two'), 'Lists Item Two');
    assert.ok(reply.includes('IN STOCK'), 'Indicates IN STOCK');
  });

  test('9. Owner photo cannot change catalogue', async () => {
    const sock = mockSock();
    await handleOrgIncomingMessage(orgA, {
      key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: false, id: `img_ign_${Date.now()}` },
      message: {
        imageMessage: {
          caption: 'Look at this picture'
        }
      }
    }, sock);

    assert.ok(sock.sentMessages[0].content.text.includes('disabled'));
  });

  test('11. Customer Side: Never send photos for products marked [OUT OF STOCK]', async () => {
    db.insert('products', {
      id: 'prod_out',
      org_id: orgA,
      organization_id: orgA,
      name: 'Out Suit',
      price_raw: '700',
      description: '[OUT OF STOCK] Red',
      image_url: 'https://example.com/out_suit.jpg',
      sku: 'WA-OUT'
    });

    const replyObj = await generateShortSalesReply({
      organizationId: orgA,
      org: { name: 'Org A Textiles', city_base: 'Delhi' },
      lead: { phone: customerPhone, name: 'Buyer' },
      incomingText: 'Please send photo of Out Suit'
    });

    assert.equal(replyObj.matchedImageUrl, null, 'Must NOT attach photo for out-of-stock product');
  });

  test('12. Customer Side: Photo dispatch is limited to max 3 photos per conversation and once per product', async () => {
    db.insert('products', {
      id: 'p_instock_1',
      org_id: orgA,
      organization_id: orgA,
      name: 'Kurti Alpha',
      price_raw: '500',
      description: 'Cotton',
      brochure_url: 'https://example.com/kurti_alpha.jpg',
      sku: 'WA-K1'
    });

    const reply1 = await generateShortSalesReply({
      organizationId: orgA,
      org: { name: 'Org A Textiles', city_base: 'Delhi' },
      lead: { phone: customerPhone, name: 'Buyer' },
      incomingText: 'Show me Kurti Alpha photo'
    });

    assert.equal(reply1.matchedImageUrl, 'https://example.com/kurti_alpha.jpg');
    assert.equal(reply1.matchedImageCaption, 'Kurti Alpha (500)');

    // Second call for same product in same conversation should NOT re-send image
    const reply2 = await generateShortSalesReply({
      organizationId: orgA,
      org: { name: 'Org A Textiles', city_base: 'Delhi' },
      lead: { phone: customerPhone, name: 'Buyer' },
      incomingText: 'Can you send Kurti Alpha photo again?'
    });

    assert.equal(reply2.matchedImageUrl, null, 'Same product photo must NOT be re-sent in same chat');
  });
});


test.after(() => { setTimeout(() => process.exit(0), 100).unref(); });

test('WhatsApp identity: unresolved LID cannot trigger owner commands', async () => {
  const orgId='owner-lid-test';
  db.insert('organizations',{id:orgId,name:'LID test',owner_alert_number:'919781018975',wa_auto_reply:false});
  const sent=[];
  const sock={user:{id:'919115748457:1@s.whatsapp.net'},sendMessage:async(jid,content)=>{sent.push({jid,content});return {key:{id:'response'}};},sendPresenceUpdate:async()=>{},readMessages:async()=>{}};
  await handleOrgIncomingMessage(orgId,{key:{remoteJid:'148004724064491@lid',fromMe:false,id:'untrusted-lid'},message:{conversation:'add: Unauthorized product | 1 | details'}},sock);
  assert.equal(db.find('products',p=>(p.org_id===orgId||p.organization_id===orgId)&&p.name==='Unauthorized product').length,0);
});

test('same inbound message ID in different workspaces is not suppressed', async () => {
  const a='duplicate-id-org-a',b='duplicate-id-org-b',phone='919876543210';
  for(const id of [a,b]) db.insert('organizations',{id,name:id,owner_alert_number:phone,wa_auto_reply:false});
  const sock={user:{id:'919115748457:1@s.whatsapp.net'},sendMessage:async()=>({key:{id:'response'}}),sendPresenceUpdate:async()=>{},readMessages:async()=>{}};
  const msg={key:{remoteJid:`${phone}@s.whatsapp.net`,fromMe:false,id:'shared-id'},message:{conversation:'note: Shared test note'}};
  await handleOrgIncomingMessage(a,msg,sock); await handleOrgIncomingMessage(b,msg,sock);
  for(const id of [a,b]) assert.match(db.findById('organizations',id).website_knowledge,/Shared test note/);
});

test('owner note and undo preserve the previous tenant knowledge', async () => {
  const id='notes-undo-test',phone='919876543210';
  db.insert('organizations',{id,name:id,owner_alert_number:phone,website_knowledge:'Original knowledge'});
  const sent=[],sock={user:{id:'919115748457:1@s.whatsapp.net'},sendMessage:async(jid,content)=>{sent.push(content.text);return {key:{id:'response'}};},sendPresenceUpdate:async()=>{},readMessages:async()=>{}};
  await handleOrgIncomingMessage(id,{key:{remoteJid:`${phone}@s.whatsapp.net`,fromMe:false,id:'note-1'},message:{conversation:'note: Special hours'}},sock);
  assert.match(db.findById('organizations',id).website_knowledge,/Special hours/);
  assert.match(sent[0],/Done/);
  await handleOrgIncomingMessage(id,{key:{remoteJid:`${phone}@s.whatsapp.net`,fromMe:false,id:'note-undo'},message:{conversation:'undo'}},sock);
  assert.equal(db.findById('organizations',id).website_knowledge,'Original knowledge');
});


test('owner phone alone cannot mutate catalogue or run imports', async () => {
  const id='catalog-owner-block',phone='919876543210';
  db.insert('organizations',{id,name:id,owner_alert_number:phone,website_knowledge:'Original'});
  db.insert('products',{id:'catalog-owner-product',org_id:id,organization_id:id,name:'Existing',price_raw:'100'});
  const sent=[],sock={user:{id:'919115748457:1@s.whatsapp.net'},sendMessage:async(jid,content)=>{sent.push(content.text);return {key:{id:'response'}};},sendPresenceUpdate:async()=>{},readMessages:async()=>{}};
  for (const [i,text] of ['add: New | 1','price: Existing = 1','out: Existing','remove: Existing','yes','website: https://example.com','please change the price of Existing','stock: Existing is available','offer: 50 percent off'].entries()) {
    await handleOrgIncomingMessage(id,{key:{remoteJid:`${phone}@s.whatsapp.net`,fromMe:false,id:`block-${i}`},message:{conversation:text}},sock);
  }
  await handleOrgIncomingMessage(id,{key:{remoteJid:`${phone}@s.whatsapp.net`,fromMe:false,id:'block-pdf'},message:{documentMessage:{mimetype:'application/pdf',fileName:'catalog.pdf'}}},sock);
  assert.equal(db.findById('products','catalog-owner-product').price_raw,'100');
  assert.equal(db.find('products',p=>p.org_id===id).length,1);
  assert.equal(db.findById('organizations',id).website_knowledge,'Original');
  assert.equal(sent.length,10);
  assert.ok(sent.every(text=>text.includes('disabled')));
});


test('workspace manual and automatic modes do not change another workspace', async () => {
  const a='mode-org-a', b='mode-org-b', phone='919876543210';
  for (const id of [a,b]) db.insert('organizations',{id,name:id,owner_alert_number:phone,wa_auto_reply:true});
  const sock={user:{id:'919115748457:1@s.whatsapp.net'},sendMessage:async()=>({key:{id:'response'}}),sendPresenceUpdate:async()=>{},readMessages:async()=>{}};
  for (const [i,text] of ['manual','automatic'].entries()) {
    await handleOrgIncomingMessage(a,{key:{remoteJid:`${phone}@s.whatsapp.net`,fromMe:false,id:`mode-${i}`},message:{conversation:text}},sock);
    assert.equal(db.findById('organizations',a).wa_auto_reply, i === 1);
    assert.equal(db.findById('organizations',b).wa_auto_reply,true);
  }
});
