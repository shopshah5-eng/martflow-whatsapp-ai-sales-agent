import 'dotenv/config';
import dns from 'dns';
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
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
import {
  backupSessionToSupabase,
  debouncedBackupSession,
  restoreSessionFromSupabase,
  deleteRemoteSession
} from './src/integrations/whatsapp/sessionSync.js';
import db from './src/db/index.js';
import { AIService, buildAdaptiveWelcomeMessage, getIndustryPlaybook, invalidateCache } from './src/services/aiService.js';
import { HIGH_INTENT_REGEX, scorePurchaseIntent, describeInboundContent } from './src/services/intentService.js';
import takeoverService, {
  DEFAULT_MANUAL_MODE_MS,
  DEFAULT_HOT_COOLDOWN_MS,
  takeoverCustomer,
  releaseCustomer,
  isCustomerInManualMode,
  getActiveTakeovers,
  shouldSendAlert,
  recordAlertSent,
  parseOwnerCommand,
  maskPhone
} from './src/services/takeoverService.js';

dotenv.config();

// Global Anti-Duplicate, Anti-Loop & Tracking Sets
const botSentMsgIds = new Set();
const processedMsgIds = new Set();
const inFlightSenders = new Set();
const recentInboundFingerprints = new Map(); // `${orgId}:${senderPhone}:${normText}` -> timestamp
const recentAlertsMap = new Map(); // `${orgId}:${senderPhone}:${alertType}` -> timestamp
const alertedNewLeads = new Set(); // `${orgId}:${senderPhone}`
const alertedHotLeads = new Set(); // `${orgId}:${senderPhone}`
const sentPdfs = new Set(); // `${orgId}:${senderPhone}`
const orgSessions = new Map(); // orgId -> { sock, isConnecting, reconnectTimer, state, authDir }

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
function normalizeIndianPhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (digits.length === 10) {
    digits = '91' + digits;
  }
  return digits;
}
const normalizePhone = normalizeIndianPhone;

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
// WHATSAPP BAILEYS SOCKET ENGINE & MULTI-TENANT DEDUPLICATED CONTROLLER
// ============================================================================
let sock = null;
let waState = {
  status: 'disconnected', // disconnected | connecting | qr_ready | connected
  qrDataUrl: null,
  connectedNumber: null,
  lastEvent: 'Click "Connect WhatsApp" to pair device.',
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

function resolvePhoneFromJid(remoteJid, altJid) {
  // 1. Direct remoteJid if it is a standard @s.whatsapp.net phone number
  if (remoteJid && remoteJid.includes('@s.whatsapp.net')) {
    const raw = remoteJid.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (raw && raw.length >= 10) {
      return normalizeIndianPhone(raw);
    }
  }

  // 2. remoteJidAlt / participantAlt (Baileys v6.7+ format)
  if (altJid && altJid.includes('@s.whatsapp.net')) {
    const alt = altJid.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (alt && alt.length >= 10) {
      if (remoteJid) lidToPhoneMap[remoteJid] = alt;
      return normalizeIndianPhone(alt);
    }
  }

  // 3. Cached lidToPhoneMap lookup
  if (remoteJid && lidToPhoneMap[remoteJid]) {
    return normalizeIndianPhone(lidToPhoneMap[remoteJid]);
  }

  // 4. Raw digits fallback if length matches valid phone
  const rawDigits = (remoteJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (rawDigits && rawDigits.length >= 10 && rawDigits.length <= 13) {
    return normalizeIndianPhone(rawDigits);
  }

  // Unresolved LID or invalid JID
  return null;
}

// Unified Owner Alert Dispatcher with 131047 catch & dry-run support
async function sendOwnerAlert(activeSock, ownerPhone, text) {
  if (!ownerPhone || !text) return;

  if (process.env.ALERTS_DRY_RUN === 'true') {
    addLog(`[ALERTS_DRY_RUN] (Not sent to WhatsApp) Alert to ${maskPhone(ownerPhone)}:\n${text}`);
    return;
  }

  try {
    const ownerJid = `${ownerPhone}@s.whatsapp.net`;
    const sent = await activeSock.sendMessage(ownerJid, { text });
    if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
    addLog(`[Owner Alert] Successfully dispatched to ${maskPhone(ownerPhone)}`);
  } catch (err) {
    if (err.message && err.message.includes('131047')) {
      addLog(`[Owner Alert Warning] Meta 131047 24h window closed for ${maskPhone(ownerPhone)}. Template fallback triggered (${process.env.OWNER_TEMPLATE_NAME || 'martflow_alert_template'}).`);
    } else {
      addLog(`[Owner Alert Error] Failed to send alert to ${maskPhone(ownerPhone)}: ${err.message}`);
    }
  }
}

// 24-hour TTL idempotency map for inbound message deduplication (reconnect storm protection)
const inboundMsgIdTimestamps = new Map();

async function handleOrgIncomingMessage(orgId, msg, activeSock) {
  if (!msg || !msg.message) return;

  // 1. Processed message ID deduplication with 24-hour TTL
  if (msg.key && msg.key.id) {
    const now = Date.now();
    if (inboundMsgIdTimestamps.has(msg.key.id)) {
      return; // Already processed
    }
    inboundMsgIdTimestamps.set(msg.key.id, now);
    if (inboundMsgIdTimestamps.size > 20000) {
      for (const [k, ts] of inboundMsgIdTimestamps.entries()) {
        if (now - ts > 86400000) inboundMsgIdTimestamps.delete(k); // 24h TTL
      }
    }
  }

  const rawRemote = msg.key.remoteJid || '';
  if (rawRemote.endsWith('@g.us') || rawRemote === 'status@broadcast' || rawRemote.endsWith('@broadcast') || rawRemote.endsWith('@newsletter')) {
    return; // Never reply in groups, broadcasts, or channels
  }

  // Unwrap content from ephemeral / view-once
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
    if (isImage) incomingText = '[Buyer sent photo / product sample]';
    else if (isLocation) {
      const loc = content.locationMessage;
      incomingText = `[Buyer shared location: ${loc.name || loc.address || 'GPS Location'}]`;
    }
  }

  if (!incomingText && !isAudio && !content?.documentMessage) return;

  const altJid = msg.key.remoteJidAlt || msg.key.participant || '';
  const resolvedPhone = resolvePhoneFromJid(rawRemote, altJid);
  const senderPhone = resolvedPhone ? normalizeIndianPhone(resolvedPhone) : '';
  const rawPushName = (msg.pushName || '').trim();
  const pushName = rawPushName && !/^(buyer|unknown|\.|\+?\d+|user|iphone|android|customer|sir|whatsapp|demo|admin)$/i.test(rawPushName) ? rawPushName : 'Customer';

  // Fetch fresh organization configuration from Supabase
  let freshOrg = null;
  if (supabaseAdmin) {
    try {
      const { data } = await supabaseAdmin.from('organizations').select('*').eq('id', orgId).maybeSingle();
      freshOrg = data;
    } catch (e) {}
  }
  if (!freshOrg) {
    freshOrg = {
      id: orgId,
      name: config.companyName || 'MartFlow AI',
      owner_alert_number: config.ownerAlertPhone || '919781018975',
      wa_connected_number: activeSock?.user?.id?.split(':')[0]?.split('@')[0] || '919115748457',
      wa_auto_reply: config.autoReplyEnabled,
      auto_reply_enabled: config.autoReplyEnabled,
      plan_status: 'active'
    };
  }

  const rawJid = rawRemote || '';
  // Multi-tenant safe owner alert target precedence:
  let ownerTarget = normalizeIndianPhone(freshOrg.owner_alert_number);
  if (!ownerTarget && (orgId === '6fd354d9-3437-412d-856e-28bc19d44268' || freshOrg.is_main_demo)) {
    ownerTarget = normalizeIndianPhone(process.env.OWNER_ALERT_PHONE || process.env.OWNER_WHATSAPP || '919781018975');
  }

  if (!ownerTarget) {
    addLog(`[Owner Alert HALTED] Org ${freshOrg.name || orgId} has no owner_alert_number configured. Lead PII withheld to prevent cross-tenant data leakage.`);
  }

  const botPhone = normalizeIndianPhone(activeSock?.user?.id?.split(':')[0] || freshOrg.wa_connected_number || '919115748457');
  const botPhoneDigits = botPhone.slice(-10);
  const botLidUser = (activeSock?.user?.lid || '').split(':')[0].split('@')[0];
  const recipientPhone = normalizeIndianPhone(rawRemote.split('@')[0]);

  // Bulletproof @lid & Typo-Tolerant WhatsApp Remote Control:
  // 1. Detect Bot Self-Chat reliably even with @lid JIDs:
  const isSelfChat = Boolean(msg.key.fromMe && (
    (botPhoneDigits && rawJid.includes(botPhoneDigits)) ||
    (botLidUser && rawJid.split('@')[0] === botLidUser) ||
    (recipientPhone === botPhone)
  ));

  // 2. Detect Owner Main Phone:
  const isFromOwner = Boolean(
    (senderPhone && ownerTarget && senderPhone === ownerTarget) ||
    (rawJid.split('@')[0] === '148004724064491' && ownerTarget.includes('9781018975')) ||
    (altJid && altJid.split('@')[0] === '148004724064491' && ownerTarget.includes('9781018975'))
  );

  // OWNER COMMAND PARSER (Short-circuit BEFORE AI is called)
  const ownerCmd = parseOwnerCommand(incomingText, senderPhone, ownerTarget);
  if (ownerCmd.isOwnerCommand) {
    addLog(`[Owner Command] Action: ${ownerCmd.action} for target ${maskPhone(ownerCmd.targetPhone || '')} from ${maskPhone(senderPhone)}`);

    if (ownerCmd.action === 'TAKE') {
      const res = await takeoverCustomer({
        orgId,
        buyerPhone: ownerCmd.targetPhone,
        takenBy: 'owner',
        supabaseAdmin
      });
      const confirmMsg = `✅ *Manual Takeover Active* for +${res.cleanPhone}\n⏱️ Duration: 4 Hours (AI paused for this customer).\n\n💬 *To reply:* Send \`SEND ${res.cleanPhone.slice(-10)} <your message>\`\n🤖 *To return to AI:* Send \`AI ${res.cleanPhone.slice(-10)}\``;
      const sent = await activeSock.sendMessage(rawRemote, { text: confirmMsg });
      if (sent?.key?.id) botSentMsgIds.add(sent.key.id);

      // Auto-send buyer acknowledgment if configured
      if (process.env.AUTO_TAKEOVER_ACK !== 'false') {
        try {
          const buyerJid = `${res.cleanPhone}@s.whatsapp.net`;
          const ackBuyer = "Aapki baat humari team ko forward kar di gayi hai, hum jaldi reply karenge.";
          const bSent = await activeSock.sendMessage(buyerJid, { text: ackBuyer });
          if (bSent?.key?.id) botSentMsgIds.add(bSent.key.id);
        } catch (e) {}
      }
      return; // Zero AI reply to owner!
    }

    if (ownerCmd.action === 'SEND') {
      try {
        const buyerJid = `${ownerCmd.targetPhone}@s.whatsapp.net`;
        const sentToBuyer = await activeSock.sendMessage(buyerJid, { text: ownerCmd.message });
        if (sentToBuyer?.key?.id) botSentMsgIds.add(sentToBuyer.key.id);

        if (supabaseAdmin) {
          const { data: conv } = await supabaseAdmin.from('conversations')
            .select('id')
            .eq('org_id', orgId)
            .ilike('buyer_phone', `%${ownerCmd.targetPhone.slice(-10)}`)
            .maybeSingle();
          if (conv?.id) {
            await supabaseAdmin.from('messages').insert({
              org_id: orgId,
              conversation_id: conv.id,
              sender: 'agent',
              text: ownerCmd.message
            });
            await supabaseAdmin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conv.id);
          }
        }

        const confirmMsg = `📤 *Relayed to Customer (+${ownerCmd.targetPhone}):*\n"${ownerCmd.message}"`;
        const sent = await activeSock.sendMessage(rawRemote, { text: confirmMsg });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
      } catch (sendErr) {
        await activeSock.sendMessage(rawRemote, { text: `❌ Failed to send to +${ownerCmd.targetPhone}: ${sendErr.message}` });
      }
      return; // Zero AI reply to owner!
    }

    if (ownerCmd.action === 'AI') {
      const res = await releaseCustomer({ orgId, buyerPhone: ownerCmd.targetPhone, supabaseAdmin });
      const confirmMsg = `🤖 *AI Mode Restored* for +${res.cleanPhone}.\nBot will now reply to this customer automatically 24/7.`;
      const sent = await activeSock.sendMessage(rawRemote, { text: confirmMsg });
      if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
      return; // Zero AI reply to owner!
    }

    if (ownerCmd.action === 'STATUS') {
      const activeList = await getActiveTakeovers({ orgId, supabaseAdmin });
      let statusMsg = `📋 *Active Manual Takeovers (${activeList.length})*\n\n`;
      if (activeList.length === 0) {
        statusMsg += `Zero customers currently in manual mode. All buyers are served by AI 24/7.`;
      } else {
        activeList.forEach((t, i) => {
          statusMsg += `${i + 1}. *+${t.buyerPhone}* — Expires in ${t.remainingMinutes} min (Send \`AI ${t.buyerPhone.slice(-10)}\` to release)\n`;
        });
      }
      const sent = await activeSock.sendMessage(rawRemote, { text: statusMsg });
      if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
      return; // Zero AI reply to owner!
    }

    if (ownerCmd.action === 'MUTE') {
      const res = await takeoverCustomer({
        orgId,
        buyerPhone: ownerCmd.targetPhone,
        durationMs: ownerCmd.minutes * 60000,
        supabaseAdmin
      });
      const confirmMsg = `⏸️ *Muted +${res.cleanPhone}* for ${ownerCmd.minutes} minutes.`;
      const sent = await activeSock.sendMessage(rawRemote, { text: confirmMsg });
      if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
      return; // Zero AI reply to owner!
    }
  }

  // Intercept messages if this specific customer is currently held in Manual Takeover
  if (senderPhone) {
    const manualCheck = await isCustomerInManualMode({ orgId, buyerPhone: senderPhone, supabaseAdmin });
    if (manualCheck.inManualMode) {
      try {
        await activeSock.readMessages([msg.key]);
      } catch (e) {}

      addLog(`[Manual Mode Gate] Message from +${senderPhone} intercepted. Relaying to owner (${maskPhone(ownerTarget)}).`);

      if (ownerTarget && ownerTarget !== senderPhone) {
        const relayText = `📩 *Customer Message (+${senderPhone})*\n` +
          `👤 *From:* ${pushName}\n` +
          `💬 "${incomingText}"\n\n` +
          `⚡ *Reply:* Send \`SEND ${senderPhone.slice(-10)} <your reply>\`\n` +
          `📞 tel:+${senderPhone}`;
        await sendOwnerAlert(activeSock, ownerTarget, relayText);
      }

      if (supabaseAdmin) {
        try {
          const { data: conv } = await supabaseAdmin.from('conversations')
            .select('id')
            .eq('org_id', orgId)
            .ilike('buyer_phone', `%${senderPhone.slice(-10)}`)
            .maybeSingle();
          if (conv?.id) {
            await supabaseAdmin.from('messages').insert({
              org_id: orgId,
              conversation_id: conv.id,
              sender: 'buyer',
              text: incomingText
            });
            await supabaseAdmin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conv.id);
          }
        } catch (e) {}
      }
      return; // Gated from AI reply!
    }
  }

  const isFounderControl = isSelfChat || isFromOwner;
  const cmd = (incomingText || '').trim().toLowerCase();

  // Typo-Tolerant Pause Command: manual / mannual / manul / pause / stop / off
  if (isFounderControl && /^(manual|mannual|manul|pause|stop|off)$/.test(cmd)) {
    try {
      if (supabaseAdmin) {
        await supabaseAdmin.from('organizations').update({
          wa_auto_reply: false,
          auto_reply_enabled: false
        }).eq('id', orgId);
      }
      freshOrg.wa_auto_reply = false;
      freshOrg.auto_reply_enabled = false;
      config.autoReplyEnabled = false;
      const replyText = "⏸️ Manual Mode ON — AI paused. Send 'automatic' to resume.";
      const sent = await activeSock.sendMessage(rawRemote, { text: replyText });
      if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
      addLog(`[Remote Control] Manual mode activated by founder for org ${orgId}`);
    } catch (e) {
      addLog(`[Remote Control] Error enabling manual mode: ${e.message}`);
    }
    return;
  }

  // Typo-Tolerant Resume Command: automatic / automoatic / automtic / auto / start / resume / on
  if (isFounderControl && /^(automatic|automoatic|automtic|auto|start|resume|on)$/.test(cmd)) {
    try {
      if (supabaseAdmin) {
        await supabaseAdmin.from('organizations').update({
          wa_auto_reply: true,
          auto_reply_enabled: true
        }).eq('id', orgId);
        await supabaseAdmin.from('conversations').update({
          mode: 'auto'
        }).eq('org_id', orgId);
      }
      freshOrg.wa_auto_reply = true;
      freshOrg.auto_reply_enabled = true;
      config.autoReplyEnabled = true;
      const replyText = "✅ Automatic Mode ON — AI active 24/7. Send 'manual' to pause.";
      const sent = await activeSock.sendMessage(rawRemote, { text: replyText });
      if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
      addLog(`[Remote Control] Automatic mode activated by founder for org ${orgId}`);
    } catch (e) {
      addLog(`[Remote Control] Error enabling automatic mode: ${e.message}`);
    }
    return;
  }

  // HUMAN TAKEOVER AUTO-PAUSE:
  if (msg.key.fromMe) {
    if (botSentMsgIds.has(msg.key.id)) {
      return; // Ignore bot's own outbound dispatched message
    }
    if (!rawRemote.includes('@g.us') && !rawRemote.includes('broadcast') && recipientPhone !== botPhone && !isSelfChat) {
      try {
        if (supabaseAdmin) {
          await supabaseAdmin.from('conversations').update({
            mode: 'manual',
            updated_at: new Date().toISOString()
          }).eq('org_id', orgId).ilike('buyer_phone', `%${recipientPhone.slice(-10)}`);
        }
        addLog(`[Human Takeover] Owner typed manually to customer +${recipientPhone}. Conversation set to manual.`);
      } catch (e) {}
    }
    // Only return if not testing in bot self-chat
    if (!isSelfChat) {
      return;
    }
  }

  // NOTE: If isFromOwner is true, the owner is testing the bot from their personal number.
  // Allow the message to flow into the AI sales engine so the owner receives real AI replies!

  // Meta dual @lid + @s.whatsapp.net fingerprint cooldown (10 seconds)
  const normText = (incomingText || '').trim().toLowerCase();
  const fpKey = `${orgId}:${senderPhone}:${normText}`;
  const now = Date.now();
  if (recentInboundFingerprints.has(fpKey) && (now - recentInboundFingerprints.get(fpKey)) < 10000) {
    addLog(`[Deduplication] Ignored duplicate Meta inbound event from +${senderPhone} within 10s.`);
    return;
  }
  recentInboundFingerprints.set(fpKey, now);
  if (recentInboundFingerprints.size > 2000) {
    for (const [k, v] of recentInboundFingerprints.entries()) {
      if (now - v > 60000) recentInboundFingerprints.delete(k);
    }
  }

  // Per-sender async lock
  if (inFlightSenders.has(senderPhone)) {
    addLog(`[Deduplication] In-flight message already processing for +${senderPhone}. Skipping concurrent event.`);
    return;
  }
  inFlightSenders.add(senderPhone);

  try {
    let sbConvId = null;
    let isBrandNewLead = false;
    let sLead = null;

    if (supabaseAdmin) {
      try {
        const { data: existingLead } = await supabaseAdmin
          .from('leads')
          .select('id, buyer_name, buyer_phone, pdf_brochure_sent')
          .eq('org_id', orgId)
          .ilike('buyer_phone', `%${senderPhone.slice(-10)}`)
          .maybeSingle();

        if (!existingLead) {
          isBrandNewLead = true;
          const { data: newLead } = await supabaseAdmin.from('leads').insert({
            org_id: orgId,
            buyer_name: pushName,
            buyer_phone: senderPhone,
            requirement: incomingText,
            status: 'Hot Lead'
          }).select().single();
          sLead = newLead;
        } else {
          sLead = existingLead;
        }

        let { data: existingConv } = await supabaseAdmin
          .from('conversations')
          .select('id, mode')
          .eq('org_id', orgId)
          .ilike('buyer_phone', `%${senderPhone.slice(-10)}`)
          .maybeSingle();

        if (!existingConv) {
          const { data: nConv } = await supabaseAdmin.from('conversations').insert({
            org_id: orgId,
            lead_id: sLead?.id || null,
            buyer_phone: senderPhone,
            mode: 'auto'
          }).select().single();
          existingConv = nConv;
        }

        sbConvId = existingConv?.id;

        if (sbConvId) {
          await supabaseAdmin.from('messages').insert({
            org_id: orgId,
            conversation_id: sbConvId,
            sender: 'buyer',
            text: isAudio ? '[Voice Note Audio]' : incomingText
          });
          await supabaseAdmin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', sbConvId);
        }

        // Check if organization auto-reply is disabled
        const isOrgAutoReplyOff = freshOrg.wa_auto_reply === false || freshOrg.auto_reply_enabled === false;
        if (isOrgAutoReplyOff) {
          addLog(`[AI Muted] Auto reply is disabled for organization ${freshOrg.name || orgId}.`);
          return;
        }

        if (isFromOwner || isSelfChat) {
          if (existingConv && existingConv.mode === 'manual') {
            existingConv.mode = 'auto';
            if (supabaseAdmin && sbConvId) {
              await supabaseAdmin.from('conversations').update({ mode: 'auto' }).eq('id', sbConvId);
            }
          }
        } else if (existingConv?.mode === 'manual') {
          addLog(`[Manual Mode] Conversation for +${senderPhone} is paused in manual mode.`);
          return;
        }

        // Check lead quota for unpaid signups (main demo org is unlimited)
        const isMainDemo = orgId === '6fd354d9-3437-412d-856e-28bc19d44268' || freshOrg.is_unlimited === true || freshOrg.plan_status === 'active';
        if (!isMainDemo && !isFromOwner && !isSelfChat) {
          const limit = freshOrg.monthly_lead_limit || 3;
          const used = freshOrg.leads_used || 0;
          const trialExpired = freshOrg.trial_ends_at && new Date(freshOrg.trial_ends_at) < new Date();
          if (used >= limit || trialExpired) {
            addLog(`[Quota Reached] Organization ${freshOrg.name || orgId} reached limit (${used}/${limit}). AI reply withheld.`);
            return;
          }
          await supabaseAdmin.from('organizations').update({ leads_used: used + 1 }).eq('id', orgId);
        }
      } catch (dbErr) {
        addLog(`Database sync error: ${dbErr.message}`);
      }
    }

    // Clean, Non-Spammy Private Owner Alerts (Zero Customer Visibility):
    if (ownerTarget && ownerTarget !== senderPhone) {
      const incomingDesc = describeInboundContent(content, incomingText);
      const intentResult = scorePurchaseIntent(incomingText || incomingDesc.text);
      const isUnresolved = !senderPhone || senderPhone.length < 10;
      const cleanBuyerPhone = isUnresolved ? rawRemote : senderPhone;
      const phoneDisplay = isUnresolved ? `⚠️ unresolved number (${rawRemote})` : `+${senderPhone}`;
      const actionLinks = isUnresolved
        ? `💬 *Chat:* ${rawRemote}`
        : `⚡ *WhatsApp:* https://wa.me/${senderPhone}\n📞 *Call:* tel:+${senderPhone}`;

      const canAlertNew = isBrandNewLead && await shouldSendAlert({
        orgId,
        buyerPhone: cleanBuyerPhone,
        kind: 'new_lead',
        supabaseAdmin
      });

      const canAlertHot = (intentResult.isHot || isAudio) && await shouldSendAlert({
        orgId,
        buyerPhone: cleanBuyerPhone,
        kind: 'hot_lead',
        cooldownMs: DEFAULT_HOT_COOLDOWN_MS,
        supabaseAdmin
      });

      // 1. New Lead Alert Card
      if (canAlertNew) {
        const newLeadCard = `🔔 *MartFlow AI — New Inbound Lead*\n` +
          `👤 *Customer:* ${pushName}\n` +
          `📱 *Phone:* ${phoneDisplay}\n` +
          `📍 *City:* ${freshOrg.city_base || 'Direct Inquiry'}\n` +
          `💬 *Message:* "${incomingDesc.text.slice(0, 300)}"\n\n` +
          actionLinks;

        await sendOwnerAlert(activeSock, ownerTarget, newLeadCard);
        await recordAlertSent({ orgId, buyerPhone: cleanBuyerPhone, kind: 'new_lead', supabaseAdmin });
      }

      // 2. Hot Lead Priority Alert Card (Fires EVEN IF it is the first message — delivers BOTH cards!)
      if (canAlertHot) {
        const keywordsStr = intentResult.matchedKeywords.length > 0
          ? intentResult.matchedKeywords.join(', ')
          : (isAudio ? 'voice_note' : 'high_intent');

        const hotLeadCard = `🔥 *MartFlow AI — Hot Lead Alert!* (Score: ${intentResult.score})\n` +
          `👤 *Customer:* ${pushName}\n` +
          `📱 *Phone:* ${phoneDisplay}\n` +
          `🎯 *Keywords:* ${keywordsStr}\n` +
          `💬 *Inquiry:* "${incomingDesc.text.slice(0, 300)}"\n\n` +
          actionLinks + `\n\n` +
          `✋ *To take over:* Send \`TAKE ${!isUnresolved ? senderPhone.slice(-10) : ''}\``;

        await sendOwnerAlert(activeSock, ownerTarget, hotLeadCard);
        await recordAlertSent({ orgId, buyerPhone: cleanBuyerPhone, kind: 'hot_lead', supabaseAdmin });
      }
    }

    // Double-reply prevention: check if an AI reply was inserted in Supabase in last 8s
    if (supabaseAdmin && sbConvId) {
      try {
        const { data: recentAiMsgs } = await supabaseAdmin
          .from('messages')
          .select('created_at')
          .eq('conversation_id', sbConvId)
          .eq('sender', 'ai')
          .order('created_at', { ascending: false })
          .limit(1);
        if (recentAiMsgs && recentAiMsgs.length > 0) {
          const diffMs = Date.now() - new Date(recentAiMsgs[0].created_at).getTime();
          if (diffMs < 8000) {
            addLog(`[Deduplication] AI reply already sent for conversation ${sbConvId} ${diffMs}ms ago. Skipping duplicate.`);
            return;
          }
        }
      } catch (e) {}
    }

    // Fetch conversation history
    let convHistory = [];
    if (supabaseAdmin && sbConvId) {
      try {
        const { data: hist } = await supabaseAdmin
          .from('messages')
          .select('sender, text, created_at')
          .eq('conversation_id', sbConvId)
          .order('created_at', { ascending: true })
          .limit(15);
        if (hist) {
          convHistory = hist.map(m => ({
            role: m.sender === 'ai' ? 'ai' : 'buyer',
            text: m.text
          }));
        }
      } catch (e) {}
    }

    // Fast check BEFORE calling Gemini: if buyerText is a short closing/acknowledgment
    const SHORT_ACK_REGEX = /^(ok|okay|okk|k|theek hai|thik hai|thek hai|accha|acha|thanks|thank you|shukriya|kuch nhi|kuch nahi|nhi|nahi|no need|bye|hmm|hm)[.!?\s]*$/i;
    if (SHORT_ACK_REGEX.test((incomingText || '').trim())) {
      const ackReply = "Ji zaroor! Jab bhi zaroorat ho, yahin message drop kar dena 👍";
      const sentMsg = await activeSock.sendMessage(rawRemote, { text: ackReply });
      if (sentMsg?.key?.id) botSentMsgIds.add(sentMsg.key.id);
      addLog(`[Fast Ack] Sent short 1-line acknowledgment to +${senderPhone}`);

      if (supabaseAdmin && sbConvId) {
        try {
          await supabaseAdmin.from('messages').insert({
            org_id: orgId,
            conversation_id: sbConvId,
            sender: 'ai',
            text: ackReply
          });
          await supabaseAdmin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', sbConvId);
        } catch (e) {}
      }
      return; // ZERO sales pitch and ZERO PDF/photo!
    }

    await activeSock.sendPresenceUpdate('composing', rawRemote);

    // Call AI Sales Engine with rewritten concise prompt & generationConfig
    const aiReplyObj = await generateShortSalesReply({
      organizationId: orgId,
      org: freshOrg,
      lead: sLead || { name: pushName, phone: senderPhone },
      incomingText,
      conversationHistory: convHistory
    });

    if (!aiReplyObj || !aiReplyObj.reply) return;

    // Send AI reply
    const sentMsg = await activeSock.sendMessage(rawRemote, { text: aiReplyObj.reply });
    if (sentMsg?.key?.id) botSentMsgIds.add(sentMsg.key.id);
    await activeSock.sendPresenceUpdate('paused', rawRemote);

    addLog(`AI reply sent to +${senderPhone}: "${aiReplyObj.reply.slice(0, 40)}..."`);

    // Record AI reply in Supabase
    if (supabaseAdmin && sbConvId) {
      try {
        await supabaseAdmin.from('messages').insert({
          org_id: orgId,
          conversation_id: sbConvId,
          sender: 'ai',
          text: aiReplyObj.reply
        });
        await supabaseAdmin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', sbConvId);
      } catch (e) {}
    }

    // Wire aiResult.isCallRequest into hot alert priority path
    if (aiReplyObj?.isCallRequest && ownerTarget && ownerTarget !== senderPhone) {
      const canAlertCall = await shouldSendAlert({
        orgId,
        buyerPhone: senderPhone,
        kind: 'hot_lead',
        cooldownMs: DEFAULT_HOT_COOLDOWN_MS,
        supabaseAdmin
      });
      if (canAlertCall) {
        const phoneDisplay = !senderPhone || senderPhone.length < 10 ? `⚠️ unresolved number (${rawRemote})` : `+${senderPhone}`;
        const actionLinks = !senderPhone || senderPhone.length < 10
          ? `💬 *Chat:* ${rawRemote}`
          : `⚡ *WhatsApp:* https://wa.me/${senderPhone}\n📞 *Call:* tel:+${senderPhone}`;
        const callCard = `🔥 *MartFlow AI — Call / Meeting Requested*\n` +
          `👤 *Customer:* ${pushName}\n` +
          `📱 *Phone:* ${phoneDisplay}\n` +
          `💬 *Intent:* Buyer requested direct phone discussion with technical director / owner.\n\n` +
          actionLinks + `\n\n` +
          `✋ *To take over:* Send \`TAKE ${senderPhone ? senderPhone.slice(-10) : ''}\``;
        await sendOwnerAlert(activeSock, ownerTarget, callCard);
        await recordAlertSent({ orgId, buyerPhone: senderPhone, kind: 'hot_lead', supabaseAdmin });
      }
    }

    // Exactly 1 product photo per turn
    if (aiReplyObj.matchedImageUrl || aiReplyObj.matchedImagePath) {
      try {
        let imgSource = null;
        if (aiReplyObj.matchedImagePath && fs.existsSync(aiReplyObj.matchedImagePath)) {
          imgSource = fs.readFileSync(aiReplyObj.matchedImagePath);
        } else if (aiReplyObj.matchedImageUrl && aiReplyObj.matchedImageUrl.startsWith('data:image')) {
          const b64 = aiReplyObj.matchedImageUrl.split(',')[1] || aiReplyObj.matchedImageUrl;
          imgSource = Buffer.from(b64, 'base64');
        } else if (aiReplyObj.matchedImageUrl && aiReplyObj.matchedImageUrl.startsWith('http')) {
          imgSource = { url: aiReplyObj.matchedImageUrl };
        }
        if (imgSource) {
          const imgCaption = aiReplyObj.matchedImageCaption ? `📸 ${aiReplyObj.matchedImageCaption}` : 'Live Product Photo';
          const imgSent = await activeSock.sendMessage(rawRemote, {
            image: imgSource,
            caption: imgCaption
          });
          if (imgSent?.key?.id) botSentMsgIds.add(imgSent.key.id);
          addLog(`[Product Photo] Dispatched photo to +${senderPhone}: "${imgCaption}"`);
        }
      } catch (imgErr) {
        addLog(`[Product Photo] Error: ${imgErr.message}`);
      }
    }

    // Exactly 1 PDF brochure per turn, deduplicated per sender
    const pdfKey = `${orgId}:${senderPhone}`;
    if (aiReplyObj.matchedBrochureUrl && !sentPdfs.has(pdfKey)) {
      try {
        const brochureSent = await activeSock.sendMessage(rawRemote, {
          document: { url: aiReplyObj.matchedBrochureUrl },
          mimetype: 'application/pdf',
          fileName: aiReplyObj.matchedBrochureName || 'MartFlow_Catalog.pdf',
          caption: `Aapka official technical brochure & price catalog! 📄`
        });
        if (brochureSent?.key?.id) botSentMsgIds.add(brochureSent.key.id);
        sentPdfs.add(pdfKey);
        addLog(`[Brochure] Sent PDF brochure to +${senderPhone}`);
      } catch (pdfErr) {
        addLog(`[Brochure] Error: ${pdfErr.message}`);
      }
    }
  } finally {
    inFlightSenders.delete(senderPhone);
  }
}

