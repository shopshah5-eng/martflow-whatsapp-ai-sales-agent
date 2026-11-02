/**
 * MartFlow AI — Purchase Intent Scoring & Inbound Content Formatter
 * 
 * Single source of truth for high-intent purchase detection, scoring,
 * and inbound multi-modal message description (voice notes, images, PDFs, locations).
 */

// Single source of truth boolean regex for high purchase intent (English + Hinglish)
export const HIGH_INTENT_REGEX = /\b(price|pricing|cost|rate|kitna|kitne|kitne\s+ka|bhav|daam|pilot|buy|purchase|kharidna|lena\s+hai|chahiye|pay|payment|upi|gpay|phonepe|advance|token|call|contact|talk|baat\s+karni|call\s+karo|demo|meet|meeting|appointment|agency|white-label|whitelabel|partner|book|booking|order|quote|quotation|urgent|jaldi|turant|kab\s+tak|deal|invoice|gst|bill|discount|chhoot|bulk|wholesale|dealer|distributor|dispatch|delivery|sample|specs|specification|model|capacity|speed|units?|pcs?|pieces?)\b/i;

// Weighted intent token dictionary for scoring (English + Hinglish)
const INTENT_WEIGHTS = [
  // High-value commitment / transaction (30 pts)
  { regex: /\b(pay|payment|advance|token|upi|gpay|phonepe|gst|bill|invoice|bank\s*transfer|cheque)\b/i, weight: 30, tag: 'payment_terms' },
  { regex: /\b(buy|purchase|kharidna|lena\s+hai|deal\s+done|book\s+karo|order\s+karna)\b/i, weight: 30, tag: 'purchase_intent' },
  
  // Commercial pricing & quotation (25 pts)
  { regex: /\b(price|pricing|cost|rate|quotation|quote|kitna\s+hoga|kitne\s+ka|bhav|daam|discount|chhoot|final\s+rate|best\s+price)\b/i, weight: 25, tag: 'pricing_quote' },
  
  // Urgent delivery / timeline (25 pts)
  { regex: /\b(urgent|urgently|turant|jaldi|ready\s+stock|dispatch|delivery|kab\s+tak|delivery\s+time|deliver\s+date|immediate)\b/i, weight: 25, tag: 'urgent_timeline' },
  
  // Direct human discussion / visit / call (20 pts)
  { regex: /\b(call\s*me|call\s*karo|phone\s*karo|baat\s*karni|director|owner|meeting|visit|factory\s*visit|appointment|discuss)\b/i, weight: 20, tag: 'call_meeting' },
  
  // Volume & Wholesale / Dealer (20 pts)
  { regex: /\b(bulk|wholesale|dealer|distributor|dealership|agency|reseller|white-?label|multiple\s+units?)\b/i, weight: 20, tag: 'bulk_wholesale' },
  
  // Quantity specs & sample evaluation (15 pts)
  { regex: /\b(\d+\s*(?:pcs|pieces|units|sets|machines|bottles|pouches|kg|ton))\b/i, weight: 15, tag: 'quantity_specified' },
  { regex: /\b(sample|trial|demo|testing|test\s+run|catalogue|catalog|brochure|specs|specification|model)\b/i, weight: 15, tag: 'specs_sample' },

  // General requirement signals (10 pts)
  { regex: /\b(chahiye|requirement|interested|looking\s+for|need|want)\b/i, weight: 10, tag: 'general_intent' }
];

/**
 * Score purchase intent from message text
 * @param {string} text 
 * @param {number} threshold - Default score threshold to qualify as "hot" (default: 20)
 * @returns {{ score: number, isHot: boolean, matchedKeywords: string[], intentSummary: string }}
 */
export function scorePurchaseIntent(text, threshold = 20) {
  if (!text || typeof text !== 'string') {
    return { score: 0, isHot: false, matchedKeywords: [], intentSummary: '' };
  }

  const clean = text.trim();
  if (!clean) {
    return { score: 0, isHot: false, matchedKeywords: [], intentSummary: '' };
  }

  let totalScore = 0;
  const matchedKeywords = [];
  const tags = new Set();

  for (const item of INTENT_WEIGHTS) {
    const match = clean.match(item.regex);
    if (match) {
      totalScore += item.weight;
      matchedKeywords.push(match[0].toLowerCase());
      tags.add(item.tag);
    }
  }

  // Bonus: If message contains both a price question AND quantity/urgency, boost score
  if (tags.has('pricing_quote') && (tags.has('quantity_specified') || tags.has('urgent_timeline'))) {
    totalScore += 15;
  }

  const uniqueKeywords = Array.from(new Set(matchedKeywords));
  const isHot = totalScore >= threshold || HIGH_INTENT_REGEX.test(clean);

  return {
    score: totalScore,
    isHot,
    matchedKeywords: uniqueKeywords,
    intentSummary: Array.from(tags).join(', ') || (isHot ? 'keyword_match' : 'general')
  };
}

/**
 * Describe non-text inbound content (Voice Notes, Images, PDFs, Location, Contact)
 * @param {object} content - Baileys message content or wrapped object
 * @param {string} text - Plain text if any
 * @returns {{ text: string, isMedia: boolean, mediaType: string }}
 */
export function describeInboundContent(content, text = '') {
  if (text && text.trim()) {
    return { text: text.trim(), isMedia: false, mediaType: 'text' };
  }

  if (!content) {
    return { text: '[Empty Message]', isMedia: false, mediaType: 'none' };
  }

  // 1. Audio / Voice Note
  if (content.audioMessage) {
    const sec = content.audioMessage.seconds || 0;
    const durStr = sec > 0 ? ` (${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')})` : '';
    const isPtt = content.audioMessage.ptt ? 'Voice Note' : 'Audio';
    return { text: `🎤 ${isPtt}${durStr}`, isMedia: true, mediaType: 'audio' };
  }

  // 2. Image / Photo
  if (content.imageMessage) {
    const cap = content.imageMessage.caption ? ` "${content.imageMessage.caption}"` : '';
    return { text: `🖼️ Photo / Sample${cap}`, isMedia: true, mediaType: 'image' };
  }

  // 3. Document / PDF
  if (content.documentMessage) {
    const fn = content.documentMessage.fileName || 'document.pdf';
    const cap = content.documentMessage.caption ? ` "${content.documentMessage.caption}"` : '';
    return { text: `📄 Document: ${fn}${cap}`, isMedia: true, mediaType: 'document' };
  }

  // 4. Location Pin
  if (content.locationMessage || content.liveLocationMessage) {
    const loc = content.locationMessage || content.liveLocationMessage;
    const name = loc.name || loc.address || `${loc.degreesLatitude?.toFixed(4)}, ${loc.degreesLongitude?.toFixed(4)}`;
    return { text: `📍 Location: ${name}`, isMedia: true, mediaType: 'location' };
  }

  // 5. Contact Card
  if (content.contactMessage || content.contactsArrayMessage) {
    const name = content.contactMessage?.displayName || 'Shared Contact';
    return { text: `👤 Contact Card: ${name}`, isMedia: true, mediaType: 'contact' };
  }

  // 6. Sticker / Other
  if (content.stickerMessage) {
    return { text: `🏷️ [Sticker]`, isMedia: true, mediaType: 'sticker' };
  }

  return { text: '[Unsupported Message Type]', isMedia: true, mediaType: 'other' };
}

export default {
  HIGH_INTENT_REGEX,
  scorePurchaseIntent,
  describeInboundContent
};
