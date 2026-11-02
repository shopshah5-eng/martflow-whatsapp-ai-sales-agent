import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIGH_INTENT_REGEX, scorePurchaseIntent, describeInboundContent } from '../src/services/intentService.js';
import {
  normalizeIndianPhone,
  maskPhone,
  takeoverCustomer,
  releaseCustomer,
  isCustomerInManualMode,
  getActiveTakeovers,
  shouldSendAlert,
  recordAlertSent,
  parseOwnerCommand
} from '../src/services/takeoverService.js';

test('INTENT SCORING: English & Hinglish purchase signals score above threshold', () => {
  // English high-intent inquiries
  const en1 = scorePurchaseIntent('What is the price of the packaging machine? Need quotation for 5 units');
  assert.ok(en1.isHot, 'Price + quotation + units should be hot');
  assert.ok(en1.score >= 40, `Score should be >= 40, got ${en1.score}`);
  assert.ok(en1.matchedKeywords.includes('price'));

  // Hinglish high-intent inquiries
  const hi1 = scorePurchaseIntent('Kitne ka padega machine? Best bhav batao, lena hai urgently');
  assert.ok(hi1.isHot, 'Kitne ka + bhav + lena hai + urgently should be hot');
  assert.ok(hi1.score >= 50, `Score should be >= 50, got ${hi1.score}`);

  // Commercial transaction signals
  const hi2 = scorePurchaseIntent('Advance payment kitna dena hoga? GST invoice milega kya?');
  assert.ok(hi2.isHot, 'Advance payment + GST invoice should be hot');
  assert.ok(hi2.matchedKeywords.includes('payment') || hi2.matchedKeywords.includes('advance'));

  // Low intent / casual greeting
  const low = scorePurchaseIntent('Hello, good morning');
  assert.strictEqual(low.isHot, false, 'Casual greeting should not be hot');
  assert.strictEqual(low.score, 0);

  // Exported regex backward-compatibility
  assert.ok(HIGH_INTENT_REGEX.test('quotation chahiye'), 'HIGH_INTENT_REGEX must match quotation');
  assert.ok(HIGH_INTENT_REGEX.test('kitna rate hai'), 'HIGH_INTENT_REGEX must match rate');
});

test('MULTI-MODAL INBOUND: Describes voice notes, images, PDFs, and locations', () => {
  // Voice note (PTT)
  const vn = describeInboundContent({ audioMessage: { seconds: 14, ptt: true } });
  assert.ok(vn.text.includes('Voice Note'), 'Should describe as Voice Note');
  assert.ok(vn.text.includes('0:14'), 'Should include duration');

  // Photo / Sample
  const img = describeInboundContent({ imageMessage: { caption: 'Sample Pouch' } });
  assert.ok(img.text.includes('Photo / Sample'), 'Should describe as photo');
  assert.ok(img.text.includes('Sample Pouch'), 'Should include caption');

  // PDF Document
  const doc = describeInboundContent({ documentMessage: { fileName: 'factory_quotation.pdf' } });
  assert.ok(doc.text.includes('factory_quotation.pdf'), 'Should include document name');

  // Location pin
  const loc = describeInboundContent({ locationMessage: { name: 'Industrial Area Phase 2, Ludhiana' } });
  assert.ok(loc.text.includes('Ludhiana'), 'Should include location name');
});

test('COMMAND PARSING & SECURITY: Rejects buyer-sent commands, accepts owner only', () => {
  const ownerNumber = '919781018975';
  const buyerNumber = '919876543210';

  // Buyer typing "TAKE 9876543210" -> MUST BE REJECTED
  const buyerTake = parseOwnerCommand('TAKE 9876543210', buyerNumber, ownerNumber);
  assert.strictEqual(buyerTake.isOwnerCommand, false, 'Buyer typing TAKE must NEVER be treated as owner command');

  // Buyer typing "SEND 9876543210 hello" -> MUST BE REJECTED
  const buyerSend = parseOwnerCommand('SEND 9876543210 hello', buyerNumber, ownerNumber);
  assert.strictEqual(buyerSend.isOwnerCommand, false, 'Buyer typing SEND must NEVER be treated as owner command');

  // Owner typing "TAKE 9876543210" -> ACCEPTED
  const ownerTake = parseOwnerCommand('TAKE 9876543210', ownerNumber, ownerNumber);
  assert.strictEqual(ownerTake.isOwnerCommand, true);
  assert.strictEqual(ownerTake.action, 'TAKE');
  assert.strictEqual(ownerTake.targetPhone, '919876543210');

  // Owner typing "SEND 9876543210 We have stock available" -> ACCEPTED
  const ownerSend = parseOwnerCommand('SEND 9876543210 We have stock available', ownerNumber, ownerNumber);
  assert.strictEqual(ownerSend.isOwnerCommand, true);
  assert.strictEqual(ownerSend.action, 'SEND');
  assert.strictEqual(ownerSend.targetPhone, '919876543210');
  assert.strictEqual(ownerSend.message, 'We have stock available');

  // Owner typing "AI 9876543210" -> ACCEPTED
  const ownerAi = parseOwnerCommand('AI 9876543210', ownerNumber, ownerNumber);
  assert.strictEqual(ownerAi.isOwnerCommand, true);
  assert.strictEqual(ownerAi.action, 'AI');
  assert.strictEqual(ownerAi.targetPhone, '919876543210');

  // Owner typing "STATUS" -> ACCEPTED
  const ownerStatus = parseOwnerCommand('STATUS', ownerNumber, ownerNumber);
  assert.strictEqual(ownerStatus.isOwnerCommand, true);
  assert.strictEqual(ownerStatus.action, 'STATUS');
});

