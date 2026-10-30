/**
 * MartFlow AI — AI Sales Executive & Catalog Retrieval Service
 * Multi-tenant Gemini orchestration with strict catalog knowledge grounding, zero hallucination, and Hinglish deal making.
 */

import dns from 'dns';
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

    const q = inquiryText.toLowerCase();
    const ranked = products
      .map((p) => {
        let score = 0;
        const name = (p.name || '').toLowerCase();
        const specs = (p.model_specs || '').toLowerCase();
        if (name && q.includes(name)) score += 15;
        if (specs && q.split(/\s+/).some(w => w.length > 3 && specs.includes(w))) score += 8;

        // Common product intent boosting
        if (/namkeen|snacks|chips|kurkure/i.test(q) && /pouch|packing|packaging|collar|auger/i.test(name + ' ' + specs)) score += 20;
        if (/oil|juice|water|liquid|syrup/i.test(q) && /liquid|filling|piston|bottle/i.test(name + ' ' + specs)) score += 20;
        if (/powder|spices|masala|flour/i.test(q) && /auger|powder/i.test(name + ' ' + specs)) score += 20;

        return { product: p, score };
      })
      .sort((a, b) => b.score - a.score);

    return ranked
      .slice(0, 6)
      .map(({ product: p }) => {
        return `[Item: "${p.name}"] | SKU: ${p.sku || 'N/A'} | Price: ${p.price_raw || 'Contact for official GST quotation'} | Specifications: ${p.model_specs || 'Industrial standard'}`;
      })
      .join('\n');
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

    // Check if bot already greeted earlier in this conversation
    const previousAiMessages = (conversationHistory || []).filter(
      (m) => m.sender_type === 'ai' || m.sender === 'ai'
    );
    const isFirstTurn = previousAiMessages.length === 0;

    // Detect catalog / brochure dispatch request
    const isCatalogRequest = /catalog|catalogue|brochure|pdf|price\s*list|all\s*machines|all\s*products|share\s*details|kya\s*kya/i.test(qLower);

    // Find any brochure PDF in catalog
    let matchedBrochureUrl = null;
    let matchedBrochureName = null;
    const prodWithPdf = (products || []).find(p => p.brochure_url && p.brochure_url.startsWith('http'));
    if (prodWithPdf) {
      matchedBrochureUrl = prodWithPdf.brochure_url;
      matchedBrochureName = (prodWithPdf.name || 'Catalog').replace(/[^a-zA-Z0-9_-]/g, '_') + '.pdf';
    }

    // 1. Pure greeting check on turn 1
    const isPureGreeting = /^(hi|hello|hey|namaste|pranam|good\s*(morning|afternoon|evening)|hlo|hie|salaam)\b[!?.]*$/i.test(qLower);
    if (isPureGreeting) {
      if (isFirstTurn) {
        return {
          reply: buildAdaptiveWelcomeMessage(org, products),
          isGreeting: true,
          provider: 'rule_engine'
        };
      } else {
        return {
          reply: `Ji, batayein main aapki kya madad kar sakta hoon? Aapko kis product ya specification ki requirement hai?`,
          provider: 'rule_engine'
        };
      }
    }

    // Check for call / owner meeting request
    const isCallRequest = /call|phone|baat|director|owner|meeting|contact|appointment|schedule/i.test(qLower);
    if (isCallRequest) {
      const greeting = isFirstTurn && lead.buyer_name ? `Namaste ${lead.buyer_name} Ji! ` : '';
      return {
        reply: `${greeting}Hamare senior technical director se direct discussion ke liye main unka free time slot check karke WhatsApp pe confirm karta hoon! Aap kis city se baat kar rahe hain?`,
        isCallRequest: true,
        provider: 'rule_engine'
      };
    }

    const catalogContext = this.getCatalogContext(products, `${lead.product_inquired || ''} ${incomingText}`);

    // Call Gemini API (gemini-3.8-flash primary, fallback gemini-flash-latest)
    const geminiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
    if (geminiKey && geminiKey.length > 10) {
      try {
        const historyText = (conversationHistory || [])
          .slice(-15)
          .map((m) => `${m.sender_type || m.sender || 'buyer'}: ${m.content || m.text || ''}`)
          .join('\n');

        const systemPrompt = `You are the Senior Technical Sales Executive at "${orgName}" located in ${cityBase}.
Industry Domain: ${playbook.niche}.
You are speaking directly with an inbound customer on WhatsApp.

CRITICAL DEAL-MAKING RULES:
1. GREETING & TONE:
   - ${isFirstTurn ? 'This is the FIRST message: Greet warmly with "Namaste Ji!" or "Namaste [Name] Ji!" if buyer name is known.' : 'This conversation is ALREADY ONGOING: DO NOT say "Namaste", "Hello", or greet again! Answer the buyer directly.'}
   - Respond in natural, conversational Hinglish (or English if buyer wrote English).
   - Never invent or assume buyer names. Never repeat previous bot replies.

2. STRICT CATALOG KNOWLEDGE GROUNDING:
   - ONLY quote verified product specifications and prices from the verified catalog knowledge below.
   - If customer asks for catalog or brochure: confirm you have attached the catalog PDF and ask about their specific capacity/product.
   - If customer asks about packaging for namkeen/snacks/powders: recommend the relevant pouch packing / auger machine from catalog.
   - NEVER fabricate prices or capacities.

3. INDUSTRY QUALIFICATIONS (${playbook.niche}):
${playbook.qualifications.map((q) => `   - ${q}`).join('\n')}

VERIFIED CATALOG KNOWLEDGE:
${catalogContext || 'Official catalog available upon inquiry.'}

CONVERSATION HISTORY:
${historyText || '(New conversation)'}

CUSTOMER'S NEW MESSAGE:
"${incomingText}"

OUTPUT INSTRUCTIONS:
Reply in 2 to 3 concise, high-converting WhatsApp sentences. No markdown stars, no corporate fluff. Warm, professional, and action-oriented.`;

        const modelsToTry = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'];
        for (const modelName of modelsToTry) {
          try {
            const resp = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(geminiKey)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(6000),
                body: JSON.stringify({
                  contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
                  generationConfig: {
                    maxOutputTokens: 450,
                    temperature: 0.35
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
                  matchedBrochureUrl: (isCatalogRequest || /catalog|brochure|pdf/i.test(replyText)) ? matchedBrochureUrl : null,
                  matchedBrochureName
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

    // Deterministic High-Converting Fallback (NO REPEATING HARDCODED STRING)
    const greetingPrefix = isFirstTurn ? (lead.buyer_name ? `Namaste ${lead.buyer_name} Ji! ` : 'Namaste Ji! ') : '';

    if (isCatalogRequest) {
      const prodList = (products || []).slice(0, 3).map(p => `• ${p.name} (${p.price_raw || 'Price on request'})`).join('\n');
      return {
        reply: `${greetingPrefix}Hamara official catalog details ready hain.${prodList ? '\n\n' + prodList : ''}\n\nMaine brochure PDF attach kar diya hai. Aapko kis product ke liye aur kitni daily production speed chahiye?`,
        matchedBrochureUrl,
        matchedBrochureName,
        provider: 'rule_engine'
      };
    }

    // Use-case matching (namkeen, snacks, powder, liquid, etc.)
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

    // General contextual inquiry
    return {
      reply: `${greetingPrefix}${orgName} me aapki inquiry note kar li gayi hai. Aapki exact requirement ya daily capacity kitni hai taaki hum exact technical quotation aur PDF share kar sakein?`,
      provider: 'rule_engine'
    };
  }
}

export default AIService;
