import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
const XLSX = require('xlsx');
import pino from 'pino';
import dotenv from 'dotenv';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers
} from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';

import apiRouter from './src/routes/api.js';
import { baileysManager } from './src/integrations/whatsapp/baileysManager.js';
import db from './src/db/index.js';

dotenv.config();

// Global crash handlers to prevent server crashes
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message, err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/catalogs', express.static(path.join(__dirname, 'catalogs')));
app.use(express.static(path.join(__dirname, 'public')));

// Mount MartFlow AI Multi-Tenant SaaS API
app.use('/api', apiRouter);

const CONFIG_FILE = path.join(__dirname, 'config.json');
const LEADS_FILE = path.join(__dirname, 'leads_db.json');
const AUTH_DIR = path.join(__dirname, 'auth_info');

// Default seller profile (editable live from dashboard for ANY client!)
const defaultConfig = {
  companyName: 'Bharat PackTech Machinery',
  cityBase: 'Delhi NCR / Ludhiana Dispatch Hub',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  ownerAlertPhone: process.env.OWNER_ALERT_PHONE || '',
  replyDelaySec: 3,
  autoReplyEnabled: true,
  replyWithVoiceNotes: true,
  products: [
    {
      id: 'pouch',
      name: 'Automatic Pouch Packing Machine',
      keywords: ['pouch', 'packing', 'namkeen', 'masala', 'spice', 'haldi', 'granule', 'collar', 'chips', 'kurkure', 'tea', 'pulse'],
      catalogFile: 'Pouch-Packing-Machine-Catalog.pdf',
      priceRange: '₹1,45,000 – ₹3,15,000 + GST (40–65 Pouches/Min, SS-304 Food Grade, Delta PLC)'
    },
    {
      id: 'liquid',
      name: 'Automatic Liquid & Paste Filling Machine',
      keywords: ['liquid', 'filling', 'oil', 'paste', 'bottle', 'juice', 'honey', 'sauce', 'ketchup', 'shampoo', 'ghee', 'handwash'],
      catalogFile: 'Liquid-Paste-Filling-Machine-Catalog.pdf',
      priceRange: '₹68,000 (Semi-Auto) to ₹2,10,000 – ₹3,45,000 + GST (4/6-Head Servo Anti-Drip)'
    },
    {
      id: 'carton',
      name: 'Carton Sealer, Box Strapping & Shrink Tunnel',
      keywords: ['carton', 'taping', 'sealer', 'strapping', 'shrink', 'box', 'wrapping', 'tunnel', 'corrugated'],
      catalogFile: 'Shrink-Tunnel-Carton-Sealer-Catalog.pdf',
      priceRange: '₹34,000 (Strapper) | ₹48,500 (Carton Taper) | ₹62,000 (Shrink Tunnel) + GST'
    }
  ]
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const merged = { ...defaultConfig, ...saved };
      if (!merged.geminiApiKey && process.env.GEMINI_API_KEY) {
        merged.geminiApiKey = process.env.GEMINI_API_KEY;
      }
      return merged;
    }
  } catch (e) {
    console.error('Config load error:', e.message);
  }
  return { ...defaultConfig };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

let config = loadConfig();

function loadLeads() {
  try {
    if (fs.existsSync(LEADS_FILE)) {
      return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Leads load error:', e.message);
  }
  return [];
}

function saveLeads(list) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

let leads = loadLeads();

// Normalize Indian & International phone numbers -> digits only (e.g. 919876543210)
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 11) {
    digits = '91' + digits.slice(1);
  } else if (digits.length === 10) {
    digits = '91' + digits;
  }
  return digits;
}

const LEARNINGS_FILE = path.join(__dirname, 'learnings_db.json');

function loadLearnings() {
  try {
    if (fs.existsSync(LEARNINGS_FILE)) {
      return JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Learnings load error:', e.message);
  }
  return {
    lastUpdated: new Date().toISOString(),
    totalLearningsCount: 0,
    synonyms: {},
    faqs: [],
    customerPreferences: { popularModels: [], commonPackSizes: [] }
  };
}

function saveLearnings(data) {
  try {
    fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Learnings save error:', e.message);
  }
}

let learnings = loadLearnings();

const KNOWLEDGE_FILE = path.join(__dirname, 'catalog_knowledge.json');

function loadCatalogKnowledge() {
  try {
    if (fs.existsSync(KNOWLEDGE_FILE)) {
      return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Catalog knowledge read error:', e.message);
  }
  return { files: [], textKnowledge: '' };
}

function saveCatalogKnowledge(data) {
  try {
    fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Catalog knowledge save error:', e.message);
  }
}

async function initCatalogKnowledge() {
  try {
    let k = loadCatalogKnowledge();
    if (k.textKnowledge && k.textKnowledge.length > 100) return;

    const catDir = path.join(__dirname, 'catalogs');
    if (!fs.existsSync(catDir)) return;

    const files = fs.readdirSync(catDir).filter((f) => f.endsWith('.pdf'));
    const parts = [];
    const registeredFiles = [];

    for (const f of files) {
      try {
        const buf = fs.readFileSync(path.join(catDir, f));
        const p = new pdf.PDFParse({ data: buf });
        const res = await p.getText();
        const txt = (res.text || '').trim();
        if (txt) {
          parts.push(`=== FILE: ${f} ===\n${txt}`);
          registeredFiles.push({ filename: f, type: 'pdf', length: txt.length });
        }
      } catch (err) {
        console.error(`Error indexing ${f}:`, err.message);
      }
    }

    k = {
      files: registeredFiles,
      textKnowledge: parts.join('\n\n')
    };
    saveCatalogKnowledge(k);
    addLog(`Indexed ${registeredFiles.length} catalog files into dynamic AI knowledge base.`);
  } catch (e) {
    console.error('Catalog knowledge init error:', e.message);
  }
}

// Smart multi-product matcher & disambiguator with full submodel analysis
function findProductMatches(queryText = '') {
  const lower = String(queryText || '').toLowerCase().trim();
  if (!lower) return [config.products[0]];

  // 1. Direct option selection (e.g., '1', '2', '3', 'option 1', 'pehli')
  if (lower === '1' || lower.startsWith('1 ') || lower.includes('option 1') || lower.includes('pehli') || lower.includes('first')) {
    return [config.products[0]];
  }
  if (lower === '2' || lower.startsWith('2 ') || lower.includes('option 2') || lower.includes('dusri') || lower.includes('second')) {
    return config.products[1] ? [config.products[1]] : [config.products[0]];
  }
  if (lower === '3' || lower.startsWith('3 ') || lower.includes('option 3') || lower.includes('teesri') || lower.includes('third')) {
    return config.products[2] ? [config.products[2]] : [config.products[0]];
  }

  // 2. Check learned synonyms
  const l = loadLearnings();
  for (const [syn, mapped] of Object.entries(l.synonyms || {})) {
    if (lower.includes(syn.toLowerCase())) {
      const match = config.products.find(
        (p) => mapped.toLowerCase().includes(p.id) || mapped.toLowerCase().includes(p.name.toLowerCase())
      );
      if (match) return [match];
    }
  }

  // 3. Score all products based on full catalog analysis (sub-models, keywords, applications)
  const scored = [];
  for (const p of config.products) {
    let score = 0;
    if (lower.includes(p.id)) score += 10;
    if (lower.includes(p.name.toLowerCase())) score += 15;

    // Check subModels (e.g. BPT-500, Auger, Piston, Servo, Taper, Strapper)
    for (const sm of (p.subModels || [])) {
      if (lower.includes(sm.name.toLowerCase())) score += 20;
      if (sm.suitableFor && sm.suitableFor.toLowerCase().split(/[\s,]+/).some((w) => w.length > 3 && lower.includes(w))) {
        score += 8;
      }
    }

    // Check keywords
    for (const kw of p.keywords) {
      if (lower.includes(kw.toLowerCase())) score += 5;
    }

    if (score > 0) {
      scored.push({ product: p, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // If query is broad / generic (e.g. 'packing machine', 'machine', 'packing', 'filling') and matches multiple categories
  const isGeneric = ['packing machine', 'packaging machine', 'machine', 'packing', 'filling', 'sealer'].some((g) => lower === g || lower === `${g} chahiye` || lower === `${g} price` || lower === `${g} rate`);
  if (isGeneric && scored.length > 1) {
    return scored.map((s) => s.product);
  }

  if (scored.length > 0) {
    if (scored.length === 1 || scored[0].score >= (scored[1]?.score || 0) + 10) {
      return [scored[0].product];
    }
    return scored.map((s) => s.product);
  }

  return [config.products[0]];
}

// Match inquiry product name to the best PDF catalog
function matchProduct(queryText = '') {
  const matches = findProductMatches(queryText);
  return matches[0] || config.products[0];
}

// Autonomous learning loop: extracts customer terms, abbreviations, and verified FAQs
function analyzeAndLearnFromChat(lead, incomingText, aiResult) {
  try {
    const text = String(incomingText || '').trim();
    if (!text || text.length < 3) return;

    let modified = false;
    learnings = loadLearnings();
    if (!learnings.synonyms) learnings.synonyms = {};
    if (!learnings.faqs) learnings.faqs = [];

    const lower = text.toLowerCase();
    const currentProd = matchProduct(lead.productName || text);

    // 1. Learn machinery model abbreviations / slang
    const modelTerms = [
      'bpt 500', 'bpt-500', 'collar plc', 'auger filler', 'pneumatic sealer',
      'piston filler', 'servo filler', 'carton taper', 'box strapper', 'shrink tunnel',
      'ffs machine', 'vffs', 'flow wrap', 'band sealer'
    ];
    for (const term of modelTerms) {
      if (lower.includes(term) && !learnings.synonyms[term]) {
        learnings.synonyms[term] = currentProd.name;
        learnings.totalLearningsCount = (learnings.totalLearningsCount || 0) + 1;
        modified = true;
        addLog(`🧠 Self-Learning: Learned buyer model term "${term}" -> ${currentProd.name}`);
      }
    }

    // 2. Learn city phonetic spelling / typos
    if (aiResult.extractedCity) {
      const city = aiResult.extractedCity.trim();
      const cityLower = city.toLowerCase();
      const words = lower.split(/[\s,]+/);
      for (const w of words) {
        if (w.length >= 4 && w !== cityLower && (cityLower.startsWith(w.slice(0, 4)) || w.startsWith(cityLower.slice(0, 4)))) {
          if (!learnings.synonyms[w]) {
            learnings.synonyms[w] = city;
            learnings.totalLearningsCount = (learnings.totalLearningsCount || 0) + 1;
            modified = true;
            addLog(`🧠 Self-Learning: Learned city typo "${w}" -> ${city}`);
          }
        }
      }
    }

    // 3. Learn FAQs from technical questions
    const faqTriggers = [
      { key: 'single phase', query: 'single phase or 220v load' },
      { key: 'compressor', query: 'air compressor requirement' },
      { key: 'nitrogen', query: 'nitrogen flushing shelf life' },
      { key: 'warranty', query: 'on-site warranty & technician' },
      { key: 'gst', query: '18% GST input credit' }
    ];
    for (const ft of faqTriggers) {
      if (lower.includes(ft.key)) {
        const exists = learnings.faqs.some((f) => f.trigger.includes(ft.key));
        if (!exists && aiResult.reply) {
          learnings.faqs.push({
            trigger: ft.query,
            learnedAnswer: aiResult.reply.slice(0, 180)
          });
          learnings.totalLearningsCount = (learnings.totalLearningsCount || 0) + 1;
          modified = true;
          addLog(`🧠 Self-Learning: Saved customer FAQ answer for "${ft.key}".`);
        }
      }
    }

    if (modified) {
      learnings.lastUpdated = new Date().toISOString();
      saveLearnings(learnings);
    }
  } catch (err) {
    console.error('Learning loop error:', err.message);
  }
}

// High-Speed Natural Indian Hinglish Voice Note Synthesizer (PTT Opus OGG)
async function convertMp3ToOpusOgg(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegInstaller.path, [
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ar', '48000',
      '-ac', '1',
      '-f', 'ogg',
      'pipe:1'
    ]);
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', () => {});
    ff.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error('ffmpeg conversion error: ' + code));
    });
    ff.on('error', (err) => reject(err));
    ff.stdin.write(mp3Buffer);
    ff.stdin.end();
  });
}

