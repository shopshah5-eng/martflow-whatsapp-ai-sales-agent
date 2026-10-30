/**
 * MartFlow AI — Production Multi-Tenant Baileys WhatsApp Session Manager
 * Strict zero-overlap isolation: each organization has its own WASocket instance,
 * dedicated auth state inside auth_info/${orgId}/, independent QR stream,
 * and tenant-scoped AI conversation listener.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import db from '../../db/index.js';
import { AIService } from '../../services/aiService.js';

const BASE_AUTH_DIR = path.join(process.cwd(), 'auth_info');

let cachedBaileysVersion = null;
async function getBaileysVersion() {
  if (cachedBaileysVersion) return cachedBaileysVersion;
  try {
    const v = await fetchLatestBaileysVersion();
    if (v?.version) cachedBaileysVersion = v.version;
  } catch (e) {
    cachedBaileysVersion = [2, 3000, 1015901307];
  }
  return cachedBaileysVersion || [2, 3000, 1015901307];
}

const pdfBufferCache = new Map();
async function getPdfBuffer(url) {
  if (!url) return null;
  if (pdfBufferCache.has(url)) return pdfBufferCache.get(url);
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const arr = await resp.arrayBuffer();
      const buf = Buffer.from(arr);
      pdfBufferCache.set(url, buf);
      return buf;
    }
  } catch (e) {
    console.warn(`[PDF Cache] Failed to load ${url}:`, e.message);
  }
  return null;
}

function normalizeIndianPhone(phone) {
  if (!phone) return '';
  let clean = String(phone).replace(/\D/g, '');
  if (clean.length === 10 && /^[6-9]/.test(clean)) {
    clean = '91' + clean;
  } else if (clean.startsWith('0') && clean.length === 11) {
    clean = '91' + clean.slice(1);
  }
  return clean;
}

let _supabaseAdmin = null;
function getSupabaseAdmin() {
  if (_supabaseAdmin) return _supabaseAdmin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (url && key) {
    _supabaseAdmin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return _supabaseAdmin;
}

export class TenantBaileysInstance {
  constructor(orgId) {
    this.orgId = orgId;
    this.sock = null;
    this.authDir = path.join(BASE_AUTH_DIR, orgId);
    this.state = {
      status: 'disconnected', // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
      qrDataUrl: null,
      connectedNumber: null,
      lastEvent: 'WhatsApp socket offline. Click Connect to pair.',
      logs: []
    };
    this.reconnectTimer = null;
    this.isConnecting = false;
  }

  addLog(msg) {
    const timestamp = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const line = `[${timestamp}] [Org: ${this.orgId.slice(0, 8)}] ${msg}`;
    this.state.logs.unshift(line);
    if (this.state.logs.length > 20) this.state.logs.pop();
    console.log(line);
  }

  normalizeJid(phone) {
    if (!phone) return null;
    const clean = normalizeIndianPhone(phone);
    return clean ? `${clean}@s.whatsapp.net` : null;
  }

  getState() {
    return {
      orgId: this.orgId,
      status: this.state.status,
      connectedNumber: this.state.connectedNumber,
      qrDataUrl: this.state.qrDataUrl,
      lastEvent: this.state.lastEvent,
      logs: this.state.logs
    };
  }

  async init(forceNew = false) {
    if (forceNew) {
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners();
          this.sock.end();
        } catch (e) {}
        this.sock = null;
      }
      this.isConnecting = false;
      this.state.status = 'connecting';
      this.state.qrDataUrl = null;
      try {
        fs.rmSync(this.authDir, { recursive: true, force: true });
      } catch (e) {}
    } else {
      if (this.isConnecting || this.state.status === 'connected') return;
      this.isConnecting = true;
      this.state.status = 'connecting';
    }
    this.state.lastEvent = 'Initializing isolated WhatsApp socket...';

    try {
      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const version = await getBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '120.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
            this.state.status = 'qr_ready';
            this.state.lastEvent = 'Scan QR code with WhatsApp (Linked Devices > Link a Device)';
            this.addLog('Fresh WhatsApp QR code generated. Scan to link device.');
            const admin = getSupabaseAdmin();
            if (admin && this.orgId) {
              await admin
                .from('organizations')
                .update({ wa_status: 'qr_ready', wa_qr_data_url: this.state.qrDataUrl, wa_command: null })
                .eq('id', this.orgId);
            }
          } catch (err) {
            this.addLog(`QR Generation error: ${err.message}`);
          }
        }

        if (connection === 'open') {
          this.isConnecting = false;
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.state.status = 'connected';
          this.state.qrDataUrl = null;
          this.state.pairingCode = null;
          const rawMe = this.sock.user?.id || '';
          this.state.connectedNumber = rawMe.split(':')[0].split('@')[0];
          this.state.lastEvent = `Live & Connected as +${this.state.connectedNumber}`;
          this.addLog(`WhatsApp CONNECTED successfully (+${this.state.connectedNumber})`);
          const admin = getSupabaseAdmin();
          if (admin && this.orgId) {
            await admin
              .from('organizations')
              .update({
                wa_status: 'connected',
                wa_connected_number: this.state.connectedNumber,
                bot_whatsapp_number: this.state.connectedNumber,
                wa_qr_data_url: null,
                wa_pairing_code: null,
                wa_command: null
              })
              .eq('id', this.orgId);
          }
        }

        if (connection === 'close') {
          this.isConnecting = false;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          this.state.qrDataUrl = null;

          if (isLoggedOut) {
            this.state.status = 'disconnected';
            this.state.connectedNumber = null;
            this.state.pairingCode = null;
            this.state.lastEvent = 'Logged out from phone. Click Connect to scan again.';
            this.addLog('Session logged out. Cleared local auth state.');
            try {
              fs.rmSync(this.authDir, { recursive: true, force: true });
            } catch (e) {}
            const admin = getSupabaseAdmin();
            if (admin && this.orgId) {
              await admin
                .from('organizations')
                .update({
                  wa_status: 'disconnected',
                  wa_connected_number: null,
                  wa_qr_data_url: null,
                  wa_pairing_code: null,
                  wa_command: null
                })
                .eq('id', this.orgId);
            }
          } else {
            const isRestart = statusCode === DisconnectReason.restartRequired;
            this.state.status = 'connecting';
            this.state.lastEvent = isRestart
              ? 'Finalizing session handshake...'
              : `Connection interrupted (code: ${statusCode || 'unknown'}). Reconnecting...`;
            
            // Post-scan restart (515) must reconnect IMMEDIATELY (150ms) to finish cryptographic handshake!
            const delay = isRestart ? 150 : 2000;
            this.addLog(`Socket closed (code: ${statusCode}). Reconnecting in ${delay}ms...`);

            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
              this.isConnecting = false;
              this.init(false);
            }, delay);
          }
        }
      });

      // Tenant-isolated inbound WhatsApp message listener
      this.sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const remoteJid = msg.key.remoteJid;
          if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('broadcast')) continue;

          const rawPhone = remoteJid.split('@')[0];
          const phone = rawPhone.replace(/[^0-9]/g, '');

          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            '';

          if (!text) continue;

          this.addLog(`Inbound message from +${phone}: "${text.slice(0, 35)}..."`);

          // Strictly scope lead lookup and mutation to this.orgId
          let lead = db.findOne('leads', (l) =>
            l.organization_id === this.orgId && l.buyer_phone.slice(-10) === phone.slice(-10)
          );

          if (!lead) {
            lead = db.insert('leads', {
              organization_id: this.orgId,
              buyer_name: msg.pushName || 'WhatsApp Buyer',
              buyer_phone: phone,
              status: 'new'
            });
          }

          let conv = db.findOne('conversations', (c) => c.lead_id === lead.id);
          if (!conv) {
            conv = db.insert('conversations', {
              organization_id: this.orgId,
              lead_id: lead.id,
              channel: 'whatsapp',
              mode: 'ai',
              is_unread: true
            });
          }

          // Save inbound message
          db.insert('messages', {
            organization_id: this.orgId,
            conversation_id: conv.id,
            sender_type: 'buyer',
            content: text,
            delivery_status: 'delivered',
            provider_message_id: msg.key.id
          });

          // If conversation is in AI Auto-Pilot mode, generate catalog-grounded reply
          if (conv.mode === 'ai') {
            this.sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});

            const conversationHistory = db.findScoped('messages', this.orgId)
              .filter((m) => m.conversation_id === conv.id)
              .slice(-20);

            AIService.generateSalesReply({
              organizationId: this.orgId,
              lead,
              incomingText: text,
              conversationHistory
            }).then(async (aiReplyObj) => {
              if (aiReplyObj && aiReplyObj.reply) {
                // Send reply immediately — NO artificial wait!
                await this.sock.sendMessage(remoteJid, { text: aiReplyObj.reply });
                this.addLog(`AI Auto-Reply sent to +${phone}: "${aiReplyObj.reply.slice(0, 40)}..."`);
                this.sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});

                // Save message & handle async brochure delivery in background
                db.insert('messages', {
                  organization_id: this.orgId,
                  conversation_id: conv.id,
                  sender_type: 'ai',
                  content: aiReplyObj.reply,
                  delivery_status: 'sent'
                });

                // Sync with Supabase messages & conversations if configured
                const admin = getSupabaseAdmin();
                if (admin && this.orgId) {
                  try {
                    let { data: sbConv } = await admin.from('conversations').select('id').eq('org_id', this.orgId).eq('buyer_phone', phone).maybeSingle();
                    if (!sbConv) {
                      const { data: newSbConv } = await admin.from('conversations').insert({
                        org_id: this.orgId,
                        buyer_phone: phone,
                        mode: 'ai'
                      }).select('id').single();
                      sbConv = newSbConv;
                    }
                    if (sbConv?.id) {
                      await admin.from('messages').insert([
                        { org_id: this.orgId, conversation_id: sbConv.id, sender: 'buyer', text: text },
                        { org_id: this.orgId, conversation_id: sbConv.id, sender: 'ai', text: aiReplyObj.reply }
                      ]);
                      await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', sbConv.id);
                    }
                  } catch (sbMsgErr) {
                    // Non-blocking sync
                  }
                }

                if (aiReplyObj.matchedBrochureUrl) {
                  try {
                    const pdfBuf = await getPdfBuffer(aiReplyObj.matchedBrochureUrl);
                    const docPayload = pdfBuf
                      ? { document: pdfBuf, mimetype: 'application/pdf', fileName: aiReplyObj.matchedBrochureName || 'Catalog.pdf', caption: 'Official Product Brochure & Specifications' }
                      : { document: { url: aiReplyObj.matchedBrochureUrl }, mimetype: 'application/pdf', fileName: aiReplyObj.matchedBrochureName || 'Catalog.pdf', caption: 'Official Product Brochure & Specifications' };
                    await this.sock.sendMessage(remoteJid, docPayload);
                    this.addLog(`PDF Brochure dispatched to +${phone}`);
                  } catch (pdfErr) {
                    this.addLog(`Brochure delivery error: ${pdfErr.message}`);
                  }
                }
              }
            }).catch((err) => {
              this.addLog(`AI Auto-Reply error: ${err.message}`);
            });
          }
        }
      });
    } catch (err) {
      this.isConnecting = false;
      this.state.status = 'disconnected';
      this.state.lastEvent = `Failed to start WhatsApp socket: ${err.message}`;
      this.addLog(`Initialization error: ${err.message}`);
    }
  }

  async sendMessage(toPhone, text, attachmentPath = null, caption = '') {
    if (!this.sock || this.state.status !== 'connected') {
      return { ok: false, error: 'WhatsApp socket is not connected. Please pair via QR code.' };
    }

    const jid = this.normalizeJid(toPhone);
    if (!jid) return { ok: false, error: 'Invalid phone number format.' };

    try {
      this.sock.sendPresenceUpdate('composing', jid).catch(() => {});

      let sentMsg = null;
      if (attachmentPath) {
        if (/^https?:\/\//i.test(attachmentPath)) {
          const fileBuffer = await getPdfBuffer(attachmentPath);
          if (fileBuffer) {
            sentMsg = await this.sock.sendMessage(jid, {
              document: fileBuffer,
              mimetype: 'application/pdf',
              fileName: path.basename(attachmentPath) || 'Brochure.pdf',
              caption: caption || text
            });
          } else {
            sentMsg = await this.sock.sendMessage(jid, { text: caption || text });
          }
        } else if (fs.existsSync(attachmentPath)) {
          const fileBuffer = fs.readFileSync(attachmentPath);
          const ext = path.extname(attachmentPath).toLowerCase();
          const filename = path.basename(attachmentPath);

          if (ext === '.pdf') {
            sentMsg = await this.sock.sendMessage(jid, {
              document: fileBuffer,
              mimetype: 'application/pdf',
              fileName: filename,
              caption: caption || text
            });
          } else if (['.jpg', '.jpeg', '.png'].includes(ext)) {
            sentMsg = await this.sock.sendMessage(jid, {
              image: fileBuffer,
              caption: caption || text
            });
          } else {
            sentMsg = await this.sock.sendMessage(jid, {
              document: fileBuffer,
              fileName: filename,
              caption: caption || text
            });
          }
        } else {
          sentMsg = await this.sock.sendMessage(jid, { text: caption || text });
        }
      } else {
        sentMsg = await this.sock.sendMessage(jid, { text });
      }

      this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
      return { ok: true, messageId: sentMsg?.key?.id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async requestPairing(phoneDigits) {
    const clean = String(phoneDigits || '').replace(/\D/g, '');
    if (!clean || clean.length < 10) {
      throw new Error('Valid phone number with country code is required (e.g. 9198XXXXXXXX)');
    }
    await this.init();
    for (let i = 0; i < 25; i++) {
      if (this.sock && typeof this.sock.requestPairingCode === 'function') break;
      await new Promise(r => setTimeout(r, 200));
    }
    if (!this.sock || typeof this.sock.requestPairingCode !== 'function') {
      throw new Error('WhatsApp engine is initializing, please retry in a few seconds.');
    }
    const rawCode = await this.sock.requestPairingCode(clean);
    const formatted = rawCode ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode;
    this.state.pairingCode = formatted;
    this.state.status = 'code_ready';
    this.state.lastEvent = `Enter code ${formatted} in WhatsApp > Linked Devices > Link with phone number`;
    this.addLog(`8-digit pairing code generated: ${formatted}`);
    const admin = getSupabaseAdmin();
    if (admin && this.orgId) {
      await admin
        .from('organizations')
        .update({ wa_status: 'code_ready', wa_pairing_code: formatted, wa_command: null })
        .eq('id', this.orgId);
    }
    return formatted;
  }

  async disconnect() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (e) {}
      this.sock = null;
    }
    this.state.status = 'disconnected';
    this.state.connectedNumber = null;
    this.state.qrDataUrl = null;
    this.state.pairingCode = null;
    this.state.lastEvent = 'WhatsApp disconnected. Pairing data cleared.';
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch (e) {}
    this.addLog('Disconnected WhatsApp and cleared tenant session keys.');
    const admin = getSupabaseAdmin();
    if (admin && this.orgId) {
      try {
        await admin
          .from('organizations')
          .update({
            wa_status: 'disconnected',
            wa_connected_number: null,
            wa_qr_data_url: null,
            wa_pairing_code: null,
            wa_command: null
          })
          .eq('id', this.orgId);
      } catch (e) {}
    }
    return { ok: true };
  }
}

// Master Multi-Tenant Session Registry
export class MultiTenantBaileysManager {
  constructor() {
    this.instances = new Map(); // orgId -> TenantBaileysInstance
  }

  getInstance(orgId = 'default_org') {
    if (!this.instances.has(orgId)) {
      this.instances.set(orgId, new TenantBaileysInstance(orgId));
    }
    return this.instances.get(orgId);
  }

  async init(orgId = 'default_org', forceNew = false) {
    return this.getInstance(orgId).init(forceNew);
  }

  getState(orgId = 'default_org') {
    return this.getInstance(orgId).getState();
  }

  async sendMessage(orgId = 'default_org', toPhone, text, attachmentPath = null, caption = '') {
    // Handle overload where orgId is omitted: sendMessage(toPhone, text, attachmentPath, caption)
    if (typeof orgId === 'string' && (orgId.startsWith('+') || orgId.length === 10 || /^\d+$/.test(orgId))) {
      return this.getInstance('default_org').sendMessage(orgId, toPhone, text, attachmentPath);
    }
    return this.getInstance(orgId).sendMessage(toPhone, text, attachmentPath, caption);
  }

  async requestPairing(orgId = 'default_org', phoneDigits) {
    return this.getInstance(orgId).requestPairing(phoneDigits);
  }

  async disconnect(orgId = 'default_org') {
    return this.getInstance(orgId).disconnect();
  }
}

export const baileysManager = new MultiTenantBaileysManager();
export default baileysManager;

// Unified Tenant WhatsApp Sender (Meta Cloud API if configured, else isolated Baileys)
export async function sendTenantWhatsApp(orgId, { toPhone, text, pdfBuffer = null, fileName = null, attachmentPath = null }) {
  if (!orgId) throw new Error('orgId is required to send tenant WhatsApp message');
  const org = db.findById('organizations', orgId);

  // 1. Check for Meta WhatsApp Cloud API credentials
  const wabaPhoneId = org?.waba_phone_id;
  const wabaToken = org?.waba_token;

  if (wabaPhoneId && wabaToken) {
    const cleanTo = String(toPhone).replace(/[^0-9]/g, '');
    try {
      let payload;
      if (attachmentPath && fs.existsSync(attachmentPath)) {
        // Upload/send document via Meta Graph API
        payload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'document',
          document: {
            link: `https://martflow.ai/api/catalog/download/${encodeURIComponent(path.basename(attachmentPath))}`,
            caption: text,
            filename: fileName || path.basename(attachmentPath)
          }
        };
      } else {
        payload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'text',
          text: { body: text }
        };
      }

      const resp = await fetch(`https://graph.facebook.com/v21.0/${wabaPhoneId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${wabaToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      return { ok: resp.ok, provider: 'whatsapp_cloud', providerMessageId: data?.messages?.[0]?.id };
    } catch (e) {
      console.warn('Meta Cloud API send failed, falling back to Baileys:', e.message);
    }
  }

  // 2. Default to isolated Baileys socket for this tenant
  return baileysManager.sendMessage(orgId, toPhone, text, attachmentPath, text);
}
