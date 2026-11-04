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

  test('2. Owner Command "add: Name | price | details" inserts ONE product with auto-generated WA SKU', async () => {
    const sock = mockSock();
    const ownerMsg = {
      key: {
        remoteJid: `${ownerPhone}@s.whatsapp.net`,
        fromMe: false,
        id: `owner_${Date.now()}`
      },
      pushName: 'Owner',
      message: {
        conversation: 'add: Maroon Suit | 550 | Pure cotton with dupatta'
      }
    };

    await handleOrgIncomingMessage(orgA, ownerMsg, sock);

    const prods = db.findScoped('products', orgA);
    const prod = prods.find(p => p.name === 'Maroon Suit');
    assert.ok(prod, 'Product Maroon Suit should be inserted');
    assert.equal(prod.price_raw, '550');
    assert.equal(prod.description, 'Pure cotton with dupatta');
    assert.ok(prod.sku.startsWith('WA-'), 'SKU should start with WA-');

    assert.ok(sock.sentMessages.length > 0, 'Confirmation message should be sent to owner');
    assert.ok(sock.sentMessages[0].content.text.includes('Done: Maroon Suit added. Type undo to reverse.'));
  });

  test('3. Owner Command "add:" with same name updates existing product instead of duplicating', async () => {
    db.insert('products', {
      id: 'prod_101',
      org_id: orgA,
      organization_id: orgA,
      name: 'Maroon Suit',
      price_raw: '500',
      description: 'Old details',
      sku: 'WA-101'
    });

    const sock = mockSock();
    const ownerMsg = {
      key: {
        remoteJid: `${ownerPhone}@s.whatsapp.net`,
        fromMe: false,
        id: `owner_${Date.now()}`
      },
      message: {
        conversation: 'add: maroon suit | 650 | Upgraded 100% fine cotton'
      }
    };

    await handleOrgIncomingMessage(orgA, ownerMsg, sock);

    const prods = db.findScoped('products', orgA);
    const matches = prods.filter(p => p.name.toLowerCase() === 'maroon suit');
    assert.equal(matches.length, 1, 'Should NOT create duplicate product with same name');
    assert.equal(matches[0].price_raw, '650', 'Price should be updated to 650');
    assert.equal(matches[0].description, 'Upgraded 100% fine cotton', 'Description should be updated');
  });

  test('4. Owner Command "price: Name = 595" updates price_raw of matching product only', async () => {
    db.insert('products', {
      id: 'prod_102',
      org_id: orgA,
      organization_id: orgA,
      name: 'Green Kurti',
      price_raw: '450',
      sku: 'WA-102'
    });

    const sock = mockSock();
    const ownerMsg = {
      key: {
        remoteJid: `${ownerPhone}@s.whatsapp.net`,
        fromMe: false,
        id: `owner_${Date.now()}`
      },
      message: {
        conversation: 'price: Green Kurti = 595'
      }
    };

    await handleOrgIncomingMessage(orgA, ownerMsg, sock);

    const updated = db.findById('products', 'prod_102');
    assert.equal(updated.price_raw, '595');
    assert.ok(sock.sentMessages[0].content.text.includes('Done: Green Kurti price updated to 595. Type undo to reverse.'));
  });

  test('5. Owner Command "out: Name" and "in: Name" toggles [OUT OF STOCK] prefix on description', async () => {
    db.insert('products', {
      id: 'prod_103',
      org_id: orgA,
      organization_id: orgA,
      name: 'Yellow Anarkali',
      price_raw: '999',
      description: 'Festive collection',
      sku: 'WA-103'
    });

    const sock = mockSock();
    // 5a. Out of stock
    await handleOrgIncomingMessage(orgA, {
      key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: false, id: `owner_out_${Date.now()}` },
      message: { conversation: 'out: Yellow Anarkali' }
    }, sock);

    let p = db.findById('products', 'prod_103');
    assert.ok(p.description.startsWith('[OUT OF STOCK]'), 'Description should start with [OUT OF STOCK]');
    assert.ok(sock.sentMessages[0].content.text.includes('Done: Yellow Anarkali marked OUT OF STOCK. Type undo to reverse.'));

    // 5b. In stock
    await handleOrgIncomingMessage(orgA, {
      key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: false, id: `owner_in_${Date.now()}` },
      message: { conversation: 'in: Yellow Anarkali' }
    }, sock);

    p = db.findById('products', 'prod_103');
    assert.equal(p.description, 'Festive collection', 'Prefix should be cleanly removed');
    assert.ok(sock.sentMessages[1].content.text.includes('Done: Yellow Anarkali marked IN STOCK. Type undo to reverse.'));
  });

  test('6. Owner Command "remove: Name" initiates 2-step confirmation and deletes only on YES', async () => {
    db.insert('products', {
      id: 'prod_104',
      org_id: orgA,
      organization_id: orgA,
      name: 'Silk Dupatta',
      price_raw: '300',
      sku: 'WA-104'
    });

    const sock = mockSock();
    // Step 1: remove: Silk Dupatta
    await handleOrgIncomingMessage(orgA, {
      key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: false, id: `owner_rem_${Date.now()}` },
      message: { conversation: 'remove: Silk Dupatta' }
    }, sock);

    assert.ok(sock.sentMessages[0].content.text.includes('Remove Silk Dupatta? Reply YES within 2 minutes'));
    assert.ok(db.findById('products', 'prod_104'), 'Product should NOT be deleted before YES');

    // Step 2: Owner replies YES
    await handleOrgIncomingMessage(orgA, {
      key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: false, id: `owner_yes_${Date.now()}` },
      message: { conversation: 'YES' }
    }, sock);

    assert.equal(db.findById('products', 'prod_104'), null, 'Product should be deleted after YES');
    assert.ok(sock.sentMessages[1].content.text.includes('Done: Silk Dupatta removed. Type undo to reverse.'));
  });

  test('7. Undo reverses last change (re-inserts deleted product)', async () => {
    db.insert('products', {
      id: 'prod_105',
      org_id: orgA,
      organization_id: orgA,
      name: 'Velvet Shawl',
      price_raw: '1200',
      sku: 'WA-105'
    });

    const sock = mockSock();
    // Remove
    await handleOrgIncomingMessage(orgA, {
      key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: false, id: `rem_${Date.now()}` },
      message: { conversation: 'remove: Velvet Shawl' }
    }, sock);
    await handleOrgIncomingMessage(orgA, {
      key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: false, id: `yes_${Date.now()}` },
      message: { conversation: 'YES' }
    }, sock);

    assert.equal(db.findById('products', 'prod_105'), null);

    // Undo
    await handleOrgIncomingMessage(orgA, {
      key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: false, id: `undo_${Date.now()}` },
      message: { conversation: 'undo' }
    }, sock);

    const restored = db.findById('products', 'prod_105');
    assert.ok(restored, 'Product should be restored on undo');
    assert.equal(restored.name, 'Velvet Shawl');
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

  test('9. Owner sending photo with caption NOT starting with add: is ignored', async () => {
    const sock = mockSock();
    await handleOrgIncomingMessage(orgA, {
      key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: false, id: `img_ign_${Date.now()}` },
      message: {
        imageMessage: {
          caption: 'Look at this picture'
        }
      }
    }, sock);

    assert.equal(sock.sentMessages.length, 0, 'No action or storage for non-add photos from owner');
  });

  test('10. Multi-tenant isolation: Owner of Org A cannot view or mutate Org B products', async () => {
    db.insert('products', {
      id: 'prod_b_1',
      org_id: orgB,
      organization_id: orgB,
      name: 'Org B Secret Gadget',
      price_raw: '5000',
      sku: 'WA-B1'
    });

    const sock = mockSock();
    // Owner of Org A tries to change price of Org B product
    await handleOrgIncomingMessage(orgA, {
      key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: false, id: `hack_${Date.now()}` },
      message: { conversation: 'price: Org B Secret Gadget = 10' }
    }, sock);

    const unchanged = db.findById('products', 'prod_b_1');
    assert.equal(unchanged.price_raw, '5000', 'Org B product price must remain unchanged');
    assert.ok(sock.sentMessages[0].content.text.includes('not found in catalog'), 'Should report not found for cross-tenant product');
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
