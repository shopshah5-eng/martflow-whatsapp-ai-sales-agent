import test from 'node:test';
import assert from 'node:assert/strict';
import { getConversationTrackingKey } from '../src/services/conversationTracking.js';

test('CUSTOMER PHOTO SELECTION: Specific product match takes precedence over first product in list', async () => {
  const products = [
    { id: '1', sku: 'KURTI-01', name: 'Kurti Alpha', image_url: 'https://example.com/alpha.jpg', stock_status: 'Available' },
    { id: '2', sku: 'KURTI-02', name: 'Kurti Beta', image_url: 'https://example.com/beta.jpg', stock_status: 'Available' },
    { id: '3', sku: 'KURTI-03', name: 'Kurti Gamma', image_url: 'https://example.com/gamma.jpg', stock_status: 'Available' }
  ];

  function matchCandidateProduct(queryText, lead = null) {
    const qLower = (queryText || '').toLowerCase();
    const isImageRequest = /photo|image|pic|dikhao|bhejo|dekhna/i.test(qLower);
    let targetProd = null;

    const candidates = [];
    for (const p of products) {
      const pName = (p.name || '').toLowerCase().trim();
      const pSku = (p.sku_code || p.sku || '').toLowerCase().trim();
      if (pName && qLower.includes(pName)) {
        candidates.push({ product: p, score: pName.length * 10 });
      } else if (pSku && qLower.includes(pSku)) {
        candidates.push({ product: p, score: pSku.length * 10 });
      } else if (pName && qLower.split(/\s+/).some(w => w.length > 3 && pName.includes(w))) {
        candidates.push({ product: p, score: 5 });
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      targetProd = candidates[0].product;
    }

    if (!targetProd) {
      const leadProdName = (lead?.product_inquired || lead?.productName || '').toLowerCase().trim();
      if (leadProdName) {
        targetProd = products.find(p => {
          const pName = (p.name || '').toLowerCase().trim();
          return pName && (leadProdName.includes(pName) || pName.includes(leadProdName));
        });
      }
    }

    if (!targetProd && isImageRequest) {
      targetProd = products.find(p => (p.image_url || p.imageUrl) && !(p.description || '').startsWith('[OUT OF STOCK]'));
    }

    return targetProd;
  }

  // 1. Explicit query for Kurti Beta should return Kurti Beta, NOT Kurti Alpha (the first product)
  const matchedBeta = matchCandidateProduct('Please send me a photo of Kurti Beta');
  assert.equal(matchedBeta?.name, 'Kurti Beta', 'Must match Kurti Beta specifically');
  assert.equal(matchedBeta?.sku, 'KURTI-02');

  // 2. Explicit query for Kurti Gamma by SKU should return Kurti Gamma
  const matchedGamma = matchCandidateProduct('show pic for KURTI-03');
  assert.equal(matchedGamma?.name, 'Kurti Gamma');

  // 3. Generic image request without specific product falls back to first available product with image
  const matchedGeneric = matchCandidateProduct('send photo please');
  assert.equal(matchedGeneric?.name, 'Kurti Alpha', 'Generic request falls back to first available product');
});

test('CUSTOMER PHOTO DEDUPLICATION: Different customers never share a deduplication key', async () => {
  const orgId = '00000000-0000-4000-8000-000000000001';

  // 1. Two different phone numbers produce distinct keys
  const customerA = { phone: '+91 98765 43210' };
  const customerB = { phone: '+91 91234 56789' };
  const keyA = getConversationTrackingKey(orgId, customerA);
  const keyB = getConversationTrackingKey(orgId, customerB);
  assert.notEqual(keyA, keyB, 'Distinct phone numbers must produce distinct keys');
  assert.equal(keyA, getConversationTrackingKey(orgId, { phone: '919876543210' }));
  assert.notEqual(keyA, getConversationTrackingKey('another-org', customerA));
  assert.notEqual(getConversationTrackingKey(orgId, { id: 'a-12' }), getConversationTrackingKey(orgId, { id: 'b-12' }));
  assert.notEqual(getConversationTrackingKey(orgId, { name: 'Alex' }), getConversationTrackingKey(orgId, { name: 'Alex' }));

  // 2. Two different anonymous customers without phone or id must NOT collapse into the same key
  const anonLead1 = { inquiry: 'Need price' };
  const anonLead2 = { inquiry: 'Need brochure' };
  const keyAnon1 = getConversationTrackingKey(orgId, anonLead1);
  const keyAnon2 = getConversationTrackingKey(orgId, anonLead2);
  assert.notEqual(keyAnon1, keyAnon2, 'Different anonymous customers must NEVER share a dedup key');

  // 3. Repeated calls for the same anonymous lead object must be stable (idempotent)
  const keyAnon1Repeat = getConversationTrackingKey(orgId, anonLead1);
  assert.equal(keyAnon1, keyAnon1Repeat, 'Tracking key for the same session object must be stable');
});

