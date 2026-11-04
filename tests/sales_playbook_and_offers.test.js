import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('SALES PLAYBOOK & OFFER INTEGRITY: server.js contains negotiation rules and sales playbook', async () => {
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

  // Verify NEGOTIATION & OFFER RULE
  assert.ok(serverJs.includes('NEGOTIATION & OFFER RULE:'), 'Must contain NEGOTIATION & OFFER RULE');
  assert.ok(serverJs.includes('Never reduce a price, invent a discount, or reveal a minimum/floor price on your own'), 'Must contain price floor rule');
  assert.ok(serverJs.includes('If the buyer asks for a discount: stay calm and polite'), 'Must contain discount response rule');
  assert.ok(serverJs.includes('If the buyer pushes a second time, or asks beyond the data\'s slabs'), 'Must contain second push owner alert rule');
  assert.ok(serverJs.includes('Never use fake urgency or false scarcity'), 'Must ban fake urgency');

  // Verify TOP SALES PLAYBOOK
  assert.ok(serverJs.includes('TOP SALES PLAYBOOK (applies to any industry'), 'Must contain TOP SALES PLAYBOOK');
  assert.ok(serverJs.includes('DISCOVER BEFORE YOU PITCH:'), 'Must contain DISCOVER BEFORE YOU PITCH');
  assert.ok(serverJs.includes('BUYING SIGNALS:'), 'Must contain BUYING SIGNALS');
  assert.ok(serverJs.includes('OBJECTIONS (acknowledge first, never argue):'), 'Must contain OBJECTIONS section');
  assert.ok(serverJs.includes('HONESTY RULES:'), 'Must contain HONESTY RULES');
  assert.ok(serverJs.includes('LEAD QUALITY:'), 'Must contain LEAD QUALITY');
  assert.ok(serverJs.includes('INDUSTRY ADAPTATION:'), 'Must contain INDUSTRY ADAPTATION');

  // Verify Offer commands in owner self-chat
  assert.ok(serverJs.includes('/^offer\\s*:\\s*([\\s\\S]+)$/i'), 'Must support offer: <text> command');
  assert.ok(serverJs.includes('/^(?:offer\\s+off|offers\\s+off)$/i'), 'Must support offer off command');
  assert.ok(serverJs.includes('isOfferExpired'), 'Must contain isOfferExpired helper');
});

test('OFFER EXPIRY: compares Valid till date to Asia/Kolkata date', async () => {
  // Test offer expiry calculation logic
  function isOfferExpired(offerLine) {
    if (!/^\s*OFFER:/i.test(offerLine)) return false;
    const match = offerLine.match(/valid\s+(?:till|until|to|through)\s+([a-zA-Z0-9\s,\/\-]+?)(?:\s*[\(\[\.\;\)]|$)/i);
    if (!match) return false;
    const rawDateStr = match[1].trim().replace(/(?:st|nd|rd|th)(?=[\s,])/gi, '');
    
    const kolkataNowStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const kolkataNow = new Date(kolkataNowStr);

    const dmyMatch = rawDateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    let offerExpiryTime = null;
    if (dmyMatch) {
      const day = parseInt(dmyMatch[1], 10);
      const month = parseInt(dmyMatch[2], 10) - 1;
      const year = parseInt(dmyMatch[3], 10);
      offerExpiryTime = new Date(year, month, day, 23, 59, 59, 999).getTime();
    } else {
      const parsed = Date.parse(rawDateStr);
      if (!isNaN(parsed)) {
        const d = new Date(parsed);
        offerExpiryTime = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
      }
    }

    if (offerExpiryTime !== null) {
      return kolkataNow.getTime() > offerExpiryTime;
    }
    return false;
  }

  // An offer expired in 2024 or earlier in November 2026 must be expired
  assert.strictEqual(isOfferExpired('OFFER: 20% flat discount. Valid till 1 Jan 2024'), true);
  assert.strictEqual(isOfferExpired('OFFER: Free delivery on 10+ sets. Valid till 01-11-2026'), true);

  // A future offer must remain active
  assert.strictEqual(isOfferExpired('OFFER: Diwali gift hamper. Valid till 25 Dec 2026'), false);
  assert.strictEqual(isOfferExpired('OFFER: 10% off. Valid till 30-11-2026'), false);

  // Non-offer line must not be expired
  assert.strictEqual(isOfferExpired('Standard factory lead time: 3 business days.'), false);
});