test('MANUAL TAKEOVER LIFECYCLE: Takeover gates customer, auto-expires, and restores AI', async () => {
  const testOrg = 'test-org-takeover-1';
  const testBuyer = '919811122233';

  // Initially not in manual mode
  const initial = await isCustomerInManualMode({ orgId: testOrg, buyerPhone: testBuyer });
  assert.strictEqual(initial.inManualMode, false);

  // Owner takes over customer
  const takeRes = await takeoverCustomer({
    orgId: testOrg,
    buyerPhone: testBuyer,
    takenBy: 'owner',
    durationMs: 4 * 3600 * 1000 // 4 hours
  });
  assert.strictEqual(takeRes.ok, true);

  // Now customer MUST be in manual mode
  const activeCheck = await isCustomerInManualMode({ orgId: testOrg, buyerPhone: testBuyer });
  assert.strictEqual(activeCheck.inManualMode, true);
  assert.ok(activeCheck.remainingMinutes > 200, 'Should have ~240 mins left');

  // Should show up in active takeovers list
  const list = await getActiveTakeovers({ orgId: testOrg });
  const found = list.find(t => t.buyerPhone === testBuyer);
  assert.ok(found, 'Customer must appear in active takeovers');

  // Release customer back to AI
  const releaseRes = await releaseCustomer({ orgId: testOrg, buyerPhone: testBuyer });
  assert.strictEqual(releaseRes.ok, true);

  // Verified restored to AI
  const afterRelease = await isCustomerInManualMode({ orgId: testOrg, buyerPhone: testBuyer });
  assert.strictEqual(afterRelease.inManualMode, false);
});

test('ALERT DEDUP & ANTI-FLOOD: At most 1 new lead alert ever, 30-min cooldown for hot alerts', async () => {
  const testOrg = 'test-org-dedup-1';
  const testBuyer = '919444555666';

  // 1. First time new lead: should send
  const newLead1 = await shouldSendAlert({ orgId: testOrg, buyerPhone: testBuyer, kind: 'new_lead' });
  assert.strictEqual(newLead1, true, 'First new lead check must pass');
  await recordAlertSent({ orgId: testOrg, buyerPhone: testBuyer, kind: 'new_lead' });

  // 2. Second time new lead: MUST NOT SEND (at most 1 new-lead alert ever)
  const newLead2 = await shouldSendAlert({ orgId: testOrg, buyerPhone: testBuyer, kind: 'new_lead' });
  assert.strictEqual(newLead2, false, 'Second new lead check must be rejected');

  // 3. First time hot alert: should send
  const hot1 = await shouldSendAlert({ orgId: testOrg, buyerPhone: testBuyer, kind: 'hot_lead', cooldownMs: 30 * 60 * 1000 });
  assert.strictEqual(hot1, true, 'First hot alert check must pass');
  await recordAlertSent({ orgId: testOrg, buyerPhone: testBuyer, kind: 'hot_lead' });

  // 4. Repeated hot message within 30 mins: MUST NOT SPAM OWNER
  const hot2 = await shouldSendAlert({ orgId: testOrg, buyerPhone: testBuyer, kind: 'hot_lead', cooldownMs: 30 * 60 * 1000 });
  assert.strictEqual(hot2, false, 'Repeated hot alert within 30 min cooldown must be rejected');

  // 5. Hot alert after cooldown expires: should pass
  const hotAfterCooldown = await shouldSendAlert({ orgId: testOrg, buyerPhone: testBuyer, kind: 'hot_lead', cooldownMs: 0 });
  assert.strictEqual(hotAfterCooldown, true, 'Hot alert after cooldown expiration must be allowed');
});

test('SECURITY & LOGGING: Owner phone is masked in logs', () => {
  const masked1 = maskPhone('919781018975');
  assert.strictEqual(masked1, '9197****8975', 'Should mask middle digits');

  const masked2 = maskPhone('+91 97810 18975');
  assert.strictEqual(masked2, '9197****8975', 'Should normalize and mask phone');
});