async function generateTtsAudio(rawText) {
  try {
    const cleaned = String(rawText || '')
      .replace(/[*#_•👉📌✅🙏1️⃣2️⃣3️⃣📘📄📸🔥💡🚨⏰👍]/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[()]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return null;

    // Break into natural chunks of max 140 chars for Google TTS
    const words = cleaned.split(' ');
    const textChunks = [];
    let curr = '';
    for (const w of words) {
      if ((curr + ' ' + w).length <= 140) {
        curr = curr ? curr + ' ' + w : w;
      } else {
        textChunks.push(curr);
        curr = w;
      }
      if (textChunks.length >= 2) break; // Keep voice notes punchy (10-15 seconds)
    }
    if (curr && textChunks.length < 2) textChunks.push(curr);

    const mp3Parts = [];
    for (const chunk of textChunks) {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=hi&client=tw-ob`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (resp.ok) {
        mp3Parts.push(Buffer.from(await resp.arrayBuffer()));
      }
    }

    if (!mp3Parts.length) return null;
    const combinedMp3 = Buffer.concat(mp3Parts);

    // Convert MP3 to WhatsApp's mandatory native Opus in Ogg container!
    const oggOpusBuffer = await convertMp3ToOpusOgg(combinedMp3);
    return oggOpusBuffer;
  } catch (err) {
    addLog(`TTS generation error: ${err.message}`);
    return null;
  }
}

// ============================================================================
// WHATSAPP BAILEYS SOCKET ENGINE
// ============================================================================
let sock = null;
let waState = {
  status: 'disconnected', // disconnected | connecting | qr_ready | connected
  qrDataUrl: null,
  connectedNumber: null,
  lastEvent: 'Click "Connect Spare WhatsApp SIM" to generate QR code.',
  logs: []
};

function addLog(msg) {
  const entry = `[${new Date().toLocaleTimeString('en-IN')}] ${msg}`;
  console.log(entry);
  waState.logs.unshift(entry);
  if (waState.logs.length > 60) waState.logs.pop();
}

let isConnecting = false;
let reconnectTimer = null;
let lidToPhoneMap = {}; // Maps WhatsApp @lid JIDs to normalized phone numbers

async function startWhatsApp() {
  if (isConnecting) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  isConnecting = true;
  waState.status = 'connecting';
  waState.lastEvent = 'Initializing WhatsApp multi-device session...';
  addLog('Starting WhatsApp WebSocket engine...');

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1043857760];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) version = latest.version;
    } catch {
      // Fallback version works fine if offline check times out
    }

    try {
      if (sock) {
        sock.ev.removeAllListeners();
        sock.end();
      }
    } catch {}

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.windows('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    baileysManager.sock = sock;
    baileysManager.state = waState;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        waState.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        waState.status = 'qr_ready';
        waState.lastEvent = 'Scan QR Code with your Spare WhatsApp Business / WhatsApp App -> Linked Devices';
        addLog('Fresh WhatsApp QR code generated! Open dashboard to scan.');
      }

      if (connection === 'open') {
        isConnecting = false;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        waState.status = 'connected';
        waState.qrDataUrl = null;
        const rawMe = sock.user?.id || '';
        waState.connectedNumber = rawMe.split(':')[0].split('@')[0];
        waState.lastEvent = `Live & Connected as +${waState.connectedNumber}`;
        addLog(`WhatsApp CONNECTED successfully (+${waState.connectedNumber})`);
      }

      if (connection === 'close') {
        isConnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        waState.qrDataUrl = null;

        if (loggedOut) {
          waState.status = 'disconnected';
          waState.connectedNumber = null;
          waState.lastEvent = 'Logged out from phone. Click Reset & Connect to scan again.';
          addLog('Session logged out. Clearing auth_info folder.');
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch {}
        } else {
          // In Baileys, code 515 (restartRequired) is standard after scanning QR code or updating session
          const isRestart = statusCode === DisconnectReason.restartRequired;
          waState.status = 'connecting';
          waState.lastEvent = isRestart
            ? 'Pairing handshake complete. Finalizing session connection...'
            : `Connection interrupted (code: ${statusCode || 'net'}). Reconnecting...`;
          addLog(`WhatsApp closed (code: ${statusCode || 'network'}). Auto-reconnecting in 1.5s...`);
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            startWhatsApp();
          }, 1500);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          await handleIncomingWhatsAppMessage(msg);
        } catch (err) {
          addLog(`Message handler error: ${err.message}`);
        }
      }
    });
  } catch (err) {
    isConnecting = false;
    waState.status = 'disconnected';
    waState.lastEvent = `Startup error: ${err.message}`;
    addLog(`WhatsApp init error: ${err.message}`);
  }
}

async function resolveWhatsAppJid(phoneDigits) {
  if (!sock || waState.status !== 'connected') {
    throw new Error('WhatsApp is not connected yet. Scan the QR code first.');
  }
  const clean = normalizePhone(phoneDigits);
  try {
    const [result] = await sock.onWhatsApp(clean);
    if (result?.exists && result?.jid) {
      return result.jid;
    }
  } catch {
    // Fallback to standard JID
  }
  return `${clean}@s.whatsapp.net`;
}

// ============================================================================
// AI BRAIN: GEMINI 2.5 FLASH (TEXT + VOICE NOTES) + ZERO-KEY HINGLISH FALLBACK
// ============================================================================
async function generateSalesReply({ lead, incomingText, audioBuffer, audioMime }) {
  const learningsData = loadLearnings();
  const learnedSynonymsList = Object.entries(learningsData.synonyms || {})
    .slice(0, 20)
    .map(([k, v]) => `"${k}" -> ${v}`)
    .join(', ');
  const learnedFaqsList = (learningsData.faqs || [])
    .slice(0, 6)
    .map((f) => `• ${f.trigger}: ${f.learnedAnswer}`)
    .join('\n');

  const catalogSummary = config.products
    .map((p) => {
      const sub = (p.subModels || [])
        .map((sm) => `  * ${sm.name}: ${sm.price} (${sm.speed}, pack size: ${sm.packSize || 'flexible'}, best for: ${sm.suitableFor})`)
        .join('\n');
      return `📌 CATEGORY: ${p.name} (Base Range: ${p.priceRange})\n${sub || '  * Standard production line model'}`;
    })
    .join('\n\n');

  const historyText = (lead.history || [])
    .slice(-8)
    .map((h) => `${h.role === 'buyer' ? 'Buyer' : 'Sales AI'}: ${h.text}`)
    .join('\n');

  // If Gemini API key is configured, use real LLM + native Voice Note audio understanding!
  if (config.geminiApiKey && config.geminiApiKey.trim().length > 15) {
    const knowledgeData = loadCatalogKnowledge();
    const catalogKnowledgeText = (knowledgeData.textKnowledge || '').slice(0, 5000);

    const systemInstruction = `You are the Senior B2B Sales Specialist on WhatsApp for "${config.companyName}" (${config.cityBase}).
Speak natural, polite, confident Indian B2B Hinglish (mix of simple English & Roman Hindi like real factory sales managers use on WhatsApp—keep it concise: 3 to 5 short lines max, WhatsApp friendly with bullet points if needed).

COMPANY'S PRODUCT CATALOG & ACTIVE SPECIFICATIONS:
${catalogSummary}

FULL EXTRACTED CATALOG KNOWLEDGE BASE (FROM UPLOADED PDF BROCHURES & EXCEL SHEETS):
${catalogKnowledgeText || 'Standard factory specifications apply.'}

AUTONOMOUSLY LEARNED BUYER SLANG & SYNONYMS:
${learnedSynonymsList || 'No learned synonyms yet'}

AUTONOMOUSLY LEARNED FAQ KNOWLEDGE:
${learnedFaqsList || 'Standard factory specs apply'}

CURRENT LEAD CONTEXT:
- Customer Name: ${lead.name ? lead.name : '[NOT SHARED YET - DO NOT INVENT A NAME]'}
- Product Enquired: ${lead.productName}
- Known Delivery City: ${lead.city || 'Unknown'}
- Known Requirements / Specs: ${lead.requirement || 'Unknown'}

CONVERSATION SO FAR:
${historyText || '(First reply after sending PDF catalog)'}

CRITICAL RULES:
1. STRICT CUSTOMER NAME RULE:
   - NEVER invent, assume, or guess the customer's name!
   - ONLY address the customer by their name IF they have explicitly stated their name in the chat (e.g. "Mera naam Ramesh hai", "I am Vikram", "This is Amit") or if a verified name is present in CURRENT LEAD CONTEXT above.
   - If the customer has NOT explicitly shared their name, ALWAYS address them respectfully with neutral Indian B2B terms: "Namaste Ji!", "Ji Sir", or "Sir/Ma'am".
   - Under NO circumstances should you call them "Rajesh", "Rahul", "Buyer", or any random/made-up name!

2. UNIVERSAL PRODUCT INGESTION & ANALYSIS RULE:
   - The company sells WHATEVER products are listed in the uploaded catalog and knowledge base above (packaging machines, industrial components, chemicals, garments, hardware, electronics, etc.).
   - Carefully analyze and answer inquiries for ANY product found in the catalog knowledge above.
   - If the customer asks for a product using partial names, slang, or specs from the catalog, match it accurately.
   - If multiple models or variants match the customer's broad query, present 1-2-3 clear options from the catalog.
   - If a product is truly not present in the uploaded catalog, politely inform the customer what product lines the company specializes in from the catalog.

3. ANTI-REPETITION:
   - Carefully inspect CONVERSATION SO FAR:
   - If the customer already specified their product/model, city, or specs, NEVER ask for those details again!
   - Acknowledge what they said with genuine excitement and move to the immediate next step.

4. 1-2-3 MULTI-PRODUCT SELECTION RULE:
   - If the customer's inquiry is broad or matches multiple models in the catalog, present 1-2-3 options and ask them: "Bas 1, 2 ya 3 reply kar dijiye ya product bata dijiye!"

5. PRODUCT PHOTO REQUEST:
   - If the customer asked for photos/pics ("photo bhejo", "pics", "dikhao", "image", etc.), acknowledge warmly: "Maine aapko factory floor se machine/product ki live photo WhatsApp pe attach kar di hai! 🙏" and ask if they would also like a live video demonstration!

6. OWNER UNAVAILABLE / CALL REQUEST RULE:
   - If the customer asks for a phone call, asks to speak with owner/engineer, complains about no call, or asks when they will get a call:
     - Reassure them: "Namaste Ji! Hamare technical director abhi manufacturing plant floor pe hain. Main turant unse unka free time confirm karke aapko update karta hoon ki wo kis time call karenge!"
     - Confirm that their product requirement and delivery city are locked in priority queue.
     - Set "requestedCallback": true in the output.

7. If missing details remain (e.g. pack weight, quantity, or city), ask specifically for only that one detail.

Respond STRICTLY as valid JSON without markdown fences:
{
  "reply": "Your concise WhatsApp message here",
  "extractedCustomerName": "real name ONLY if customer explicitly introduced themselves in this message (e.g. 'Mera naam Vikas hai' -> 'Vikas'), else empty string",
  "extractedCity": "city name if customer mentioned it, else empty string",
  "extractedRequirement": "product model or item mentioned, else empty string",
  "transcriptSummary": "if voice note, 1-line summary, else empty string",
  "isHotLead": true or false,
  "requestedCallback": true or false,
  "preferredCallbackTime": "time slot if mentioned, else empty string"
}`;

    const parts = [{ text: systemInstruction }];
    if (audioBuffer) {
      const cleanMime = (audioMime || 'audio/ogg').split(';')[0].trim();
      parts.push({
        inline_data: {
          mime_type: cleanMime,
          data: audioBuffer.toString('base64')
        }
      });
      parts.push({ text: 'Buyer sent the attached WhatsApp voice note. Understand their Hindi/Punjabi/English audio and generate the JSON response.' });
    } else {
      parts.push({ text: `Buyer's new WhatsApp message: "${incomingText}"` });
    }

    const modelsToTry = [
      'gemini-3.5-flash',
      'gemini-3-flash-preview',
      'gemini-3.5-flash-lite',
      'gemini-flash-latest',
      'gemini-3.7-flash',
      'gemini-3.1-pro-preview'
    ];
    for (const modelName of modelsToTry) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(config.geminiApiKey.trim())}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts }],
              generationConfig: {
                temperature: 0.4,
                responseMimeType: 'application/json'
              }
            })
          }
        );

        if (resp.ok) {
          const data = await resp.json();
          const rawJson = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const cleaned = rawJson.replace(/```json|```/g, '').trim();
          const parsed = JSON.parse(cleaned);
          if (parsed?.reply) {
            if (parsed.extractedCustomerName && parsed.extractedCustomerName.trim().length >= 2) {
              const cleanExtracted = parsed.extractedCustomerName.trim();
              if (!/^(buyer|sir|unknown|rajesh|customer|user)$/i.test(cleanExtracted)) {
                lead.name = cleanExtracted;
              }
            }
            return parsed;
          }
        } else {
          const errTxt = await resp.text();
          addLog(`Gemini (${modelName}) HTTP ${resp.status}: ${errTxt.slice(0, 120)}`);
        }
      } catch (e) {
        addLog(`Gemini call fallback notice: ${e.message}`);
      }
    }
  }

  // ==========================================================================
  // SMART BUILT-IN HINGLISH FALLBACK (Works with ZERO API Key!)
  // ==========================================================================
  const msg = String(incomingText || '').toLowerCase();
  const matchedProd = matchProduct(msg || lead.productName);

  // Extract Indian cities if mentioned (including common typos)
  const cities = [
    'delhi', 'noida', 'gurgaon', 'faridabad', 'ghaziabad', 'ludhiana', 'chandigarh', 'amritsar', 'amritsra', 'jalandhar',
    'jaipur', 'mumbai', 'pune', 'surat', 'ahmedabad', 'rajkot', 'vadodara', 'indore', 'bhopal', 'lucknow',
    'kanpur', 'patna', 'kolkata', 'hyderabad', 'bangalore', 'bengaluru', 'chennai', 'coimbatore', 'nagpur', 'raipur',
    'punjab', 'haryana', 'up', 'uttar pradesh', 'gujarat', 'maharashtra', 'rajasthan'
  ];
  const foundCityRaw = cities.find((c) => msg.includes(c));
  const cityResolved = foundCityRaw === 'amritsra' ? 'amritsar' : foundCityRaw;
  const cityCap = cityResolved ? cityResolved.charAt(0).toUpperCase() + cityResolved.slice(1) : '';

  // Extract weight/qty mentions (e.g., 100g, 500gm, 1kg, 50 pouch, Namkeen, Masala)
  const sizeMatch = msg.match(/(\d+\s?(g|gm|gram|kg|ml|ltr|liter|pouch|bottle|piece|machine|ton))/i);
  const itemWords = [
    'namkeen', 'masala', 'haldi', 'mirch', 'oil', 'kurkure', 'chips', 'tea', 'atta', 'besan', 'detergent', 'juice', 'paste', 'honey', 'box', 'carton',
    'bpt', 'collar', 'plc', 'auger', 'ffs', 'pneumatic', 'pouch', 'granule', 'powder'
  ];
  const foundItem = itemWords.find((w) => msg.includes(w));
  const extractedReq = [foundItem ? foundItem.toUpperCase() : '', sizeMatch ? sizeMatch[0] : ''].filter(Boolean).join(' ').trim() || (msg.length < 50 ? msg.trim() : '');

  // Extract customer name ONLY if they explicitly introduced themselves!
  const nameIntroMatch = msg.match(/(?:mera naam|my name is|i am|this is|naam hai)\s+([a-zA-Z\u0900-\u097F]+)/i);
  if (nameIntroMatch && nameIntroMatch[1]) {
    const rawN = nameIntroMatch[1].trim();
    if (!/^(buyer|sir|ji|kya|hai|koi|machin|machine|need)$/i.test(rawN)) {
      lead.name = rawN.charAt(0).toUpperCase() + rawN.slice(1).toLowerCase();
    }
  }

  const politeSir = lead.name ? `${lead.name} ji` : 'Sir';
  const politeGreeting = lead.name ? `Namaste *${lead.name} ji*!` : 'Namaste Ji!';

  if (audioBuffer) {
    return {
      reply: `Ji ${politeSir}, aapka voice note mil gaya! 🙏\n*${matchedProd.name}* mein hamare paas models ready stock mein hain (${matchedProd.priceRange}).\n\nExact quotation aur live product video bhejne ke liye bas batayein:\n1️⃣ Kya item pack/fill karna hai?\n2️⃣ Delivery kis City mein chahiye?`,
      extractedCity: '',
      extractedRequirement: 'Voice Note Received',
      transcriptSummary: 'Voice Note',
      isHotLead: true
    };
  }

  let reply = '';
  const effectiveCity = cityCap || lead.city;
  const effectiveReq = extractedReq || lead.requirement;

  // Check if buyer asked for a call
  if (msg.includes('call') || msg.includes('phone') || msg.includes('baat') || msg.includes('number') || msg.includes('kab call')) {
    return {
      reply: `${politeGreeting} 🙏 Hamare technical director abhi manufacturing plant floor pe hain. Main turant unse unka free time pooch kar aapko WhatsApp pe confirm karta hoon ki wo kis time call karenge! Tab tak hamara technical brochure zaroor check kar lijiye.`,
      extractedCity: cityCap || lead.city || '',
      extractedRequirement: extractedReq || lead.requirement || '',
      transcriptSummary: '',
      isHotLead: true,
      requestedCallback: true
    };
  }

  // Check if we already greeted the customer in recent history
  const alreadyGreeted = (lead.history || []).some((h) => h.role === 'ai' && (h.text.includes('swagat hai') || h.text.includes('Price List')));

  if (msg.includes('price') || msg.includes('rate') || msg.includes('kitne') || msg.includes('cost') || msg.includes('budget')) {
    reply = `Ji ${politeSir}, *${matchedProd.name}* ki ex-factory range *${matchedProd.priceRange}* hai.\n\n${
      !effectiveReq
        ? 'Exact model suggest karne ke liye batayein aap *kya product/item* produce ya pack karna chahte hain?'
        : !effectiveCity
        ? `Great! *${effectiveReq}* ke liye model ready stock mein hai. Aapki unit kis *City* mein hai taaki transport jod ke final quote bhej sakein?`
        : `Perfect! *${effectiveReq}* (${effectiveCity} delivery) ke liye hamare Senior Specialist aapko final GST quote aur details bhej rahe hain. Kya 2 min call pe baat ho sakti hai?`
    }`;
  } else if (msg.includes('single phase') || msg.includes('bijli') || msg.includes('power') || msg.includes('warranty')) {
    reply = `Haan ji ${politeSir}! Standard models single-phase ya 3-phase option ke saath aate hain. Saath mein *1 Saal ki On-Site Warranty + Free Installation Support* milega.\n\nAapko kis application ke liye chahiye aur kis *City* mein delivery chahiye?`;
  } else if (effectiveCity && effectiveReq) {
    reply = `Bahut badhiya ${politeSir}! ✅ Maine note kar liya:\n• *Requirement:* ${effectiveReq}\n• *Delivery City:* ${effectiveCity}\n• *Suggested Line:* ${matchedProd.name} (${matchedProd.priceRange})\n\nHamare Senior Technical Engineer aapko final GST offer forward kar rahe hain! 🙏`;
  } else if (effectiveReq && !effectiveCity) {
    reply = `Noted ${politeSir}! *${effectiveReq}* ke liye hamara model best rahega (${matchedProd.priceRange}).\n\nBas apni *Delivery City / State* bata dijiye taaki main transport kharcha aur final GST rate bhej sakoon?`;
  } else if (effectiveCity && !effectiveReq) {
    reply = `Ji ${politeSir}, *${effectiveCity}* ke liye hamare dispatch hub se fast delivery ho jayegi.\n\nAapko isme *kaunsa item ya capacity* chahiye?`;
  } else if (alreadyGreeted) {
    reply = `Ji ${politeSir}, aapki details note kar li hain. Hamare Senior Factory Engineer aapko directly WhatsApp pe running video aur exact GST offer bhej rahe hain. Kya main call connect karwaun?`;
  } else {
    reply = `${politeGreeting} *${config.companyName}* mein aapka swagat hai.\n*${matchedProd.name}* (${matchedProd.priceRange}) ready stock mein available hai.\n\nExact quotation aur details ke liye bas 2 cheezein bata dijiye:\n1️⃣ Kaunsa item / capacity chahiye?\n2️⃣ Delivery kis *City* mein chahiye?`;
  }

  return {
    reply,
    extractedCity: cityCap,
    extractedRequirement: extractedReq,
    transcriptSummary: '',
    isHotLead: Boolean(effectiveCity || effectiveReq || msg.includes('price') || msg.includes('rate') || msg.includes('call'))
  };
}