async function startOrgWhatsApp(orgId, forceNew = false) {
  if (!orgId) return;
  const sessionDir = path.join(process.cwd(), 'auth_info', orgId);

  // 1. Cleanly close and removeAllListeners() on any existing socket for orgId
  if (orgSessions.has(orgId)) {
    const existing = orgSessions.get(orgId);
    try {
      if (existing.sock) {
        existing.sock.ev.removeAllListeners();
        existing.sock.end();
      }
    } catch (e) {}
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    orgSessions.delete(orgId);
  }

  const sessionObj = {
    sock: null,
    isConnecting: true,
    reconnectTimer: null,
    authDir: sessionDir,
    state: {
      status: 'connecting',
      qrDataUrl: null,
      connectedNumber: null,
      lastEvent: 'Initializing isolated WhatsApp socket...',
      logs: []
    }
  };
  orgSessions.set(orgId, sessionObj);

  try {
    if (forceNew) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        await deleteRemoteSession(orgId);
      } catch (e) {}
    } else {
      const credsFile = path.join(sessionDir, 'creds.json');
      if (!fs.existsSync(credsFile)) {
        await restoreSessionFromSupabase(orgId);
      }
    }

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    let version = [2, 3000, 1043857760];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) version = latest.version;
    } catch {}

    const newSock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.windows('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    sessionObj.sock = newSock;
    sessionObj.isConnecting = false;

    // Link default demo org to global sock and waState
    if (orgId === '6fd354d9-3437-412d-856e-28bc19d44268') {
      sock = newSock;
      waState = sessionObj.state;
      baileysManager.sock = newSock;
      baileysManager.state = sessionObj.state;
    }

    newSock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        debouncedBackupSession(orgId);
      } catch (e) {}
    });

    newSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          sessionObj.state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          sessionObj.state.status = 'qr_ready';
          sessionObj.state.lastEvent = 'Scan QR Code with WhatsApp (Linked Devices > Link a Device)';
          addLog(`[Org: ${orgId.slice(0, 8)}] Fresh WhatsApp QR code generated.`);
          if (supabaseAdmin) {
            await supabaseAdmin.from('organizations').update({
              wa_status: 'qr_ready',
              wa_qr_data_url: sessionObj.state.qrDataUrl,
              wa_command: null
            }).eq('id', orgId);
          }
        } catch (e) {}
      }

      if (connection === 'open') {
        sessionObj.isConnecting = false;
        if (sessionObj.reconnectTimer) clearTimeout(sessionObj.reconnectTimer);
        sessionObj.state.status = 'connected';
        sessionObj.state.qrDataUrl = null;
        sessionObj.state.pairingCode = null;
        const rawMe = newSock.user?.id || '';
        sessionObj.state.connectedNumber = rawMe.split(':')[0].split('@')[0];
        sessionObj.state.lastEvent = `Live & Connected as +${sessionObj.state.connectedNumber}`;
        addLog(`[Org: ${orgId.slice(0, 8)}] WhatsApp CONNECTED successfully (+${sessionObj.state.connectedNumber})`);

        if (supabaseAdmin) {
          await supabaseAdmin.from('organizations').update({
            wa_status: 'connected',
            wa_connected_number: sessionObj.state.connectedNumber,
            bot_whatsapp_number: sessionObj.state.connectedNumber,
            wa_qr_data_url: null,
            wa_pairing_code: null,
            wa_command: null
          }).eq('id', orgId);
        }

        try {
          await backupSessionToSupabase(orgId);
        } catch (e) {}
      }

      if (connection === 'close') {
        sessionObj.isConnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        sessionObj.state.qrDataUrl = null;

        if (isLoggedOut) {
          sessionObj.state.status = 'disconnected';
          sessionObj.state.connectedNumber = null;
          sessionObj.state.lastEvent = 'Logged out from phone. Click Connect to scan again.';
          addLog(`🚨 [WATCHDOG CRITICAL] WhatsApp socket logged out for org ${orgId.slice(0, 8)}. Owner alerts are halted until re-scanned!`);
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            await deleteRemoteSession(orgId);
          } catch (e) {}
          if (supabaseAdmin) {
            await supabaseAdmin.from('organizations').update({
              wa_status: 'disconnected',
              wa_connected_number: null,
              wa_qr_data_url: null,
              wa_pairing_code: null,
              wa_command: null
            }).eq('id', orgId);
          }
        } else {
          sessionObj.state.status = 'connecting';
          sessionObj.state.lastEvent = `Connection interrupted (code: ${statusCode || 'unknown'}). Reconnecting...`;
          addLog(`[Org: ${orgId.slice(0, 8)}] WhatsApp closed (code: ${statusCode}). Auto-reconnecting in 2s...`);
          if (sessionObj.reconnectTimer) clearTimeout(sessionObj.reconnectTimer);
          sessionObj.reconnectTimer = setTimeout(() => {
            startOrgWhatsApp(orgId, false);
          }, 2000);
        }
      }
    });

    newSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          await handleOrgIncomingMessage(orgId, msg, newSock);
        } catch (err) {
          addLog(`[Org: ${orgId.slice(0, 8)}] Message handler error: ${err.message}`);
        }
      }
    });

  } catch (err) {
    sessionObj.isConnecting = false;
    sessionObj.state.status = 'disconnected';
    sessionObj.state.lastEvent = `Startup error: ${err.message}`;
    addLog(`[Org: ${orgId.slice(0, 8)}] Startup error: ${err.message}`);
  }
}

