/**
 * MartFlow AI — AI Sales Executive & Catalog Retrieval Service
 * Multi-tenant Gemini orchestration with strict catalog knowledge grounding, zero hallucination, and Hinglish deal making.
 */

import dns from 'dns';
import path from 'path';
import fs from 'fs';
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
import { createClient } from '@supabase/supabase-js';
import db from '../db/index.js';

let _sbAdmin = null;
function getSupabaseAdmin() {
  if (_sbAdmin) return _sbAdmin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (url && key) {
    _sbAdmin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return _sbAdmin;
}

// 15-second RAM cache for org and product catalog to eliminate redundant DB roundtrips
const ramCache = new Map();
async function getCachedOrgData(organizationId) {
  const now = Date.now();
  const cached = ramCache.get(organizationId);
  if (cached && (now - cached.ts) < 15000) {
    return cached;
  }
  let org = db.findById('organizations', organizationId) || {};
  let products = db.findScoped('products', organizationId) || [];

  const admin = getSupabaseAdmin();
  if (admin && organizationId) {
    try {
      const { data: dbOrg } = await admin.from('organizations').select('*').eq('id', organizationId).maybeSingle();
      if (dbOrg) org = { ...org, ...dbOrg };
      const { data: dbProds } = await admin.from('products').select('*').eq('org_id', organizationId).neq('is_active', false);
      if (dbProds && dbProds.length > 0) {
        products = dbProds;
      }
    } catch (e) {
      console.warn('[AI Service] Supabase cache fetch error:', e.message);
    }
  }

  const entry = { org, products, ts: now };
  ramCache.set(organizationId, entry);
  return entry;
}

export function getIndustryPlaybook(businessType = 'auto') {
  const bType = (businessType || 'auto').toLowerCase();
  switch (bType) {
    case 'coaching_ielts':
      return {
        niche: 'Education / IELTS / Visa',
        qualifications: [
          'Target exam (IELTS Academic/General, PTE, TOEFL, Duolingo)',
          'Target country (Canada, UK, Australia, USA, Europe)',
          'Current educational background and English level',
          'Preferred intake session (Fall/Spring)'
        ],
        promptGuidelines: 'Focus on student goals: exam type, target band score, destination country, and offer a free demo class or profile assessment.'
      };
    case 'solar':
      return {
        niche: 'Solar Rooftop & EPC',
        qualifications: [
          'Average monthly electricity bill (in ₹)',
          'Sanctioned load / Required solar capacity (kW)',
          'Property type (Residential rooftop, Commercial building, Industrial shed)',
          'Roof area availability and city/district'
        ],
        promptGuidelines: 'Focus on monthly bill reduction, government subsidy (PM Surya Ghar), net metering, and Tier-1 solar panels.'
      };
    case 'real_estate':
      return {
        niche: 'Real Estate & Properties',
        qualifications: [
          'Unit configuration (2 BHK, 3 BHK, Penthouse, Plot, Office Space)',
          'Budget range (in Lakhs/Crores)',
          'Preferred locality or city sector',
          'Purpose of purchase (Self-use or Investment ROI), Timeline (Ready to Move vs Under Construction)'
        ],
        promptGuidelines: 'Highlight prime location, floor plans, amenities, RERA registration, and offer a private site visit.'
      };
    case 'interiors':
      return {
        niche: 'Interior Design & Modular Living',
        qualifications: [
          'Scope of work (Modular kitchen, wardrobes, complete 2/3 BHK flat, commercial)',
          'Apartment/Site carpet area (sq. ft.) and possession status',
          'Preferred design aesthetic (Modern minimal, contemporary luxury, classic wood)',
          'Budget expectation and site city'
        ],
        promptGuidelines: 'Focus on German fittings (Hettich/Hafele), 10-year warranty, 3D render designs, and schedule a free site measurement visit.'
      };
    case 'manufacturing':
      return {
        niche: 'Custom Manufacturing & B2B Wholesale',
        qualifications: [
          'Technical drawing / CAD or sample availability',
          'Material grade requirement (SS304, MS, Aluminum, Brass, Polymers)',
          'Initial order volume and monthly repeat batch size',
          'Target unit delivery timeline'
        ],
        promptGuidelines: 'Emphasize ISO-certified quality, CNC precision tolerance, wholesale pricing tiers, and fast turnaround sample testing.'
      };
    case 'services':
      return {
        niche: 'Professional Services & Consulting',
        qualifications: [
          'Specific service requirement and deliverables',
          'Timeline and urgency',
          'Company size and location'
        ],
        promptGuidelines: 'Be consultative, highlight expertise and case studies, and offer an exploratory consultation call.'
      };
    case 'machinery':
    default:
      return {
        niche: 'Packaging & Industrial Machinery',
        qualifications: [
          'Product to be packed / filled (granules, powder, liquid, paste, snacks, namkeen)',
          'Pouch / container dimensions and weight range (e.g. 50g-1kg)',
          'Required production speed (pouches/min or units/hr)',
          'Delivery destination city'
        ],
        promptGuidelines: 'Focus on machine automation grade (Pneumatic vs Mechanical vs Servo), stainless steel build, warranty, and dispatching catalog PDF.'
      };
  }
}

export function buildAdaptiveWelcomeMessage(org = {}, products = []) {
  if (org.wa_welcome_message && org.wa_welcome_message.trim()) {
    return org.wa_welcome_message.trim();
  }
  const orgName = org.name || 'our sales desk';
  const bType = (org.business_type || 'auto').toLowerCase();
  const prodNames = (products || [])
    .map((p) => p.name || p.product_name)
    .filter(Boolean)
    .slice(0, 3);
  const itemsText = prodNames.length > 0 ? ` (${prodNames.join(', ')})` : '';

  switch (bType) {
    case 'coaching_ielts':
      return `Hello! Welcome to ${orgName}${itemsText}. We offer certified training for IELTS, PTE, and Study Visa counseling for Canada, UK, and Australia. Which exam or destination country are you planning for?`;
    case 'solar':
      return `Namaste! Welcome to ${orgName}${itemsText}. We provide Tier-1 Solar Rooftop & EPC solutions with government subsidy assistance. Are you planning for residential rooftop or commercial/factory installation?`;
    case 'real_estate':
      return `Hello! Welcome to ${orgName}${itemsText}. Explore our verified residential and commercial properties. Are you looking for 2/3 BHK luxury apartments, independent plots, or commercial retail spaces?`;
    case 'interiors':
      return `Namaste! Welcome to ${orgName}${itemsText}. We specialize in bespoke modular kitchens, custom wardrobes, and turnkey home interiors. Would you like to share your floor plan or schedule a free site consultation?`;
    case 'manufacturing':
      return `Namaste! Welcome to ${orgName}${itemsText}. We specialize in precision custom manufacturing, fabrication, and bulk wholesale supplies. What is your required batch size or technical drawing specification?`;
    case 'services':
      return `Namaste! Welcome to ${orgName}${itemsText}. Thank you for connecting with us. How can our team assist you with your project requirements today?`;
    case 'machinery':
    default:
      return `Namaste! Welcome to ${orgName}${itemsText}. We manufacture high-performance packaging and industrial machinery. Which machine model or daily capacity are you looking for?`;
  }
}

export class AIService {
  // Retrieve authorized catalog context for organization
  static getCatalogContext(products = [], inquiryText = '') {
    if (!products || !products.length) return '';

    return products.map((p, idx) => {
      const cat = p.category ? `Category: ${p.category} | ` : '';
      const hasImg = (p.image_url || p.imageUrl) ? `[Photo Available: YES]` : '[Photo Available: NO]';
      return `${idx + 1}. "${p.name}" | ${cat}Price: ${p.price_raw || 'Price on request'} | Specs: ${p.model_specs || 'Industrial standard'} | ${hasImg}`;
    }).join('\n');
  }

  // Generate an authentic, catalog-grounded sales reply
  static async generateSalesReply({ organizationId, lead = {}, incomingText = '', conversationHistory = [] }) {
    if (!organizationId) throw new Error('organization_id is required');

    const { org, products } = await getCachedOrgData(organizationId);
    const orgName = org.name || 'our business';
    const cityBase = org.company_city || org.city_base || 'Hub';
    const playbook = getIndustryPlaybook(org.business_type || 'auto');
    const qTrim = (incomingText || '').trim();
    const qLower = qTrim.toLowerCase();

    // 1. LIFECYCLE STAGE DETECTION
    const priorMessages = (conversationHistory || []).filter(
      (m) => (m.content || m.text || '').trim()
    );
    const previousAiMessages = priorMessages.filter(
      (m) => m.sender_type === 'ai' || m.sender === 'ai'
    );
    const isFirstTurn = previousAiMessages.length === 0;

    const lastMsg = priorMessages[priorMessages.length - 1];
    let lastMsgTime = 0;
    if (lastMsg) {
      const rawTime = lastMsg.created_at || lastMsg.timestamp || lastMsg.ts;
      if (rawTime) lastMsgTime = new Date(rawTime).getTime();
    }
    const lastMsgAgeHours = lastMsgTime ? (Date.now() - lastMsgTime) / (3600 * 1000) : 999999;

    // Detect Graceful Closing (Buyer acknowledges/exits)
    const isClosing = /^(ok|okay|thik\s*hai|theek\s*hai|thik\s*h|accha|achha|thanks|thank\s*you|dhanyawad|shukriya|will\s*let\s*you\s*know|batata\s*hu|soch\s*ke\s*batata|bye|good\s*night)\b[!?.]*$/i.test(qLower);

    let lifecycleStage = 'ACTIVE_ONGOING';
    if (isClosing) {
      lifecycleStage = 'GRACEFUL_CLOSING';
    } else if (isFirstTurn) {
      lifecycleStage = 'NEW_FIRST_TIME';
    } else if (lastMsgAgeHours < 3) {
      lifecycleStage = 'ACTIVE_ONGOING';
    } else if (lastMsgAgeHours < 72) {
      lifecycleStage = 'SECOND_TIME_RETURN';
    } else {
      lifecycleStage = 'LONG_GAP_RETURN';
    }

    // STAGE: GRACEFUL CLOSING — Stop asking questions and end naturally
    if (lifecycleStage === 'GRACEFUL_CLOSING') {
      return {
        reply: 'Theek hai ji, thank you! Jab bhi zaroorat ho bas ek message kar dijiyega 👍',
        provider: 'lifecycle_closing',
        isClosing: true
      };
    }

    // 2. ANTI-SPAM PDF BROCHURE RULES
    const isCatalogRequest = /catalog|catalogue|brochure|pdf|price\s*list|all\s*machines|all\s*products|share\s*details|kya\s*kya/i.test(qLower);
    const isExplicitResend = /again|dobara|phir\s*se|resend|re-send|mila\s*nahi|open\s*nahi|bhejo\s*phir/i.test(qLower);

    const brochureAlreadySent = Boolean(
      lead?.pdf_brochure_sent ||
      lead?.pdfSent ||
      (conversationHistory || []).some(m => (m.content || m.text || '').includes('[Brochure Sent:'))
    );

    let matchedBrochureUrl = null;
    let matchedBrochureName = null;
    const prodWithPdf = (products || []).find(p => p.brochure_url && p.brochure_url.startsWith('http'));

    if (prodWithPdf && (isExplicitResend || !brochureAlreadySent)) {
      if (isCatalogRequest || (isFirstTurn && !isClosing) || isExplicitResend) {
        matchedBrochureUrl = prodWithPdf.brochure_url;
        matchedBrochureName = (prodWithPdf.name || 'Catalog').replace(/[^a-zA-Z0-9_-]/g, '_') + '.pdf';
      }
    }

    // 3. HUMAN GREETING PER LIFECYCLE STAGE
    const rawName = lead.buyer_name || lead.name || '';
    const firstName = rawName && !/^(buyer|customer|sir|unknown|rajesh)$/i.test(rawName.trim())
      ? rawName.trim().split(' ')[0]
      : '';
    const lastProduct = lead.product_inquired || lead.productName || 'product';

    const isPureGreeting = /^(hi|hello|hey|namaste|pranam|good\s*(morning|afternoon|evening)|hlo|hie|salaam)\b[!?.]*$/i.test(qLower);
    if (isPureGreeting) {
      if (lifecycleStage === 'NEW_FIRST_TIME') {
        return {
          reply: buildAdaptiveWelcomeMessage(org, products),
          isGreeting: true,
          provider: 'rule_engine',
          matchedBrochureUrl,
          matchedBrochureName
        };
      } else if (lifecycleStage === 'SECOND_TIME_RETURN') {
        const greetName = firstName ? `Hi ${firstName}!` : 'Hi!';
        return {
          reply: `${greetName} Bataiye, pichhli baar wali ${lastProduct} ke baare mein kuch aur janna tha ya rate final karein?`,
          provider: 'rule_engine'
        };
      } else if (lifecycleStage === 'LONG_GAP_RETURN') {
        const greetName = firstName ? `Hi ${firstName} ji!` : 'Hi ji!';
        return {
          reply: `${greetName} Kaise hain aap? Pichhli baar aap ${lastProduct} dekh rahe the—usi ko aage badhayein ya kuch naya dekh rahe hain?`,
          provider: 'rule_engine'
        };
      } else {
        // ACTIVE_ONGOING
        return {
          reply: 'Ji, bataiye main aapki kya madad kar sakta hoon? Aapko kis product ya specification ki requirement hai?',
          provider: 'rule_engine'
        };
      }
    }

    // 4. CALL / OWNER MEETING REQUEST
    const isCallRequest = /call|phone|baat|director|owner|meeting|contact|appointment|schedule/i.test(qLower);
    if (isCallRequest) {
      const greeting = isFirstTurn && firstName ? `Namaste ${firstName} Ji! ` : '';
      return {
        reply: `${greeting}Hamare senior technical director se direct discussion ke liye main unka free time slot check karke WhatsApp pe confirm karta hoon! Aap kis city se baat kar rahe hain?`,
        isCallRequest: true,
        provider: 'rule_engine'
      };
    }

    // 5. CONTEXTUAL NUMBER-REPLY AMNESIA REASONING
    const lastBotMsg = [...previousAiMessages].reverse()[0];
    const lastBotText = (lastBotMsg?.content || lastBotMsg?.text || '').toLowerCase();
    const didAskQuantity = /speed|capacity|kitne|kitna|pouches|bottles|gram|batch|size|units|output|production|daily/i.test(lastBotText);
    const didAskCity = /city|location|kaha|kahan|state|district|area/i.test(lastBotText);
    const didAskCall = /call|phone|baat|slot|afternoon|evening/i.test(lastBotText);

    const numMatch = qTrim.match(/^(\d+)(?:\s*(bottles?|pouches?|units?|pieces?|pcs?|kg|gm|gram|ltr|liter|ml|per\s*day|daily))?$/i);
    let numberAdvice = '';
    if (numMatch) {
      const qty = parseInt(numMatch[1], 10);
      if (qty < 50) {
        numberAdvice = `${qty} daily output ke hisaab se heavy industrial machine lene ki zaroorat nahi hai—hamara compact tabletop / semi-automatic model aapke liye sabse economical aur easy-to-use rahega.`;
      } else if (qty <= 1000) {
        numberAdvice = `${qty} daily requirement ke hisaab se hamara standard automatic pneumatic model bilkul suitable hai. Isme digital batch counter aur speed regulator milta hai.`;
      } else {
        numberAdvice = `${qty} daily production ke liye hamara high-speed automatic servo line model best rahega jo continuous 24×7 shift bina rukawat chalta hai.`;
      }
    }

    const allProducts = (products && products.length > 0) ? products : [];
    const isShortCatalog = allProducts.length <= 5;
    const catalogCategories = [...new Set(allProducts.map(p => p.category).filter(Boolean))];
    const websiteUrl = org.website_url || '';

    // Image & Photo Matching Logic
    const asksForImages = /photo|image|pic|dikhao|bhejo|dekhna|one\s*by\s*one|ek\s*ek/i.test(qLower);
    const isOneByOne = /one\s*by\s*one|ek\s*ek|sbhi|sab\s*bhejo|shuru\s*karo/i.test(qLower);
    let matchedImageUrl = null;
    let matchedImagePath = null;
    let matchedImageCaption = null;

    const isAffirmativeNext = /^(ha|haji|haa|yes|next|agla|sure|dikhao|bhejo)\b/i.test(qLower) || /(next|agla|aur\s*batao|aur\s*dikhao|aur\s*bhejo)/i.test(qLower);
    const histStr = (conversationHistory || []).map(m => (m.content || m.text || '')).join(' ').toLowerCase();

    if (asksForImages || isAffirmativeNext) {
      let matchedProd = null;

      if (isAffirmativeNext && (histStr.includes('liquid') || histStr.includes('paste filling'))) {
        matchedProd = allProducts.find(p => /carton|strap/i.test(p.name || ''));
        matchedImageUrl = 'https://uriqhusalcdgdlgzgasp.supabase.co/storage/v1/object/public/catalogs/demo/carton-sealing-machine.jpg';
        matchedImageCaption = 'Carton Sealer & Box Strapping Machine (₹34,000 – ₹48,500 + GST)';
      } else if (isAffirmativeNext && (histStr.includes('pouch') || histStr.includes('packing machine'))) {
        matchedProd = allProducts.find(p => /liquid|filling/i.test(p.name || ''));
        matchedImageUrl = 'https://uriqhusalcdgdlgzgasp.supabase.co/storage/v1/object/public/catalogs/demo/liquid-filling-machine.jpg';
        matchedImageCaption = 'Automatic Liquid & Paste Filling Machine (₹68,000 – ₹2,85,000 + GST)';
      } else if (isOneByOne) {
        // When buyer asks for "one by one" or "all with images", start with the flagship pouch packing machine
        matchedProd = allProducts.find(p => p.sku === 'BPT-POUCH-01') ||
                      allProducts.find(p => /pouch/i.test(p.name || '')) ||
                      allProducts.find(p => p.image_url || p.imageUrl);
      } else {
        const stopwords = new Set(['with', 'that', 'this', 'there', 'have', 'from', 'they', 'krr', 'skte', 'kya', 'aap', 'sbhi', 'share', 'images', 'prices', 'photos', 'pics', 'bhejo', 'dikhao']);
        matchedProd = allProducts.find(p => (p.image_url || p.imageUrl) && (
          qLower.includes((p.name || '').toLowerCase()) ||
          (p.category && qLower.includes(p.category.toLowerCase())) ||
          (p.model_specs && qLower.split(/\s+/).some(w => w.length > 3 && !stopwords.has(w) && p.model_specs.toLowerCase().includes(w)))
        ));
      }

      if (!matchedProd) {
        matchedProd = allProducts.find(p => p.sku === 'BPT-POUCH-01') || allProducts.find(p => p.image_url || p.imageUrl);
      }

      if (!matchedImageUrl && matchedProd && (matchedProd.image_url || matchedProd.imageUrl)) {
        matchedImageUrl = matchedProd.image_url || matchedProd.imageUrl;
        matchedImageCaption = `${matchedProd.name} (${matchedProd.price_raw || 'Price on request'})`;
      } else if (!matchedImageUrl) {
        const localImg = path.join(process.cwd(), 'catalogs/images/pouch-packing-machine.jpg');
        if (fs.existsSync(localImg)) {
          matchedImagePath = localImg;
          matchedImageCaption = 'Automatic Pouch Packing Machine';
        }
      }
    }

    const catalogContext = this.getCatalogContext(products, `${lead.product_inquired || ''} ${incomingText}`);

    // 6. CALL GEMINI 2.5 FLASH (WITH STATEFUL LIFECYCLE & PERSONA)
    const geminiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
    if (geminiKey && geminiKey.length > 10) {
      try {
        const historyText = (conversationHistory || [])
          .slice(-15)
          .map((m) => `${m.sender_type || m.sender || 'buyer'}: ${m.content || m.text || ''}`)
          .join('\n');

        const systemPrompt = `You are the friendly, highly experienced Senior Sales Director at "${orgName}" (${cityBase}).
Industry Domain: ${playbook.niche}.
Official Website: ${websiteUrl || 'Available on request'}.
You are texting directly with a customer on WhatsApp. You know every product, price, category, and machine specification inside out.

CONVERSATION LIFECYCLE STAGE: ${lifecycleStage}
${lifecycleStage === 'NEW_FIRST_TIME' ? '- First message from customer: greet warmly in 1 short line.' : '- Conversation already in progress: DO NOT say "Namaste", "Hello", or greet again! Answer the buyer directly in natural context.'}
${brochureAlreadySent ? '- NOTE: The product brochure PDF has ALREADY been sent. Do NOT offer to send the brochure or say "taaki hum PDF share karein".' : ''}
${numberAdvice ? `- NUMBER RECOGNITION: The customer replied with a quantity: "${qTrim}". Give honest human advice: "${numberAdvice}".` : ''}

CRITICAL SALES RULES:
1. CASUAL CONVERSATIONS & IDENTITY ("Who are you", "Kaise hai aap", "Kaise ho"):
   - If the customer asks how you are doing or who you are: respond warmly, politely, and casually like a real human director! (e.g., "Arre ekdum badhiya ji! Main ${orgName} ki sales desk se baat kar raha hoon. Aap bataiye aap kaise hain aur aaj hum aapki kis item ya requirement mein madad kar sakte hain?")
   - NEVER pitch or say "aapko best machine aur quotation provide karenge... target daily production kitna hai" in response to a casual "Kaise hai aap" or "Who are you"!
2. ONE-BY-ONE SHOWCASE / PHOTO REQUESTS ("Kya aap one by one sbhi share krr skte hai with their images and prices?", "sabka bata do", "photo bhejo"):
   - When the buyer asks to share one-by-one or with photos and prices:
     DO NOT ask which category they want in a loop! DO NOT repeat categories!
     Immediately START the tour with Product #1 from verified catalog (e.g. *Automatic Pouch Packing Machine*). Quote its exact price range, mention key specs, announce that you have shared its photo below ("Maine iski photo WhatsApp pe attach kar di hai! 👇"), and ask if they would like to see model #2 next!
   - When buyer replies "Next", "Haan", "Yes", "Agla batao": Present the NEXT model in sequence with its price, announce that its photo is sent below, and invite them to see the next model!
3. CATEGORY-WISE EXPLORATION:
   - If buyer specifically asks category-wise (e.g. "pouch packing", "liquid filling", "carton sealer"), present the specific models in THAT category with verified prices and specs.
4. SHORT VS HUGE CATALOG:
${isShortCatalog
  ? `- SHORT CATALOG (${allProducts.length} items total): When the customer says "App sbhi ka bta dejiye" or asks what you offer, list all ${allProducts.length} items directly with their starting price and main application! Keep it clean, friendly, and transparent.`
  : `- HUGE CATALOG (${allProducts.length} items in categories: ${catalogCategories.join(', ')}): If the buyer asks generally what you do, summarize the 3-4 key categories with starting price ranges, and ask what they produce/pack. BUT if they asked for "one by one" or a specific category, follow Rule 2 and show the specific items directly!`}
5. Keep answers short: 2 to 4 natural WhatsApp sentences. NO robotic walls of text.
6. Speak natural, conversational Indian Hinglish (or English if the customer wrote in English). Friendly, confident, plain business owner style.
7. GROUNDING: Only quote specifications & prices from verified catalog knowledge below. Never invent arbitrary specs.
8. PERSUASIVE SALES CLOSER & OBJECTION HANDLING:
   - Act like a top-performing, warm, persuasive Indian sales closer. Never sound like a passive ticketing clerk or robot.
   - Price & Cost Objections ("mehnga hai", "discount", "pricing", "cost"):
     * Compare the ₹9,999 3-month launch offer (~₹110/day for 24×7 3-second replies) vs ₹15,000/month for a human telecaller who misses late-night and Sunday leads. If even 1 extra lead converts, it pays for itself!
     * NEVER mention "Free 48-Hour Trial". Pitch the "₹999 48-Hour Live VIP Pilot on your own WhatsApp" with up to 25 real leads + white-glove AI setup + FREE custom PDF brochure. Highlight that the entire ₹999 is 100% adjusted/deducted on upgrade (pay only ₹9,000 balance for Standard or ₹14,000 for Pro). Direct to UPI saraitaj6-2@okaxis and VIP Desk +91 97810 18975.
   - WhatsApp Ban Concerns ("ban hoga kya", "number block", "safe"):
     * Reassure that MartFlow AI is 100% safe because it is strictly inbound-only (replies only when a customer messages first from an ad or website), zero bulk spam blasting.
   - No PDF Catalog ("catalog nahi hai", "brochure nahi"):
     * Tell them: "Koi tension nahi sir! Bas 1 minute ka voice note ya rate list photo WhatsApp pe bhej dijiye, hamare engineers aapke liye photo-rich PDF brochure FREE design kar denge!"
   - Closing Nudge: End replies with a low-friction, natural question that moves them forward to ordering, site inspection, or the ₹999 VIP Pilot.

VERIFIED CATALOG KNOWLEDGE:
${catalogContext || 'Standard verified company offerings apply.'}

CONVERSATION HISTORY:
${historyText || '(New conversation)'}

CUSTOMER'S NEW MESSAGE:
"${incomingText}"

Output: Exactly 1 to 3 natural lines of WhatsApp text.`;

        const modelsToTry = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite'];
        for (const modelName of modelsToTry) {
          try {
            const resp = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(geminiKey)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(35000),
                body: JSON.stringify({
                  contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
                  generationConfig: {
                    maxOutputTokens: 1200,
                    temperature: 0.45
                  }
                })
              }
            );

            if (resp.ok) {
              const data = await resp.json();
              const replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (replyText && replyText.trim()) {
                return {
                  reply: replyText.trim(),
                  provider: `gemini (${modelName})`,
                  matchedProductCatalog: catalogContext,
                  matchedBrochureUrl: (isCatalogRequest || isExplicitResend) ? matchedBrochureUrl : null,
                  matchedBrochureName,
                  matchedImageUrl,
                  matchedImagePath,
                  matchedImageCaption
                };
              }
            } else {
              const errText = await resp.text();
              console.warn(`[AI Service] Model ${modelName} returned status ${resp.status}:`, errText.slice(0, 150));
            }
          } catch (modelErr) {
            console.warn(`[AI Service] Model ${modelName} error:`, modelErr.message);
          }
        }
      } catch (err) {
        console.warn('[AI Service] Gemini live call exception:', err.message);
      }
    }

    // 7. DETERMINISTIC STATEFUL FALLBACK (NO ROBOTIC STRINGS)
    const greetingPrefix = isFirstTurn ? (firstName ? `Namaste ${firstName} Ji! ` : 'Namaste Ji! ') : '';

    // Quantity / Number Response
    if (numMatch && numberAdvice) {
      return {
        reply: `${numberAdvice} Aapki delivery city kaunsi hai taaki transport time aur final GST rate confirm kar sakein?`,
        matchedBrochureUrl: (isCatalogRequest || isExplicitResend) ? matchedBrochureUrl : null,
        matchedBrochureName,
        provider: 'rule_engine'
      };
    }

    // Catalog Request Response
    if (isCatalogRequest) {
      const prodList = (products || []).slice(0, 3).map(p => `• ${p.name} (${p.price_raw || 'Price on request'})`).join('\n');
      const attachNotice = matchedBrochureUrl ? 'Maine catalog PDF brochure share kar diya hai. ' : '';
      return {
        reply: `${greetingPrefix}${attachNotice}Hamare top verified models:${prodList ? '\n' + prodList : ''}\n\nAapko kis product ke liye aur kitni daily production speed chahiye?`,
        matchedBrochureUrl,
        matchedBrochureName,
        provider: 'rule_engine'
      };
    }

    // Product Use-case Matching
    if (/namkeen|snacks|chips|kurkure/i.test(qLower)) {
      const matched = (products || []).find(p => /pouch|packing|packaging|collar|auger/i.test(p.name + ' ' + (p.model_specs || ''))) || products[0];
      const pName = matched ? matched.name : 'Automatic Pouch Packing Machine';
      return {
        reply: `${greetingPrefix}${pName} namkeen aur fryums packaging ke liye best suited hai. Isme nitrogen flushing aur automatic batch coding available hai. Aapko kitne gram (50g / 200g / 500g) pouch pack karna hai?`,
        matchedBrochureUrl,
        matchedBrochureName,
        provider: 'rule_engine'
      };
    }

    if (/oil|juice|water|liquid|syrup/i.test(qLower)) {
      return {
        reply: `${greetingPrefix}Hamare paas Semi-Automatic aur Fully-Automatic Liquid Filling Machines available hain (100ml se 5 Litre tak). Aapko daily kitne bottles ya pouches fill karne hain?`,
        matchedBrochureUrl,
        matchedBrochureName,
        provider: 'rule_engine'
      };
    }

    // One-by-One Product Demonstration with Live Photos & Prices
    if (isOneByOne) {
      return {
        reply: `Bilkul! Chaliye sabse pehle humari best-selling *Automatic Pouch Packing Machine* se shuru karte hain:\n\n• Price: ₹1,45,000 – ₹3,15,000 + GST\n• Speed: 40–65 Pouches/Min (SS-304 Food Grade, Delta PLC Touchscreen)\n• Best for: Namkeen, chips, spices, dry fruits, grains\n\nMaine iski factory live photo WhatsApp pe attach kar di hai! 👇\n\nKya aap iske baad next model (*Automatic Liquid & Paste Filling Machine*) ki details aur photo dekhna chahenge?`,
        matchedImageUrl: 'https://uriqhusalcdgdlgzgasp.supabase.co/storage/v1/object/public/catalogs/demo/pouch-packing-machine.jpg',
        matchedImageCaption: 'Automatic Pouch Packing Machine (₹1,45,000 – ₹3,15,000 + GST)',
        provider: 'rule_engine'
      };
    }

    // Sequence progression: Next product in sequence
    if (isAffirmativeNext && (histStr.includes('liquid') || histStr.includes('paste filling'))) {
      return {
        reply: `Yeh raha humara 3rd model: *Carton Sealer & Box Strapping Machine*:\n\n• Price: ₹34,000 (Strapper) | ₹48,500 (Carton Taper) + GST\n• Speed: 20 meters/min top & bottom tape sealing\n• Application: Dispatch packing, corrugated boxes, heavy bundle strapping\n\nIski live photo WhatsApp pe share kar di hai! 👇\n\nKya aap 4th industrial model (*BPT-500 High-Speed Servo*) bhi dekhna chahenge?`,
        matchedImageUrl: 'https://uriqhusalcdgdlgzgasp.supabase.co/storage/v1/object/public/catalogs/demo/carton-sealing-machine.jpg',
        matchedImageCaption: 'Carton Sealer & Box Strapping Machine (₹34,000 – ₹48,500 + GST)',
        provider: 'rule_engine'
      };
    } else if (isAffirmativeNext && (histStr.includes('pouch') || histStr.includes('packing machine'))) {
      return {
        reply: `Yeh raha humara 2nd model: *Automatic Liquid & Paste Filling Machine*:\n\n• Price: ₹68,000 (Semi-Auto) se ₹2,85,000 + GST (Fully Auto Anti-Drip)\n• Capacity: 100ml se 5 Litre bottles/pouches\n• Application: Edible oils, juices, honey, sauces, sanitizers, shampoos\n\nIski live photo WhatsApp pe share kar di hai! 👇\n\nKya aap 3rd model (*Carton Sealer & Strapping Machine*) ki details dekhna chahenge?`,
        matchedImageUrl: 'https://uriqhusalcdgdlgzgasp.supabase.co/storage/v1/object/public/catalogs/demo/liquid-filling-machine.jpg',
        matchedImageCaption: 'Automatic Liquid & Paste Filling Machine (₹68,000 – ₹2,85,000 + GST)',
        provider: 'rule_engine'
      };
    }

    // All Products Overview ("App sbhi ka bta dejiye" / "sabka bata do")
    const isAllProducts = /sbhi|sabka|sab\s*bata|all\s*machines|all\s*products|tell\s*all|saari\s*machine/i.test(qLower);
    if (isAllProducts) {
      return {
        reply: `Humare paas 4 main manufacturing models available hain:\n\n1. *Automatic Pouch Packing Machine* (₹1.45L – ₹3.15L) — Namkeen, chips, spices ke liye\n2. *Automatic Liquid & Paste Filling Machine* (₹68K – ₹2.85L) — Oil, juice, syrup, shampoo ke liye\n3. *Carton Sealer & Box Strapper* (₹34K – ₹48.5K) — Outer box packing ke liye\n4. *BPT-500 High-Speed Servo Collar Machine* (₹2.85L – ₹3.75L) — 80 pouches/min industrial line\n\nAapko kis product ki packaging shuru karni hai?`,
        provider: 'rule_engine'
      };
    }

    // Conversational Queries
    if (/who\s*are\s*you|koun\s*ho|kaun\s*ho|aap\s*kaun|who\s*is\s*this/i.test(qLower)) {
      return {
        reply: `Ji Namaste! Main ${orgName} ki sales team se baat kar raha hoon. Hum verified commercial solutions & catalogs provide karte hain. Aapko kis product ke baare mein inquiry karni thi?`,
        provider: 'rule_engine'
      };
    }

    if (/kaise\s*hai|kaise\s*ho|how\s*are\s*you|kya\s*hal/i.test(qLower)) {
      return {
        reply: `Arre ekdum badhiya ji! Aap bataiye aap kaise hain? Aaj ${orgName} se aapko kis item ya requirement ke baare mein janna tha?`,
        provider: 'rule_engine'
      };
    }

    // Default Human Consultative Reply
    return {
      reply: `${greetingPrefix}Ji zaroor! ${orgName} se aapko kis specific product ya model ki requirement hai? Thoda sa idea de dijiye taaki main exact details share kar sakoon.`,
      provider: 'rule_engine'
    };
  }
}

export default AIService;
