/**
 * MartFlow AI — AI Sales Executive & Catalog Retrieval Service
 * Multi-tenant Gemini orchestration with strict catalog knowledge grounding, zero hallucination, and Hinglish deal making.
 */

import db from '../db/index.js';

export class AIService {
  // Retrieve authorized catalog context for organization
  static getCatalogContext(organizationId, inquiryText = '') {
    const products = db.findScoped('products', organizationId);
    if (!products.length) return '';

    // If inquiry text provided, sort products by keyword relevance
    const q = inquiryText.toLowerCase();
    const ranked = products.map((p) => {
      let score = 0;
      if (p.name && q.includes(p.name.toLowerCase())) score += 10;
      if (p.keywords && Array.isArray(p.keywords)) {
        for (const k of p.keywords) {
          if (q.includes(k.toLowerCase())) score += 3;
        }
      }
      return { product: p, score };
    }).sort((a, b) => b.score - a.score);

    return ranked.slice(0, 5).map(({ product: p }) => {
      return `[Product: "${p.name}"] | SKU: ${p.sku || 'N/A'} | Price: ${p.price_raw || 'Contact for official GST quotation'} | Specifications: ${JSON.stringify(p.specifications || {})}`;
    }).join('\n');
  }

  // Generate an authentic, catalog-grounded sales reply
  static async generateSalesReply({ organizationId, lead, incomingText, conversationHistory = [] }) {
    if (!organizationId) throw new Error('organization_id is required');

    const aiSettings = db.findOne('ai_settings', (s) => s.organization_id === organizationId) || {
      company_name: 'Our Manufacturing Works',
      city_base: 'Industrial Area Hub',
      supported_languages: ['Hinglish', 'Hindi', 'English'],
      strict_catalog_only: true
    };

    const catalogContext = this.getCatalogContext(organizationId, `${lead.product_inquired || ''} ${incomingText}`);

    // If Gemini API key is available in process.env, use live LLM
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey && geminiKey.trim().length > 15) {
      try {
        const systemPrompt = `You are the Senior Technical Sales Executive at "${aiSettings.company_name}" (${aiSettings.city_base}).
You are speaking directly with an inbound B2B buyer on WhatsApp.

CRITICAL DEAL-MAKING RULES:
1. TONE & LANGUAGE:
   - Natural conversational Hinglish/Hindi or English matching the buyer.
   - Respectful Indian B2B etiquette: use "Ji", "Namaste Ji", "Sir/Ma'am".
   - If buyer shares their name, address them as "[Name] Ji". Otherwise, NEVER assume or invent a name.

2. STRICT CATALOG KNOWLEDGE GROUNDING:
   - ONLY quote verified product specifications and prices from the verified catalog knowledge below.
   - NEVER invent or fabricate prices, discounts, delivery dates, or technical capacity.
   - If a specific price is not in catalog, state: "Is model ka final GST quotation humare technical engineer aapko formal quote me provide karenge."

3. QUALIFICATION OBJECTIVES:
   - Identify their exact raw material / product application.
   - Required speed or batch capacity (e.g. pouches/min, kg/batch).
   - Delivery destination city.

4. 2-WAY OWNER CALL SCHEDULING:
   - If the buyer asks for a phone call, owner consultation, or visiting the factory:
     Tell them politely that you will check the factory director's free time and confirm the call slot on WhatsApp immediately.

VERIFIED FACTORY CATALOG KNOWLEDGE:
${catalogContext || 'Official factory catalog under review.'}

CONVERSATION HISTORY:
${conversationHistory.map(m => `${m.sender_type}: ${m.content}`).join('\n')}

BUYER'S NEW MESSAGE:
"${incomingText}"

OUTPUT INSTRUCTIONS:
Reply in 2 to 3 concise, high-converting WhatsApp sentences. No markdown stars, no corporate jargon. Be warm, professional, and action-oriented.`;

        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey.trim())}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
              generationConfig: { maxOutputTokens: 250, temperature: 0.3 }
            })
          }
        );

        if (resp.ok) {
          const data = await resp.json();
          const replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (replyText && replyText.trim()) {
            return {
              reply: replyText.trim(),
              provider: 'gemini',
              matchedProductCatalog: catalogContext
            };
          }
        }
      } catch (err) {
        console.warn('Gemini live call error, using deterministic catalog fallback:', err.message);
      }
    }

    // Deterministic High-Converting Fallback grounded in catalog
    const qLower = incomingText.toLowerCase();
    const isCallRequest = /call|phone|baat|director|owner|meeting|contact/i.test(qLower);
    const greeting = lead.buyer_name ? `Namaste ${lead.buyer_name} Ji!` : 'Namaste Ji!';

    if (isCallRequest) {
      return {
        reply: `${greeting} Humare factory director se aapki technical discussion ke liye main unka free time slot check karke WhatsApp pe confirm karta hoon!`,
        isCallRequest: true,
        provider: 'rule_engine'
      };
    }

    return {
      reply: `${greeting} ${aiSettings.company_name} se baat kar rahe hain. Aapki inquiry ke mutabiq product specifications share kar di gayi hain. Aapki daily production capacity requirement kya hai Ji?`,
      provider: 'rule_engine'
    };
  }
}

export default AIService;