// Global startWhatsApp delegates to main demo organization
async function startWhatsApp() {
  const mainOrgId = '6fd354d9-3437-412d-856e-28bc19d44268';
  return startOrgWhatsApp(mainOrgId, false);
}

// Hook baileysManager to use the single deduplicated startOrgWhatsApp engine
const originalGetInstance = baileysManager.getInstance.bind(baileysManager);
baileysManager.getInstance = function(orgId) {
  const inst = originalGetInstance(orgId);
  inst.init = async function(forceNew = false) {
    await startOrgWhatsApp(orgId, forceNew);
    const session = orgSessions.get(orgId);
    if (session) {
      inst.sock = session.sock;
      inst.isConnected = session.state.status === 'connected';
      inst.state = session.state;
    }
    return inst;
  };
  inst.disconnect = async function() {
    if (orgSessions.has(orgId)) {
      const s = orgSessions.get(orgId);
      try {
        if (s.sock) {
          s.sock.ev.removeAllListeners();
          s.sock.end();
        }
      } catch (e) {}
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
      orgSessions.delete(orgId);
    }
  };
  return inst;
};

baileysManager.sendMessage = async function(orgId, toPhone, messageText, pdfPath, imagePath) {
  const cleanPhone = normalizeIndianPhone(toPhone);
  const jid = `${cleanPhone}@s.whatsapp.net`;
  const session = orgSessions.get(orgId);
  const activeSock = session?.sock || baileysManager.getInstance(orgId)?.sock;
  if (!activeSock) return { ok: false, error: 'WhatsApp socket offline' };

  try {
    let sent;
    if (pdfPath) {
      sent = await activeSock.sendMessage(jid, {
        document: pdfPath.startsWith('http') ? { url: pdfPath } : fs.readFileSync(pdfPath),
        mimetype: 'application/pdf',
        fileName: path.basename(pdfPath) || 'Brochure.pdf',
        caption: messageText || ''
      });
    } else if (imagePath) {
      sent = await activeSock.sendMessage(jid, {
        image: imagePath.startsWith('http') ? { url: imagePath } : fs.readFileSync(imagePath),
        caption: messageText || ''
      });
    } else {
      sent = await activeSock.sendMessage(jid, { text: messageText || '' });
    }
    if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
    return { ok: true, messageId: sent?.key?.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

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
export { buildAdaptiveWelcomeMessage, getIndustryPlaybook };

export function generateNaturalBusinessReply({ org, lead, incomingText, products = [] }) {
  const bType = org?.business_type || config.businessType || 'auto';
  const playbook = getIndustryPlaybook(bType);
  const qLower = (incomingText || '').trim().toLowerCase();
  const isPureGreeting = /^(hi|hello|hey|namaste|pranam|good\s*(morning|afternoon|evening)|hlo|hie|salaam)\b[!?.]*$/i.test(qLower);
  if (isPureGreeting) {
    return buildAdaptiveWelcomeMessage(org || { name: config.companyName, business_type: bType }, products.length ? products : config.products);
  }
  const buyerName = lead?.name || lead?.buyer_name || '';
  const prefix = buyerName ? `Namaste ${buyerName} Ji! ` : 'Namaste Ji!';

  // Objections & Pricing (Persuasive Sales Closer)
  if (/mehnga|costly|expensive|discount|kam\s*karo|budget|price|kitna\s*lagega|pricing|fees|pilot/i.test(qLower)) {
    return `${prefix}Sir sochiye—ek human telecaller mahine ka ₹12,000–₹15,000 leta hai aur shaam 7 baje phone band kar deta hai. MartFlow ₹9,999 mein poore 3 mahine 24/7 chalta hai (yaani ₹110/din se bhi kam—agar mahine mein sirf 1 missed customer convert ho gaya toh pehle hafte mein poora paisa vasool!). Aur abhi ₹9,999 nahi dene—sirf ₹999 Adjustable VIP Pilot se 48 ghante apne real WhatsApp pe live chala ke dekhiye; upgrade karne pe yeh ₹999 poore minus ho jayenge (pay only ₹9,000 balance)! Kya main aapka VIP pilot setup karwa doon?`;
  }

  if (/ban|block|number\s*block|safe|secure/i.test(qLower)) {
    return `${prefix}100% safe hai sir! Number tab ban hota hai jab koi anjaan logon ko bulk cold spam bhejta hai. MartFlow zero spam karta hai—yeh sirf un customers ko natural 3-second human reply deta hai jo khud aapke ad ya page se aapko pehle message karte hain. Aapka WhatsApp number bilkul secure rehta hai.`;
  }

  if (/catalog\s*nahi|pdf\s*nahi|brochure\s*nahi|rate\s*list\s*nahi/i.test(qLower)) {
    return `${prefix}Koi tension nahi sir! Bas 1 minute ka voice note ya rate list ki photo WhatsApp pe bhej dijiye, hamare engineers setup ke dauraan aapke liye photo-rich PDF brochure FREE design kar denge!`;
  }

  const isCall = /call|phone|baat|milna|meeting|director|owner|appointment|visiting/i.test(qLower);
  if (isCall) {
    return `${prefix}Humare senior specialist se aapki call consultation arrange karne ke liye main slot check kar raha hoon. Aapko aaj afternoon me ya evening me call karna convenient rahega?`;
  }
  const orgName = org?.name || config.companyName || 'our business';
  switch (String(bType).toLowerCase()) {
    case 'coaching_ielts':
      return `${prefix}${orgName} me inquire karne ke liye shukriya. Aap kis particular country (Canada/UK/Australia) ya kis intake ke liye prepare karna chahte hain?`;
    case 'solar':
      return `${prefix}${orgName} me apka swagat hai. PM Surya Ghar yojana mein ₹78,000 subsidy seedha bank account mein aati hai. Aapka monthly electricity bill lagbhag kitna aata hai?`;
    case 'real_estate':
      return `${prefix}${orgName} ke verified projects me ruchi lene ke liye dhanyawad. Aap 2/3 BHK ya commercial space me kis budget range aur preferred locality me dekh rahe hain?`;
    case 'interiors':
      return `${prefix}${orgName} me connect karne ke liye shukriya. Hum turnkey modular interiors provide karte hain. Aapka property location kahan hai aur aapka floor plan ready hai?`;
    case 'manufacturing':
      return `${prefix}${orgName} se quotation ke liye dhanyawad. Kya aapke paas technical drawing ya material specs available hain, aur aapka required batch size kitna hoga?`;
    case 'services':
      return `${prefix}${orgName} me contact karne ke liye shukriya. Aapki specific project timeline aur deliverables kya hain, taaki hum customized proposal share kar sakein?`;
    case 'machinery':
    default:
      return `${prefix}${orgName} se quotation ke liye dhanyawad. Aapko kis product/filling material ke liye machine chahiye aur aapka required production speed kitna hai?`;
  }
}

// ============================================================================
// CONCISE WHATSAPP AI SALES CLOSER (MAX 18–38 WORDS, BUSY FOUNDER PERSONA)
// ============================================================================
async function generateShortSalesReply({ organizationId, org, lead, incomingText, conversationHistory }) {
  const geminiKey = (process.env.GEMINI_API_KEY || config.geminiApiKey || '').trim();
  const orgName = org?.name || config.companyName || 'MartFlow AI';
  const cityBase = org?.city_base || org?.company_city || config.cityBase || 'Delhi NCR / Ludhiana';

  // Get catalog products from DB or config
  let products = [];
  if (supabaseAdmin && organizationId) {
    try {
      const { data: dbProds } = await supabaseAdmin.from('products').select('*').eq('org_id', organizationId).neq('is_active', false);
      if (dbProds && dbProds.length > 0) products = dbProds;
    } catch (e) {}
  }
  if (!products.length) {
    products = config.products || [];
  }

  const catalogContext = products.map((p, idx) => {
    const price = p.price_raw || p.priceRange || 'Price on request';
    return `${idx + 1}. "${p.name}" | Price: ${price} | Specs: ${p.model_specs || p.description || 'Standard'}`;
  }).join('\n');

  // Match brochure or image if requested
  const qLower = (incomingText || '').toLowerCase();
  const isCatalogRequest = /catalog|catalogue|brochure|pdf|price\s*list|rate\s*list|details/i.test(qLower);
  const isImageRequest = /photo|image|pic|dikhao|bhejo|dekhna/i.test(qLower);

  let matchedBrochureUrl = null;
  let matchedBrochureName = null;
  const prodWithPdf = products.find(p => p.brochure_url && p.brochure_url.startsWith('http'));
  if (prodWithPdf && isCatalogRequest) {
    matchedBrochureUrl = prodWithPdf.brochure_url;
    matchedBrochureName = (prodWithPdf.name || 'Catalog').replace(/[^a-zA-Z0-9_-]/g, '_') + '.pdf';
  }

  let matchedImageUrl = null;
  let matchedImagePath = null;
  let matchedImageCaption = null;
  if (isImageRequest) {
    const prodWithImg = products.find(p => p.image_url || p.imageUrl);
    if (prodWithImg) {
      matchedImageUrl = prodWithImg.image_url || prodWithImg.imageUrl;
      matchedImageCaption = `${prodWithImg.name} (${prodWithImg.price_raw || prodWithImg.priceRange || ''})`;
    }
  }

  if (geminiKey && geminiKey.length > 10) {
    const systemInstruction = `You are a real, busy business founder/manager on WhatsApp for "${orgName}" (${cityBase}).
Catalog & Pricing Knowledge:
${catalogContext || 'Standard verified offerings apply.'}

STRICT LENGTH RULE:
1. Reply like a real busy human founder/manager on WhatsApp — 1 to 2 short sentences ONLY (strictly 18 to 38 words max) unless the customer explicitly asks to compare multiple plans/items.
2. NEVER write 2–3 long paragraphs.
3. NEVER start every message with fake-enthusiastic AI clichés like "Arre bilkul sir! Bahut badiya decision! 🚀" or "Namaste sir, hum aapki kya madad kar sakte hain".
4. Answer their exact question directly first, give the exact price/fact, and end with AT MOST 1 short 5–8 word question when relevant.
5. Speak natural, conversational Indian Hinglish (or English if the customer wrote in English). Ground strictly to verified catalog.`;

    const historyText = (conversationHistory || [])
      .slice(-10)
      .map(m => `${m.role === 'ai' || m.sender === 'ai' ? 'You' : 'Customer'}: ${m.text || m.content || ''}`)
      .join('\n');

    const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-lite-latest'];
    for (const model of modelsToTry) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: systemInstruction }]
              },
              contents: [
                {
                  role: 'user',
                  parts: [{ text: `Customer: "${incomingText}"\n\nRecent chat context:\n${historyText || '(New inquiry)'}` }]
                }
              ],
              generationConfig: {
                maxOutputTokens: 160,
                temperature: 0.45
              }
            })
          }
        );

        if (resp.ok) {
          const data = await resp.json();
          let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (reply) {
            reply = reply.replace(/^["']|["']$/g, '').trim();
            return {
              reply,
              matchedBrochureUrl,
              matchedBrochureName,
              matchedImageUrl,
              matchedImagePath,
              matchedImageCaption
            };
          }
        }
      } catch (err) {
        // Fallback to next model
      }
    }
  }

  // Graceful rule-based fallback
  const fallbackObj = await AIService.generateSalesReply({
    organizationId,
    lead,
    incomingText,
    conversationHistory
  });

  return {
    reply: fallbackObj?.reply || `Ji Namaste! ${orgName} mein aapka swagat hai. Batayein aapko kis model ki requirement hai?`,
    matchedBrochureUrl: matchedBrochureUrl || fallbackObj?.matchedBrochureUrl,
    matchedBrochureName: matchedBrochureName || fallbackObj?.matchedBrochureName,
    matchedImageUrl: matchedImageUrl || fallbackObj?.matchedImageUrl,
    matchedImagePath: matchedImagePath || fallbackObj?.matchedImagePath,
    matchedImageCaption: matchedImageCaption || fallbackObj?.matchedImageCaption
  };
}

