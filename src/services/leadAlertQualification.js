// Heuristics, not proof of a buyer's intent. Keep only coarse signals, keyed by
// the exact workspace and phone, for a short period; no message text is stored.
const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

const RESET = /^(?:\/?reset|clear|restart|new\s*chat|start\s*again)\b/i;
const DECLINE = /^(?:stop|unsubscribe|opt\s*out|remove\s+me)[.!?\s]*$|\b(?:do\s+not\s+call|don't\s+call|dont\s+call|call\s+mat\s+(?:karna|karo)|not\s+interested|not\s+buying|no\s+thanks|just\s+browsing|no\s+longer\s+interested|don't\s+want|do\s+not\s+want|don't\s+need|do\s+not\s+need|no\s+need|nahi\s+chahiye|nahin\s+chahiye|nhi\s+chahiye|mat\s+bhejo)\b|नहीं\s+चाहिए|नही\s+चाहिए/i;
const HANDOFF = /\b(?:call\s+me|please\s+call|call\s+(?:karo|kijiye|karna)|phone\s+(?:me|karo|kijiye)|baat\s+(?:karni|karna|karao|kijiye)|(?:talk|speak|connect)\s+(?:to|with)\s+(?:a\s+|the\s+)?(?:real\s+)?(?:someone|person|human|agent|owner|manager|representative|team)|(?:need|want)\s+(?:to\s+(?:talk|speak)\s+to\s+)?(?:a\s+)?(?:real\s+)?(?:person|human|agent|manager)|(?:human|person|agent|owner|manager)\s+(?:se|ko)\s+(?:baat|connect))\b|(?:इंसान|व्यक्ति|मालिक|मैनेजर)\s+से\s+बात|(?:कॉल|फोन)\s+(?:करो|कीजिए|करें)/i;
const COMMIT = /\b(?:(?:want|would\s+like|ready|going)\s+to\s+(?:buy|purchase|order|book)|(?:confirm|place|proceed\s+with|finali[sz]e)\s+(?:my\s+|the\s+|an?\s+)?(?:order|booking|purchase)|(?:order|book|purchase)\s+(?:karna|karo|karni|karni\s+hai|karna\s+hai)|(?:book|schedule)\s+(?:an?\s+|my\s+)?(?:appointment|visit|meeting|demo)|lena\s+hai)\b|(?:ऑर्डर|बुकिंग)\s+(?:करना|करनी|करें)/i;
const INTEREST = /\b(?:price|pricing|cost|rate|quotation|quote|kitna|kitne|bhav|daam|buy|purchase|order|book|chahiye|requirement|need|want|interested|looking\s+for|budget|discount|wholesale|bulk)\b|(?:कीमत|दाम|रेट|चाहिए|खरीदना|कोटेशन)/i;
const DETAIL = /(?:\b\d+(?:[.,]\d+)?\s*(?:pcs?\.?|pieces?|units?|sets?|machines?|items?|pairs?|boxes?|kg|kgs|kilograms?|tons?|tonnes?|lit(?:er|re)s?|lakh|lakhs|crore|cr|k)\b|(?:₹|rs\.?|inr|rupees?)\s*\d|\b(?:budget\s*(?:is|of|:)?\s*\d|this\s+(?:week|month)|next\s+(?:week|month)|tomorrow|today|urgent(?:ly)?|turant|jaldi|kal|quantity\s*(?:is|of|:)?\s*\d|qty\s*:?\s*\d)\b|\d+\s*(?:पीस|नग|किलो|मशीन|लाख)|(?:आज|कल|तुरंत))/i;

export function createLeadAlertQualifier({ ttlMs = TTL_MS, maxEntries = MAX_ENTRIES, now = () => Date.now() } = {}) {
  const states = new Map();
  return {
    evaluate({ orgId, phone, text }) {
      if (!orgId || !phone) return { shouldAlert: false, reason: null };
      const key = JSON.stringify([orgId, phone]);
      const current = now();
      for (const [k, v] of states) if (current - v.updatedAt >= ttlMs) states.delete(k);
      const value = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
      if (!value) return { shouldAlert: false, reason: null };
      if (RESET.test(value) || DECLINE.test(value)) {
        states.delete(key);
        return { shouldAlert: false, reason: null };
      }
      const directHuman = HANDOFF.test(value);
      const commitment = COMMIT.test(value);
      const interest = INTEREST.test(value);
      const detail = DETAIL.test(value);
      const previous = states.get(key);
      const state = previous || { interest: false, detail: false, updatedAt: current };
      state.interest ||= interest;
      state.detail ||= detail;
      state.updatedAt = current;
      // Refresh insertion order and bound memory even under sustained traffic.
      states.delete(key);
      if (previous || interest || detail || commitment || directHuman) {
        states.set(key, state);
        while (states.size > maxEntries) states.delete(states.keys().next().value);
      }
      const reason = directHuman ? 'human_request' : commitment ? 'purchase_intent' :
        (state.interest && state.detail && (interest || detail)) ? 'interest_with_details' : null;
      return { shouldAlert: Boolean(reason), reason };
    },
    clear() { states.clear(); }
  };
}

export const leadAlertQualifier = createLeadAlertQualifier();
