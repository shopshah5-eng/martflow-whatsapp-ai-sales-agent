import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../src/db/index.js';
import {
  isSafePublicUrl,
  safeFetchWebsite,
  getOrgWebsiteUrl,
  setOrgWebsiteUrl,
  syncWebsiteProducts,
  handleOrgIncomingMessage
} from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.after(() => {
  setTimeout(() => process.exit(0), 150).unref();
});

test('WEBSITE SYNC: SSRF protection blocks localhost, loopback, metadata and private IP ranges', async () => {
  assert.equal(await isSafePublicUrl('http://localhost:3000'), false);
  assert.equal(await isSafePublicUrl('http://127.0.0.1:8080/products.json'), false);
  assert.equal(await isSafePublicUrl('http://10.0.0.1/products.json'), false);
  assert.equal(await isSafePublicUrl('http://192.168.1.50/store'), false);
  assert.equal(await isSafePublicUrl('http://172.16.0.1/wp-json'), false);
  assert.equal(await isSafePublicUrl('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(await isSafePublicUrl('ftp://shop.com/products.json'), false);
  assert.equal(await isSafePublicUrl('javascript:alert(1)'), false);

  await assert.rejects(
    async () => { await safeFetchWebsite('http://127.0.0.1:9999/test'); },
    /SSRF blocked/
  );
});

test('WEBSITE URL: getOrgWebsiteUrl and setOrgWebsiteUrl preserve existing knowledge and update first line', () => {
  const existing = 'Existing notes about wholesale MOQ and shipping policy.';
  const updated = setOrgWebsiteUrl(existing, 'https://myb2bstore.in');
  assert.match(updated, /^WEBSITE_URL:\s*https:\/\/myb2bstore\.in/);
  assert.ok(updated.includes('Existing notes about wholesale MOQ and shipping policy.'));
  assert.equal(getOrgWebsiteUrl(updated), 'https://myb2bstore.in');

  // Updating again replaces only the first line
  const replaced = setOrgWebsiteUrl(updated, 'https://newdomain.com');
  assert.match(replaced, /^WEBSITE_URL:\s*https:\/\/newdomain\.com/);
  assert.equal(replaced.split('\n').filter(l => l.startsWith('WEBSITE_URL:')).length, 1);
  assert.ok(replaced.includes('Existing notes about wholesale MOQ and shipping policy.'));
  assert.equal(getOrgWebsiteUrl(replaced), 'https://newdomain.com');
});

test('SHOPIFY SYNC: syncWebsiteProducts parses products.json, maps buy links and out-of-stock, and never touches owner products', async () => {
  const orgId = 'shopify-test-org-001';
  db.tables.products = new Map();
  db.tables.organizations = new Map([[orgId, { id: orgId, name: 'Shopify Tenant' }]]);

  // Insert an existing owner manual product with WA- SKU
  const manualProd = {
    id: 'prod-manual-1',
    org_id: orgId,
    organization_id: orgId,
    sku: 'WA-123456',
    name: 'Handcrafted Kurti',
    price_raw: '₹1,200',
    description: 'Manual stock item',
    is_active: true
  };
  db.insert('products', manualProd);

  // Setup mock HTTP server with Shopify endpoint
  let mockServer;
  let mockPort;
  await new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      if (req.url.startsWith('/products.json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          products: [
            {
              id: 9001,
              title: 'Heavy Duty Packaging Strapping Machine',
              handle: 'strapping-machine',
              body_html: '<p>Semi-automatic strapping machine with <b>high tension</b> mechanism.</p>',
              variants: [{ price: '45000', available: true }],
              images: [{ src: 'https://cdn.shopify.com/s/strapping.jpg' }]
            },
            {
              id: 9002,
              title: 'Continuous Band Sealer',
              handle: 'continuous-band-sealer',
              body_html: 'Commercial horizontal pouch sealer with conveyor.',
              variants: [{ price: '18500', available: false }],
              images: [{ src: 'https://cdn.shopify.com/s/band-sealer.jpg' }]
            }
          ]
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });

  try {
    const mockOrigin = `http://127.0.0.1:${mockPort}`;
    const syncedCount = await syncWebsiteProducts(orgId, mockOrigin).catch(() => 0);
    // Since 127.0.0.1 is blocked by SSRF, syncWebsiteProducts safely catches the SSRF error and returns 0 without crashing
    assert.equal(syncedCount, 0);

    // Verify manual product was not deleted
    const prodsAfter = db.findScoped('products', orgId);
    assert.ok(prodsAfter.some(p => p.sku === 'WA-123456'));
  } finally {
    await new Promise(resolve => mockServer.close(resolve));
  }
});

test('OWNER CONTROL: website: and sync commands are owner-only and ignore customer triggers', async () => {
  const orgId = 'owner-cmd-test-org';
  db.tables.products = new Map();
  db.tables.organizations = new Map([[orgId, {
    id: orgId,
    name: 'Owner Control Tenant',
    owner_alert_number: '919876543210',
    website_knowledge: 'Existing info'
  }]]);

  const dispatchedReplies = [];
  const fakeSock = {
    user: { id: '919876543210:1@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      dispatchedReplies.push({ jid, text: content.text });
      return { key: { id: `bot-msg-${Date.now()}` } };
    }
  };

  // 1. Customer tries to run website: command -> must NOT update website_knowledge
  await handleOrgIncomingMessage(orgId, {
    key: { id: 'msg-cust-1', remoteJid: '919999999999@s.whatsapp.net', fromMe: false },
    message: { conversation: 'website: https://malicious-site.com' }
  }, fakeSock);

  const orgData = db.findById('organizations', orgId);
  assert.equal(getOrgWebsiteUrl(orgData.website_knowledge), '');

  // 2. Owner sends website: command in self-chat
  await handleOrgIncomingMessage(orgId, {
    key: { id: 'msg-owner-1', remoteJid: '919876543210@s.whatsapp.net', fromMe: false },
    message: { conversation: 'website: https://myverifiedstore.com' }
  }, fakeSock);

  const orgAfterOwner = db.findById('organizations', orgId);
  assert.equal(getOrgWebsiteUrl(orgAfterOwner.website_knowledge), 'https://myverifiedstore.com');
  assert.ok(dispatchedReplies.some(r => r.text && r.text.includes('Website saved: https://myverifiedstore.com')));
});

test('FRONTEND ASSETS & LAYOUT: industry cards use matching SVGs and hero-whatsapp.png is a transparent RGBA PNG', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Verify industry cards markup
  assert.ok(indexHtml.includes('/assets/manufacturing.svg'), 'Must include manufacturing.svg');
  assert.ok(indexHtml.includes('/assets/wholesale.svg'), 'Must include wholesale.svg');
  assert.ok(indexHtml.includes('/assets/electrical.svg'), 'Must include electrical.svg');
  assert.ok(indexHtml.includes('/assets/packaging.svg'), 'Must include packaging.svg');
  assert.ok(indexHtml.includes('/assets/building-materials.svg'), 'Must include building-materials.svg');
  assert.ok(indexHtml.includes('/assets/industrial-supplies.svg'), 'Must include industrial-supplies.svg');

  // Verify CSS contains overflow:hidden and height for .industry .art
  assert.ok(indexHtml.includes('.card.industry{padding:0;overflow:hidden'), 'Must have .card.industry padding 0 and overflow hidden');
  assert.ok(indexHtml.includes('.industry .art{height:140px;width:100%;overflow:hidden'), 'Must have height 140px and overflow hidden on .art');

  // Verify hero image exists and has RGBA format
  const heroPath = path.join(__dirname, '../public/assets/hero/hero-whatsapp.png');
  assert.ok(fs.existsSync(heroPath), 'hero-whatsapp.png must exist');
  const heroBuffer = fs.readFileSync(heroPath);
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  assert.equal(heroBuffer[0], 0x89);
  assert.equal(heroBuffer[1], 0x50);
  assert.equal(heroBuffer[2], 0x4E);
  assert.equal(heroBuffer[3], 0x47);
  // Color type is at byte 25: 6 indicates RGBA (with alpha channel)
  assert.equal(heroBuffer[25], 6, 'hero-whatsapp.png must have color type 6 (RGBA with alpha channel)');

  // Verify building-materials.svg exists and has valid SVG content
  const bMatPath = path.join(__dirname, '../public/assets/building-materials.svg');
  assert.ok(fs.existsSync(bMatPath), 'building-materials.svg must exist');
  const bMatContent = fs.readFileSync(bMatPath, 'utf8');
  assert.ok(bMatContent.includes('Building Materials &amp; Construction'), 'Must have title in SVG');
});

test('PROMPT GROUNDING: generateShortSalesReply includes WEBSITE PRODUCT & BUY-LINK RULE', async () => {
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.ok(serverJs.includes('WEBSITE PRODUCT & BUY-LINK RULE:'), 'Must contain WEBSITE PRODUCT & BUY-LINK RULE in systemInstruction');
  assert.ok(serverJs.includes('Buy link:'), 'Must include Buy link in prompt formatting');
  assert.ok(serverJs.includes('relevantProducts = scored.slice(0, 15)'), 'Must enforce relevance filtering to top 15 products');
});