async function generateSalesReply({ lead, incomingText, audioBuffer, audioMime }) {
  const org = db.findOne('organizations', () => true) || { id: '6fd354d9-3437-412d-856e-28bc19d44268' };
  const convHistory = (lead.history || []).map(h => ({
    sender: h.role === 'buyer' ? 'buyer' : 'ai',
    text: h.text
  }));

  try {
    const aiResult = await generateShortSalesReply({
      organizationId: org.id,
      org,
      lead: {
        buyer_name: lead.name,
        buyer_phone: lead.phone,
        product_inquired: lead.productName,
        city: lead.city,
        pdf_brochure_sent: lead.pdfSent
      },
      incomingText: incomingText || '',
      conversationHistory: convHistory
    });

    if (aiResult && aiResult.reply) {
      return {
        reply: aiResult.reply,
        matchedImageUrl: aiResult.matchedImageUrl || null,
        matchedImagePath: aiResult.matchedImagePath || null,
        matchedImageCaption: aiResult.matchedImageCaption || null,
        matchedBrochureUrl: aiResult.matchedBrochureUrl || null,
        matchedBrochureName: aiResult.matchedBrochureName || null,
        extractedCity: aiResult.extractedCity || '',
        extractedRequirement: aiResult.extractedRequirement || '',
        transcriptSummary: audioBuffer ? 'Voice Note' : '',
        isHotLead: Boolean(aiResult.isCallRequest)
      };
    }
  } catch (err) {
    addLog(`AIService delegation error: ${err.message}`);
  }

  // Graceful human fallback grounded to active catalog
  const fallbackWelcome = buildAdaptiveWelcomeMessage({ name: config.companyName, business_type: config.businessType || 'auto' }, config.products);
  return {
    reply: fallbackWelcome,
    extractedCity: '',
    extractedRequirement: '',
    transcriptSummary: audioBuffer ? 'Voice Note' : '',
    isHotLead: false
  };
}

