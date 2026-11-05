import 'dotenv/config';
import dns from 'dns';
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
import crypto from 'crypto';
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
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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
import { authenticate, requireRole } from './src/middleware/authMiddleware.js';
import { requireCatalogManager, requireConversationAccess } from './src/middleware/catalogAccess.js';
import { baileysManager } from './src/integrations/whatsapp/baileysManager.js';
import { attachIncomingCallAlerts } from './src/integrations/whatsapp/incomingCallAlert.js';
import {
  backupSessionToSupabase,
  debouncedBackupSession,
  restoreSessionFromSupabase,
  deleteRemoteSession,
  enableSessionBackups
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
import LearningService from './src/services/learningService.js';
import { isSafePublicUrl, safeFetchWebsite } from './src/services/safeWebsiteFetch.js';

dotenv.config();

// Global Anti-Duplicate, Anti-Loop & Tracking Sets
const botSentMsgIds = new Set();
const processedMsgIds = new Set();
const senderQueues = new Map();
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

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please slow down.' }
});
app.use('/api/', apiLimiter);

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

// Safe Conversational Learning: Proposes verified knowledge rules strictly for consented tenants
function analyzeAndLearnFromChat(lead, incomingText, aiResult) {
  try {
    const orgId = lead?.org_id || lead?.organization_id;
    if (!orgId || !LearningService.isLearningOptedIn(orgId)) {
      return; // Fail safe: never extract unconsented knowledge or modify global databases
    }
    const history = lead.history || [];
    if (history.length >= 2) {
      LearningService.proposeFactsFromConversation({
        organizationId: orgId,
        conversationId: lead.id,
        messages: history
      });
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

  // 4. Raw digits fallback if length matches valid phone or WhatsApp LID (10 to 16 digits)
  const rawDigits = (remoteJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (rawDigits && rawDigits.length >= 10 && rawDigits.length <= 16) {
    return normalizeIndianPhone(rawDigits);
  }

  // Unresolved JID
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
    addLog(`[Owner Alert Error] Failed to send alert to ${maskPhone(ownerPhone)}: ${err.message}`);
  }
}

// 24-hour TTL idempotency map for inbound message deduplication (reconnect storm protection)
const inboundMsgIdTimestamps = new Map();

// Owner WhatsApp catalog control state (in-memory per org)
const ownerPendingConfirmations = new Map(); // orgId -> { type, data, actions, product, summary, expiresAt }
const ownerUndoSnapshots = new Map();        // orgId -> { action, data, rollbacks }
const conversationSentPhotos = new Map();    // `${orgId}:${senderPhone}` -> Set<productNameOrId>
const conversationSentBuyLinks = new Map();  // `${orgId}:${senderPhone}` -> Set<productKeyOrUrl>
const lastOrgWebsiteSync = new Map();        // orgId -> timestamp
const orderAlertSentSet = new Set();         // `${orgId}:${senderPhone}:order_intent`

function getConversationTrackingKey(orgId, lead) {
  const identifier = lead?.phone || lead?.buyer_phone || lead?.senderPhone || lead?.customer_phone ||
    lead?.id || lead?.conversation_id || lead?.sessionKey || (lead?.name ? 'name:' + lead.name : null);
  if (identifier) {
    const cleanId = String(identifier).trim().replace(/\D/g, '') || String(identifier).trim().replace(/\s+/g, '_');
    return `${orgId}:${cleanId}`;
  }
  if (lead && typeof lead === 'object') {
    if (!lead._trackingKey) {
      lead._trackingKey = 'ephem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    }
    return `${orgId}:${lead._trackingKey}`;
  }
  return `${orgId}:ephem_` + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}


// --- Website Sync & SSRF Protection Helpers ---
function stripHtmlTags(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getOrgWebsiteUrl(websiteKnowledge) {
  if (!websiteKnowledge) return '';
  const firstLine = websiteKnowledge.split('\n')[0] || '';
  const m = firstLine.match(/^WEBSITE_URL:\s*(https?:\/\/[^\s]+)/i);
  return m ? m[1].trim() : '';
}

function setOrgWebsiteUrl(existingKnowledge, newUrl) {
  const cleanUrl = newUrl.trim();
  const restLines = (existingKnowledge || '')
    .split('\n')
    .filter(line => !line.startsWith('WEBSITE_URL:'))
    .join('\n')
    .trim();
  const newHeader = `WEBSITE_URL: ${cleanUrl}`;
  return restLines ? `${newHeader}\n${restLines}` : newHeader;
}

async function syncWebsiteProducts(orgId, websiteUrl, activeSock = null, rawRemote = null) {
  try {
    addLog(`[Website Sync] Initiating sync for org ${orgId} from ${websiteUrl}`);
    const parsed = new URL(websiteUrl);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const syncedItems = [];

    // Attempt (a): Shopify products.json
    try {
      const shopifyUrl = `${origin}/products.json?limit=250`;
      const sRes = await safeFetchWebsite(shopifyUrl);
      if (sRes.ok && sRes.text) {
        let sData = null;
        try { sData = JSON.parse(sRes.text); } catch (_) {}
        if (sData && Array.isArray(sData.products) && sData.products.length > 0) {
          addLog(`[Website Sync] Detected Shopify store with ${sData.products.length} products`);
          for (const p of sData.products) {
            const title = (p.title || '').trim();
            if (!title) continue;
            const handle = p.handle || String(p.id);
            const sku = `WEB-${handle}`;
            const v0 = p.variants?.[0] || {};
            const priceVal = v0.price;
            let price_raw = 'Price on request';
            if (priceVal !== undefined && priceVal !== null && priceVal !== '') {
              price_raw = String(priceVal).includes('₹') || String(priceVal).includes('$') ? String(priceVal) : `₹${priceVal}`;
            }
            const isAvailable = p.variants?.some(v => v.available !== false) ?? true;
            const shortDesc = stripHtmlTags(p.body_html || '').slice(0, 300).trim();
            const prodUrl = `${origin}/products/${handle}`;
            const desc = `${isAvailable ? '' : '[OUT OF STOCK] '}${shortDesc ? shortDesc + '\n' : ''}Buy link: ${prodUrl}`.trim();
            const img = p.images?.[0]?.src || null;
            syncedItems.push({
              sku,
              name: title,
              price_raw,
              description: desc,
              brochure_url: img,
              brochure_filename: `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`,
              isAvailable
            });
          }
        }
      }
    } catch (sErr) {
      addLog(`[Website Sync] Shopify attempt error: ${sErr.message}`);
    }

    // Attempt (b): WooCommerce Store API
    if (syncedItems.length === 0) {
      try {
        const wcUrl = `${origin}/wp-json/wc/store/v1/products?per_page=100`;
        const wRes = await safeFetchWebsite(wcUrl);
        if (wRes.ok && wRes.text) {
          let wData = null;
          try { wData = JSON.parse(wRes.text); } catch (_) {}
          if (Array.isArray(wData) && wData.length > 0) {
            addLog(`[Website Sync] Detected WooCommerce store with ${wData.length} products`);
            for (const p of wData) {
              const name = (p.name || '').trim();
              if (!name) continue;
              const handle = p.slug || String(p.id);
              const sku = `WEB-${handle}`;
              const sym = p.prices?.currency_symbol || '₹';
              const rawVal = p.prices?.price || p.prices?.regular_price;
              const unit = p.prices?.currency_minor_unit ?? 2;
              let price_raw = 'Price on request';
              if (rawVal) {
                const num = Number(rawVal) / Math.pow(10, unit);
                price_raw = isNaN(num) ? `₹${rawVal}` : `${sym}${num.toLocaleString('en-IN')}`;
              }
              const isAvailable = p.is_in_stock !== false;
              const shortDesc = stripHtmlTags(p.short_description || p.description || '').slice(0, 300).trim();
              const prodUrl = p.permalink || `${origin}/?p=${p.id}`;
              const desc = `${isAvailable ? '' : '[OUT OF STOCK] '}${shortDesc ? shortDesc + '\n' : ''}Buy link: ${prodUrl}`.trim();
              const img = p.images?.[0]?.src || null;
              syncedItems.push({
                sku,
                name,
                price_raw,
                description: desc,
                brochure_url: img,
                brochure_filename: `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`,
                isAvailable
              });
            }
          }
        }
      } catch (wErr) {
        addLog(`[Website Sync] WooCommerce attempt error: ${wErr.message}`);
      }
    }

    // Attempt (c): Sitemap + Schema.org JSON-LD fallback
    if (syncedItems.length === 0) {
      try {
        const sitemapPaths = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-products.xml', '/product-sitemap.xml'];
        let sitemapXml = '';
        for (const smp of sitemapPaths) {
          try {
            const smRes = await safeFetchWebsite(`${origin}${smp}`);
            if (smRes.ok && smRes.text && (smRes.text.includes('<urlset') || smRes.text.includes('<sitemapindex') || smRes.text.includes('<loc>'))) {
              sitemapXml = smRes.text;
              break;
            }
          } catch (_) {}
        }
        if (sitemapXml) {
          const urlMatches = Array.from(sitemapXml.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/gi)).map(m => m[1].trim());
          const productUrls = urlMatches.filter(u => {
            const low = u.toLowerCase();
            return (low.includes('/product/') || low.includes('/products/') || low.includes('/item/') || low.includes('/p/'))
              && !low.includes('/category/') && !low.includes('/tag/') && !low.endsWith('.xml');
          }).slice(0, 60);

          const urlsToFetch = productUrls.length > 0 ? productUrls : urlMatches.filter(u => !u.endsWith('.xml')).slice(0, 30);
          addLog(`[Website Sync] Sitemap found. Scanning ${urlsToFetch.length} candidate URLs for JSON-LD`);

          for (let i = 0; i < urlsToFetch.length; i += 5) {
            const batch = urlsToFetch.slice(i, i + 5);
            await Promise.all(batch.map(async (pUrl) => {
              try {
                const pageRes = await safeFetchWebsite(pUrl);
                if (pageRes.ok && pageRes.text) {
                  const jsonLdMatches = Array.from(pageRes.text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
                  for (const jm of jsonLdMatches) {
                    try {
                      const parsedLd = JSON.parse(jm[1]);
                      const itemsArray = Array.isArray(parsedLd) ? parsedLd : (parsedLd['@graph'] || [parsedLd]);
                      for (const item of itemsArray) {
                        if (item && (item['@type'] === 'Product' || (Array.isArray(item['@type']) && item['@type'].includes('Product')))) {
                          const name = (item.name || '').trim();
                          if (!name) continue;
                          const handle = pUrl.split('/').filter(Boolean).pop() || crypto.createHash('md5').update(name).digest('hex').slice(0, 8);
                          const sku = `WEB-${handle}`;
                          const offer = Array.isArray(item.offers) ? item.offers[0] : (item.offers || {});
                          const priceVal = offer.price;
                          const curr = offer.priceCurrency || '₹';
                          let price_raw = 'Price on request';
                          if (priceVal) {
                            price_raw = String(priceVal).includes('₹') || String(priceVal).includes('$') ? String(priceVal) : `${curr} ${priceVal}`;
                          }
                          const avail = String(offer.availability || '');
                          const isAvailable = !avail.toLowerCase().includes('outofstock');
                          const shortDesc = stripHtmlTags(item.description || '').slice(0, 300).trim();
                          const img = typeof item.image === 'string' ? item.image : (Array.isArray(item.image) ? item.image[0] : (item.image?.url || null));
                          const desc = `${isAvailable ? '' : '[OUT OF STOCK] '}${shortDesc ? shortDesc + '\n' : ''}Buy link: ${pUrl}`.trim();
                          syncedItems.push({
                            sku,
                            name,
                            price_raw,
                            description: desc,
                            brochure_url: img,
                            brochure_filename: `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`,
                            isAvailable
                          });
                        }
                      }
                    } catch (_) {}
                  }
                }
              } catch (_) {}
            }));
          }
        }
      } catch (smErr) {
        addLog(`[Website Sync] Sitemap attempt error: ${smErr.message}`);
      }
    }

    const toUpsert = syncedItems.slice(0, 300);
    let upsertCount = 0;
    for (const item of toUpsert) {
      try {
        let existing = null;
        if (supabaseAdmin) {
          const { data } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).or(`sku.eq.${item.sku},name.ilike.${item.name}`).limit(1).maybeSingle();
          existing = data;
        }
        if (!existing) {
          existing = db.findOne('products', p => (p.org_id === orgId || p.organization_id === orgId) && (p.sku === item.sku || p.name.toLowerCase() === item.name.toLowerCase()));
        }
        if (existing) {
          const upd = {
            name: item.name,
            price_raw: item.price_raw,
            description: item.description,
            brochure_url: item.brochure_url || existing.brochure_url,
            brochure_filename: item.brochure_filename || existing.brochure_filename,
            is_active: true,
            updated_at: new Date().toISOString()
          };
          if (supabaseAdmin) await supabaseAdmin.from('products').update(upd).eq('id', existing.id).eq('org_id', orgId);
          try { db.update('products', existing.id, { ...upd, org_id: orgId, organization_id: orgId }); } catch (_) {}
        } else {
          const newId = crypto.randomUUID();
          const rec = {
            id: newId,
            org_id: orgId,
            organization_id: orgId,
            sku: item.sku,
            name: item.name,
            price_raw: item.price_raw,
            description: item.description,
            brochure_url: item.brochure_url,
            brochure_filename: item.brochure_filename,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
          if (supabaseAdmin) {
            const sbRec = { ...rec };
            delete sbRec.organization_id;
            await supabaseAdmin.from('products').insert(sbRec);
          }
          try { db.insert('products', rec); } catch (_) {}
        }
        upsertCount++;
      } catch (upErr) {
        addLog(`[Website Sync] Error upserting product ${item.name}: ${upErr.message}`);
      }
    }

    lastOrgWebsiteSync.set(orgId, Date.now());
    const replyMsg = `Synced ${upsertCount} products from your website.`;
    addLog(`[Website Sync] Completed: ${replyMsg}`);
    if (activeSock && rawRemote) {
      const sent = await activeSock.sendMessage(rawRemote, { text: replyMsg });
      if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
    }
    return upsertCount;
  } catch (err) {
    addLog(`[Website Sync Critical] ${err.message}`);
    if (activeSock && rawRemote) {
      try {
        const sent = await activeSock.sendMessage(rawRemote, { text: `❌ Website sync error: ${err.message}` });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
      } catch (_) {}
    }
    return 0;
  }
}

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
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    '';

  const isAudio = Boolean(content?.audioMessage);
  const isImage = Boolean(content?.imageMessage);
  const isVideo = Boolean(content?.videoMessage);
  const isLocation = Boolean(content?.locationMessage);

  // Download image buffer if buyer sent a photo / product screenshot
  let imageBase64 = null;
  let imageMime = 'image/jpeg';
  if (isImage) {
    try {
      imageMime = content?.imageMessage?.mimetype || 'image/jpeg';
      const imgBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: activeSock?.logger || pino({ level: 'silent' }),
        reuploadRequest: activeSock?.updateMediaMessage
      });
      if (imgBuffer) {
        imageBase64 = Buffer.isBuffer(imgBuffer) ? imgBuffer.toString('base64') : Buffer.from(imgBuffer).toString('base64');
      }
    } catch (e) {
      addLog(`[Image Download] Error downloading image message: ${e.message}`);
    }
  }

  // Detect Meta Click-to-WhatsApp Ad headline (externalAdReply)
  const adContext =
    content?.extendedTextMessage?.contextInfo?.externalAdReply ||
    content?.imageMessage?.contextInfo?.externalAdReply ||
    msg.message?.extendedTextMessage?.contextInfo?.externalAdReply ||
    msg.message?.imageMessage?.contextInfo?.externalAdReply;
  const clickedAdInfo = (adContext?.title || adContext?.body)
    ? `Clicked Ad Info: "${(adContext.title || '').trim()} - ${(adContext.body || '').trim()}"`
    : '';

  if (!incomingText) {
    if (isImage) {
      incomingText = '[Customer sent a product photo screenshot — identify the matching category from active catalog, share pricing/details from catalog, and ask desired specifications/quantity/city]';
    } else if (isVideo) {
      incomingText = content?.videoMessage?.caption || '[Customer shared a video/reel inquiry — ask screenshot or desired quantity & share matching category range]';
    } else if (isLocation) {
      const loc = content.locationMessage;
      incomingText = `[Buyer shared location: ${loc.name || loc.address || 'GPS Location'}]`;
    }
  }

  if (!incomingText && !isAudio && !isImage && !isVideo && !content?.documentMessage) return;

  const altJid = msg.key.remoteJidAlt || msg.key.participant || '';
  const resolvedPhone = resolvePhoneFromJid(rawRemote, altJid);
  let senderPhone = resolvedPhone ? normalizeIndianPhone(resolvedPhone) : '';
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
    try { freshOrg = db.findById('organizations', orgId); } catch (e) {}
  }
  if (!freshOrg && supabaseAdmin) {
    addLog(`[Org: ${orgId.slice(0, 8)}] Organization unavailable; inbound reply withheld.`);
    return;
  }
  if (!freshOrg) {
    freshOrg = {
      id: orgId,
      name: config.companyName || 'Leadsy AI',
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
  const botLidUser = (activeSock?.user?.lid || activeSock?.authState?.creds?.me?.lid || '').split(':')[0].split('@')[0];
  const recipientPhone = normalizeIndianPhone(rawRemote.split('@')[0]);

  // Bulletproof @lid & Typo-Tolerant WhatsApp Remote Control:
  // 1. Detect Bot Self-Chat reliably even with @lid JIDs:
  const isSelfChat = Boolean(msg.key.fromMe && (
    (botPhoneDigits && rawJid.includes(botPhoneDigits)) ||
    (botLidUser && (rawJid.split('@')[0] === botLidUser || rawJid.includes(botLidUser))) ||
    (recipientPhone === botPhone) ||
    (rawRemote && activeSock?.user?.id && rawRemote.split('@')[0] === activeSock.user.id.split(':')[0])
  ));

  // If self-chat, senderPhone is authoritatively the bot's connected phone
  if (isSelfChat && (!senderPhone || senderPhone === botLidUser || senderPhone.length < 10)) {
    senderPhone = botPhone;
  } else if (!senderPhone) {
    const rawDigits = rawRemote.split('@')[0].replace(/\D/g, '');
    senderPhone = rawDigits.length >= 10 ? rawDigits : `lid_${rawRemote.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  }

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

  // OWNER CALL TIME CONFIRMATION HANDLER
  if (isFromOwner && !ownerCmd.isOwnerCommand) {
    let targetLead = leads.find((l) => (l.org_id === orgId || l.organization_id === orgId) && l.callbackStatus === 'awaiting_client_time');
    const looksLikeTime = /(today|tomorrow|kal|aaj|pm|am|baje|\d{1,2}:\d{2}|abhi|now|sham|subah|afternoon|morning|evening)/i.test(incomingText);
    if (targetLead && looksLikeTime) {
      const confirmedTime = await parseClientConfirmedTime(incomingText);
      await confirmCallSlotAndNotifyBoth({
        lead: targetLead,
        confirmedTime,
        confirmedBy: `Owner WhatsApp (+${senderPhone})`
      });
      const confirmReply = `✅ *Call Slot Confirmed & Buyer Notified!* Scheduled for *${confirmedTime}*.`;
      const sent = await activeSock.sendMessage(rawRemote, { text: confirmReply });
      if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
      return;
    }
  }

  // Intercept messages if this specific customer is currently held in Manual Takeover
  if (senderPhone) {
    const manualCheck = await isCustomerInManualMode({ orgId, buyerPhone: senderPhone, supabaseAdmin });
    if (manualCheck.inManualMode && !isFromOwner && !isSelfChat) {
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

  // Live AI Note / Stock Update Command: note: <text> or stock: <text>
  if (isFounderControl && /^(?:note|stock)\s*:\s*([\s\S]+)$/i.test((incomingText || '').trim())) {
    const match = (incomingText || '').trim().match(/^(?:note|stock)\s*:\s*([\s\S]+)$/i);
    const updateText = match ? match[1].trim() : '';
    if (updateText) {
      try {
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const noteLine = `[Live Update ${timestamp}]: ${updateText}`;
        let updatedKnowledge = noteLine;
        if (supabaseAdmin) {
          const { data: curOrg } = await supabaseAdmin.from('organizations').select('website_knowledge').eq('id', orgId).maybeSingle();
          const existing = curOrg?.website_knowledge || freshOrg.website_knowledge || '';
          updatedKnowledge = existing ? `${existing}\n${noteLine}` : noteLine;
          await supabaseAdmin.from('organizations').update({
            website_knowledge: updatedKnowledge,
            updated_at: new Date().toISOString()
          }).eq('id', orgId);
        } else {
          const existing = freshOrg.website_knowledge || '';
          updatedKnowledge = existing ? `${existing}\n${noteLine}` : noteLine;
        }
        ownerUndoSnapshots.set(orgId, {
          action: 'knowledge',
          oldKnowledge: existing
        });
        freshOrg.website_knowledge = updatedKnowledge;
        const sent = await activeSock.sendMessage(rawRemote, { text: "Done: Live note updated. Type undo to reverse." });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        addLog(`[Remote Control] Live AI note updated by owner for org ${orgId}: ${updateText}`);
      } catch (e) {
        addLog(`[Remote Control] Error updating live note: ${e.message}`);
        await activeSock.sendMessage(rawRemote, { text: `❌ Failed to update note: ${e.message}` });
      }
      return;
    }
  }

  // Owner Offer Command: offer: <text with Valid till date>
  if (isFounderControl && /^offer\s*:\s*([\s\S]+)$/i.test((incomingText || '').trim())) {
    const match = (incomingText || '').trim().match(/^offer\s*:\s*([\s\S]+)$/i);
    const offerText = match ? match[1].trim() : '';
    if (offerText) {
      try {
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const cleanOffer = offerText.replace(/^OFFER:\s*/i, '').trim();
        const offerLine = `OFFER: ${cleanOffer} [Added ${timestamp}]`;
        let updatedKnowledge = offerLine;
        let existing = '';
        if (supabaseAdmin) {
          try {
            const { data: curOrg } = await supabaseAdmin.from('organizations').select('website_knowledge').eq('id', orgId).maybeSingle();
            existing = curOrg?.website_knowledge || freshOrg.website_knowledge || '';
            updatedKnowledge = existing ? `${existing}\n${offerLine}` : offerLine;
            await supabaseAdmin.from('organizations').update({
              website_knowledge: updatedKnowledge,
              updated_at: new Date().toISOString()
            }).eq('id', orgId);
          } catch (dbErr) {
            addLog(`[Remote Control] DB error saving offer: ${dbErr.message}`);
          }
        } else {
          existing = freshOrg.website_knowledge || '';
          updatedKnowledge = existing ? `${existing}\n${offerLine}` : offerLine;
        }
        ownerUndoSnapshots.set(orgId, {
          action: 'knowledge',
          oldKnowledge: existing
        });
        freshOrg.website_knowledge = updatedKnowledge;
        const confirmMsg = `✅ *Offer Activated!*\n"${offerLine}"\n\n💡 Send \`offer off\` anytime to deactivate.`;
        const sent = await activeSock.sendMessage(rawRemote, { text: confirmMsg });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        addLog(`[Remote Control] Live offer added by owner for org ${orgId}: ${cleanOffer}`);
      } catch (e) {
        addLog(`[Remote Control] Error updating live offer: ${e.message}`);
        try {
          await activeSock.sendMessage(rawRemote, { text: `❌ Failed to update offer: ${e.message}` });
        } catch (_) {}
      }
      return;
    }
  }

  // Owner Offer Off Command: offer off
  if (isFounderControl && /^(?:offer\s+off|offers\s+off)$/i.test(cmd)) {
    try {
      let existing = '';
      let updatedKnowledge = '';
      if (supabaseAdmin) {
        try {
          const { data: curOrg } = await supabaseAdmin.from('organizations').select('website_knowledge').eq('id', orgId).maybeSingle();
          existing = curOrg?.website_knowledge || freshOrg.website_knowledge || '';
          const lines = existing.split(/\r?\n/).filter(line => !/^\s*OFFER:/i.test(line));
          updatedKnowledge = lines.join('\n').trim();
          await supabaseAdmin.from('organizations').update({
            website_knowledge: updatedKnowledge,
            updated_at: new Date().toISOString()
          }).eq('id', orgId);
        } catch (dbErr) {
          addLog(`[Remote Control] DB error removing offers: ${dbErr.message}`);
        }
      } else {
        existing = freshOrg.website_knowledge || '';
        const lines = existing.split(/\r?\n/).filter(line => !/^\s*OFFER:/i.test(line));
        updatedKnowledge = lines.join('\n').trim();
      }
      ownerUndoSnapshots.set(orgId, {
        action: 'knowledge',
        oldKnowledge: existing
      });
      freshOrg.website_knowledge = updatedKnowledge;
      const confirmMsg = `✅ *Active Offers Removed.* All OFFER lines cleared from knowledge base.`;
      const sent = await activeSock.sendMessage(rawRemote, { text: confirmMsg });
      if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
      addLog(`[Remote Control] Active offers removed by owner for org ${orgId}`);
    } catch (e) {
      addLog(`[Remote Control] Error removing offers: ${e.message}`);
      try {
        await activeSock.sendMessage(rawRemote, { text: `❌ Failed to clear offers: ${e.message}` });
      } catch (_) {}
    }
    return;
  }

  // Typo-Tolerant Pause Command: manual / mannual / manul / pause / stop / off
  if (isFounderControl && /^(manual|mannual|manul|pause|stop|off)$/.test(cmd)) {
    try {
      if (supabaseAdmin) {
        await supabaseAdmin.from('organizations').update({
          wa_auto_reply: false
        }).eq('id', orgId);
      }
      freshOrg.wa_auto_reply = false;
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
          wa_auto_reply: true
        }).eq('id', orgId);
        await supabaseAdmin.from('conversations').update({
          mode: 'auto'
        }).eq('org_id', orgId);
      }
      freshOrg.wa_auto_reply = true;
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

  // ============================================================================
  // OWNER-ONLY WHATSAPP CATALOG MANAGEMENT (Strictly scoped to orgId, max 20 changes)
  // ============================================================================
  if (isFounderControl) {
    const trimmedText = (incomingText || '').trim();
    const lowerCmd = trimmedText.toLowerCase();

    // 1. Two-step Confirmation (YES / HAAN) for pending owner actions within 2 minutes
    if (/^(yes|haan|ha|confirm|ok|y)$/i.test(lowerCmd)) {
      const pending = ownerPendingConfirmations.get(orgId);
      if (pending) {
        if (Date.now() <= pending.expiresAt) {
          ownerPendingConfirmations.delete(orgId);
          try {
            if (pending.type === 'remove' && pending.product) {
              const pToRemove = pending.product;
              if (supabaseAdmin) {
                await supabaseAdmin.from('products').delete().eq('org_id', orgId).eq('id', pToRemove.id);
              }
              try { db.delete('products', pToRemove.id); } catch (de) {}
              ownerUndoSnapshots.set(orgId, {
                action: 'remove',
                product: pToRemove
              });
              const replyText = `Done: ${pToRemove.name} removed. Type undo to reverse.`;
              const sent = await activeSock.sendMessage(rawRemote, { text: replyText });
              if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
              addLog(`[Owner Control] Removed product ${pToRemove.name} for org ${orgId}`);
              return;
            } else if (pending.type === 'batch' && Array.isArray(pending.actions)) {
              const rollbacks = [];
              let appliedCount = 0;
              const actionsToRun = pending.actions.slice(0, 20);
              for (const act of actionsToRun) {
                const actName = (act.name || '').trim();
                if (!actName) continue;
                if (act.action === 'out' || act.action === 'in') {
                  let cur = null;
                  if (supabaseAdmin) {
                    const { data } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).ilike('name', actName).limit(1).maybeSingle();
                    cur = data;
                  } else {
                    cur = db.findOne('products', p => p.org_id === orgId && p.name.toLowerCase() === actName.toLowerCase());
                  }
                  if (cur) {
                    const oldDesc = cur.description || '';
                    rollbacks.push({ action: 'stock', productId: cur.id, oldDescription: oldDesc });
                    const newDesc = act.action === 'out'
                      ? (oldDesc.startsWith('[OUT OF STOCK]') ? oldDesc : `[OUT OF STOCK] ${oldDesc}`.trim())
                      : oldDesc.replace(/^\[OUT OF STOCK\]\s*/i, '').trim();
                    if (supabaseAdmin) {
                      await supabaseAdmin.from('products').update({ description: newDesc, updated_at: new Date().toISOString() }).eq('id', cur.id).eq('org_id', orgId);
                    }
                    try { db.update('products', cur.id, { description: newDesc }); } catch (ue) {}
                    appliedCount++;
                  }
                } else if (act.action === 'price') {
                  let cur = null;
                  if (supabaseAdmin) {
                    const { data } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).ilike('name', actName).limit(1).maybeSingle();
                    cur = data;
                  } else {
                    cur = db.findOne('products', p => p.org_id === orgId && p.name.toLowerCase() === actName.toLowerCase());
                  }
                  if (cur) {
                    rollbacks.push({ action: 'price', productId: cur.id, oldPrice: cur.price_raw });
                    const newP = String(act.price_raw || '').trim();
                    if (supabaseAdmin) {
                      await supabaseAdmin.from('products').update({ price_raw: newP, updated_at: new Date().toISOString() }).eq('id', cur.id).eq('org_id', orgId);
                    }
                    try { db.update('products', cur.id, { price_raw: newP }); } catch (ue) {}
                    appliedCount++;
                  }
                } else if (act.action === 'add') {
                  let cur = null;
                  if (supabaseAdmin) {
                    const { data } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).ilike('name', actName).limit(1).maybeSingle();
                    cur = data;
                  } else {
                    cur = db.findOne('products', p => p.org_id === orgId && p.name.toLowerCase() === actName.toLowerCase());
                  }
                  if (cur) {
                    rollbacks.push({ action: 'add', isInsert: false, previousProduct: cur, newProductId: cur.id });
                    const upd = {
                      price_raw: String(act.price_raw || cur.price_raw).trim(),
                      description: act.description || cur.description,
                      updated_at: new Date().toISOString()
                    };
                    if (supabaseAdmin) await supabaseAdmin.from('products').update(upd).eq('id', cur.id).eq('org_id', orgId);
                    try { db.update('products', cur.id, upd); } catch (ue) {}
                  } else {
                    const newId = crypto.randomUUID();
                    rollbacks.push({ action: 'add', isInsert: true, newProductId: newId });
                    const rec = {
                      id: newId,
                      org_id: orgId,
                      sku: `WA-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                      name: actName,
                      price_raw: String(act.price_raw || 'Price on request').trim(),
                      description: act.description || '',
                      is_active: true
                    };
                    if (supabaseAdmin) await supabaseAdmin.from('products').insert(rec);
                    try { db.insert('products', rec); } catch (ie) {}
                  }
                  appliedCount++;
                } else if (act.action === 'remove') {
                  let cur = null;
                  if (supabaseAdmin) {
                    const { data } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).ilike('name', actName).limit(1).maybeSingle();
                    cur = data;
                  } else {
                    cur = db.findOne('products', p => p.org_id === orgId && p.name.toLowerCase() === actName.toLowerCase());
                  }
                  if (cur) {
                    rollbacks.push({ action: 'remove', product: cur });
                    if (supabaseAdmin) await supabaseAdmin.from('products').delete().eq('id', cur.id).eq('org_id', orgId);
                    try { db.delete('products', cur.id); } catch (de) {}
                    appliedCount++;
                  }
                }
              }
              ownerUndoSnapshots.set(orgId, { action: 'batch', rollbacks });
              const replyText = `Done: ${pending.summary || `${appliedCount} changes applied`}. Type undo to reverse.`;
              const sent = await activeSock.sendMessage(rawRemote, { text: replyText });
              if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
              addLog(`[Owner Control] Applied ${appliedCount} batch catalog changes for org ${orgId}`);
              return;
            }
          } catch (e) {
            addLog(`[Owner Control] Error executing pending confirmation: ${e.message}`);
            await activeSock.sendMessage(rawRemote, { text: `❌ Error: ${e.message}` });
            return;
          }
        } else {
          ownerPendingConfirmations.delete(orgId);
          const replyText = "Confirmation expired (2 minutes passed). Please send your update command again.";
          const sent = await activeSock.sendMessage(rawRemote, { text: replyText });
          if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
          return;
        }
      }
    }

    // 2. Undo Command: restore previous state of last change
    if (/^(undo|revert)$/i.test(lowerCmd)) {
      const lastChange = ownerUndoSnapshots.get(orgId);
      if (!lastChange) {
        const sent = await activeSock.sendMessage(rawRemote, { text: "Nothing to undo." });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        return;
      }
      ownerUndoSnapshots.delete(orgId);
      try {
        if (lastChange.action === 'add') {
          if (lastChange.isInsert && lastChange.newProductId) {
            if (supabaseAdmin) await supabaseAdmin.from('products').delete().eq('org_id', orgId).eq('id', lastChange.newProductId);
            try { db.delete('products', lastChange.newProductId); } catch (de) {}
          } else if (lastChange.previousProduct) {
            const prev = lastChange.previousProduct;
            if (supabaseAdmin) {
              await supabaseAdmin.from('products').update({
                price_raw: prev.price_raw,
                description: prev.description,
                brochure_url: prev.brochure_url,
                brochure_filename: prev.brochure_filename,
                updated_at: new Date().toISOString()
              }).eq('id', prev.id).eq('org_id', orgId);
            }
            try { db.update('products', prev.id, prev); } catch (ue) {}
          }
        } else if (lastChange.action === 'price') {
          if (supabaseAdmin) {
            await supabaseAdmin.from('products').update({
              price_raw: lastChange.oldPrice,
              updated_at: new Date().toISOString()
            }).eq('id', lastChange.productId).eq('org_id', orgId);
          }
          try { db.update('products', lastChange.productId, { price_raw: lastChange.oldPrice }); } catch (ue) {}
        } else if (lastChange.action === 'stock') {
          if (supabaseAdmin) {
            await supabaseAdmin.from('products').update({
              description: lastChange.oldDescription,
              updated_at: new Date().toISOString()
            }).eq('id', lastChange.productId).eq('org_id', orgId);
          }
          try { db.update('products', lastChange.productId, { description: lastChange.oldDescription }); } catch (ue) {}
        } else if (lastChange.action === 'remove' && lastChange.product) {
          if (supabaseAdmin) {
            await supabaseAdmin.from('products').insert({
              ...lastChange.product,
              updated_at: new Date().toISOString()
            });
          }
          try { db.insert('products', lastChange.product); } catch (ie) {}
        } else if (lastChange.action === 'knowledge') {
          if (supabaseAdmin) {
            await supabaseAdmin.from('organizations').update({
              website_knowledge: lastChange.oldKnowledge,
              updated_at: new Date().toISOString()
            }).eq('id', orgId);
          }
          freshOrg.website_knowledge = lastChange.oldKnowledge;
        } else if (lastChange.action === 'batch' && Array.isArray(lastChange.rollbacks)) {
          for (const rb of lastChange.rollbacks.reverse()) {
            if (rb.action === 'stock') {
              if (supabaseAdmin) await supabaseAdmin.from('products').update({ description: rb.oldDescription }).eq('id', rb.productId).eq('org_id', orgId);
              try { db.update('products', rb.productId, { description: rb.oldDescription }); } catch (ue) {}
            } else if (rb.action === 'price') {
              if (supabaseAdmin) await supabaseAdmin.from('products').update({ price_raw: rb.oldPrice }).eq('id', rb.productId).eq('org_id', orgId);
              try { db.update('products', rb.productId, { price_raw: rb.oldPrice }); } catch (ue) {}
            } else if (rb.action === 'add') {
              if (rb.isInsert) {
                if (supabaseAdmin) await supabaseAdmin.from('products').delete().eq('id', rb.newProductId).eq('org_id', orgId);
                try { db.delete('products', rb.newProductId); } catch (de) {}
              } else if (rb.previousProduct) {
                if (supabaseAdmin) await supabaseAdmin.from('products').update({ price_raw: rb.previousProduct.price_raw, description: rb.previousProduct.description }).eq('id', rb.previousProduct.id).eq('org_id', orgId);
                try { db.update('products', rb.previousProduct.id, rb.previousProduct); } catch (ue) {}
              }
            } else if (rb.action === 'remove' && rb.product) {
              if (supabaseAdmin) await supabaseAdmin.from('products').insert(rb.product);
              try { db.insert('products', rb.product); } catch (ie) {}
            }
          }
        }
        const sent = await activeSock.sendMessage(rawRemote, { text: "Done: Last change reversed." });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        addLog(`[Owner Control] Reversed last change for org ${orgId}`);
        return;
      } catch (e) {
        addLog(`[Owner Control] Error during undo: ${e.message}`);
        await activeSock.sendMessage(rawRemote, { text: `❌ Undo failed: ${e.message}` });
        return;
      }
    }

    // 3. Command 1: add: Name | price | details (supports photo/video caption)
    if (/^add\s*:\s*/i.test(trimmedText)) {
      const rawPayload = trimmedText.replace(/^add\s*:\s*/i, '').trim();
      const parts = rawPayload.split('|').map(s => s.trim());
      const prodName = parts[0] || '';
      const prodPrice = parts[1] || '';
      const prodDetails = parts.slice(2).join(' | ').trim();

      if (!prodName) {
        const sent = await activeSock.sendMessage(rawRemote, { text: "Please specify product name, e.g. add: Maroon Suit | 550 | Pure cotton" });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        return;
      }

      try {
        let mediaUrl = null;
        let mediaFilename = null;
        if (isImage || isVideo) {
          try {
            const mediaBuf = await downloadMediaMessage(msg, 'buffer', {}, {
              logger: activeSock?.logger || pino({ level: 'silent' }),
              reuploadRequest: activeSock?.updateMediaMessage
            });
            if (mediaBuf) {
              const ext = isImage ? 'jpg' : 'mp4';
              const safeName = prodName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
              const storagePath = `${orgId}/products/${Date.now()}_${safeName}.${ext}`;
              mediaFilename = `${safeName}.${ext}`;
              if (supabaseAdmin) {
                const mime = isImage ? (imageMime || 'image/jpeg') : (content?.videoMessage?.mimetype || 'video/mp4');
                const { error: upErr } = await supabaseAdmin.storage.from('catalogs').upload(storagePath, mediaBuf, {
                  contentType: mime,
                  upsert: true
                });
                if (!upErr) {
                  const { data: pubData } = supabaseAdmin.storage.from('catalogs').getPublicUrl(storagePath);
                  mediaUrl = pubData?.publicUrl || null;
                }
              }
            }
          } catch (mediaErr) {
            addLog(`[Owner Control] Media download/upload error: ${mediaErr.message}`);
          }
        }

        let existing = null;
        if (supabaseAdmin) {
          const { data: found } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).ilike('name', prodName).limit(1).maybeSingle();
          existing = found;
        }
        if (!existing) {
          existing = db.findOne('products', p => (p.org_id === orgId || p.organization_id === orgId) && p.name.toLowerCase() === prodName.toLowerCase());
        }

        if (existing) {
          ownerUndoSnapshots.set(orgId, {
            action: 'add',
            isInsert: false,
            previousProduct: existing,
            newProductId: existing.id
          });
          const updatePayload = {
            updated_at: new Date().toISOString()
          };
          if (prodPrice) updatePayload.price_raw = prodPrice;
          if (prodDetails) updatePayload.description = prodDetails;
          if (mediaUrl) {
            updatePayload.brochure_url = mediaUrl;
            updatePayload.brochure_filename = mediaFilename;
          }
          if (supabaseAdmin) {
            await supabaseAdmin.from('products').update(updatePayload).eq('id', existing.id).eq('org_id', orgId);
          }
          try { db.update('products', existing.id, { ...updatePayload, organization_id: orgId, org_id: orgId }); } catch (ue) {}
        } else {
          const newId = crypto.randomUUID();
          ownerUndoSnapshots.set(orgId, {
            action: 'add',
            isInsert: true,
            newProductId: newId
          });
          const newProd = {
            id: newId,
            org_id: orgId,
            organization_id: orgId,
            sku: `WA-${Date.now()}`,
            name: prodName,
            price_raw: prodPrice || 'Price on request',
            description: prodDetails || '',
            brochure_url: mediaUrl,
            brochure_filename: mediaFilename,
            is_active: true
          };
          if (supabaseAdmin) {
            const sbProd = { ...newProd };
            delete sbProd.organization_id;
            await supabaseAdmin.from('products').insert(sbProd);
          }
          try { db.insert('products', newProd); } catch (ie) {}
        }

        const confirmText = (isImage || isVideo) && mediaUrl
          ? `Done: ${prodName} added with photo. Type undo to reverse.`
          : `Done: ${prodName} added. Type undo to reverse.`;
        const sent = await activeSock.sendMessage(rawRemote, { text: confirmText });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        addLog(`[Owner Control] Product "${prodName}" upserted for org ${orgId}`);
        return;
      } catch (err) {
        addLog(`[Owner Control] Error adding product: ${err.message}`);
        await activeSock.sendMessage(rawRemote, { text: `❌ Failed to add product: ${err.message}` });
        return;
      }
    }

    // 4. If owner sends photo/video with a caption that is NOT an add: command, ignore it (do not store)
    if (isImage || isVideo) {
      addLog(`[Owner Control] Ignoring non-add photo/video sent by owner`);
      return;
    }

    // 5. Command 2: price: Name = 595
    if (/^price\s*:\s*([^=]+)=\s*([^=]+)$/i.test(trimmedText)) {
      const match = trimmedText.match(/^price\s*:\s*([^=]+)=\s*([^=]+)$/i);
      const targetName = match[1].trim();
      const newPrice = match[2].trim();
      try {
        let prod = null;
        if (supabaseAdmin) {
          const { data } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).ilike('name', `%${targetName}%`).limit(1).maybeSingle();
          prod = data;
        }
        if (!prod) {
          prod = db.findOne('products', p => (p.org_id === orgId || p.organization_id === orgId) && p.name.toLowerCase().includes(targetName.toLowerCase()));
        }
        if (!prod) {
          const sent = await activeSock.sendMessage(rawRemote, { text: `Product "${targetName}" not found in catalog.` });
          if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
          return;
        }
        ownerUndoSnapshots.set(orgId, {
          action: 'price',
          productId: prod.id,
          oldPrice: prod.price_raw
        });
        if (supabaseAdmin) {
          await supabaseAdmin.from('products').update({
            price_raw: newPrice,
            updated_at: new Date().toISOString()
          }).eq('id', prod.id).eq('org_id', orgId);
        }
        try { db.update('products', prod.id, { price_raw: newPrice }); } catch (ue) {}
        const sent = await activeSock.sendMessage(rawRemote, { text: `Done: ${prod.name} price updated to ${newPrice}. Type undo to reverse.` });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        addLog(`[Owner Control] Updated price for ${prod.name} to ${newPrice}`);
        return;
      } catch (e) {
        addLog(`[Owner Control] Error updating price: ${e.message}`);
        await activeSock.sendMessage(rawRemote, { text: `❌ Failed to update price: ${e.message}` });
        return;
      }
    }

    // 6. Command 3: out: Name / in: Name
    if (/^(out|in)\s*:\s*(.+)$/i.test(trimmedText)) {
      const match = trimmedText.match(/^(out|in)\s*:\s*(.+)$/i);
      const action = match[1].toLowerCase();
      const targetName = match[2].trim();
      try {
        let prod = null;
        if (supabaseAdmin) {
          const { data } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).ilike('name', `%${targetName}%`).limit(1).maybeSingle();
          prod = data;
        }
        if (!prod) {
          prod = db.findOne('products', p => (p.org_id === orgId || p.organization_id === orgId) && p.name.toLowerCase().includes(targetName.toLowerCase()));
        }
        if (!prod) {
          const sent = await activeSock.sendMessage(rawRemote, { text: `Product "${targetName}" not found.` });
          if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
          return;
        }
        const oldDesc = prod.description || '';
        ownerUndoSnapshots.set(orgId, {
          action: 'stock',
          productId: prod.id,
          oldDescription: oldDesc
        });
        let newDesc = oldDesc;
        if (action === 'out') {
          if (!newDesc.startsWith('[OUT OF STOCK]')) {
            newDesc = `[OUT OF STOCK] ${newDesc}`.trim();
          }
        } else {
          newDesc = newDesc.replace(/^\[OUT OF STOCK\]\s*/i, '').trim();
        }
        if (supabaseAdmin) {
          await supabaseAdmin.from('products').update({
            description: newDesc,
            updated_at: new Date().toISOString()
          }).eq('id', prod.id).eq('org_id', orgId);
        }
        try { db.update('products', prod.id, { description: newDesc }); } catch (ue) {}
        const statusText = action === 'out' ? 'OUT OF STOCK' : 'IN STOCK';
        const sent = await activeSock.sendMessage(rawRemote, { text: `Done: ${prod.name} marked ${statusText}. Type undo to reverse.` });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        addLog(`[Owner Control] Marked ${prod.name} as ${statusText}`);
        return;
      } catch (e) {
        addLog(`[Owner Control] Error toggling stock status: ${e.message}`);
        await activeSock.sendMessage(rawRemote, { text: `❌ Failed to update stock: ${e.message}` });
        return;
      }
    }

    // 7. Command 4: remove: Name (Two-step confirmation: "Remove <Name>? Reply YES within 2 minutes")
    if (/^remove\s*:\s*(.+)$/i.test(trimmedText)) {
      const match = trimmedText.match(/^remove\s*:\s*(.+)$/i);
      const targetName = match[1].trim();
      try {
        let prod = null;
        if (supabaseAdmin) {
          const { data } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).ilike('name', `%${targetName}%`).limit(1).maybeSingle();
          prod = data;
        }
        if (!prod) {
          prod = db.findOne('products', p => (p.org_id === orgId || p.organization_id === orgId) && p.name.toLowerCase().includes(targetName.toLowerCase()));
        }
        if (!prod) {
          const sent = await activeSock.sendMessage(rawRemote, { text: `Product "${targetName}" not found in catalog.` });
          if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
          return;
        }
        ownerPendingConfirmations.set(orgId, {
          type: 'remove',
          product: prod,
          expiresAt: Date.now() + 120000
        });
        const sent = await activeSock.sendMessage(rawRemote, { text: `Remove ${prod.name}? Reply YES within 2 minutes.` });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        addLog(`[Owner Control] Pending removal confirmation created for ${prod.name}`);
        return;
      } catch (e) {
        addLog(`[Owner Control] Error initiating remove: ${e.message}`);
        await activeSock.sendMessage(rawRemote, { text: `❌ Error: ${e.message}` });
        return;
      }
    }

    // 8. Command 5: list
    if (/^(list|products|catalog|all\s*products)$/i.test(lowerCmd)) {
      try {
        let prods = [];
        if (supabaseAdmin) {
          const { data } = await supabaseAdmin.from('products').select('name, price_raw, description').eq('org_id', orgId).limit(25);
          if (data && data.length > 0) prods = data;
        }
        if (prods.length === 0) {
          prods = db.findScoped('products', orgId) || [];
        }
        if (!prods || prods.length === 0) {
          const sent = await activeSock.sendMessage(rawRemote, { text: "Catalog is currently empty. Add products with: add: Name | price | details" });
          if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
          return;
        }
        let listMsg = `📋 *Product Catalog (${prods.length})*\n\n`;
        prods.forEach((p, idx) => {
          const isOut = (p.description || '').startsWith('[OUT OF STOCK]');
          const status = isOut ? '❌ OUT OF STOCK' : '✅ IN STOCK';
          const price = p.price_raw || 'Price on request';
          listMsg += `${idx + 1}. *${p.name}* — ${price} [${status}]\n`;
        });
        const sent = await activeSock.sendMessage(rawRemote, { text: listMsg.trim() });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        return;
      } catch (e) {
        addLog(`[Owner Control] Error listing products: ${e.message}`);
        return;
      }
    }

    // Command: website: https://theirsite.com (sets website URL and runs sync)
    if (/^website\s*:\s*https?:\/\//i.test(trimmedText)) {
      const targetUrl = trimmedText.replace(/^website\s*:\s*/i, '').trim();
      try {
        new URL(targetUrl);
      } catch (_) {
        const sent = await activeSock.sendMessage(rawRemote, { text: "❌ Invalid URL format. Example: website: https://yourdomain.com" });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        return;
      }
      let existingKnowledge = '';
      if (supabaseAdmin) {
        const { data: curOrg } = await supabaseAdmin.from('organizations').select('website_knowledge').eq('id', orgId).maybeSingle();
        existingKnowledge = curOrg?.website_knowledge || freshOrg.website_knowledge || '';
      } else {
        existingKnowledge = freshOrg.website_knowledge || '';
      }
      const updatedKnowledge = setOrgWebsiteUrl(existingKnowledge, targetUrl);
      if (supabaseAdmin) {
        await supabaseAdmin.from('organizations').update({
          website_knowledge: updatedKnowledge,
          updated_at: new Date().toISOString()
        }).eq('id', orgId);
      }
      try { db.update('organizations', orgId, { website_knowledge: updatedKnowledge }); } catch (_) {}
      freshOrg.website_knowledge = updatedKnowledge;
      ownerUndoSnapshots.set(orgId, { action: 'knowledge', oldKnowledge: existingKnowledge });
      const sent = await activeSock.sendMessage(rawRemote, { text: `Website saved: ${targetUrl}. Starting sync…` });
      if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
      await syncWebsiteProducts(orgId, targetUrl, activeSock, rawRemote);
      return;
    }

    // Command: sync (syncs products from the stored website URL)
    if (/^(sync|sync\s*products?|refresh\s*catalog)$/i.test(lowerCmd)) {
      let existingKnowledge = '';
      if (supabaseAdmin) {
        const { data: curOrg } = await supabaseAdmin.from('organizations').select('website_knowledge').eq('id', orgId).maybeSingle();
        existingKnowledge = curOrg?.website_knowledge || freshOrg.website_knowledge || '';
      } else {
        existingKnowledge = freshOrg.website_knowledge || '';
      }
      const siteUrl = getOrgWebsiteUrl(existingKnowledge);
      if (!siteUrl) {
        const sent = await activeSock.sendMessage(rawRemote, { text: "Please set your website first using: website: https://yourdomain.com" });
        if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
        return;
      }
      const sent = await activeSock.sendMessage(rawRemote, { text: `Syncing products from ${siteUrl}…` });
      if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
      await syncWebsiteProducts(orgId, siteUrl, activeSock, rawRemote);
      return;
    }

    // 9. Command 9: PDF document from owner
    if (content?.documentMessage && (content.documentMessage.mimetype === 'application/pdf' || (content.documentMessage.fileName || '').toLowerCase().endsWith('.pdf'))) {
      try {
        const pdfBuf = await downloadMediaMessage(msg, 'buffer', {}, {
          logger: activeSock?.logger || pino({ level: 'silent' }),
          reuploadRequest: activeSock?.updateMediaMessage
        });
        if (pdfBuf) {
          const caption = (content.documentMessage.caption || incomingText || '').toLowerCase();
          let savedBrochure = false;
          if (caption.includes('brochure')) {
            const storagePath = `${orgId}/brochures/${Date.now()}_catalog.pdf`;
            if (supabaseAdmin) {
              const { error: upErr } = await supabaseAdmin.storage.from('catalogs').upload(storagePath, pdfBuf, {
                contentType: 'application/pdf',
                upsert: true
              });
              if (!upErr) {
                const { data: pubData } = supabaseAdmin.storage.from('catalogs').getPublicUrl(storagePath);
                if (pubData?.publicUrl) {
                  await supabaseAdmin.from('organizations').update({
                    catalog_pdf_url: pubData.publicUrl,
                    catalog_pdf_name: content.documentMessage.fileName || 'Catalog.pdf',
                    updated_at: new Date().toISOString()
                  }).eq('id', orgId);
                  savedBrochure = true;
                }
              }
            }
          }

          const geminiKey = (process.env.GEMINI_API_KEY || config.geminiApiKey || '').trim();
          let extractedProducts = [];
          if (geminiKey) {
            try {
              const resp = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-latest:generateContent?key=${encodeURIComponent(geminiKey)}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  signal: AbortSignal.timeout(25000),
                  body: JSON.stringify({
                    contents: [{
                      role: 'user',
                      parts: [
                        { inlineData: { mimeType: 'application/pdf', data: pdfBuf.toString('base64') } },
                        { text: 'Extract distinct commercial products from this catalog as a clean JSON array of objects with keys: name (string), price_raw (string or number), description (short string). Max 20 items. Return ONLY valid JSON array with no markdown.' }
                      ]
                    }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
                  })
                }
              );
              if (resp.ok) {
                const resJson = await resp.json();
                const text = resJson?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
                const cleaned = text.replace(/^\`\`\`json\s*/i, '').replace(/\`\`\`$/i, '').trim();
                const parsed = JSON.parse(cleaned);
                if (Array.isArray(parsed)) extractedProducts = parsed;
              }
            } catch (gErr) {
              addLog(`[Owner Control] Gemini PDF extraction error: ${gErr.message}`);
            }
          }

          // Fallback to pdf-parse if Gemini not reachable
          if (extractedProducts.length === 0) {
            try {
              const pdfParse = (await import('pdf-parse')).default;
              const pdfData = await pdfParse(pdfBuf);
              const lines = (pdfData.text || '').split('\n').map(l => l.trim()).filter(Boolean);
              for (const line of lines.slice(0, 40)) {
                const match = line.match(/^([^:-|]+)[:|-]\s*(?:₹|Rs\.?)?\s*(\d+[\d,.]*)\s*(?:\|?\s*(.*))?$/i);
                if (match) {
                  extractedProducts.push({
                    name: match[1].trim(),
                    price_raw: match[2].trim(),
                    description: (match[3] || '').trim()
                  });
                }
              }
            } catch (pe) {}
          }

          const rollbacks = [];
          let importedCount = 0;
          for (const item of extractedProducts.slice(0, 20)) {
            const itemName = (item.name || '').trim();
            if (!itemName) continue;
            let cur = null;
            if (supabaseAdmin) {
              const { data } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).ilike('name', itemName).limit(1).maybeSingle();
              cur = data;
            } else {
              cur = db.findOne('products', p => p.org_id === orgId && p.name.toLowerCase() === itemName.toLowerCase());
            }
            if (cur) {
              rollbacks.push({ action: 'add', isInsert: false, previousProduct: cur, newProductId: cur.id });
              const upd = {
                price_raw: String(item.price_raw || cur.price_raw).trim(),
                description: item.description || cur.description,
                updated_at: new Date().toISOString()
              };
              if (supabaseAdmin) await supabaseAdmin.from('products').update(upd).eq('id', cur.id).eq('org_id', orgId);
              try { db.update('products', cur.id, upd); } catch (ue) {}
            } else {
              const newId = crypto.randomUUID();
              rollbacks.push({ action: 'add', isInsert: true, newProductId: newId });
              const rec = {
                id: newId,
                org_id: orgId,
                sku: `WA-${Date.now()}-${importedCount}`,
                name: itemName,
                price_raw: String(item.price_raw || 'Price on request').trim(),
                description: item.description || '',
                is_active: true
              };
              if (supabaseAdmin) await supabaseAdmin.from('products').insert(rec);
              try { db.insert('products', rec); } catch (ie) {}
            }
            importedCount++;
          }
          ownerUndoSnapshots.set(orgId, { action: 'batch', rollbacks });
          const brochureMsg = savedBrochure ? ' and saved as official brochure' : '';
          const sent = await activeSock.sendMessage(rawRemote, { text: `Done: ${importedCount} products imported from PDF${brochureMsg}. Type undo to reverse.` });
          if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
          addLog(`[Owner Control] Imported ${importedCount} products from PDF for org ${orgId}`);
          return;
        }
      } catch (e) {
        addLog(`[Owner Control] Error processing PDF: ${e.message}`);
        await activeSock.sendMessage(rawRemote, { text: `❌ Failed to process PDF: ${e.message}` });
        return;
      }
    }

    // 10. Command 10: Excel / CSV document from owner
    if (content?.documentMessage && (
      content.documentMessage.mimetype?.includes('spreadsheet') ||
      content.documentMessage.mimetype?.includes('excel') ||
      content.documentMessage.mimetype?.includes('csv') ||
      (content.documentMessage.fileName || '').match(/\.(xlsx|xls|csv)$/i)
    )) {
      try {
        const docBuf = await downloadMediaMessage(msg, 'buffer', {}, {
          logger: activeSock?.logger || pino({ level: 'silent' }),
          reuploadRequest: activeSock?.updateMediaMessage
        });
        if (docBuf) {
          const fileName = (content.documentMessage.fileName || '').toLowerCase();
          const ExcelJS = (await import('exceljs')).default;
          const workbook = new ExcelJS.Workbook();
          if (fileName.endsWith('.csv')) {
            const stream = await import('stream');
            const bufferStream = new stream.PassThrough();
            bufferStream.end(docBuf);
            await workbook.csv.read(bufferStream);
          } else {
            await workbook.xlsx.load(docBuf);
          }

          const worksheet = workbook.worksheets[0];
          const rows = [];
          let headerMap = {};
          if (worksheet) {
            worksheet.eachRow((row, rowNumber) => {
              if (rowNumber === 1) {
                row.eachCell((cell, colNumber) => {
                  const val = String(cell.value || '').trim().toLowerCase();
                  if (val.includes('sku') || val.includes('code')) headerMap.sku = colNumber;
                  else if (val.includes('name') || val.includes('title') || val.includes('item') || val.includes('product')) headerMap.name = colNumber;
                  else if (val.includes('price') || val.includes('rate') || val.includes('mrp')) headerMap.price_raw = colNumber;
                  else if (val.includes('desc') || val.includes('detail') || val.includes('spec')) headerMap.description = colNumber;
                  else if (val.includes('cat')) headerMap.category = colNumber;
                });
                if (!headerMap.name) headerMap.name = 1;
                if (!headerMap.price_raw) headerMap.price_raw = 2;
                if (!headerMap.description) headerMap.description = 3;
              } else if (rows.length < 20) {
                const nameVal = String(row.getCell(headerMap.name || 1).value || '').trim();
                if (nameVal) {
                  rows.push({
                    sku: headerMap.sku ? String(row.getCell(headerMap.sku).value || '').trim() : null,
                    name: nameVal,
                    price_raw: headerMap.price_raw ? String(row.getCell(headerMap.price_raw).value || '').trim() : '',
                    description: headerMap.description ? String(row.getCell(headerMap.description).value || '').trim() : '',
                    category: headerMap.category ? String(row.getCell(headerMap.category).value || '').trim() : ''
                  });
                }
              }
            });
          }

          const rollbacks = [];
          let importedCount = 0;
          for (const item of rows) {
            let cur = null;
            if (supabaseAdmin) {
              if (item.sku) {
                const { data } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).eq('sku', item.sku).limit(1).maybeSingle();
                cur = data;
              }
              if (!cur) {
                const { data } = await supabaseAdmin.from('products').select('*').eq('org_id', orgId).ilike('name', item.name).limit(1).maybeSingle();
                cur = data;
              }
            } else {
              if (item.sku) cur = db.findOne('products', p => p.org_id === orgId && p.sku === item.sku);
              if (!cur) cur = db.findOne('products', p => p.org_id === orgId && p.name.toLowerCase() === item.name.toLowerCase());
            }
            if (cur) {
              rollbacks.push({ action: 'add', isInsert: false, previousProduct: cur, newProductId: cur.id });
              const upd = {
                price_raw: item.price_raw || cur.price_raw,
                description: item.description || cur.description,
                category: item.category || cur.category,
                updated_at: new Date().toISOString()
              };
              if (supabaseAdmin) await supabaseAdmin.from('products').update(upd).eq('id', cur.id).eq('org_id', orgId);
              try { db.update('products', cur.id, upd); } catch (ue) {}
            } else {
              const newId = crypto.randomUUID();
              rollbacks.push({ action: 'add', isInsert: true, newProductId: newId });
              const rec = {
                id: newId,
                org_id: orgId,
                sku: item.sku || `WA-${Date.now()}-${importedCount}`,
                name: item.name,
                price_raw: item.price_raw || 'Price on request',
                description: item.description || '',
                category: item.category || null,
                is_active: true
              };
              if (supabaseAdmin) await supabaseAdmin.from('products').insert(rec);
              try { db.insert('products', rec); } catch (ie) {}
            }
            importedCount++;
          }
          ownerUndoSnapshots.set(orgId, { action: 'batch', rollbacks });
          const sent = await activeSock.sendMessage(rawRemote, { text: `Done: ${importedCount} products imported from Excel/CSV. Type undo to reverse.` });
          if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
          addLog(`[Owner Control] Imported ${importedCount} products from Excel/CSV for org ${orgId}`);
          return;
        }
      } catch (e) {
        addLog(`[Owner Control] Error processing Excel/CSV: ${e.message}`);
        await activeSock.sendMessage(rawRemote, { text: `❌ Failed to process Excel/CSV: ${e.message}` });
        return;
      }
    }

    // 11. Command 8: Free text / Voice note from owner that sounds like catalog change or price list
    const looksLikeCatalogChange = isAudio || (
      /(khatam|out of stock|in stock|stock|hatao|delete|remove|add kar|daal do|naya|naye|price|rate|bhav|rupaye|rs\.?|₹|ka kar do)/i.test(trimmedText) &&
      !/^(hi|hello|hey|namaste|status|manual|automatic)$/i.test(lowerCmd)
    ) || (
      trimmedText.includes(',') && /\d{2,}/.test(trimmedText)
    );

    if (looksLikeCatalogChange) {
      const geminiKey = (process.env.GEMINI_API_KEY || config.geminiApiKey || '').trim();
      if (geminiKey) {
        try {
          let prods = [];
          if (supabaseAdmin) {
            const { data } = await supabaseAdmin.from('products').select('name').eq('org_id', orgId).limit(30);
            if (data) prods = data.map(p => p.name);
          } else {
            prods = (db.findScoped('products', orgId) || []).map(p => p.name);
          }

          let audioInline = null;
          if (isAudio) {
            const audioBuf = await downloadMediaMessage(msg, 'buffer', {}, {
              logger: activeSock?.logger || pino({ level: 'silent' }),
              reuploadRequest: activeSock?.updateMediaMessage
            });
            if (audioBuf) {
              audioInline = {
                inlineData: {
                  mimeType: content?.audioMessage?.mimetype || 'audio/ogg; codecs=opus',
                  data: audioBuf.toString('base64')
                }
              };
            }
          }

          const promptText = `You are an assistant parsing catalog change instructions from a business owner via WhatsApp.\n` +
            `Current active catalog products in this workspace: ${JSON.stringify(prods)}\n` +
            `Owner message: "${trimmedText || '(Voice Note)'}"\n\n` +
            `Extract requested actions as a strict JSON object:\n` +
            `{\n` +
            `  "isCatalogChange": boolean,\n` +
            `  "unclear": boolean,\n` +
            `  "question": string,\n` +
            `  "summary": string,\n` +
            `  "actions": [\n` +
            `    {\n` +
            `      "action": "add" | "price" | "out" | "in" | "remove",\n` +
            `      "name": "Product Name",\n` +
            `      "price_raw": "550",\n` +
            `      "description": "Short details"\n` +
            `    }\n` +
            `  ]\n` +
            `}\n` +
            `If this is just an ordinary chat message, set isCatalogChange: false. Max 20 actions. Return ONLY valid JSON with no markdown wrapping.`;

          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-latest:generateContent?key=${encodeURIComponent(geminiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(15000),
              body: JSON.stringify({
                contents: [{
                  role: 'user',
                  parts: [
                    ...(audioInline ? [audioInline] : []),
                    { text: promptText }
                  ]
                }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
              })
            }
          );

          if (resp.ok) {
            const resData = await resp.json();
            const rawReply = resData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
            const cleaned = rawReply.replace(/^\`\`\`json\s*/i, '').replace(/\`\`\`$/i, '').trim();
            const parsed = JSON.parse(cleaned);

            if (parsed?.isCatalogChange) {
              if (parsed.unclear && parsed.question) {
                const sent = await activeSock.sendMessage(rawRemote, { text: parsed.question });
                if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
                return;
              }

              if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
                const summary = parsed.summary || `${parsed.actions.length} catalog changes`;
                ownerPendingConfirmations.set(orgId, {
                  type: 'batch',
                  actions: parsed.actions.slice(0, 20),
                  summary,
                  expiresAt: Date.now() + 120000
                });
                const sent = await activeSock.sendMessage(rawRemote, { text: `Understood: ${summary}. Reply YES to confirm.` });
                if (sent?.key?.id) botSentMsgIds.add(sent.key.id);
                addLog(`[Owner Control] Pending batch confirmation created: "${summary}"`);
                return;
              }
            }
          }
        } catch (geminiErr) {
          addLog(`[Owner Control] Natural text parser error: ${geminiErr.message}`);
        }
      }
    }
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
            mode: 'human',
            updated_at: new Date().toISOString()
          }).eq('org_id', orgId).ilike('buyer_phone', `%${recipientPhone.slice(-10)}`);
          await takeoverCustomer({
            orgId,
            buyerPhone: recipientPhone,
            takenBy: 'owner_manual_typing',
            supabaseAdmin
          });
        }
        addLog(`[Human Takeover] Owner typed manually to customer +${recipientPhone}. Conversation set to human for 4h.`);
      } catch (e) {}
    }
    // Only return if not testing in bot self-chat
    if (!isSelfChat) {
      return;
    }
  }

  // NOTE: If isFromOwner is true, the owner is testing the bot from their personal number.
  // Allow the message to flow into the AI sales engine so the owner receives real AI replies!

  // Meta dual @lid + @s.whatsapp.net fingerprint cooldown (2.5s for normal, 1.5s for owner/self-test)
  const normText = (incomingText || '').trim().toLowerCase();
  const fpKey = `${orgId}:${senderPhone}:${normText}`;
  const now = Date.now();
  const fpCooldownMs = (isFromOwner || isSelfChat) ? 1500 : 2500;
  if (recentInboundFingerprints.has(fpKey) && (now - recentInboundFingerprints.get(fpKey)) < fpCooldownMs) {
    addLog(`[Deduplication] Ignored duplicate WhatsApp inbound event from +${senderPhone} within ${fpCooldownMs}ms.`);
    return;
  }
  recentInboundFingerprints.set(fpKey, now);
  if (recentInboundFingerprints.size > 2000) {
    for (const [k, v] of recentInboundFingerprints.entries()) {
      if (now - v > 60000) recentInboundFingerprints.delete(k);
    }
  }

  // Per-sender promise queue (processes rapid successive messages in order without dropping)
  const task = async () => {
    try {
      let sbConvId = null;
      let isBrandNewLead = false;
      let sLead = null;

      if (supabaseAdmin) {
        try {
          // Atomic & Idempotent Quota Reservation + Lead Upsert
          const { data: leadRows, error: leadRpcErr } = await supabaseAdmin.rpc('reserve_and_create_lead', {
            p_org_id: orgId,
            p_buyer_phone: senderPhone,
            p_buyer_name: pushName,
            p_query_message: incomingText,
            p_requirement: incomingText,
            p_bypass_quota: Boolean(isFromOwner || isSelfChat)
          });

          if (leadRpcErr) {
            // Missing schema or RPC failure must FAIL CLOSED
            addLog(`[Quota/Lead Error] Atomic lead reservation failed: ${leadRpcErr.message}`);
            return;
          }

          const res = Array.isArray(leadRows) ? leadRows[0] : leadRows;
          const leadId = res ? (res.out_lead_id || res.lead_id) : null;
          if (!res || !leadId) {
            addLog(`[Quota/Lead Error] No lead returned from atomic reservation`);
            return;
          }

          isBrandNewLead = Boolean(res.out_is_new ?? res.is_new);
          sLead = {
            id: leadId,
            buyer_name: pushName,
            buyer_phone: senderPhone,
            quota_admitted: Boolean(res.out_quota_admitted ?? res.quota_admitted)
          };

          let existingConv = null;
          const phoneSearch = senderPhone && senderPhone.length >= 10 ? senderPhone.slice(-10) : senderPhone;
          if (phoneSearch && phoneSearch.length >= 4) {
            const { data } = await supabaseAdmin
              .from('conversations')
              .select('id, mode')
              .eq('org_id', orgId)
              .ilike('buyer_phone', `%${phoneSearch}`)
              .order('updated_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            existingConv = data;
          }

          if (!existingConv) {
            const { data: nConv } = await supabaseAdmin.from('conversations').insert({
              org_id: orgId,
              lead_id: sLead.id,
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
          const isOrgAutoReplyOff = freshOrg.wa_auto_reply === false;
          if (isOrgAutoReplyOff) {
            addLog(`[AI Muted] Auto reply is disabled for organization ${freshOrg.name || orgId}.`);
            return;
          }

          if (isFromOwner || isSelfChat) {
            if (existingConv && (existingConv.mode === 'manual' || existingConv.mode === 'human')) {
              existingConv.mode = 'auto';
              if (supabaseAdmin && sbConvId) {
                await supabaseAdmin.from('conversations').update({ mode: 'auto' }).eq('id', sbConvId);
              }
            }
          } else if ((existingConv?.mode === 'manual' || existingConv?.mode === 'human') && !isFromOwner && !isSelfChat) {
            const activeCheck = await isCustomerInManualMode({ orgId, buyerPhone: senderPhone, supabaseAdmin });
            if (activeCheck.inManualMode) {
              addLog(`[Manual Mode] Conversation for +${senderPhone} is paused in active manual mode (${activeCheck.remainingMinutes || 0}m remaining).`);
              return;
            } else {
              // Takeover expired -> auto-restore conversation to auto mode
              existingConv.mode = 'auto';
              if (supabaseAdmin && sbConvId) {
                await supabaseAdmin.from('conversations').update({ mode: 'auto' }).eq('id', sbConvId);
              }
              addLog(`[Auto Resume] Manual takeover expired for +${senderPhone}. AI auto-reply resumed.`);
            }
          }

          // Quota gate: if quota was not admitted, withhold AI reply
          if (!isFromOwner && !isSelfChat && sLead.quota_admitted === false) {
            addLog(`[Quota Reached] AI reply withheld for organization ${orgId}.`);
            return;
          }

        } catch (dbErr) {
          addLog(`Database sync error: ${dbErr.message}`);
          return;
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
        const newLeadCard = `🔔 *Leadsy AI — New Inbound Lead*\n` +
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

        const hotLeadCard = `🔥 *Leadsy AI — Hot Lead Alert!* (Score: ${intentResult.score})\n` +
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

    // Double-reply smoothing: if an AI reply was sent to this conversation recently,
    // add a short natural delay so rapid follow-up inquiries are answered without being discarded!
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
          const replyCooldownMs = (isFromOwner || isSelfChat) ? 1000 : 2000;
          if (diffMs < replyCooldownMs) {
            const waitMs = Math.max(300, replyCooldownMs - diffMs);
            await new Promise((r) => setTimeout(r, waitMs));
          }
        }
      } catch (e) {}
    }

    // Remote Reset / New Inquiry command
    const isResetCmd = /^\s*(?:\/reset|reset|clear|restart|new\s*chat|start\s*again)\b/i.test((incomingText || '').trim());
    if (isResetCmd) {
      if (supabaseAdmin && sbConvId) {
        try {
          await supabaseAdmin.from('messages').delete().eq('conversation_id', sbConvId);
        } catch (e) {
          addLog(`[Memory Warning] Failed to delete messages on reset: ${e.message}`);
        }
        try {
          const { ConversationMemoryService } = await import('./src/services/conversationMemoryService.js');
          await ConversationMemoryService.deleteMemory(orgId, sbConvId);
        } catch (e) {
          addLog(`[Memory Warning] Failed to delete memory summary on reset: ${e.message}`);
        }
      }
      const resetGreeting = `🔄 *Chat & Memory Reset!*\n\nNamaste! Welcome to *${freshOrg.name || 'our sales desk'}*.\n\nBatayein, main aaj aapki kis requirement ya catalog details mein madad kar sakta hoon?`;
      const sentMsg = await activeSock.sendMessage(rawRemote, { text: resetGreeting });
      if (sentMsg?.key?.id) botSentMsgIds.add(sentMsg.key.id);
      addLog(`[Reset] Reset conversation ${sbConvId} for +${senderPhone}`);
      return;
    }

    // Fetch conversation history
    let convHistory = [];
    let customerMemory = null;
    if (supabaseAdmin && sbConvId) {
      try {
        let msgQuery = supabaseAdmin
          .from('messages')
          .select('sender, text, created_at')
          .eq('conversation_id', sbConvId);

        // Find when products were last uploaded/updated for this org
        const { data: latestProd } = await supabaseAdmin
          .from('products')
          .select('created_at')
          .eq('org_id', orgId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latestProd?.created_at) {
          const catalogEpoch = new Date(latestProd.created_at).getTime() - 1000;
          msgQuery = msgQuery.gte('created_at', new Date(catalogEpoch).toISOString());
        }

        // Fix oldest-15 bug: order DESC limit 20, then reverse to chronological order
        const { data: hist, error: histErr } = await msgQuery
          .order('created_at', { ascending: false })
          .limit(20);
        if (histErr) {
          addLog(`[Memory Warning] Error loading latest messages: ${histErr.message}`);
        } else if (hist) {
          convHistory = hist.slice().reverse().map(m => ({
            role: m.sender === 'ai' ? 'ai' : 'buyer',
            text: m.text
          }));
        }

        // Fetch structured customer memory
        try {
          const { ConversationMemoryService } = await import('./src/services/conversationMemoryService.js');
          customerMemory = await ConversationMemoryService.getMemory(orgId, sbConvId);
        } catch (memErr) {
          addLog(`[Memory Warning] Failed to load conversation memory: ${memErr.message}`);
        }

        // If customer asks about another industry, corrects the bot, or requests a fresh look, discard obsolete mismatched history
        const isTopicResetOrCorrection = /check\s*again|astrology|tarot|kundli|wrong|galat|kuch\s*aur|ye\s*nahi|dusra|talking\s*about|alhaada|services/i.test(incomingText || '');
        if (isTopicResetOrCorrection) {
          convHistory = [];
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
    // Update conversation memory summary with verified customer requirement
    if (supabaseAdmin && sbConvId) {
      try {
        const { ConversationMemoryService } = await import('./src/services/conversationMemoryService.js');
        const buyerTextSample = (incomingText || '').trim().slice(0, 200);
        await ConversationMemoryService.updateMemory(orgId, sbConvId, {
          buyer_requirements: buyerTextSample,
          summary_text: 'Customer asked: ' + buyerTextSample.slice(0, 80)
        });
      } catch (memUpdateErr) {
        addLog(`[Memory Warning] Failed to update conversation memory: ${memUpdateErr.message}`);
      }
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
      conversationHistory: convHistory,
      customerMemory,
      imageBase64,
      imageMime,
      clickedAdInfo
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

      // Update conversation memory on ordinary customer enquiry
      try {
        const { ConversationMemoryService } = await import('./src/services/conversationMemoryService.js');
        const buyerTextSample = (incomingText || '').trim().slice(0, 200);
        const answeredTopic = aiReplyObj?.matchedCategory || (aiReplyObj?.reply ? aiReplyObj.reply.slice(0, 60) : 'General Inquiry');
        await ConversationMemoryService.updateMemory(orgId, sbConvId, {
          buyer_requirements: buyerTextSample,
          summary_text: `Customer asked: ${buyerTextSample.slice(0, 80)}`,
          answered_questions: [answeredTopic]
        });
      } catch (memUpdateErr) {
        addLog(`[Memory Warning] Failed to update conversation memory: ${memUpdateErr.message}`);
      }
    }

    // Order Intent Alert to Owner (item, size, quantity, customer name, city)
    const orderIntentRegex = /\b(order\s*karna|confirm\s*order|mera\s*order|book\s*karna|final\s*karo|pack\s*karo|bhej\s*dijiye|bhej\s*do|deliver\s*to|deliver\s*karo|gpay|phonepe|bank\s*details|account\s*number|dispatch\s*karo)\b/i;
    const hasOrderIntent = orderIntentRegex.test(incomingText) || (/\b(quantity|qty|sets|pieces|pcs|size)\b/i.test(incomingText) && /\b(chahiye|order|book|send|deliver)\b/i.test(incomingText));
    if (hasOrderIntent && ownerTarget && ownerTarget !== senderPhone) {
      const orderKey = `${orgId}:${senderPhone}:order_intent`;
      if (!orderAlertSentSet.has(orderKey)) {
        orderAlertSentSet.add(orderKey);
        const phoneDisplay = !senderPhone || senderPhone.length < 10 ? `⚠️ unresolved number (${rawRemote})` : `+${senderPhone}`;
        const orderCard = `🛒 *New Order Intent Alert!*\n\n` +
          `👤 *Customer:* ${pushName}\n` +
          `📱 *Phone:* ${phoneDisplay}\n` +
          `💬 *Order Details:* "${incomingText}"\n` +
          `📍 *Location:* ${freshOrg?.city_base || 'Check with customer'}\n\n` +
          `⚡ *WhatsApp Customer:* https://wa.me/${senderPhone}\n` +
          `✋ *To take over:* Send \`TAKE ${senderPhone ? senderPhone.slice(-10) : ''}\``;
        await sendOwnerAlert(activeSock, ownerTarget, orderCard);
        addLog(`[Order Intent] Sent order summary alert to owner (${maskPhone(ownerTarget)}) for +${senderPhone}`);
      }
    }

    // Out of Stock or Custom Pricing Inquiry Alert to Owner
    const orgProducts = aiReplyObj?.products || [];
    const isOutOrCustomRate = Boolean(
      (aiReplyObj?.reply && /(out of stock|currently unavailable|rate depends on design|owner will confirm|khatam|available nahi)/i.test(aiReplyObj.reply)) ||
      (orgProducts.some(p => (p.description || '').startsWith('[OUT OF STOCK]') && (incomingText || '').toLowerCase().includes((p.name || '').toLowerCase())))
    );
    if (isOutOrCustomRate && ownerTarget && ownerTarget !== senderPhone) {
      const stockAlertKey = `${orgId}:${senderPhone}:stock_inquiry`;
      if (!orderAlertSentSet.has(stockAlertKey)) {
        orderAlertSentSet.add(stockAlertKey);
        const phoneDisplay = !senderPhone || senderPhone.length < 10 ? `⚠️ unresolved number (${rawRemote})` : `+${senderPhone}`;
        const alertCard = `⚠️ *Stock / Custom Pricing Alert*\n\n` +
          `👤 *Customer:* ${pushName}\n` +
          `📱 *Phone:* ${phoneDisplay}\n` +
          `💬 *Inquired:* "${incomingText}"\n\n` +
          `⚡ *WhatsApp:* https://wa.me/${senderPhone}\n` +
          `✋ *To take over:* Send \`TAKE ${senderPhone ? senderPhone.slice(-10) : ''}\``;
        await sendOwnerAlert(activeSock, ownerTarget, alertCard);
      }
    }

    // Negotiation / Discount Push Alert to Owner
    const isDiscountInquiry = /(discount|kam\s*karo|kam\s*hoga|kam\s*rate|kam\s*price|kam\s*kijiye|sasta|cheaper|best\s*rate|best\s*price|concession|bargain|gunjaish|thoda\s*kam)/i.test(incomingText);
    const mentionsOwnerConfirm = Boolean(aiReplyObj?.reply && /(owner will confirm|team will confirm|malik se|confirm kar ke|senior se)/i.test(aiReplyObj.reply));
    if ((isDiscountInquiry || mentionsOwnerConfirm) && ownerTarget && ownerTarget !== senderPhone) {
      const discAlertKey = `${orgId}:${senderPhone}:discount_push`;
      if (!orderAlertSentSet.has(discAlertKey)) {
        orderAlertSentSet.add(discAlertKey);
        const phoneDisplay = !senderPhone || senderPhone.length < 10 ? `⚠️ unresolved number (${rawRemote})` : `+${senderPhone}`;
        const discCard = `💰 *Discount / Negotiation Alert*\n\n` +
          `👤 *Customer:* ${pushName}\n` +
          `📱 *Phone:* ${phoneDisplay}\n` +
          `💬 *Buyer Asked:* "${incomingText}"\n` +
          `🤖 *Bot Replied:* "${aiReplyObj?.reply || 'Owner will confirm.'}"\n\n` +
          `⚡ *WhatsApp:* https://wa.me/${senderPhone}\n` +
          `✋ *To take over:* Send \`TAKE ${senderPhone ? senderPhone.slice(-10) : ''}\``;
        await sendOwnerAlert(activeSock, ownerTarget, discCard);
        addLog(`[Negotiation Alert] Sent discount request alert to owner (${maskPhone(ownerTarget)}) for +${senderPhone}`);
      }
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
        const callCard = `🔥 *Leadsy AI — Call / Meeting Requested*\n` +
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
        let imgBuffer = null;
        if (aiReplyObj.matchedImagePath && fs.existsSync(aiReplyObj.matchedImagePath)) {
          const { getSafeAttachmentBuffer } = await import('./src/services/storageSecurity.js');
          imgBuffer = await getSafeAttachmentBuffer(orgId, aiReplyObj.matchedImagePath);
        } else if (aiReplyObj.matchedImageUrl && aiReplyObj.matchedImageUrl.startsWith('data:image')) {
          const b64 = aiReplyObj.matchedImageUrl.split(',')[1] || aiReplyObj.matchedImageUrl;
          imgBuffer = Buffer.from(b64, 'base64');
        } else if (aiReplyObj.matchedImageUrl && aiReplyObj.matchedImageUrl.startsWith('http')) {
          const { getSafeAttachmentBuffer } = await import('./src/services/storageSecurity.js');
          imgBuffer = await getSafeAttachmentBuffer(orgId, aiReplyObj.matchedImageUrl);
        }
        if (imgBuffer) {
          const imgCaption = aiReplyObj.matchedImageCaption ? `📸 ${aiReplyObj.matchedImageCaption}` : 'Live Product Photo';
          const imgSent = await activeSock.sendMessage(rawRemote, {
            image: imgBuffer,
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
        const { getSafeAttachmentBuffer } = await import('./src/services/storageSecurity.js');
        const pdfBuffer = await getSafeAttachmentBuffer(orgId, aiReplyObj.matchedBrochureUrl);
        if (pdfBuffer) {
          const brochureSent = await activeSock.sendMessage(rawRemote, {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName: aiReplyObj.matchedBrochureName || 'Leadsy_Catalog.pdf',
            caption: `Aapka official technical brochure & price catalog! 📄`
          });
          if (brochureSent?.key?.id) botSentMsgIds.add(brochureSent.key.id);
          sentPdfs.add(pdfKey);
          addLog(`[Brochure] Sent PDF brochure to +${senderPhone}`);
        }
      } catch (pdfErr) {
        addLog(`[Brochure] Error: ${pdfErr.message}`);
      }
    }
  } catch (err) {
    addLog(`Error processing inbound message from +${senderPhone}: ${err.message}`);
  }
};

const prevQueue = senderQueues.get(senderPhone) || Promise.resolve();
const nextQueue = prevQueue
  .then(task, task)
  .finally(() => {
    if (senderQueues.get(senderPhone) === nextQueue) {
      senderQueues.delete(senderPhone);
    }
  });
senderQueues.set(senderPhone, nextQueue);
return nextQueue;
}

async function startOrgWhatsApp(orgId, forceNew = false) {
  if (!orgId) return;
  const sessionDir = path.join(process.cwd(), 'auth_info', orgId);

  // 1. Cleanly check existing socket for orgId before closing
  if (orgSessions.has(orgId)) {
    const existing = orgSessions.get(orgId);
    if (!forceNew && existing) {
      if (existing.sock && existing.state?.status === 'connected') {
        addLog(`[Org: ${orgId.slice(0, 8)}] WhatsApp socket already connected. Reusing session.`);
        return;
      }
      if (existing.isConnecting) {
        addLog(`[Org: ${orgId.slice(0, 8)}] WhatsApp socket currently initializing. Skipping duplicate initialization.`);
        return;
      }
    }
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

    enableSessionBackups(orgId);
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
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
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

        // Register bot's own @lid in lidToPhoneMap for bulletproof self-chat and identity recognition
        const myLid = newSock.user?.lid || state?.creds?.me?.lid;
        if (myLid) {
          const cleanLid = myLid.split(':')[0].split('@')[0] + '@lid';
          lidToPhoneMap[cleanLid] = sessionObj.state.connectedNumber;
          lidToPhoneMap[myLid] = sessionObj.state.connectedNumber;
          lidToPhoneMap[myLid.split(':')[0]] = sessionObj.state.connectedNumber;
        }

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
          const isRestart = statusCode === DisconnectReason.restartRequired || statusCode === 515;
          sessionObj.state.status = 'reconnecting';
          sessionObj.state.lastEvent = isRestart ? 'Finalizing pairing handshake with phone...' : `Connection interrupted (code: ${statusCode || 'unknown'}). Reconnecting...`;
          const delay = isRestart ? 150 : 2000;
          addLog(`[Org: ${orgId.slice(0, 8)}] WhatsApp closed (code: ${statusCode}). Auto-reconnecting in ${delay}ms...`);
          if (sessionObj.reconnectTimer) clearTimeout(sessionObj.reconnectTimer);
          sessionObj.reconnectTimer = setTimeout(() => {
            sessionObj.isConnecting = false;
            startOrgWhatsApp(orgId, false);
          }, delay);
        }
      }
    });

    // Alert the workspace owner without answering or rejecting the call.
    attachIncomingCallAlerts(newSock, orgId, { log: message => addLog(`[Call Alert] ${message}`) });

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

  // Define dynamic reactive getters so isConnected, sock, and state are never stale
  Object.defineProperty(inst, 'sock', {
    get() {
      return orgSessions.get(orgId)?.sock || null;
    },
    configurable: true
  });
  Object.defineProperty(inst, 'isConnected', {
    get() {
      const session = orgSessions.get(orgId);
      return Boolean(session && session.state && session.state.status === 'connected' && session.sock);
    },
    configurable: true
  });
  Object.defineProperty(inst, 'state', {
    get() {
      return orgSessions.get(orgId)?.state || { status: 'disconnected', qrDataUrl: null, logs: [] };
    },
    configurable: true
  });

  inst.init = async function(forceNew = false) {
    await startOrgWhatsApp(orgId, forceNew);
    return inst;
  };

  inst.disconnect = async function() {
    const session = orgSessions.get(orgId);
    if (session?.reconnectTimer) clearTimeout(session.reconnectTimer);
    // Remove the session before ending it, so no subsequent worker observes it as connected.
    orgSessions.delete(orgId);
    if (session?.sock) {
      session.sock.ev.removeAllListeners();
      try { await session.sock.logout(); } catch (err) { session.sock.end(); }
    }
    fs.rmSync(inst.authDir, { recursive: true, force: true });
    const isOrgUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId);
    const remoteRemoved = await deleteRemoteSession(orgId);
    if (supabaseAdmin && isOrgUuid && !remoteRemoved) throw new Error('Failed to remove remote WhatsApp session.');
    if (supabaseAdmin && isOrgUuid) {
      const { error } = await supabaseAdmin.from('organizations').update({
        wa_status: 'disconnected', wa_connected_number: null,
        wa_qr_data_url: null, wa_pairing_code: null, wa_command: null
      }).eq('id', orgId);
      if (error) throw new Error(`Failed to update WhatsApp status: ${error.message}`);
    }
    return { ok: true };
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
      const { getSafeAttachmentBuffer } = await import('./src/services/storageSecurity.js');
      const docBuffer = await getSafeAttachmentBuffer(orgId, pdfPath);
      if (!docBuffer) return { ok: false, error: 'Document attachment could not be securely loaded' };
      sent = await activeSock.sendMessage(jid, {
        document: docBuffer,
        mimetype: 'application/pdf',
        fileName: path.basename(pdfPath) || 'Brochure.pdf',
        caption: messageText || ''
      });
    } else if (imagePath) {
      const { getSafeAttachmentBuffer } = await import('./src/services/storageSecurity.js');
      const imgBuffer = await getSafeAttachmentBuffer(orgId, imagePath);
      if (!imgBuffer) return { ok: false, error: 'Image attachment could not be securely loaded' };
      sent = await activeSock.sendMessage(jid, {
        image: imgBuffer,
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
export {
  buildAdaptiveWelcomeMessage,
  getIndustryPlaybook,
  ownerPendingConfirmations,
  ownerUndoSnapshots,
  conversationSentPhotos,
  conversationSentBuyLinks,
  handleOrgIncomingMessage,
  generateShortSalesReply,
  syncWebsiteProducts,
  getOrgWebsiteUrl,
  setOrgWebsiteUrl,
  isSafePublicUrl,
  safeFetchWebsite
};

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

// Check if an OFFER line in website_knowledge has expired based on Asia/Kolkata date
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

// ============================================================================
// CONCISE WHATSAPP AI SALES CLOSER (MAX 18–38 WORDS, BUSY FOUNDER PERSONA)
// ============================================================================
async function generateShortSalesReply({ organizationId, org, lead, incomingText, conversationHistory, customerMemory, imageBase64, imageMime, clickedAdInfo }) {
  const geminiKey = (process.env.GEMINI_API_KEY || config.geminiApiKey || '').trim();
  const orgName = org?.name || config.companyName || 'Leadsy AI';
  const cityBase = org?.city_base || org?.company_city || config.cityBase || 'Delhi NCR / Ludhiana';

  // Get catalog products strictly for this organization (Zero cross-tenant leak)
  let products = [];
  if (supabaseAdmin && organizationId) {
    try {
      const { data: dbProds } = await supabaseAdmin.from('products').select('*').eq('org_id', organizationId).neq('is_active', false);
      if (dbProds && dbProds.length > 0) products = dbProds;
    } catch (e) {}
  }
  if (products.length === 0 && organizationId) {
    try { products = db.findScoped('products', organizationId) || []; } catch (e) {}
  }

  // Strictly tenant-isolated website/brochure knowledge
  let orgKnowledge = org?.website_knowledge || '';
  if (!orgKnowledge && organizationId && supabaseAdmin) {
    try {
      const { data: curOrg } = await supabaseAdmin.from('organizations').select('website_knowledge').eq('id', organizationId).maybeSingle();
      if (curOrg?.website_knowledge) orgKnowledge = curOrg.website_knowledge;
    } catch (e) {}
  }
  // OFFER EXPIRY: filter out expired OFFER lines (Asia/Kolkata date comparison) so they are never quoted
  if (orgKnowledge && orgKnowledge.includes('OFFER:')) {
    orgKnowledge = orgKnowledge
      .split(/\r?\n/)
      .filter(line => !isOfferExpired(line))
      .join('\n');
  }
  const extraKnowledge = orgKnowledge
    ? `\nBusiness & Service Knowledge Base:\n${orgKnowledge.slice(0, 10000)}\n`
    : '';
  const memoryContext = customerMemory?.summary_text
    ? `\nVerified Customer Context:\n- Summary: ${customerMemory.summary_text}\n- Inquired: ${customerMemory.buyer_requirements || 'Standard'}\n`
    : '';

  // Relevance filtering: if catalog > 15 products, select top ~15 most relevant products
  let relevantProducts = products;
  if (products.length > 15) {
    const queryTokens = (incomingText || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const historyTokens = (conversationHistory || []).slice(-3).map(m => (m.text || m.content || '').toLowerCase()).join(' ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const allTokens = [...new Set([...queryTokens, ...historyTokens])];

    const scored = products.map(p => {
      let score = 0;
      const pName = (p.name || '').toLowerCase();
      const pDesc = (p.description || '').toLowerCase();
      const pSpecs = (p.model_specs || '').toLowerCase();
      for (const t of allTokens) {
        if (pName.includes(t)) score += 5;
        if (pSpecs.includes(t)) score += 2;
        if (pDesc.includes(t)) score += 1;
      }
      if (!(p.description || '').startsWith('[OUT OF STOCK]')) score += 0.5;
      return { product: p, score };
    });
    scored.sort((a, b) => b.score - a.score);
    relevantProducts = scored.slice(0, 15).map(s => s.product);
  }

  const catalogContext = relevantProducts.map((p, idx) => {
    const isOut = (p.description || '').startsWith('[OUT OF STOCK]');
    const stockLabel = isOut ? ' [CURRENTLY OUT OF STOCK]' : ' [IN STOCK]';
    const price = p.price_raw || p.priceRange || 'Price on request';
    const buyLinkMatch = (p.description || '').match(/Buy link:\s*(https?:\/\/[^\s]+)/i);
    const buyLinkStr = buyLinkMatch ? ` | Buy link: ${buyLinkMatch[1]}` : '';
    const cleanSpecs = (p.model_specs || p.description || 'Standard')
      .replace(/Buy link:\s*https?:\/\/[^\s]+/gi, '')
      .replace(/\[OUT OF STOCK\]/gi, '')
      .trim();
    return `${idx + 1}. "${p.name}" | Price: ${price}${stockLabel} | Specs: ${cleanSpecs}${buyLinkStr}`;
  }).join('\n');

  // Match brochure or image if requested
  const qLower = (incomingText || '').toLowerCase();
  const isCatalogRequest = /catalog|catalogue|brochure|pdf|price\s*list|rate\s*list|details/i.test(qLower);
  const isImageRequest = /photo|image|pic|dikhao|bhejo|dekhna/i.test(qLower);

  let matchedBrochureUrl = null;
  let matchedBrochureName = null;
  const prodWithPdf = products.find(p => p.brochure_url && /\.pdf(\?.*)?$/i.test(p.brochure_url));
  const fallbackPdfUrl = org?.catalog_pdf_url || '';
  const fallbackPdfName = org?.catalog_pdf_name || orgName;
  if ((prodWithPdf || fallbackPdfUrl) && isCatalogRequest) {
    matchedBrochureUrl = prodWithPdf?.brochure_url || fallbackPdfUrl;
    matchedBrochureName = ((prodWithPdf?.name || fallbackPdfName || 'Catalog')).replace(/[^a-zA-Z0-9_-]/g, '_') + '.pdf';
  }

  // Customer photo dispatch: once per product per chat, max 3 photos per conversation, never for out of stock items
  let matchedImageUrl = null;
  let matchedImagePath = null;
  let matchedImageCaption = null;
  const convPhotoKey = getConversationTrackingKey(organizationId, lead);
  const sentPhotosForChat = conversationSentPhotos.get(convPhotoKey) || new Set();

  if (sentPhotosForChat.size < 3) {
    let targetProd = null;

    // 1. Explicit product match in customer query (prioritize longest matching name or SKU)
    const candidates = [];
    for (const p of products) {
      const pName = (p.name || '').toLowerCase().trim();
      const pSku = (p.sku_code || p.sku || '').toLowerCase().trim();
      if (pName && qLower.includes(pName)) {
        candidates.push({ product: p, score: pName.length * 10 });
      } else if (pSku && qLower.includes(pSku)) {
        candidates.push({ product: p, score: pSku.length * 10 });
      } else if (pName && qLower.split(/\s+/).some(w => w.length > 3 && pName.includes(w))) {
        candidates.push({ product: p, score: 5 });
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      targetProd = candidates[0].product;
    }

    // 2. Fallback to lead.product_inquired or lead.productName if query didn't match a product
    if (!targetProd) {
      const leadProdName = (lead?.product_inquired || lead?.productName || '').toLowerCase().trim();
      if (leadProdName) {
        targetProd = products.find(p => {
          const pName = (p.name || '').toLowerCase().trim();
          return pName && (leadProdName.includes(pName) || pName.includes(leadProdName));
        });
      }
    }

    // 3. Fallback to last mentioned product in recent conversation history
    if (!targetProd && conversationHistory && conversationHistory.length > 0) {
      const recentText = conversationHistory.slice(-6).map(m => (m.text || m.content || '').toLowerCase()).join(' ');
      for (const p of products) {
        const pName = (p.name || '').toLowerCase().trim();
        if (pName && recentText.includes(pName)) {
          targetProd = p;
          break;
        }
      }
    }

    // 4. ONLY if isImageRequest is true and no specific product was named, fall back to first product with an image
    if (!targetProd && isImageRequest) {
      targetProd = products.find(p => (p.image_url || p.imageUrl || p.brochure_url) && !(p.description || '').startsWith('[OUT OF STOCK]'));
    }

    if (targetProd && !(targetProd.description || '').startsWith('[OUT OF STOCK]')) {
      const isImgBrochure = targetProd.brochure_url && /\.(jpe?g|png|webp)(\?.*)?$/i.test(targetProd.brochure_url);
      const imgCandidate = isImgBrochure ? targetProd.brochure_url : (targetProd.image_url || targetProd.imageUrl);
      const prodKey = targetProd.id || targetProd.name;
      if (imgCandidate && !sentPhotosForChat.has(prodKey)) {
        matchedImageUrl = imgCandidate;
        matchedImageCaption = `${targetProd.name} (${targetProd.price_raw || 'Price on request'})`;
        sentPhotosForChat.add(prodKey);
        conversationSentPhotos.set(convPhotoKey, sentPhotosForChat);
      }
    }
  }

  if (geminiKey && geminiKey.length > 10) {
    const adPromptContext = clickedAdInfo ? `\nActive Reel/Ad Context:\n${clickedAdInfo}\n` : '';
    const systemInstruction = `You are a real, busy business founder/manager on WhatsApp for "${orgName}" (${cityBase}).
Catalog & Pricing Knowledge:
${catalogContext || 'Standard verified offerings apply.'}
${extraKnowledge}${memoryContext}${adPromptContext}

AD, MEDIA & LIVE INQUIRY RULE:
(a) If the customer asks about an item in a video, reel, or advertisement WITHOUT sharing a photo or specific product name (and no Clicked Ad Info is present), share the relevant category price range or model range strictly from the active catalog in 1 concise line, and ask them to share a quick screenshot or specify their target model/specifications and required quantity.
(b) Never fabricate stock numbers, warehouse locations, dispatch promises, dispatch teams, or unverified availability unless explicitly stated in "Catalog & Pricing Knowledge" or "Business & Service Knowledge Base".
(c) Never promise unverified stock or ask the buyer for upfront payment before owner/technical confirmation. If specific specs, batch size, or custom requirements are needed, ask the customer for their quantity and delivery city, then hand off serious inquiries to the owner/sales manager.

OUT OF STOCK RULE:
1. Products marked [CURRENTLY OUT OF STOCK] or whose description starts with [OUT OF STOCK] are sold out.
2. Politely inform the buyer that this product is currently unavailable, offer 1-2 similar in-stock products from the catalog above, ask their required quantity + city, and mention the owner has been alerted.
3. NEVER promise stock availability or dispatch date for out-of-stock items, and never send photos for out-of-stock products.

NO-PRICE-LIST & GROUNDING SAFETY RULE:
1. If a matching product, size, or price does NOT exist in "Catalog & Pricing Knowledge" or "Business & Service Knowledge Base", NEVER invent a price!
2. Reply in 1-2 short human sentences: state that the rate depends on design/quantity, ask how many sets and which city, and tell them the owner will confirm.
3. Do not ask for advance payment before owner confirmation.
4. REMOVE ALL HARDCODED BUSINESS RULES: The bot must take MOQ, shipping, payment modes, and return policies ONLY from the workspace's catalog and knowledge base. If a rule is not in that data, DO NOT invent or assume it (e.g. do not assume wholesale only or minimum order)—say the owner will confirm, collect details (item, size, quantity, city/country), and alert the owner.

ORDER INTENT RULE:
When a buyer clearly wants to place an order (gives items, size, quantity, address/city, or asks for payment details), acknowledge politely that their order details have been noted and the owner will finalize dispatch and payment shortly.

WEBSITE PRODUCT & BUY-LINK RULE:
1. Answer buyer questions about products (pricing, specifications, availability) strictly from the catalog data above.
2. When a buyer is clearly serious (wants to buy, asks how to order/pay, or explicitly asks for a link), send the EXACT "Buy link: <exact product url>" of that product, once per product per chat.
3. ONLY use URLs found in the catalog data above; NEVER invent, modify, or shorten links. Do NOT send links to casual browsers who have not shown buying intent.
4. If a product is marked [CURRENTLY OUT OF STOCK] or [OUT OF STOCK], politely say it is currently sold out and suggest 1-2 similar in-stock products with their exact buy links.
5. If a product is not found in the catalog, say the team will confirm, collect details (item, size, quantity, city), and alert the owner.

CRITICAL CATALOG PRIORITY & ANTI-HALLUCINATION RULE:
1. You represent "${orgName}". Your ONLY active products and services are in "Catalog & Pricing Knowledge" and "Business & Service Knowledge Base" above.
2. If earlier chat history mentions unrelated products (such as packaging machinery, industrial equipment, etc. from a previous catalog), DISREGARD THEM COMPLETELY! Acknowledge the current business offerings and answer strictly from your active catalog above. NEVER invent or offer products that do not exist in the active catalog!
3. If the customer asks about astrology, consultations, services, products, or says "check again" / "I'm talking about X", immediately answer from the active catalog above. Acknowledge and apologize if an earlier message mentioned something unrelated, and present what you actually offer.

NEGOTIATION & OFFER RULE:
- Never reduce a price, invent a discount, or reveal a minimum/floor price on your own. Use only discounts/slabs/offers that appear in the workspace data (products, website_knowledge).
- If the buyer asks for a discount: stay calm and polite, restate the value from the data (quality, fabric, policy), mention any real non-price benefit in the data (free shipping above X, bulk slab), and ask quantity/city. If data defines a slab and the buyer qualifies, quote it exactly.
- If the buyer pushes a second time, or asks beyond the data's slabs, do not argue and do not promise a discount; say the owner will confirm for that quantity, and send the owner's main WhatsApp (owner_alert_number, 91-normalized) a short alert with item, quantity, city and the price the buyer asked for.
- OFFER EXPIRY: when website_knowledge contains lines starting with "OFFER:" that include "Valid till <date>", compare to today's date in Asia/Kolkata and treat expired offers as not available; never quote them.
- Never use fake urgency or false scarcity. 1-2 short sentences per reply.

TOP SALES PLAYBOOK (applies to any industry; always use the workspace's own products and knowledge as the only source of facts):

ROLE: You are a calm, warm, experienced sales advisor for this business. Think like a top salesperson: curious first, helpful second, selling third. Never sound scripted, pushy or like a bot. Mirror the customer's language (Hindi, Punjabi, Hinglish, English) and tone. Use their name once you know it.

EVERY REPLY: (1) answer exactly what they asked, (2) add one useful detail that builds confidence, (3) ask ONE simple question that moves them forward. Maximum 2 short sentences. Never ask more than one question at a time.

DISCOVER BEFORE YOU PITCH: find out what they need, the quantity or budget, the city/timeline, and who decides. Recommend 1 best-fit option (at most 2), not a list of everything.

BUYING SIGNALS: asking price, delivery, availability, payment, quantity, sizes, or "how to order" means they are ready. Move to the close: confirm the option, collect the order details (item, size/quantity, name, city) and alert the owner. Do not keep selling after they are ready.

OBJECTIONS (acknowledge first, never argue):
- Too expensive: stay calm, restate the real value from the data, mention any real slab/free-shipping benefit, never lower the price yourself; if they push twice, say the owner will confirm and alert the owner.
- Need to think: respect it, offer the single most useful next step (sample, demo, site visit, a short trial), and ask what they want to compare.
- Trust or quality doubt: give factual proof from the data (policy, warranty, reviews, certifications). If none exists, offer a video call or live photo from the owner.
- Comparing with a competitor: never criticise others; explain what is strong here and ask what matters most to them.
- Not interested or "ok": thank them politely and stop. No follow-up pressure.

HONESTY RULES: no fake urgency, no false scarcity, no made-up facts, offers or guarantees. If you do not know, say the owner will confirm, collect quantity and city, and alert the owner. Never promise exact live stock.

LEAD QUALITY: treat one-piece timewasters and curiosity chats briefly and politely. For serious buyers (clear need + quantity/budget/timeline), send the owner a short summary: name, item, quantity or budget, city, what they objected to, and the buying signal.

INDUSTRY ADAPTATION: infer the industry from the products/knowledge. Wholesale: lead with MOQ, set size, dispatch. Retail brand: lead with size, delivery time, returns. Services (clinic, visa, real estate, astrology, coaching): answer basics, never diagnose or give deep paid predictions, then book or connect to the expert. High-ticket (cars, property, solar): ask budget and finance need, then book a visit or call.

STRICT LENGTH RULE:
1. Reply like a real busy human founder/manager on WhatsApp — 1 to 2 short sentences ONLY (strictly 18 to 38 words max) unless the customer explicitly asks to compare multiple plans/items.
2. NEVER write 2–3 long paragraphs.
3. NEVER start every message with fake-enthusiastic AI clichés like "Arre bilkul sir! Bahut badiya decision! 🚀" or "Namaste sir, hum aapki kya madad kar sakte hain".
4. Answer their exact question directly first, give the exact price/fact, and end with AT MOST 1 short 5–8 word question when relevant.
5. Speak natural, conversational Indian Hinglish (or English if the customer wrote in English). Ground strictly to verified catalog and business knowledge base.`;

    const historyText = (conversationHistory || [])
      .slice(-10)
      .map(m => `${m.role === 'ai' || m.sender === 'ai' ? 'You' : 'Customer'}: ${m.text || m.content || ''}`)
      .join('\n');

    const modelsToTry = ['gemini-flash-lite-latest', 'gemini-2.5-flash-latest', 'gemini-flash-latest'];
    for (const model of modelsToTry) {
      try {
        const convBuyLinkKey = getConversationTrackingKey(organizationId, lead);
        const sentBuyLinksForChat = conversationSentBuyLinks.get(convBuyLinkKey) || new Set();
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
                  parts: [
                    ...(imageBase64 ? [{ inlineData: { mimeType: imageMime || 'image/jpeg', data: imageBase64 } }] : []),
                    { text: `Customer: "${incomingText}"${clickedAdInfo ? `\n${clickedAdInfo}` : ''}\n\nRecent chat context:\n${historyText || '(New inquiry)'}` }
                  ]
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
              products: products || [],
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
    products: products || [],
    matchedBrochureUrl: matchedBrochureUrl || fallbackObj?.matchedBrochureUrl,
    matchedBrochureName: matchedBrochureName || fallbackObj?.matchedBrochureName,
    // The fallback must not override stock and per-conversation photo checks.
    matchedImageUrl,
    matchedImagePath,
    matchedImageCaption
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

  const orgId = lead.org_id || lead.organization_id;
  let companyName = config.companyName;
  let ownerPhone = config.ownerAlertPhone;
  if (orgId) {
    try {
      const org = await repository.getOrganizationById(orgId) || db.findById('organizations', orgId);
      const settings = await repository.getAiSettings(orgId) || db.findOne('ai_settings', (s) => s.organization_id === orgId);
      if (org?.name) companyName = org.name;
      if (org?.owner_alert_number || settings?.escalation_phone) {
        ownerPhone = org.owner_alert_number || settings.escalation_phone;
      }
    } catch {}
  }

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
        `— *${companyName}*`;

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
  const ownerDigits = normalizePhone(ownerPhone);
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
  if (orgId && lead.id) {
    try {
      await repository.updateLeadScoped(orgId, lead.id, {
        callbackStatus: lead.callbackStatus,
        scheduledCallTime: lead.scheduledCallTime,
        status: lead.status
      });
      db.updateScoped('leads', lead.id, orgId, {
        callbackStatus: lead.callbackStatus,
        scheduledCallTime: lead.scheduledCallTime,
        status: lead.status
      });
    } catch (e) {
      console.warn('Failed to update lead scoped in storage:', e.message);
    }
  }
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
app.get('/api/test-audio', authenticate, requireConversationAccess, async (req, res) => {
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

// Render & Uptime Healthcheck Endpoints (Liveness & Readiness Probes)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/api/ready', async (req, res) => {
  let dbOk = false;
  const isProduction = process.env.NODE_ENV === 'production';
  const useLocal = process.env.USE_LOCAL_DB === 'true';

  try {
    if (isProduction && !useLocal) {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !supabaseAdmin) {
        dbOk = false;
      } else {
        const { error } = await supabaseAdmin.from('organizations').select('id').limit(1);
        dbOk = !error;
      }
    } else {
      dbOk = db !== null;
    }
  } catch (e) {
    dbOk = false;
  }
  const storageOk = fs.existsSync(path.join(__dirname, 'catalogs'));
  const isReady = dbOk && storageOk;
  res.status(isReady ? 200 : 503).json({
    ok: isReady,
    status: isReady ? 'ready' : 'degraded',
    checks: { database: dbOk, storage: storageOk, uptime: process.uptime() },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/status', authenticate, requireConversationAccess, requireRole(['owner', 'admin', 'superadmin']), (req, res) => {
  const scopedLeads = db.findScoped('leads', req.organizationId) || [];
  const pendingCallbacks = scopedLeads.filter((l) => l.callbackStatus === 'awaiting_client_time');
  const org = db.findById('organizations', req.organizationId) || {};
  res.json({
    ok: true,
    organizationId: req.organizationId,
    planStatus: org.plan_status || 'trial',
    leadsCount: scopedLeads.length,
    pendingCallbacksCount: pendingCallbacks.length,
    pendingCallbacks,
    leads: scopedLeads.slice(0, 50)
  });
});

app.get('/api/config', authenticate, async (req, res) => {
  try {
    const org = await repository.getOrganizationById(req.organizationId) || db.findById('organizations', req.organizationId) || {};
    const settings = await repository.getAiSettings(req.organizationId) || db.findOne('ai_settings', (s) => s.organization_id === req.organizationId) || {};
    res.json({
      ok: true,
      config: {
        companyName: org.name || settings.company_name || 'MartFlow AI',
        cityBase: org.company_city || settings.city_base || 'Delhi NCR',
        ownerAlertPhone: org.owner_alert_number || settings.escalation_phone || '',
        replyDelaySec: settings.reply_delay_sec ?? org.reply_delay_sec ?? 3,
        autoReplyEnabled: org.auto_reply_enabled ?? settings.auto_reply_enabled ?? true,
        replyWithVoiceNotes: org.reply_with_voice_notes ?? false,
        hasGeminiKey: Boolean(process.env.GEMINI_API_KEY)
      }
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

app.post('/api/config', authenticate, requireRole(['owner', 'admin']), async (req, res) => {
  try {
    const { companyName, cityBase, ownerAlertPhone, replyDelaySec, autoReplyEnabled, replyWithVoiceNotes } = req.body;
    const updates = {};
    if (typeof companyName === 'string' && companyName.trim()) updates.name = companyName.trim();
    if (typeof cityBase === 'string') updates.company_city = cityBase.trim();
    if (typeof ownerAlertPhone === 'string') updates.owner_alert_number = ownerAlertPhone.trim();
    if (replyDelaySec !== undefined) updates.reply_delay_sec = Math.max(0, Math.min(60, Number(replyDelaySec) || 0));
    if (typeof autoReplyEnabled === 'boolean') {
      updates.auto_reply_enabled = autoReplyEnabled;
      updates.wa_auto_reply = autoReplyEnabled;
    }
    if (typeof replyWithVoiceNotes === 'boolean') updates.reply_with_voice_notes = replyWithVoiceNotes;

    const org = await repository.updateOrganizationScoped(req.organizationId, updates);
    db.update('organizations', req.organizationId, updates);

    // Tenant settings isolated to authenticated organization — do not mutate process-global config.json
    const existingSettings = await repository.getAiSettings(req.organizationId) || db.findOne('ai_settings', (s) => s.organization_id === req.organizationId);
    const aiUpdates = {
      company_name: updates.name || org?.name || 'Bharat Machinery',
      city_base: updates.company_city || org?.company_city || 'Delhi NCR',
      escalation_phone: updates.owner_alert_number || org?.owner_alert_number || '',
      reply_delay_sec: updates.reply_delay_sec ?? existingSettings?.reply_delay_sec ?? 3,
      auto_reply_enabled: updates.auto_reply_enabled ?? existingSettings?.auto_reply_enabled ?? true
    };
    await repository.upsertAiSettings(req.organizationId, aiUpdates);
    if (existingSettings?.id) {
      db.updateScoped('ai_settings', existingSettings.id, req.organizationId, aiUpdates);
    } else {
      db.insert('ai_settings', { organization_id: req.organizationId, ...aiUpdates });
    }

    addLog(`Tenant settings updated for organization ${req.organizationId}.`);
    res.json({
      ok: true,
      config: {
        companyName: org?.name || aiUpdates.company_name,
        cityBase: org?.company_city || aiUpdates.city_base,
        ownerAlertPhone: org?.owner_alert_number || aiUpdates.escalation_phone,
        replyDelaySec: aiUpdates.reply_delay_sec,
        autoReplyEnabled: aiUpdates.auto_reply_enabled,
        replyWithVoiceNotes: org?.reply_with_voice_notes ?? updates.reply_with_voice_notes ?? false,
        hasGeminiKey: Boolean(process.env.GEMINI_API_KEY)
      }
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// Rate limiting map for public demo enquiries (max 5 requests per IP per 10 minutes)
const publicDemoRateLimit = new Map();

function checkPublicDemoRateLimit(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const maxRequests = 5;
  const record = publicDemoRateLimit.get(ip) || [];
  const valid = record.filter((ts) => now - ts < windowMs);
  if (valid.length >= maxRequests) {
    return false;
  }
  valid.push(now);
  publicDemoRateLimit.set(ip, valid);
  return true;
}

// 1. Dedicated Public Demo Enquiry Endpoint (Rate-Limited, Abuse-Protected)
app.post('/api/public/demo-enquiry', async (req, res) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!checkPublicDemoRateLimit(clientIp)) {
    return res.status(429).json({
      ok: false,
      error: 'Demo enquiry limit reached for this IP (max 5 inquiries per 10 minutes). Please wait a few minutes or test via WhatsApp directly.'
    });
  }

  const { name, phone, productQuery, city, message, delaySec } = req.body || {};
  const cleanPhone = normalizeIndianPhone(phone);
  if (!cleanPhone || cleanPhone.length < 10) {
    return res.status(400).json({ ok: false, error: 'Valid 10-digit WhatsApp mobile number required.' });
  }

  try {
    const lead = await processNewB2BLead({
      name: (name && !/^(buyer|unknown|sir|rajesh)$/i.test(name.trim())) ? name.trim() : 'Demo Buyer',
      phone: cleanPhone,
      productQuery: productQuery || 'Automatic Pouch Packing Machine',
      city: city || 'Direct Demo Inquiry',
      message: message || '',
      source: 'Website Public Live Demo',
      customDelaySec: delaySec !== undefined ? Number(delaySec) : 5
    });
    res.json({
      ok: true,
      lead: {
        id: lead.id,
        name: lead.name,
        phone: lead.phone,
        productName: lead.productName,
        status: lead.status
      }
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Public Config Endpoint (exposes Supabase config, merchant UPI & live connected WhatsApp numbers)
app.get('/api/public-config', (req, res) => {
  const activeNumber = sock?.user?.id?.split(':')[0]?.split('@')[0] ||
    orgSessions.get('6fd354d9-3437-412d-856e-28bc19d44268')?.state?.connectedNumber ||
    process.env.SUPPORT_WHATSAPP || '919115748457';

  res.json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL || 'https://uriqhusalcdgdlgzgasp.supabase.co',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVyaXFodXNhbGNkZ2RsZ3pnYXNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzMzYwNDQsImV4cCI6MjEwODkxMjA0NH0.UTB-Ykce-bcxTrhhKvk1kNjxCH5uWsmB3yAyGJeZXkE',
    merchantUpiId: process.env.MERCHANT_UPI_ID || 'saraitaj6-2@okaxis',
    merchantName: process.env.MERCHANT_NAME || 'MartFlow AI Sales',
    supportWhatsapp: activeNumber,
    demoBotWhatsapp: activeNumber
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
const dryRunSessions = new Map();

app.post('/api/dry-run-chat', authenticate, requireConversationAccess, async (req, res) => {
  const sessionKey = req.userId || req.organizationId || 'default';
  const { text, reset, customerName } = req.body;
  if (reset || !dryRunSessions.has(sessionKey)) {
    const fresh = {
      name: customerName ? customerName.trim() : '',
      productName: '',
      city: '',
      requirement: '',
      history: []
    };
    dryRunSessions.set(sessionKey, fresh);
    if (reset) return res.json({ ok: true, dryRunLead: fresh });
  }
  const sessionLead = dryRunSessions.get(sessionKey);
  if (customerName) sessionLead.name = customerName.trim();
  const inputMsg = text || req.body.message || '';
  sessionLead.history.push({ role: 'buyer', text: inputMsg, ts: new Date().toISOString() });
  const result = await generateShortSalesReply({
    organizationId: req.organizationId, org: req.organization, lead: sessionLead,
    incomingText: inputMsg, conversationHistory: sessionLead.history
  });
  if (result.extractedCustomerName && !sessionLead.name) {
    sessionLead.name = result.extractedCustomerName;
  }
  if (result.extractedCity) sessionLead.city = result.extractedCity;
  if (result.extractedRequirement) {
    sessionLead.requirement = sessionLead.requirement
      ? `${sessionLead.requirement} | ${result.extractedRequirement}`
      : result.extractedRequirement;
  }
  sessionLead.history.push({ role: 'ai', text: result.reply, ts: new Date().toISOString() });
  res.json({ ok: true, reply: result.reply, dryRunLead: sessionLead, isHotLead: result.isHotLead });
});

// 4. Export Qualified Leads as Excel-Ready CSV (Tenant-Scoped with Formula Injection Protection)
app.get('/api/leads.csv', authenticate, requireConversationAccess, requireRole(['owner', 'admin', 'sales_manager']), (req, res) => {
  const headers = ['Lead ID', 'Time', 'Buyer Name', 'WhatsApp Mobile', 'Machine Interested', 'Buyer City', 'Requirement', 'Status', 'Source'];
  const sanitizeCell = (v) => {
    let s = String(v ?? '');
    if (/^[=+@-]/i.test(s)) {
      s = "'" + s; // Prevent CSV Formula Injection (Item 27)
    }
    return `"${s.replace(/"/g, '""')}"`;
  };
  const tenantLeads = db.findScoped('leads', req.organizationId);
  const rows = tenantLeads.map((l) => [
    l.id,
    new Date(l.created_at || l.createdAt || Date.now()).toLocaleString('en-IN'),
    l.buyer_name || l.name,
    l.buyer_phone || l.phone,
    l.product_inquired || l.productName,
    l.buyer_city || l.city,
    l.query_message || l.requirement,
    l.status,
    l.source
  ].map(sanitizeCell).join(','));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="Leadsy_B2B_Qualified_Leads.csv"');
  res.send([headers.join(','), ...rows].join('\n'));
});

app.post('/api/leads/clear', authenticate, requireConversationAccess, requireRole(['owner', 'admin']), (req, res) => {
  const tenantLeads = db.findScoped('leads', req.organizationId);
  for (const l of tenantLeads) {
    db.delete('leads', l.id);
  }
  res.json({ ok: true, clearedCount: tenantLeads.length });
});

// Public Buyer Enquiry Page (/demo) — Looks like an instant B2B Quote Form
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demo.html'));
});

// Legacy Client Portal Redirect (/client -> /)
app.get('/client', (req, res) => {
  res.redirect(301, '/');
});

// Client Upload Catalog Endpoint (Authenticated Tenant-Scoped)
app.post('/api/upload-catalog', authenticate, requireCatalogManager, async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_DB !== 'true') return res.status(503).json({ ok: false, error: 'File import is not available yet; add products manually.' });
    const { filename, fileBase64, productName, priceRange, keywords } = req.body;
    if (!filename || !fileBase64) {
      return res.status(400).json({ ok: false, error: 'Filename and file data required.' });
    }

    const cleanBase64 = fileBase64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    const { CatalogService } = await import('./src/services/catalogService.js');
    const result = await CatalogService.ingestCatalog(req.organizationId, {
      filename,
      buffer,
      uploadedBy: req.userId
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// AI Catalog Extraction Fallback Endpoint for unstructured text
app.post('/api/catalog/extract-ai', authenticate, requireCatalogManager, async (req, res) => {
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

    const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-lite-latest'];
    for (const m of models) {
      try {
        const convBuyLinkKey = `${organizationId}:${lead?.phone || 'anon'}`;
        const sentBuyLinksForChat = conversationSentBuyLinks.get(convBuyLinkKey) || new Set();
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

// Confirm available call time from Client Dashboard and notify both parties (Tenant-Scoped)
app.post('/api/callbacks/confirm-time', authenticate, requireConversationAccess, async (req, res) => {
  try {
    if (!req.organizationId) {
      return res.status(401).json({ ok: false, error: 'Authentication required with valid organization' });
    }
    const { leadId, confirmedTime } = req.body;
    let targetLead = null;

    if (leadId) {
      let existingLead = leads.find((l) => l.id === leadId);
      if (!existingLead) {
        existingLead = await repository.getLeadById(req.organizationId, leadId) || db.findById('leads', leadId);
      }
      if (!existingLead) {
        return res.status(404).json({ ok: false, error: 'Lead not found.' });
      }

      const leadOrg = existingLead.org_id || existingLead.organization_id;
      if (!leadOrg || leadOrg !== req.organizationId) {
        return res.status(403).json({ ok: false, error: 'Unauthorized: Cannot access lead belonging to another organization.' });
      }
      targetLead = existingLead;
    } else {
      targetLead = leads.find((l) => (l.org_id === req.organizationId || l.organization_id === req.organizationId) && l.callbackStatus === 'awaiting_client_time');
      if (!targetLead) {
        targetLead = db.findOne('leads', (l) => (l.org_id === req.organizationId || l.organization_id === req.organizationId) && l.callbackStatus === 'awaiting_client_time');
      }
    }

    if (!targetLead) {
      return res.status(404).json({ ok: false, error: 'No lead awaiting callback found for this organization.' });
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
app.post('/api/callbacks/request-demo', authenticate, requireConversationAccess, async (req, res) => {
  try {
    if (!req.organizationId) {
      return res.status(401).json({ ok: false, error: 'Authentication required with valid organization' });
    }
    const org = await repository.getOrganizationById(req.organizationId) || db.findById('organizations', req.organizationId) || {};
    const settings = await repository.getAiSettings(req.organizationId) || db.findOne('ai_settings', (s) => s.organization_id === req.organizationId) || {};
    const ownerDigits = normalizePhone(org.owner_alert_number || settings.escalation_phone || config.ownerAlertPhone || '');

    let lead = leads.find((l) => (l.org_id === req.organizationId || l.organization_id === req.organizationId) && normalizePhone(l.phone) !== ownerDigits);
    if (!lead) {
      const dbLead = db.findOne('leads', (l) => (l.org_id === req.organizationId || l.organization_id === req.organizationId) && normalizePhone(l.phone || l.buyer_phone) !== ownerDigits);
      if (dbLead) lead = dbLead;
    }
    if (!lead) {
      lead = {
        id: 'IM-' + Date.now().toString().slice(-6),
        org_id: req.organizationId,
        organization_id: req.organizationId,
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
      db.insert('leads', lead);
    } else {
      lead.callbackStatus = 'awaiting_client_time';
      lead.callbackRequestedAt = new Date().toISOString();
      lead.status = '⏳ Awaiting Client Call Time';
      db.updateScoped('leads', lead.id, req.organizationId, {
        callbackStatus: lead.callbackStatus,
        callbackRequestedAt: lead.callbackRequestedAt,
        status: lead.status
      });
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
    res.json({
      ok: true,
      lead,
      message: ownerDigits
        ? `Demo call request sent to Owner WhatsApp (+${ownerDigits}). Reply to WhatsApp to confirm time!`
        : `Demo lead created. Enter available time below to confirm call.`
    });
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
  const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  addLog(`[Supabase Worker] Initializing Multi-Tenant Realtime & Command Engine (${WORKER_ID})...`);
  // Never rewrite customer organizations or products automatically at startup.

  // 1. Worker Heartbeat Loop (every 20s)
  async function sendHeartbeat() {
    try {
      await supabaseAdmin
        .from('organizations')
        .update({ wa_worker_id: WORKER_ID, wa_worker_heartbeat: new Date().toISOString() })
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

        const session = orgSessions.get(org.id);
        const isConnecting = session && (session.isConnecting || session.state?.status === 'connecting');

        if (hasCreds && !inst.isConnected && !isConnecting) {
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
        // Atomically claim the command so other concurrent workers do not execute it simultaneously
        const { data: claimed, error: claimErr } = await supabaseAdmin
          .from('organizations')
          .update({ wa_command: null, wa_worker_id: WORKER_ID })
          .eq('id', org.id)
          .eq('wa_command', cmd)
          .select();

        if (claimErr || !claimed || claimed.length === 0) {
          continue; // Another worker claimed it first
        }

        addLog(`[Supabase Worker] Executing command '${cmd}' for organization ${org.name || org.id}`);

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
          const msgText = payload.message_text || 'Test message from Leadsy AI';
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
        // Atomically claim the queue item: only transition if status is still pending
        const { data: claimed, error: claimErr } = await supabaseAdmin
          .from('wa_outbound_queue')
          .update({ status: 'processing' })
          .eq('id', item.id)
          .eq('status', 'pending')
          .select();

        if (claimErr || !claimed || claimed.length === 0) {
          continue; // Another worker claimed this item first
        }

        try {
          const targetPhone = normalizeIndianPhone(item.to_phone);
          const res = await baileysManager.sendMessage(
            item.org_id,
            targetPhone,
            item.message_text || '',
            item.pdf_url || null,
            null
          );

          if (res.ok) {
            await supabaseAdmin
              .from('wa_outbound_queue')
              .update({ status: 'sent', error_text: null })
              .eq('id', item.id);
            addLog(`[Supabase Worker] Outbound queue message delivered to +${targetPhone}`);
          } else {
            await supabaseAdmin
              .from('wa_outbound_queue')
              .update({ status: 'failed', error_text: res.error || 'WhatsApp socket not connected for tenant' })
              .eq('id', item.id);
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

// Authenticated local/cloud WhatsApp endpoints scoped to verified tenant
app.get('/api/wa/status', authenticate, requireConversationAccess, (req, res) => {
  const orgId = req.organizationId;
  const inst = baileysManager.getInstance(orgId);
  res.json({ ok: true, state: inst.getState() });
});

app.get('/api/wa/status/:orgId', authenticate, requireConversationAccess, (req, res) => {
  if (req.params.orgId !== req.organizationId && req.role !== 'superadmin') {
    return res.status(403).json({ ok: false, error: 'Unauthorized to view WhatsApp status for another organization.' });
  }
  const inst = baileysManager.getInstance(req.organizationId);
  res.json({ ok: true, state: inst.getState() });
});

app.post('/api/wa/start-qr', authenticate, requireConversationAccess, requireRole(['owner', 'admin']), async (req, res) => {
  const orgId = req.organizationId;
  const inst = baileysManager.getInstance(orgId);
  await inst.init(true);
  res.json({ ok: true, message: 'QR initialization started' });
});

app.post('/api/wa/pair-code', authenticate, requireConversationAccess, requireRole(['owner', 'admin']), async (req, res) => {
  const orgId = req.organizationId;
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: 'Phone number required' });
  const inst = baileysManager.getInstance(orgId);
  try {
    const code = await inst.requestPairing(phone);
    res.json({ ok: true, pairingCode: code });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/wa/disconnect', authenticate, requireConversationAccess, requireRole(['owner', 'admin']), async (req, res) => {
  const orgId = req.organizationId;
  const inst = baileysManager.getInstance(orgId);
  await inst.disconnect();
  res.json({ ok: true, message: 'Session disconnected' });
});

// ==============================================================================
// MULTI-PAGE APPLICATION ROUTES (AUTHENTICATION & ARCHITECTURE SEPARATION)
// ==============================================================================
app.get(['/app', '/app/*', '/dashboard', '/dashboard/*'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get(['/login', '/signup', '/forgot-password'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get(['/admin', '/admin/*', '/superadmin', '/superadmin/*'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'catalog-admin.html'));
});

// SPA Wildcard Route Fallback: serves public/index.html for client routes (Home, Features, Pricing, About, etc.)
app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/catalogs') ||
    req.path.startsWith('/auth_info') ||
    req.path.includes('.')
  ) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = Number(process.env.PORT || 3000);
const server = app.listen(PORT, '0.0.0.0', () => {
  addLog(`Leadsy WhatsApp AI Server running at http://localhost:${PORT}`);
  initCatalogKnowledge();
  initSupabaseWorker();
  // 24-hour background website sync interval (checks hourly)
  const syncIntervalTimer = setInterval(async () => {
    try {
      let orgsWithUrls = [];
      if (supabaseAdmin) {
        const { data } = await supabaseAdmin.from('organizations').select('id, website_knowledge').like('website_knowledge', '%WEBSITE_URL:%');
        if (Array.isArray(data)) orgsWithUrls = data;
      }
      const now = Date.now();
      for (const org of orgsWithUrls) {
        const siteUrl = getOrgWebsiteUrl(org.website_knowledge);
        if (!siteUrl) continue;
        const lastSync = lastOrgWebsiteSync.get(org.id) || 0;
        if (now - lastSync >= 24 * 60 * 60 * 1000) {
          lastOrgWebsiteSync.set(org.id, now);
          addLog(`[Website Sync] Running scheduled 24h product sync for org ${org.id} (${siteUrl})`);
          await syncWebsiteProducts(org.id, siteUrl, null, null);
        }
      }
    } catch (e) {
      addLog(`[Website Sync Worker Error] ${e.message}`);
    }
  }, 60 * 60 * 1000);
  if (typeof syncIntervalTimer.unref === 'function') syncIntervalTimer.unref();

  // 24/7 Cloud Keep-Alive Self-Ping (Runs every 8 mins to prevent cloud host spin-down)
  const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_API_URL || 'https://martflow-whatsapp-ai-sales-agent.onrender.com';
  if (KEEP_ALIVE_URL && KEEP_ALIVE_URL.startsWith('http') && process.env.NODE_ENV !== 'test') {
    const keepAliveTimer = setInterval(async () => {
      try {
        const pingRes = await fetch(KEEP_ALIVE_URL + '/api/health', { signal: AbortSignal.timeout(10000) });
        if (pingRes.ok) {
          addLog('[Keep-Alive] 24/7 ping successful: ' + KEEP_ALIVE_URL + '/api/health');
        }
      } catch (err) {
        // Silent fallback
      }
    }, 8 * 60 * 1000);
    if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref();
  }

  // Auto-resume existing WhatsApp session if auth_info/creds.json already exists!
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    addLog('Saved WhatsApp session detected — auto-reconnecting...');
    startWhatsApp();
  }
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    addLog(`[Server Notice] Port ${PORT} already in use; running in attached/test mode.`);
  } else {
    console.error('Server error:', err.message);
  }
});