// ============================================================================
// CORE B2B LEAD DISPATCHER (SENDS GREETING + PDF CATALOG IN 8 SECONDS)
// ============================================================================
async function processNewB2BLead({ name, phone, productQuery, city = '', message = '', source = 'B2B Push API', customDelaySec }) {
// Alias for compatibility
const processNewB2BLead = processNewB2BLead;
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone || cleanPhone.length < 10) {
    throw new Error('Valid 10-digit WhatsApp mobile number required.');
  }

  const product = matchProduct(`${productQuery} ${message}`);
  const delaySec = typeof customDelaySec === 'number' ? customDelaySec : Number(config.replyDelaySec ?? 3);

  let lead = leads.find((l) => l.phone === cleanPhone);
  const nowIso = new Date().toISOString();

  if (!lead) {
    lead = {
      id: 'IM-' + Date.now().toString().slice(-6),
      createdAt: nowIso,
      updatedAt: nowIso,
      name: (name && !/^(buyer|unknown|sir|rajesh)$/i.test(name.trim())) ? name.trim() : '',
      phone: cleanPhone,
      productName: product.name,
      catalogFile: product.catalogFile,
      city: city || '',
      requirement: message || '',
      source,
      pdfSent: false,
      ownerAlerted: false,
      status: 'Sending Catalog...',
      history: []
    };
    leads.unshift(lead);
  } else {
    lead.updatedAt = nowIso;
    if (name && !/^(buyer|unknown|sir|rajesh)$/i.test(name.trim())) lead.name = name.trim();
    lead.productName = product.name;
    lead.catalogFile = product.catalogFile;
    if (city) lead.city = city;
    if (message) lead.requirement = message;
    lead.status = 'Sending Catalog...';
  }
  saveLeads(leads);

  const openerGreeting = lead.name ? `Namaste *${lead.name} ji*!` : 'Namaste Ji!';
  const openerText =
    `${openerGreeting} 🙏\n\n` +
    `Thank you for your enquiry regarding *${product.name}* at *${config.companyName}*.\n\n` +
    `📄 Main aapko hamara *Technical PDF Brochure & Price List* neeche bhej raha hoon (${product.priceRange}).\n\n` +
    `Exact model aur final GST quotation dene ke liye bas batayein *(Text ya Voice Note bhej sakte hain)*:\n` +
    `1️⃣ Aapko *kya item aur kitni capacity* chahiye?\n` +
    `2️⃣ Delivery kis *City* mein chahiye?`;

  const leadDisplay = lead.name ? `${lead.name} (+${cleanPhone})` : `Customer (+${cleanPhone})`;
  addLog(`New B2B Lead: ${leadDisplay} -> ${product.name}. Waiting ${delaySec}s...`);

  // Run async after natural human-like delay
  setTimeout(async () => {
    try {
      if (waState.status !== 'connected' || !sock) {
        lead.status = 'Queued (Connect WhatsApp QR)';
        lead.history.push({ role: 'ai', text: `[DRY-RUN PREVIEW] ${openerText}`, ts: new Date().toISOString() });
        saveLeads(leads);
        addLog(`Dry-Run logged for +${cleanPhone} (Scan WhatsApp QR to send real messages).`);
        return;
      }

      const jid = await resolveWhatsAppJid(cleanPhone);
      await sock.sendPresenceUpdate('composing', jid);
      await new Promise((r) => setTimeout(r, 1500));

      // 1. Send personalized greeting
      await sock.sendMessage(jid, { text: openerText });

      // 2. Immediately send matching Product PDF Brochure
      const pdfPath = path.join(__dirname, 'catalogs', product.catalogFile);
      if (fs.existsSync(pdfPath)) {
        const pdfBuffer = fs.readFileSync(pdfPath);
        await sock.sendMessage(jid, {
          document: pdfBuffer,
          mimetype: 'application/pdf',
          fileName: product.catalogFile,
          caption: `📘 ${product.name} — Technical Specifications & Price List (${config.companyName})`
        });
        lead.pdfSent = true;
      }

      await sock.sendPresenceUpdate('paused', jid);
      lead.status = 'Catalog Sent (Awaiting Reply)';
      lead.updatedAt = new Date().toISOString();
      lead.history.push({ role: 'ai', text: openerText + ` [+ Attached ${product.catalogFile}]`, ts: lead.updatedAt });
      saveLeads(leads);
      addLog(`Sent Greeting + ${product.catalogFile} to +${cleanPhone}!`);
    } catch (err) {
      lead.status = `Send Error: ${err.message}`;
      saveLeads(leads);
      addLog(`Failed sending to +${cleanPhone}: ${err.message}`);
    }
  }, Math.max(0, delaySec * 1000));

  return lead;
}