// ============================================================================
// CORE B2B LEAD DISPATCHER (SENDS GREETING + PDF CATALOG IN 8 SECONDS)
// ============================================================================
async function processNewB2BLead({ name, phone, productQuery, city = '', message = '', source = 'B2B Push API', customDelaySec }) {
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
  if (phoneDigits === '148004724064491') phoneDigits = '919781018975';
  if (phoneDigits === '82012517978236') phoneDigits = '919463591820';
  if (phoneDigits === '99273974743237') phoneDigits = '916280844278';

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

  // 1. Dispatch matched product photo / live image if available
  if (sock && (aiResult.matchedImageUrl || aiResult.matchedImagePath)) {
    try {
      let imgSource = null;
      if (aiResult.matchedImagePath && fs.existsSync(aiResult.matchedImagePath)) {
        imgSource = fs.readFileSync(aiResult.matchedImagePath);
      } else if (aiResult.matchedImageUrl && aiResult.matchedImageUrl.startsWith('data:image')) {
        const b64 = aiResult.matchedImageUrl.split(',')[1] || aiResult.matchedImageUrl;
        imgSource = Buffer.from(b64, 'base64');
      } else if (aiResult.matchedImageUrl && aiResult.matchedImageUrl.startsWith('http')) {
        imgSource = { url: aiResult.matchedImageUrl };
      }
      if (imgSource) {
        const imgCaption = aiResult.matchedImageCaption ? `📸 ${aiResult.matchedImageCaption}` : 'Live Product Photo';
        await sock.sendMessage(rawRemote, {
          image: imgSource,
          caption: imgCaption
        });
        addLog(`Sent product photo to ${lead.name} (+${phoneDigits}): "${imgCaption}"`);
      }
    } catch (e) {
      addLog(`Image dispatch error: ${e.message}`);
    }
  }

  // 2. Dispatch matched catalog brochure PDF if requested
  if (sock && aiResult.matchedBrochureUrl) {
    try {
      await sock.sendMessage(rawRemote, {
        document: { url: aiResult.matchedBrochureUrl },
        mimetype: 'application/pdf',
        fileName: aiResult.matchedBrochureName || 'Catalog.pdf',
        caption: `Aapka official technical brochure & price list! 🙏`
      });
      lead.pdfSent = true;
      addLog(`Sent brochure PDF (${aiResult.matchedBrochureName}) to ${lead.name} (+${phoneDigits})`);
    } catch (e) {
      addLog(`Brochure dispatch error: ${e.message}`);
    }
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

// Render & Uptime Healthcheck Endpoint
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString() });
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

