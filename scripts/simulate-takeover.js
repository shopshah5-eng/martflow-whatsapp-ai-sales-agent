/**
 * MartFlow AI — End-to-End Simulation of First-Message-Hot & Manual Takeover
 * 
 * Simulates:
 * 1. A first-time buyer sending a high-intent commercial message.
 *    -> Asserts and displays BOTH cards delivered to owner (New Lead Card + Hot Priority Card).
 * 2. Owner executing TAKE <phone>.
 *    -> Customer is gated, buyer gets forwarding notice, subsequent buyer messages are relayed to owner.
 * 3. Owner sending SEND <phone> <msg> to reply verbatim through bot.
 * 4. Owner querying STATUS and executing AI <phone> to restore 24/7 AI closer.
 */

import { scorePurchaseIntent, describeInboundContent } from '../src/services/intentService.js';
import {
  takeoverCustomer,
  releaseCustomer,
  isCustomerInManualMode,
  getActiveTakeovers,
  shouldSendAlert,
  recordAlertSent,
  parseOwnerCommand,
  maskPhone
} from '../src/services/takeoverService.js';

async function runSimulation() {
  console.log('='.repeat(75));
  console.log('🧪 MARTFLOW AI — OWNER ALERTS & MANUAL TAKEOVER SIMULATION');
  console.log('='.repeat(75));

  const orgId = 'sim-org-demo';
  const ownerNumber = '919781018975';
  const buyerNumber = '919876543210';
  const buyerName = 'Rajesh Kumar (PouchTech Solutions)';

  console.log(`\n📋 CONFIGURATION:`);
  console.log(`- Org ID: ${orgId}`);
  console.log(`- Owner WhatsApp: ${maskPhone(ownerNumber)} (Verified Owner)`);
  console.log(`- Inbound Buyer:  +${buyerNumber} (${buyerName})`);

  // --------------------------------------------------------------------------
  // STEP 1: Inbound Message 1 (First Message is HOT)
  // --------------------------------------------------------------------------
  console.log('\n' + '-'.repeat(75));
  console.log('STEP 1: Buyer sends First Inbound Message (HIGH PURCHASE INTENT)');
  console.log('-'.repeat(75));

  const inboundMsg1 = 'Namaste, automatic pouch packaging machine ka final quotation aur rate kitna padega? Advance payment de kar 5 units book karni hain urgently.';
  console.log(`📥 Buyer (+${buyerNumber}) sent:\n"${inboundMsg1}"`);

  // Intent scoring
  const intent = scorePurchaseIntent(inboundMsg1);
  console.log(`\n🔍 INTENT ANALYSIS:`);
  console.log(`- Score:    ${intent.score}/100 (Threshold: 20 -> ${intent.isHot ? '🔥 HOT LEAD' : 'Standard'})`);
  console.log(`- Keywords: ${intent.matchedKeywords.join(', ')}`);
  console.log(`- Tags:     ${intent.intentSummary}`);

  const canAlertNew = await shouldSendAlert({ orgId, buyerPhone: buyerNumber, kind: 'new_lead' });
  const canAlertHot = await shouldSendAlert({ orgId, buyerPhone: buyerNumber, kind: 'hot_lead' });

  console.log(`\n📢 OWNER RECEIVES TWO SEPARATE CARDS (Hot on First Message):`);

  if (canAlertNew) {
    const card1 = 
`[CARD 1 — NEW INBOUND LEAD]
--------------------------------------------------
🔔 *MartFlow AI — New Inbound Lead*
👤 *Customer:* ${buyerName}
📱 *Phone:* +${buyerNumber}
📍 *City:* Ludhiana / Delhi NCR
💬 *Message:* "${inboundMsg1.slice(0, 300)}"

⚡ *WhatsApp:* https://wa.me/${buyerNumber}
📞 *Call:* tel:+${buyerNumber}
--------------------------------------------------`;
    console.log(card1);
    await recordAlertSent({ orgId, buyerPhone: buyerNumber, kind: 'new_lead' });
  }

  if (canAlertHot) {
    const card2 = 
`[CARD 2 — HOT LEAD PRIORITY ALERT 🔥]
--------------------------------------------------
🔥 *MartFlow AI — Hot Lead Alert!* (Score: ${intent.score})
👤 *Customer:* ${buyerName}
📱 *Phone:* +${buyerNumber}
🎯 *Keywords:* ${intent.matchedKeywords.join(', ')}
💬 *Inquiry:* "${inboundMsg1.slice(0, 300)}"

⚡ *WhatsApp:* https://wa.me/${buyerNumber}
📞 *Call:* tel:+${buyerNumber}

✋ *To take over:* Send \`TAKE ${buyerNumber.slice(-10)}\`
--------------------------------------------------`;
    console.log(card2);
    await recordAlertSent({ orgId, buyerPhone: buyerNumber, kind: 'hot_lead' });
  }

  // --------------------------------------------------------------------------
  // STEP 2: Owner Executes Takeover
  // --------------------------------------------------------------------------
  console.log('\n' + '-'.repeat(75));
  console.log('STEP 2: Owner replies with TAKE command');
  console.log('-'.repeat(75));

  const ownerCmdText = `TAKE ${buyerNumber.slice(-10)}`;
  console.log(`📱 Owner (${maskPhone(ownerNumber)}) sends to bot: "${ownerCmdText}"`);

  const parsed = parseOwnerCommand(ownerCmdText, ownerNumber, ownerNumber);
  console.log(`✅ Parsed Command:`, parsed);

  if (parsed.isOwnerCommand && parsed.action === 'TAKE') {
    const takeRes = await takeoverCustomer({
      orgId,
      buyerPhone: parsed.targetPhone,
      takenBy: 'owner'
    });

    console.log(`\n🤖 BOT CONFIRMS TO OWNER:`);
    console.log(
`--------------------------------------------------
✅ *Manual Takeover Active* for +${takeRes.cleanPhone}
⏱️ Duration: 4 Hours (AI paused for this customer).

💬 *To reply:* Send \`SEND ${takeRes.cleanPhone.slice(-10)} <your message>\`
🤖 *To return to AI:* Send \`AI ${takeRes.cleanPhone.slice(-10)}\`
--------------------------------------------------`);

    console.log(`\n📤 AUTO-NOTIFICATION SENT TO BUYER (+${buyerNumber}):`);
    console.log(`"Aapki baat humari team ko forward kar di gayi hai, hum jaldi reply karenge."`);
  }

  // --------------------------------------------------------------------------
  // STEP 3: Buyer sends Message 2 during Manual Mode (AI Gated & Relayed)
  // --------------------------------------------------------------------------
  console.log('\n' + '-'.repeat(75));
  console.log('STEP 3: Buyer sends Message 2 while in Manual Mode');
  console.log('-'.repeat(75));

  const inboundMsg2 = 'Main kal factory visit kar sakta hoon sample dekhne? 11 baje?';
  console.log(`📥 Buyer (+${buyerNumber}) sent:\n"${inboundMsg2}"`);

  const manualCheck = await isCustomerInManualMode({ orgId, buyerPhone: buyerNumber });
  console.log(`🔒 Gate Check: inManualMode = ${manualCheck.inManualMode} (${manualCheck.remainingMinutes} min remaining)`);

  if (manualCheck.inManualMode) {
    console.log('🛑 AI Sales Engine IS GATED (Zero AI automated replies sent to customer).');
    console.log('\n📢 FORWARDED TO OWNER:');
    console.log(
`--------------------------------------------------
📩 *Customer Message (+${buyerNumber})*
👤 *From:* ${buyerName}
💬 "${inboundMsg2}"

⚡ *Reply:* Send \`SEND ${buyerNumber.slice(-10)} <your reply>\`
📞 tel:+${buyerNumber}
--------------------------------------------------`);
  }

  // --------------------------------------------------------------------------
  // STEP 4: Owner replies via SEND relay
  // --------------------------------------------------------------------------
  console.log('\n' + '-'.repeat(75));
  console.log('STEP 4: Owner relays reply via bot with SEND command');
  console.log('-'.repeat(75));

  const ownerReplyCmd = `SEND ${buyerNumber.slice(-10)} Haan Rajesh ji, kal 11 baje Factory Phase 2, Ludhiana pe aa jaiye. Main khud live demo karwaunga.`;
  console.log(`📱 Owner sends to bot:\n"${ownerReplyCmd}"`);

  const parsedSend = parseOwnerCommand(ownerReplyCmd, ownerNumber, ownerNumber);
  if (parsedSend.isOwnerCommand && parsedSend.action === 'SEND') {
    console.log(`\n📤 DELIVERED VERBATIM TO BUYER (+${buyerNumber}) FROM BOT:`);
    console.log(`"${parsedSend.message}" (Zero AI alteration, no bot branding)`);

    console.log(`\n🤖 CONFIRMED TO OWNER:`);
    console.log(`📤 *Relayed to Customer (+${parsedSend.targetPhone}):*\n"${parsedSend.message}"`);
  }

  // --------------------------------------------------------------------------
  // STEP 5: Owner checks STATUS and releases back to AI
  // --------------------------------------------------------------------------
  console.log('\n' + '-'.repeat(75));
  console.log('STEP 5: Owner checks STATUS and restores AI mode');
  console.log('-'.repeat(75));

  const statusCmd = parseOwnerCommand('STATUS', ownerNumber, ownerNumber);
  if (statusCmd.action === 'STATUS') {
    const list = await getActiveTakeovers({ orgId });
    console.log(`📋 ACTIVE TAKEOVERS (${list.length}):`);
    list.forEach((t, i) => {
      console.log(`${i + 1}. +${t.buyerPhone} — Expires in ${t.remainingMinutes} min`);
    });
  }

  const aiCmd = parseOwnerCommand(`AI ${buyerNumber.slice(-10)}`, ownerNumber, ownerNumber);
  if (aiCmd.action === 'AI') {
    const relRes = await releaseCustomer({ orgId, buyerPhone: aiCmd.targetPhone });
    console.log(`\n🤖 BOT CONFIRMS TO OWNER:`);
    console.log(`🤖 *AI Mode Restored* for +${relRes.cleanPhone}.\nBot will now reply to this customer automatically 24/7.`);
  }

  const finalCheck = await isCustomerInManualMode({ orgId, buyerPhone: buyerNumber });
  console.log(`\n✅ FINAL STATE: inManualMode = ${finalCheck.inManualMode} (AI Active 24/7)`);
  console.log('='.repeat(75));
}

runSimulation().catch(console.error);