// ============================================================================
// 2-WAY CLIENT-BUYER CALL SCHEDULER & NOTIFICATION ENGINE
// ============================================================================
async function parseClientConfirmedTime(text) {
  const clean = (text || '').trim();
  if (!clean) return 'As soon as free';

  if (/^(abhi|now|right now|turant|call now|kar lo|ready)/i.test(clean)) {
    return 'Right Now (Immediately)';
  }

  // Use Gemini if available to parse natural language Hinglish/English time availability
  if (config.geminiApiKey && config.geminiApiKey.trim().length > 15) {
    try {
      const prompt = `A machinery factory owner was asked on WhatsApp: "When are you free for a call with an inbound B2B customer?"
The owner replied: "${clean}"

Extract their exact available time slot and reformat it into a concise, polite time string (e.g. "Today at 4:00 PM", "Tomorrow at 11:30 AM", "Today at 6:00 PM", "Within 30 minutes", "Monday at 10:00 AM").
Return ONLY the clean time string without explanation, quotes, or markdown.`;

      const modelsToTry = ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite'];
      for (const m of modelsToTry) {
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(config.geminiApiKey.trim())}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1 }
              })
            }
          );
          if (resp.ok) {
            const data = await resp.json();
            const extracted = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (extracted && extracted.length < 50 && !extracted.includes('\n')) {
              return extracted;
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Regex fallback matching
  const timeMatch = clean.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm|baje)?)/i);
  const dayMatch = clean.match(/(today|tomorrow|aaj|kal|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (timeMatch || dayMatch) {
    let day = dayMatch ? dayMatch[0] : 'Today';
    if (/kal/i.test(day)) day = 'Tomorrow';
    if (/aaj/i.test(day)) day = 'Today';
    let time = timeMatch ? timeMatch[0] : '';
    return `${day} ${time}`.trim();
  }

  return clean.slice(0, 40);
}

async function confirmCallSlotAndNotifyBoth({ lead, confirmedTime, confirmedBy }) {
  if (!lead) return { ok: false, error: 'Lead not found' };

  lead.callbackStatus = 'scheduled';
  lead.scheduledCallTime = confirmedTime;
  lead.status = `⏰ Call Scheduled: ${confirmedTime}`;
  lead.updatedAt = new Date().toISOString();

  const customerPhone = normalizePhone(lead.phone);
  let customerNotified = false;
  let ownerNotified = false;

  // 1. Send WhatsApp message to the CUSTOMER (Buyer)
  if (sock && customerPhone) {
    try {
      const customerJid = await resolveWhatsAppJid(customerPhone);
      const customerMsg =
        `Namaste *${lead.name} ji*! 🙏\n\n` +
        `Hamare technical director ne confirm kiya hai ki wo *${confirmedTime}* pe available hain.\n\n` +
        `📞 Hamari team aapko *${confirmedTime}* pe call karegi taaki aapke machine specs, delivery aur pricing pe direct baat ho sake.\n` +
        `_(Aap chahein toh is waqt direct call bhi connect kar sakte hain)._\n\n` +
        `Aapka machine catalog & running specs already shared hain. Dhanyawad!\n` +
        `— *${config.companyName}*`;

      await sock.sendPresenceUpdate('composing', customerJid);
      await new Promise((r) => setTimeout(r, 800));
      await sock.sendMessage(customerJid, { text: customerMsg });

      // Only send voice note if customer specifically asked for voice in history
      const customerPrefersVoice = (lead.history || []).some((h) =>
        /(voice\s*note|audio|bol\s*ke|bol\s*kar|in\s*voice|can you send.*voice)/i.test(h.text || '')
      );
      if (customerPrefersVoice) {
        try {
          const voiceBuffer = await generateTtsAudio(
            `Namaste ${lead.name} ji. Hamare technical director ne confirm kiya hai ki wo ${confirmedTime} pe free hain. Hamari team aapko ${confirmedTime} pe call karegi. Thank you.`
          );
          if (voiceBuffer) {
            await sock.sendPresenceUpdate('recording', customerJid);
            await new Promise((r) => setTimeout(r, 1000));
            await sock.sendMessage(customerJid, {
              audio: voiceBuffer,
              mimetype: 'audio/ogg; codecs=opus',
              ptt: true
            });
          }
        } catch {}
      }

      lead.history.push({
        role: 'ai',
        text: `[Call Scheduled Notification Sent to Customer for ${confirmedTime}]`,
        ts: new Date().toISOString()
      });
      customerNotified = true;
      addLog(`Sent call schedule confirmation to Customer ${lead.name} (+${customerPhone}) for ${confirmedTime}`);
    } catch (err) {
      addLog(`Failed to notify customer: ${err.message}`);
    }
  }

  // 2. Send complete customer details dossier back to the CLIENT (Owner)
  const ownerDigits = normalizePhone(config.ownerAlertPhone);
  if (sock && ownerDigits) {
    try {
      const ownerJid = await resolveWhatsAppJid(ownerDigits);
      const ownerDossier =
        `✅ *CUSTOMER CALL SCHEDULED & NOTIFIED!* ✅\n\n` +
        `Humne *${lead.name}* ko WhatsApp pe confirm kar diya hai ki aap *${confirmedTime}* pe call karenge.\n\n` +
        `📋 *CUSTOMER DETAILS FOR YOUR CALL:*\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 *Customer Name:* ${lead.name}\n` +
        `📞 *Mobile:* +${lead.phone}\n` +
        `⚙️ *Machine Model:* ${lead.productName}\n` +
        `📍 *Delivery City:* ${lead.city || 'Confirm on call'}\n` +
        `📝 *Requirement / Notes:* ${lead.requirement || 'Full machine brochure reviewed'}\n` +
        `📊 *Catalog Status:* Brochure & Photos Dispatched\n` +
        `⏰ *Confirmed Slot:* ${confirmedTime}\n\n` +
        `👉 *Tap to Call Customer:* https://wa.me/${lead.phone}\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Confirmed via: ${confirmedBy || 'WhatsApp'}`;

      await sock.sendPresenceUpdate('composing', ownerJid);
      await new Promise((r) => setTimeout(r, 600));
      await sock.sendMessage(ownerJid, { text: ownerDossier });
      ownerNotified = true;
      addLog(`Sent full customer dossier for ${lead.name} to Client (+${ownerDigits})`);
    } catch (err) {
      addLog(`Failed to notify owner: ${err.message}`);
    }
  }

  saveLeads(leads);
  return { ok: true, lead, confirmedTime, customerNotified, ownerNotified };
}

async function handleClientAdminMessage({ msg, rawRemote, incomingText, phoneDigits, pushName }) {
  addLog(`[Client Owner Message] Received from Owner (+${phoneDigits}): "${incomingText}"`);

  // Find the lead waiting for client's time confirmation
  let targetLead = leads.find((l) => l.callbackStatus === 'awaiting_client_time') ||
                   leads.find((l) => l.status?.toLowerCase().includes('awaiting client') || l.status?.toLowerCase().includes('callback'));

  if (!targetLead && leads.length > 0) {
    // If no lead is explicitly awaiting, pick the latest lead if client typed a time
    const looksLikeTime = /(today|tomorrow|kal|aaj|pm|am|baje|\d{1,2}:\d{2}|abhi|now)/i.test(incomingText);
    if (looksLikeTime) {
      targetLead = leads[0];
    }
  }

  if (!targetLead) {
    const recentLead = leads[0];
    const replyText =
      `Namaste Sir! 🙏\n\n` +
      `Aapka B2B Sales AI 24/7 active hai aur live inquiries handle kar raha hai.\n\n` +
      `📊 *Today's Status:*\n` +
      `• Total Enquiries: ${leads.length}\n` +
      `• Latest Lead: ${recentLead ? `${recentLead.name} (${recentLead.productName})` : 'None yet'}\n\n` +
      `Jab bhi koi buyer call ke liye poochhega, main turant aapse WhatsApp pe time poochunga!`;
    await sock.sendMessage(rawRemote, { text: replyText });
    return;
  }

  const confirmedTime = await parseClientConfirmedTime(incomingText);
  await confirmCallSlotAndNotifyBoth({
    lead: targetLead,
    confirmedTime,
    confirmedBy: `Owner WhatsApp (+${phoneDigits})`
  });
}

// ============================================================================
// INCOMING WHATSAPP MESSAGE & VOICE NOTE HANDLER
// ============================================================================
async function handleIncomingWhatsAppMessage(msg) {
  if (!config.autoReplyEnabled) return;
  if (!msg.message || msg.key.fromMe) return;

  const rawRemote = msg.key.remoteJid || '';
  if (rawRemote.endsWith('@g.us') || rawRemote === 'status@broadcast' || rawRemote.endsWith('@newsletter')) {
    return; // Never reply in groups, broadcasts, or channels
  }

  // Handle Baileys v7 @lid + @s.whatsapp.net cleanly
  const altJid = msg.key.remoteJidAlt || '';
  let phoneDigits = '';
  if (rawRemote.endsWith('@s.whatsapp.net')) {
    phoneDigits = normalizePhone(rawRemote.split('@')[0]);
  } else if (altJid.endsWith('@s.whatsapp.net')) {
    phoneDigits = normalizePhone(altJid.split('@')[0]);
    lidToPhoneMap[rawRemote] = phoneDigits;
  } else if (lidToPhoneMap[rawRemote]) {
    phoneDigits = lidToPhoneMap[rawRemote];
  } else {
    phoneDigits = normalizePhone(rawRemote.split('@')[0]);
  }

  // Unwrap ephemeral/viewOnce wrappers if present
  const content = msg.message?.ephemeralMessage?.message || msg.message;
  let incomingText =
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.documentMessage?.caption ||
    '';

  const isAudio = Boolean(content?.audioMessage);
  const isImage = Boolean(content?.imageMessage);
  const isLocation = Boolean(content?.locationMessage);

  if (!incomingText) {
    if (isImage) incomingText = '[Buyer sent product sample / pouch photo]';
    else if (isLocation) {
      const loc = content.locationMessage;
      incomingText = `[Buyer shared factory location: ${loc.name || loc.address || 'GPS Location'}]`;
    }
  }

  if (!incomingText && !isAudio) return;

  const rawPushName = (msg.pushName || '').trim();
  const isRealPersonName = rawPushName &&
    !/^(buyer|unknown|\.|\+?\d+|user|iphone|android|customer|sir|whatsapp|demo|admin|rajesh)$/i.test(rawPushName) &&
    /^[a-zA-Z\u0900-\u097F\s.'-]{2,30}$/.test(rawPushName);

  const initialSafeName = isRealPersonName ? rawPushName : '';
  const pushName = initialSafeName || 'Customer';
  addLog(`Incoming WhatsApp from ${pushName} (+${phoneDigits}): ${isAudio ? '[Voice Note Audio]' : incomingText}`);

  // Check if sender is the factory owner / client replying from their registered WhatsApp!
  const ownerDigits = normalizePhone(config.ownerAlertPhone || '');
  const isFromOwner = Boolean(ownerDigits && phoneDigits === ownerDigits);
  if (isFromOwner) {
    await handleClientAdminMessage({ msg, rawRemote, incomingText, phoneDigits, pushName });
    return;
  }

  // Sync to MartFlow AI SaaS Database for real-time inbox
  try {
    const org = db.findOne('organizations', () => true);
    if (org) {
      let dbLead = db.findOne('leads', (l) => l.buyer_phone && l.buyer_phone.endsWith(phoneDigits.slice(-10)));
      if (!dbLead) {
        dbLead = db.insert('leads', {
          organization_id: org.id,
          source: 'WhatsApp Direct Inbound',
          buyer_name: initialSafeName,
          buyer_phone: phoneDigits,
          status: 'new'
        });
      }
      let conv = db.findOne('conversations', (c) => c.lead_id === dbLead.id);
      if (!conv) {
        conv = db.insert('conversations', {
          organization_id: org.id,
          lead_id: dbLead.id,
          buyer_phone: phoneDigits,
          mode: 'ai'
        });
      }
      db.insert('messages', {
        organization_id: org.id,
        conversation_id: conv.id,
        sender: 'buyer',
        text: isAudio ? '[Voice Note Audio]' : incomingText
      });

      if (supabaseAdmin) {
        (async () => {
          try {
            let { data: sLead } = await supabaseAdmin.from('leads').select('id').eq('org_id', org.id).ilike('buyer_phone', `%${phoneDigits.slice(-10)}`).maybeSingle();
            if (!sLead) {
              const { data: nLead } = await supabaseAdmin.from('leads').insert({
                org_id: org.id,
                buyer_name: initialSafeName || 'Customer',
                buyer_phone: phoneDigits,
                requirement: incomingText,
                status: 'new'
              }).select('id').single();
              sLead = nLead;
            }
            if (sLead) {
              let { data: sConv } = await supabaseAdmin.from('conversations').select('id').eq('org_id', org.id).eq('lead_id', sLead.id).maybeSingle();
              if (!sConv) {
                const { data: nConv } = await supabaseAdmin.from('conversations').insert({
                  org_id: org.id,
                  lead_id: sLead.id,
                  buyer_phone: phoneDigits,
                  mode: 'ai'
                }).select('id').single();
                sConv = nConv;
              }
              if (sConv) {
                await supabaseAdmin.from('messages').insert({
                  org_id: org.id,
                  conversation_id: sConv.id,
                  sender: 'buyer',
                  text: isAudio ? '[Voice Note Audio]' : incomingText
                });
              }
            }
          } catch (e) {}
        })();
      }
    }
  } catch (syncErr) {}

  // Check if buyer sent an initial pure greeting ("Hi", "Namaste", "Hello")
  const isPureGreeting = /^(hi|hello|hey|namaste|namaskar|salaam|pranam|good\s*(morning|afternoon|evening)|ss|hii+|helo+)\b[\s!.?]*$/i.test(incomingText.trim());
  const isFirstTrigger = incomingText.toLowerCase().includes('b2b enquiry') || incomingText.toLowerCase().includes('send catalog');
  let lead = leads.find((l) => l.phone === phoneDigits);

  const isInactive = lead ? (Date.now() - new Date(lead.updatedAt).getTime()) > 24 * 3600 * 1000 : false;
  if (isPureGreeting && (!lead || (lead.history && lead.history.length === 0) || isInactive)) {
    if (!lead) {
      lead = {
        id: 'IM-' + Date.now().toString().slice(-6),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        name: initialSafeName,
        phone: phoneDigits,
        productName: 'General Inquiry',
        catalogFile: '',
        city: '',
        requirement: incomingText,
        source: 'Direct WhatsApp Inbound',
        pdfSent: false,
        ownerAlerted: false,
        status: 'Welcomed - Awaiting Inquiry',
        history: []
      };
      leads.unshift(lead);
    }
    const politeGreeting = lead.name ? `Namaste *${lead.name} ji*!` : 'Namaste Ji!';
    const welcomeText = `${politeGreeting} 🙏 Welcome to *${config.companyName || 'our sales team'}*.\n\nHow may we assist you today? Please share which product, machinery, or service you are interested in so we can send complete specs, pricing, and catalog!`;

    if (sock) {
      await sock.sendPresenceUpdate('composing', rawRemote);
      await new Promise((r) => setTimeout(r, 800));
      await sock.sendMessage(rawRemote, { text: welcomeText });
      await sock.sendPresenceUpdate('paused', rawRemote);
    }

    lead.updatedAt = new Date().toISOString();
    lead.history.push({ role: 'buyer', text: incomingText, ts: new Date().toISOString() });
    lead.history.push({ role: 'ai', text: welcomeText, ts: lead.updatedAt });
    saveLeads(leads);
    addLog(`Conversational welcome sent to ${lead.name || pushName} (+${phoneDigits}) - awaiting inquiry.`);
    return;
  }

  if (!lead || isFirstTrigger) {
    const prod = matchProduct(incomingText);
    if (!lead) {
      lead = {
        id: 'IM-' + Date.now().toString().slice(-6),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        name: initialSafeName,
        phone: phoneDigits,
        productName: prod.name,
        catalogFile: prod.catalogFile,
        city: '',
        requirement: incomingText,
        source: isFirstTrigger ? '1-Tap WhatsApp Demo Link' : 'Direct WhatsApp Inbound',
        pdfSent: false,
        ownerAlerted: false,
        status: 'Qualifying Live',
        history: []
      };
      leads.unshift(lead);
    }

    // If they haven't received the PDF brochure yet, send it right away!
    if (!lead.pdfSent && sock) {
      await sock.sendPresenceUpdate('composing', rawRemote);
      await new Promise((r) => setTimeout(r, 1500));
      const pdfPath = path.join(__dirname, 'catalogs', prod.catalogFile);
      if (fs.existsSync(pdfPath)) {
        const brochureGreeting = lead.name ? `Namaste *${lead.name} ji*!` : 'Namaste Ji!';
        await sock.sendMessage(rawRemote, {
          document: fs.readFileSync(pdfPath),
          mimetype: 'application/pdf',
          fileName: prod.catalogFile,
          caption: `${brochureGreeting} 🙏 Here is the official *${prod.name}* Technical Brochure & Price List (${prod.priceRange}).`
        });
        lead.pdfSent = true;
      }
    }
  }

  // Download audio buffer if buyer sent a Hindi/Hinglish/Punjabi Voice Note!
  let audioBuffer = null;
  let audioMime = null;
  if (isAudio) {
    try {
      audioBuffer = await downloadMediaMessage(msg, 'buffer', {});
      const rawMime = content.audioMessage.mimetype || 'audio/ogg';
      audioMime = rawMime.split(';')[0].trim();
    } catch (e) {
      addLog(`Voice note download error: ${e.message}`);
    }
  }

  // 1. Check if buyer selected an option (1, 2, 3 or category name)
  const lowerText = incomingText.toLowerCase().trim();
  let optionChosen = null;
  if (lowerText === '1' || lowerText === 'option 1' || lowerText.includes('pehli') || lowerText === '1️⃣') {
    optionChosen = config.products[0];
  } else if (lowerText === '2' || lowerText === 'option 2' || lowerText.includes('dusri') || lowerText === '2️⃣') {
    optionChosen = config.products[1];
  } else if (lowerText === '3' || lowerText === 'option 3' || lowerText.includes('teesri') || lowerText === '3️⃣') {
    optionChosen = config.products[2];
  }

  if (optionChosen && lead) {
    lead.productName = optionChosen.name;
    lead.catalogFile = optionChosen.catalogFile;
    if (sock) {
      const pdfPath = path.join(__dirname, 'catalogs', optionChosen.catalogFile);
      if (fs.existsSync(pdfPath)) {
        await sock.sendMessage(rawRemote, {
          document: fs.readFileSync(pdfPath),
          mimetype: 'application/pdf',
          fileName: optionChosen.catalogFile,
          caption: `Aapki pasand ki *${optionChosen.name}* ka technical brochure & price list! 🙏`
        });
        lead.pdfSent = true;
      }
    }
  }

  // 2. Check if buyer asked for real product photos / images
  const asksForImage = /(photo|pic|image|tasveer|dikhao|dikha|bhejo|share karo|send photo|send pic)/i.test(incomingText);
  if (asksForImage && sock) {
    const prod = matchProduct(lead.productName || incomingText);
    const imgFile = prod.imageFile || 'pouch-packing-machine.jpg';
    const imgPath = path.join(__dirname, 'catalogs', 'images', imgFile);
    if (fs.existsSync(imgPath)) {
      await sock.sendPresenceUpdate('composing', rawRemote);
      await new Promise((r) => setTimeout(r, 600));
      await sock.sendMessage(rawRemote, {
        image: fs.readFileSync(imgPath),
        caption: `📸 *${prod.name}* (Factory Floor Live Unit)\n• SS-304 Food Grade Material\n• Delta Touchscreen PLC Controller\n• Ready Stock in Ludhiana/Delhi Dispatch Hub`
      });
      addLog(`Sent product photo (${imgFile}) to ${lead.name} (+${phoneDigits})`);
    }
  }

  lead.history.push({
    role: 'buyer',
    text: isAudio ? '🎤 [Voice Note Sent]' : incomingText,
    ts: new Date().toISOString()
  });

  await sock.sendPresenceUpdate('composing', rawRemote);
  const aiResult = await generateSalesReply({
    lead,
    incomingText,
    audioBuffer,
    audioMime
  });

  if (aiResult.transcriptSummary && isAudio) {
    lead.history[lead.history.length - 1].text = `🎤 Voice Note: "${aiResult.transcriptSummary}"`;
  }
  if (aiResult.extractedCity) lead.city = aiResult.extractedCity;
  if (aiResult.extractedRequirement) {
    lead.requirement = lead.requirement
      ? `${lead.requirement} | ${aiResult.extractedRequirement}`
      : aiResult.extractedRequirement;
  }

  // Only send voice note when explicitly asked by the buyer or when buyer sent a voice note!
  const asksForVoice = /(voice\s*note|audio|bol\s*ke|bol\s*kar|awaz|aawaz|sunao|voice\s*message|in\s*voice|can you send.*voice)/i.test(incomingText);
  const shouldSendVoice = isAudio || asksForVoice;
  if (shouldSendVoice && sock) {
    try {
      await sock.sendPresenceUpdate('recording', rawRemote);
      const voiceBuffer = await generateTtsAudio(aiResult.reply);
      if (voiceBuffer) {
        await new Promise((r) => setTimeout(r, 1200));
        await sock.sendMessage(rawRemote, {
          audio: voiceBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
        addLog(`Sent 🎙️ Voice Note (PTT) to ${lead.name} (+${phoneDigits})`);
      }
    } catch (e) {
      addLog(`Voice note dispatch error: ${e.message}`);
    }
  }

  await sock.sendPresenceUpdate('composing', rawRemote);
  await new Promise((r) => setTimeout(r, 1000));
  await sock.sendMessage(rawRemote, { text: aiResult.reply });
  await sock.sendPresenceUpdate('paused', rawRemote);

  lead.updatedAt = new Date().toISOString();
  lead.history.push({ role: 'ai', text: aiResult.reply, ts: lead.updatedAt });

  // 3. Autonomous Self-Learning: Extracts new buyer terms, city typos, and FAQs automatically
  analyzeAndLearnFromChat(lead, incomingText, aiResult);

  if (aiResult.requestedCallback) {
    lead.callbackStatus = 'awaiting_client_time';
    lead.callbackRequestedAt = new Date().toISOString();
    lead.status = '⏳ Awaiting Client Call Time';
    if (config.ownerAlertPhone && sock) {
      const ownerDigits = normalizePhone(config.ownerAlertPhone);
      if (ownerDigits && ownerDigits !== phoneDigits) {
        try {
          const ownerJid = await resolveWhatsAppJid(ownerDigits);
          const callPrompt =
            `🔔 *CUSTOMER CALL REQUEST* 🔔\n\n` +
            `Ek buyer aapse call pe baat karna chahta hai:\n` +
            `👤 *Customer:* ${lead.name}\n` +
            `📞 *Mobile:* +${lead.phone}\n` +
            `⚙️ *Machine:* ${lead.productName}\n` +
            `📍 *City:* ${lead.city || 'Not specified'}\n` +
            `📝 *Requirement:* ${lead.requirement || 'Full machine inquiry'}\n\n` +
            `❓ *Aap kab free hain call ke liye?*\n` +
            `Bas is message ka reply karein apna free time likh kar. For example:\n` +
            `• *"Today 4 PM"*\n` +
            `• *"Kal 11 AM"*\n` +
            `• *"30 minutes mein"*\n` +
            `• *"Abhi"*\n\n` +
            `Aapka reply aate hi main customer ko confirm kar dunga aur aapko unki full details forward kar dunga!`;
          await sock.sendMessage(ownerJid, { text: callPrompt });
          addLog(`Sent call time request prompt to Client (+${ownerDigits}) for customer ${lead.name}!`);
        } catch (e) {
          addLog(`Failed to send prompt to owner: ${e.message}`);
        }
      }
    }
  } else if (aiResult.isHotLead || (lead.city && lead.requirement)) {
    lead.status = '🔥 HOT QUALIFIED';
    // Send instant alert to Factory Owner's personal WhatsApp if configured!
    if (!lead.ownerAlerted && config.ownerAlertPhone) {
      const ownerDigits = normalizePhone(config.ownerAlertPhone);
      if (ownerDigits && ownerDigits !== phoneDigits) {
        try {
          const ownerJid = await resolveWhatsAppJid(ownerDigits);
          const alertMsg =
            `🔥 *HOT B2B BUYER LEAD QUALIFIED!* 🔥\n\n` +
            `👤 *Buyer:* ${lead.name}\n` +
            `📞 *Mobile:* +${lead.phone}\n` +
            `⚙️ *Machine:* ${lead.productName}\n` +
            `📦 *Requirement:* ${lead.requirement || 'Asked price/specs'}\n` +
            `📍 *City:* ${lead.city || 'Confirming'}\n\n` +
            `👉 Tap to call or chat: https://wa.me/${lead.phone}`;
          await sock.sendMessage(ownerJid, { text: alertMsg });
          lead.ownerAlerted = true;
          addLog(`Sent 🔥 HOT LEAD alert to Owner (+${ownerDigits})!`);
        } catch (e) {
          addLog(`Owner alert skipped: ${e.message}`);
        }
      }
    }
  } else {
    lead.status = 'AI Qualifying...';
  }

  saveLeads(leads);
  addLog(`AI replied to ${lead.name} (+${phoneDigits})`);
}

// ============================================================================
// REST API ROUTES FOR DASHBOARD, SIMULATOR & B2B PUSH WEBHOOK
// ============================================================================
app.get('/api/test-audio', async (req, res) => {
  try {
    const text = req.query.text || 'Namaste Rajesh ji! Hamare technical director ne confirm kiya hai ki wo aaj chaar baje free hain. Hamari team aapko call karegi. Dhanyawad!';
    const oggBuffer = await generateTtsAudio(text);
    if (!oggBuffer) {
      return res.status(500).send('Audio generation failed');
    }
    res.setHeader('Content-Type', 'audio/ogg; codecs=opus');
    res.setHeader('Content-Length', oggBuffer.length);
    res.send(oggBuffer);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get('/api/status', (req, res) => {
  const pendingCallbacks = leads.filter((l) => l.callbackStatus === 'awaiting_client_time');
  res.json({
    waState,
    config: {
      ...config,
      geminiConfigured: Boolean(config.geminiApiKey && config.geminiApiKey.trim().length > 15),
      geminiApiKeyMasked: config.geminiApiKey ? `${config.geminiApiKey.slice(0, 6)}...` : ''
    },
    leadsCount: leads.length,
    pendingCallbacksCount: pendingCallbacks.length,
    pendingCallbacks,
    leads: leads.slice(0, 50),
    learnings: loadLearnings()
  });
});

app.post('/api/whatsapp/connect', async (req, res) => {
  if (req.body?.reset) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      if (sock) {
        sock.ev.removeAllListeners();
        sock.end();
      }
    } catch {}
    sock = null;
    isConnecting = false;
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch {}
    waState.status = 'disconnected';
    waState.qrDataUrl = null;
    waState.connectedNumber = null;
    waState.lastEvent = 'Resetting session and preparing fresh QR code...';
  }
  startWhatsApp();
  res.json({ ok: true, message: 'WhatsApp connection started.' });
});

app.post('/api/config', (req, res) => {
  const { companyName, cityBase, geminiApiKey, ownerAlertPhone, replyDelaySec, autoReplyEnabled, replyWithVoiceNotes } = req.body;
  if (typeof companyName === 'string' && companyName.trim()) config.companyName = companyName.trim();
  if (typeof cityBase === 'string') config.cityBase = cityBase.trim();
  if (typeof geminiApiKey === 'string' && !geminiApiKey.includes('...')) {
    config.geminiApiKey = geminiApiKey.trim();
  }
  if (typeof ownerAlertPhone === 'string') config.ownerAlertPhone = ownerAlertPhone.trim();
  if (replyDelaySec !== undefined) config.replyDelaySec = Math.max(0, Math.min(60, Number(replyDelaySec) || 0));
  if (typeof autoReplyEnabled === 'boolean') config.autoReplyEnabled = autoReplyEnabled;
  if (typeof replyWithVoiceNotes === 'boolean') config.replyWithVoiceNotes = replyWithVoiceNotes;
  saveConfig(config);
  addLog('Settings updated from dashboard.');
  res.json({ ok: true, config });
});

// 1. Operator Live Demo Trigger + Public Simulator Form Endpoint
app.post('/api/simulate-lead', async (req, res) => {
  try {
    const { name, phone, productQuery, city, message, delaySec } = req.body;
    const lead = await processNewB2BLead({
      name: name || 'Rajesh Ji',
      phone,
      productQuery: productQuery || 'Automatic Pouch Packing Machine',
      city: city || '',
      message: message || '',
      source: 'Live Demo Trigger',
      customDelaySec: delaySec !== undefined ? Number(delaySec) : undefined
    });
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Public Config Endpoint (exposes Supabase config, merchant UPI & support WhatsApp for live checkout)
app.get('/api/public-config', (req, res) => {
  res.json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL || 'https://uriqhusalcdgdlgzgasp.supabase.co',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVyaXFodXNhbGNkZ2RsZ3pnYXNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzMzYwNDQsImV4cCI6MjEwODkxMjA0NH0.UTB-Ykce-bcxTrhhKvk1kNjxCH5uWsmB3yAyGJeZXkE',
    merchantUpiId: process.env.MERCHANT_UPI_ID || 'YOUR_REAL_UPI_ID',
    merchantName: process.env.MERCHANT_NAME || 'MartFlow AI Sales',
    supportWhatsapp: process.env.SUPPORT_WHATSAPP || process.env.OWNER_PHONE || 'YOUR_REAL_WHATSAPP_91XXXXXXXXXX'
  });
});

// 2. Official B2B Push API Webhook Endpoint (With backward-compatible aliases)
app.post(['/api/webhook/b2b', '/api/webhook/b2b/:key', '/api/webhook/indiamart', '/api/webhook/indiamart/:key'], async (req, res) => {
  try {
    let raw = req.body?.RESPONSE || req.body || {};
    const body = Array.isArray(raw) ? (raw[0] || {}) : raw;
    const name = body.SENDER_NAME || body.sender_name || body.name || 'B2B Buyer';
    const phone = body.SENDER_MOBILE || body.sender_mobile || body.MOBILE || body.phone || '';
    const productQuery = body.QUERY_PRODUCT_NAME || body.PRODUCT_NAME || body.QUERY_MODID || body.SUBJECT || body.subject || 'Packaging Machine';
    const city = body.SENDER_CITY || body.city || '';
    const message = body.QUERY_MESSAGE || body.message || '';

    if (!phone) {
      return res.status(200).json({ status: 'ignored', reason: 'No SENDER_MOBILE in payload' });
    }
    const lead = await processNewB2BLead({
      name,
      phone,
      productQuery,
      city,
      message,
      source: 'B2B Official Webhook'
    });
    res.status(200).json({ status: 'success', leadId: lead.id });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 3. Browser Dry-Run AI Chat Tester (Test AI replies with 0 WhatsApp messages!)
let dryRunLead = {
  name: '',
  productName: '',
  city: '',
  requirement: '',
  history: []
};

app.post('/api/dry-run-chat', async (req, res) => {
  const { text, reset, customerName } = req.body;
  if (reset) {
    dryRunLead = {
      name: customerName ? customerName.trim() : '',
      productName: '',
      city: '',
      requirement: '',
      history: []
    };
    return res.json({ ok: true, dryRunLead });
  }
  if (customerName) dryRunLead.name = customerName.trim();
  const inputMsg = text || req.body.message || '';
  dryRunLead.history.push({ role: 'buyer', text: inputMsg, ts: new Date().toISOString() });
  const result = await generateSalesReply({ lead: dryRunLead, incomingText: inputMsg });
  if (result.extractedCustomerName && !dryRunLead.name) {
    dryRunLead.name = result.extractedCustomerName;
  }
  if (result.extractedCity) dryRunLead.city = result.extractedCity;
  if (result.extractedRequirement) {
    dryRunLead.requirement = dryRunLead.requirement
      ? `${dryRunLead.requirement} | ${result.extractedRequirement}`
      : result.extractedRequirement;
  }
  dryRunLead.history.push({ role: 'ai', text: result.reply, ts: new Date().toISOString() });
  res.json({ ok: true, reply: result.reply, dryRunLead, isHotLead: result.isHotLead });
});

// 4. Export Qualified Leads as Excel-Ready CSV
app.get('/api/leads.csv', (req, res) => {
  const headers = ['Lead ID', 'Time', 'Buyer Name', 'WhatsApp Mobile', 'Machine Interested', 'PDF Sent', 'Buyer City', 'Requirement', 'Status', 'Source'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = leads.map((l) => [
    l.id,
    new Date(l.createdAt).toLocaleString('en-IN'),
    l.name,
    l.phone,
    l.productName,
    l.pdfSent ? 'YES' : 'NO',
    l.city,
    l.requirement,
    l.status,
    l.source
  ].map(esc).join(','));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="MartFlow_B2B_Qualified_Leads.csv"');
  res.send([headers.join(','), ...rows].join('\n'));
});

app.post('/api/leads/clear', (req, res) => {
  leads = [];
  saveLeads(leads);
  res.json({ ok: true });
});

// Public Buyer Enquiry Page (/demo) — Looks like an instant B2B Quote Form
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demo.html'));
});

// Dedicated Simple Client Portal (/client)
app.get('/client', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

// Client Upload Catalog Endpoint (Universal Multi-Format: PDF, Excel .xlsx/.xls, CSV .csv)
app.post('/api/upload-catalog', async (req, res) => {
  try {
    const { filename, fileBase64, productName, priceRange, keywords } = req.body;
    if (!filename || !fileBase64) {
      return res.status(400).json({ ok: false, error: 'Filename and file data required.' });
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const catalogPath = path.join(__dirname, 'catalogs', safeName);
    const cleanBase64 = fileBase64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    fs.writeFileSync(catalogPath, buffer);

    const ext = path.extname(safeName).toLowerCase();
    let extractedText = '';
    const newProducts = [];

    if (ext === '.pdf') {
      try {
        const p = new pdf.PDFParse({ data: buffer });
        const textRes = await p.getText();
        extractedText = textRes.text || '';
      } catch (e) {
        addLog(`PDF text extraction notice: ${e.message}`);
      }

      const prodName = (productName || safeName.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ')).trim();
      const kwList = typeof keywords === 'string'
        ? keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
        : (Array.isArray(keywords) ? keywords : []);

      if (!kwList.length) {
        kwList.push(...prodName.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
      }

      const newProduct = {
        id: 'cat_' + Date.now().toString().slice(-4),
        name: prodName,
        keywords: kwList,
        catalogFile: safeName,
        priceRange: priceRange || 'Contact for official GST quotation',
        imageFile: 'pouch-packing-machine.jpg',
        subModels: [
          {
            name: prodName,
            speed: 'Standard Factory Speed',
            price: priceRange || 'Contact factory',
            suitableFor: 'Industrial Manufacturing Line'
          }
        ]
      };
      config.products.unshift(newProduct);
      newProducts.push(newProduct);
    } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
      try {
        const wb = XLSX.read(buffer, { type: 'buffer' });
        const textLines = [];
        for (const sheetName of wb.SheetNames) {
          const sheet = wb.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet);
          if (rows.length) {
            textLines.push(`=== SPREADSHEET SHEET: ${sheetName} ===`);
            for (const r of rows) {
              const rowStr = Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' | ');
              textLines.push(rowStr);

              // Auto-generate product entry from row
              const nameKey = Object.keys(r).find((k) => /name|item|product|title|model|description/i.test(k));
              const priceKey = Object.keys(r).find((k) => /price|rate|cost|mrp|amount/i.test(k));
              const specsKey = Object.keys(r).find((k) => /spec|detail|feature|capacity|size|speed/i.test(k));

              const itemTitle = String(r[nameKey] || '').trim();
              if (itemTitle && itemTitle.length > 2) {
                const itemPrice = priceKey && r[priceKey] ? String(r[priceKey]) : (priceRange || 'Contact for quote');
                const itemSpecs = specsKey && r[specsKey] ? String(r[specsKey]) : Object.values(r).slice(1, 4).join(', ');
                const kw = itemTitle.toLowerCase().split(/[\s,-]+/).filter((w) => w.length > 2);

                const generated = {
                  id: 'item_' + Math.random().toString(36).slice(2, 7),
                  name: itemTitle,
                  keywords: kw,
                  catalogFile: safeName,
                  priceRange: itemPrice,
                  subModels: [
                    {
                      name: itemTitle,
                      price: itemPrice,
                      speed: 'Standard',
                      suitableFor: itemSpecs
                    }
                  ]
                };
                config.products.unshift(generated);
                newProducts.push(generated);
              }
            }
          }
        }
        extractedText = textLines.join('\n');
      } catch (err) {
        addLog(`Excel/CSV parse error: ${err.message}`);
      }
    } else {
      extractedText = buffer.toString('utf8');
    }

    // Append to dynamic catalog knowledge base
    const k = loadCatalogKnowledge();
    k.files = (k.files || []).filter((f) => f.filename !== safeName);
    k.files.push({
      filename: safeName,
      type: ext.replace('.', ''),
      uploadedAt: new Date().toISOString(),
      productsCount: newProducts.length
    });
    k.textKnowledge = `${k.textKnowledge || ''}\n\n=== UPLOADED CATALOG FILE: ${safeName} ===\n${extractedText}`.trim();
    saveCatalogKnowledge(k);

    saveConfig(config);
    addLog(`Uploaded & analyzed client catalog: "${safeName}" (${newProducts.length} products found)`);

    res.json({
      ok: true,
      filename: safeName,
      productsCount: newProducts.length,
      message: `Catalog analyzed successfully! Extracted specifications for ${newProducts.length} product(s).`
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Confirm available call time from Client Dashboard and notify both parties
app.post('/api/callbacks/confirm-time', async (req, res) => {
  try {
    const { leadId, confirmedTime } = req.body;
    let targetLead = null;
    if (leadId) {
      targetLead = leads.find((l) => l.id === leadId);
    }
    if (!targetLead) {
      targetLead = leads.find((l) => l.callbackStatus === 'awaiting_client_time') || leads[0];
    }
    if (!targetLead) {
      return res.status(404).json({ ok: false, error: 'No lead found to schedule call.' });
    }

    const cleanTime = (confirmedTime || 'Today at 4:00 PM').trim();
    const result = await confirmCallSlotAndNotifyBoth({
      lead: targetLead,
      confirmedTime: cleanTime,
      confirmedBy: 'Client Web Portal'
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Trigger a Demo Call Request to test the 2-way WhatsApp prompt
app.post('/api/callbacks/request-demo', async (req, res) => {
  try {
    const ownerDigits = normalizePhone(config.ownerAlertPhone || '');
    let lead = leads.find((l) => normalizePhone(l.phone) !== ownerDigits);
    if (!lead) {
      lead = {
        id: 'IM-' + Date.now().toString().slice(-6),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        name: 'Rajesh Verma (Demo Buyer)',
        phone: '919781018975',
        productName: 'Automatic Pouch Packing Machine',
        catalogFile: 'Pouch-Packing-Machine-Catalog.pdf',
        city: 'Amritsar',
        requirement: 'BPT-500 Collar Type PLC Pouch Machine (50g spices)',
        source: 'Live Demo Simulation',
        pdfSent: true,
        ownerAlerted: false,
        status: '⏳ Awaiting Client Call Time',
        callbackStatus: 'awaiting_client_time',
        callbackRequestedAt: new Date().toISOString(),
        history: [
          { role: 'buyer', text: 'Mujhe machine final karni hai, director sahab se call pe baat karao please.', ts: new Date().toISOString() },
          { role: 'ai', text: 'Namaste Ji! Main abhi director sahab se unka free time pooch kar WhatsApp pe confirm karta hoon!', ts: new Date().toISOString() }
        ]
      };
      leads.unshift(lead);
    } else {
      lead.callbackStatus = 'awaiting_client_time';
      lead.callbackRequestedAt = new Date().toISOString();
      lead.status = '⏳ Awaiting Client Call Time';
    }

    if (ownerDigits && sock) {
      try {
        const ownerJid = await resolveWhatsAppJid(ownerDigits);
        const customerDisplayName = lead.name || 'Customer (Inquiry)';
        const callPrompt =
          `🔔 *CUSTOMER CALL REQUEST (DEMO TEST)* 🔔\n\n` +
          `Ek buyer aapse call pe baat karna chahta hai:\n` +
          `👤 *Customer:* ${customerDisplayName}\n` +
          `📞 *Mobile:* +${lead.phone}\n` +
          `⚙️ *Machine:* ${lead.productName}\n` +
          `📍 *City:* ${lead.city || 'Confirm on call'}\n` +
          `📝 *Requirement:* ${lead.requirement || 'Full machine line inquiry'}\n\n` +
          `❓ *Aap kab free hain call ke liye?*\n` +
          `Bas is message ka reply karein apna free time likh kar (e.g. *"Today 4 PM"*, *"Kal 11 AM"*, ya *"Abhi"*).\n` +
          `Main customer ko confirm kar dunga aur aapko unki full details forward kar dunga!`;

        await sock.sendMessage(ownerJid, { text: callPrompt });
        addLog(`Sent Demo Call Request prompt to Client (+${ownerDigits})`);
      } catch (e) {
        addLog(`Demo prompt error: ${e.message}`);
      }
    }

    saveLeads(leads);
    res.json({ ok: true, lead, message: 'Demo call request triggered. Check your WhatsApp!' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// SUPABASE MULTI-TENANT WORKER & REALTIME COMMAND ENGINE
// ============================================================================
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

async function initSupabaseWorker() {
  if (!supabaseAdmin) {
    addLog('[Supabase Worker] Supabase credentials not found in .env, worker running in local-only mode.');
    return;
  }
  addLog('[Supabase Worker] Initializing Multi-Tenant Realtime & Command Engine...');

  // 1. Worker Heartbeat Loop (every 20s)
  async function sendHeartbeat() {
    try {
      await supabaseAdmin
        .from('organizations')
        .update({ wa_worker_heartbeat: new Date().toISOString() })
        .neq('id', '00000000-0000-0000-0000-000000000000');
    } catch (e) {
      // silent heartbeat error
    }
  }

  await sendHeartbeat();
  setInterval(sendHeartbeat, 20000);

  // 2. Poll & Process Organizations Commands (wa_command)
  async function pollCommands() {
    try {
      const { data: orgs, error } = await supabaseAdmin
        .from('organizations')
        .select('*')
        .not('wa_command', 'is', null);

      if (error || !orgs || orgs.length === 0) return;

      for (const org of orgs) {
        const cmd = org.wa_command;
        addLog(`[Supabase Worker] Executing command '${cmd}' for organization ${org.name || org.id}`);

        // Acknowledge command first
        await supabaseAdmin
          .from('organizations')
          .update({ wa_command: null })
          .eq('id', org.id);

        if (cmd === 'start_qr') {
          await supabaseAdmin
            .from('organizations')
            .update({ wa_status: 'initializing' })
            .eq('id', org.id);

          const inst = baileysManager.getInstance(org.id);
          await inst.init();
        } else if (cmd === 'start_pair_code') {
          await supabaseAdmin
            .from('organizations')
            .update({ wa_status: 'initializing' })
            .eq('id', org.id);

          const inst = baileysManager.getInstance(org.id);
          try {
            const rawPhone = org.bot_whatsapp_number || org.escalation_phone || '';
            const code = await inst.requestPairing(rawPhone);
            await supabaseAdmin
              .from('organizations')
              .update({ wa_status: 'code_ready', wa_pairing_code: code })
              .eq('id', org.id);
          } catch (err) {
            addLog(`[Supabase Worker] Pairing code error: ${err.message}`);
            await supabaseAdmin
              .from('organizations')
              .update({ wa_status: 'disconnected', wa_pairing_code: null })
              .eq('id', org.id);
          }
        } else if (cmd === 'disconnect') {
          const inst = baileysManager.getInstance(org.id);
          await inst.disconnect();
          await supabaseAdmin
            .from('organizations')
            .update({
              wa_status: 'disconnected',
              wa_connected_number: null,
              wa_qr_data_url: null,
              wa_pairing_code: null
            })
            .eq('id', org.id);
        } else if (cmd === 'send_test') {
          const payload = org.wa_command_payload || {};
          const toPhone = payload.to_phone || org.owner_alert_number;
          const msgText = payload.message_text || 'Test message from MartFlow AI';
          const pdfPath = payload.pdf_path || null;
          await baileysManager.sendMessage(org.id, toPhone, msgText, pdfPath);
        }
      }
    } catch (e) {
      addLog(`[Supabase Worker] Command poll error: ${e.message}`);
    }
  }

  // 3. Poll & Process Outbound Queue (wa_outbound_queue)
  async function pollOutboundQueue() {
    try {
      const { data: queueItems, error } = await supabaseAdmin
        .from('wa_outbound_queue')
        .select('*')
        .eq('status', 'pending')
        .limit(10);

      if (error || !queueItems || queueItems.length === 0) return;

      for (const item of queueItems) {
        await supabaseAdmin
          .from('wa_outbound_queue')
          .update({ status: 'processing' })
          .eq('id', item.id);

        try {
          const res = await baileysManager.sendMessage(
            item.org_id,
            item.to_phone,
            item.message_text || '',
            item.pdf_url || null,
            item.message_text || ''
          );

          if (res.ok) {
            await supabaseAdmin
              .from('wa_outbound_queue')
              .update({ status: 'sent', error_text: null })
              .eq('id', item.id);
            addLog(`[Supabase Worker] Outbound queue message delivered to +${item.to_phone}`);
          } else {
            // Also attempt fallback via primary socket if connected
            if (sock && waState.status === 'connected') {
              const jid = `${String(item.to_phone).replace(/\D/g, '')}@s.whatsapp.net`;
              if (item.pdf_url) {
                await sock.sendMessage(jid, {
                  document: { url: item.pdf_url },
                  mimetype: 'application/pdf',
                  fileName: item.pdf_name || 'Brochure.pdf',
                  caption: item.message_text || ''
                });
              } else {
                await sock.sendMessage(jid, { text: item.message_text });
              }
              await supabaseAdmin
                .from('wa_outbound_queue')
                .update({ status: 'sent', error_text: null })
                .eq('id', item.id);
              addLog(`[Supabase Worker] Outbound queue message delivered via primary socket to +${item.to_phone}`);
            } else {
              await supabaseAdmin
                .from('wa_outbound_queue')
                .update({ status: 'failed', error_text: res.error || 'WhatsApp not connected' })
                .eq('id', item.id);
            }
          }
        } catch (sendErr) {
          await supabaseAdmin
            .from('wa_outbound_queue')
            .update({ status: 'failed', error_text: sendErr.message })
            .eq('id', item.id);
        }
      }
    } catch (e) {
      addLog(`[Supabase Worker] Queue poll error: ${e.message}`);
    }
  }

  // Run command & queue poll every 3 seconds
  setInterval(async () => {
    await pollCommands();
    await pollOutboundQueue();
  }, 3000);

  // Realtime subscription channel
  try {
    const channel = supabaseAdmin.channel('martflow-worker');
    channel
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'organizations' },
        (payload) => {
          if (payload.new && payload.new.wa_command) {
            pollCommands();
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'wa_outbound_queue' },
        () => {
          pollOutboundQueue();
        }
      )
      .subscribe((status) => {
        addLog(`[Supabase Worker] Realtime channel status: ${status}`);
      });
  } catch (rtErr) {
    addLog(`[Supabase Worker] Realtime subscription fallback to polling: ${rtErr.message}`);
  }
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  addLog(`MartFlow B2B WhatsApp AI Server running at http://localhost:${PORT}`);
  initCatalogKnowledge();
  initSupabaseWorker();
  // Auto-resume existing WhatsApp session if auth_info/creds.json already exists!
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    addLog('Saved WhatsApp session detected — auto-reconnecting...');
    startWhatsApp();
  }
});