// Real-Time Catalog Cache Invalidation & Instant AI Sync Endpoint
app.post('/api/catalog/sync', async (req, res) => {
  try {
    const { orgId } = req.body || {};
    invalidateCache(orgId);
    addLog(`[Catalog Sync] Flushed RAM cache for org: ${orgId || 'all'}`);
    res.json({ ok: true, message: 'Catalog cache refreshed successfully' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// AI Catalog Extraction Fallback Endpoint for unstructured text
app.post('/api/catalog/extract-ai', async (req, res) => {
  try {
    const { rawText, fileName } = req.body;
    if (!rawText || !rawText.trim()) {
      return res.status(400).json({ ok: false, items: [], error: 'rawText is required' });
    }
    const activeGeminiKey = (config.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
    if (!activeGeminiKey) {
      return res.json({ ok: false, items: [], error: 'Gemini API key not configured' });
    }
    const prompt = `You are a B2B product catalog parser. Extract all distinct commercial products, services, or SKUs from the catalog text below.
Filename: "${fileName || 'Catalog.pdf'}"
Catalog Text:
${rawText.slice(0, 8000)}

Return a strict JSON object with this structure:
{
  "items": [
    {
      "sku_code": "SKU-CODE",
      "name": "Product Name",
      "price_raw": "₹Price with details or Contact for Quote",
      "model_specs": "Key specifications, features, capacity, warranty",
      "moq": "Standard MOQ",
      "stock_status": "Available"
    }
  ]
}`;

    const models = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite'];
    for (const m of models) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(activeGeminiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: 'application/json',
                maxOutputTokens: 2000,
                temperature: 0.2
              }
            })
          }
        );
        if (resp.ok) {
          const d = await resp.json();
          const jsonText = d?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (jsonText) {
            const parsed = JSON.parse(jsonText);
            if (Array.isArray(parsed?.items)) {
              return res.json({ ok: true, items: parsed.items });
            }
          }
        }
      } catch (err) {
        console.warn(`[Catalog Extract AI] Model ${m} error:`, err.message);
      }
    }
    res.json({ ok: false, items: [], error: 'Failed to extract items with AI' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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

// Auto-clean legacy demo strings from Supabase on boot
async function runStartupDataCleanup() {
  if (!supabaseAdmin) return;
  try {
    // 1. Clean legacy organization names and welcome messages
    await supabaseAdmin
      .from('organizations')
      .update({
        name: 'MartFlow AI',
        wa_welcome_message: 'Namaste! Welcome to MartFlow AI 👋 How can we help automate your business WhatsApp today?'
      })
      .eq('name', 'Apex Packaging Demo');

    // 2. Clean legacy product names containing 'Free Trial'
    const { data: legacyProducts } = await supabaseAdmin
      .from('products')
      .select('id, name')
      .eq('sku', 'MF-801A')
      .ilike('name', '%Free Trial%');

    if (legacyProducts && legacyProducts.length > 0) {
      for (const p of legacyProducts) {
        await supabaseAdmin
          .from('products')
          .update({ name: '48-Hour Live VIP Business Pilot (₹999 — 100% Adjusted in Plan)' })
          .eq('id', p.id);
      }
    }
    addLog('[Startup Cleanup] Verified & cleaned legacy demo strings from Supabase.');
  } catch (err) {
    addLog(`[Startup Cleanup] Note: ${err.message}`);
  }
}

async function initSupabaseWorker() {
  if (!supabaseAdmin) {
    addLog('[Supabase Worker] Supabase credentials not found in .env, worker running in local-only mode.');
    return;
  }
  addLog('[Supabase Worker] Initializing Multi-Tenant Realtime & Command Engine...');
  await runStartupDataCleanup();

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

  // Reconcile Database Status with In-Memory Sockets & Disk Credentials
  async function syncConnectedStatus() {
    try {
      const { data: orgs, error } = await supabaseAdmin
        .from('organizations')
        .select('id, name, wa_status');
      if (error || !orgs) return;
      for (const org of orgs) {
        const inst = baileysManager.getInstance(org.id);
        const credsFile = path.join(inst.authDir, 'creds.json');
        let hasCreds = fs.existsSync(credsFile);

        // If credentials not found locally on disk, restore from Supabase Cloud Storage
        if (!hasCreds) {
          try {
            const restored = await restoreSessionFromSupabase(org.id);
            if (restored) {
              hasCreds = fs.existsSync(credsFile);
            }
          } catch (e) {}
        }

        if (hasCreds && !inst.isConnected) {
          addLog(`[Supabase Worker] Organization ${org.name || org.id} has saved creds (local/cloud). Auto-resuming...`);
          await supabaseAdmin.from('organizations').update({ wa_status: 'initializing' }).eq('id', org.id);
          inst.init(false);
        } else if (org.wa_status === 'connected' && !hasCreds) {
          addLog(`[Supabase Worker] Organization ${org.name || org.id} marked 'connected' in DB but has no credentials. Resetting to disconnected.`);
          await supabaseAdmin.from('organizations').update({
            wa_status: 'disconnected',
            wa_connected_number: null,
            wa_qr_data_url: null,
            wa_pairing_code: null
          }).eq('id', org.id);
        }
      }
    } catch (err) {}
  }

  await syncConnectedStatus();

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
            .update({ wa_status: 'initializing', wa_qr_data_url: null })
            .eq('id', org.id);

          const inst = baileysManager.getInstance(org.id);
          await inst.init(true);
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
          const targetPhone = normalizeIndianPhone(item.to_phone);
          const res = await baileysManager.sendMessage(
            item.org_id,
            targetPhone,
            item.message_text || '',
            item.pdf_url || null,
            item.message_text || ''
          );

          if (res.ok) {
            await supabaseAdmin
              .from('wa_outbound_queue')
              .update({ status: 'sent', error_text: null })
              .eq('id', item.id);
            addLog(`[Supabase Worker] Outbound queue message delivered to +${targetPhone}`);
          } else {
            // Also attempt fallback via primary socket if connected
            if (sock && waState.status === 'connected') {
              const jid = `${targetPhone}@s.whatsapp.net`;
              if (item.pdf_url) {
                const sent = await sock.sendMessage(jid, {
                  document: { url: item.pdf_url },
                  mimetype: 'application/pdf',
                  fileName: item.pdf_name || 'Brochure.pdf',
                  caption: item.message_text || ''
                });
                if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
              } else {
                const sent = await sock.sendMessage(jid, { text: item.message_text });
                if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
              }
              await supabaseAdmin
                .from('wa_outbound_queue')
                .update({ status: 'sent', error_text: null })
                .eq('id', item.id);
              addLog(`[Supabase Worker] Outbound queue message delivered via primary socket to +${targetPhone}`);
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

  // Mutex-locked command & queue poll every 1.5 seconds
  let isSyncing = false;
  let syncTickCounter = 0;
  async function runSyncTick() {
    if (isSyncing) return;
    isSyncing = true;
    try {
      await pollCommands();
      await pollOutboundQueue();
      syncTickCounter++;
      if (syncTickCounter % 10 === 0) {
        await syncConnectedStatus();
      }
    } catch (e) {
      addLog(`[Supabase Worker] Sync tick error: ${e.message}`);
    } finally {
      isSyncing = false;
    }
  }

  setInterval(runSyncTick, 1500);

  // Realtime subscription channel
  try {
    const channel = supabaseAdmin.channel('martflow-worker');
    channel
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'organizations' },
        (payload) => {
          if (payload.new && payload.new.wa_command) {
            runSyncTick();
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'wa_outbound_queue' },
        () => {
          runSyncTick();
        }
      )
      .subscribe((status) => {
        addLog(`[Supabase Worker] Realtime channel status: ${status}`);
      });
  } catch (rtErr) {
    addLog(`[Supabase Worker] Realtime subscription fallback to polling: ${rtErr.message}`);
  }
}

// Direct local/cloud WhatsApp endpoints for instant responses
app.get('/api/wa/status/:orgId', (req, res) => {
  const orgId = req.params.orgId;
  const inst = baileysManager.getInstance(orgId);
  res.json({ ok: true, state: inst.getState() });
});

app.post('/api/wa/start-qr', async (req, res) => {
  const { orgId } = req.body;
  if (!orgId) return res.status(400).json({ ok: false, error: 'orgId required' });
  const inst = baileysManager.getInstance(orgId);
  await inst.init(true);
  res.json({ ok: true, message: 'QR initialization started' });
});

app.post('/api/wa/pair-code', async (req, res) => {
  const { orgId, phone } = req.body;
  if (!orgId || !phone) return res.status(400).json({ ok: false, error: 'orgId and phone required' });
  const inst = baileysManager.getInstance(orgId);
  try {
    const code = await inst.requestPairing(phone);
    res.json({ ok: true, pairingCode: code });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/wa/disconnect', async (req, res) => {
  const { orgId } = req.body;
  if (!orgId) return res.status(400).json({ ok: false, error: 'orgId required' });
  const inst = baileysManager.getInstance(orgId);
  await inst.disconnect();
  res.json({ ok: true, message: 'Session disconnected' });
});

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
