/**
 * MartFlow AI — Production Multi-Tenant Baileys WhatsApp Session Manager
 * Strict zero-overlap isolation: each organization has its own WASocket instance,
 * dedicated auth state inside auth_info/${orgId}/, independent QR stream,
 * and tenant-scoped AI conversation listener.
 */

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
import db from '../../db/index.js';
import { AIService } from '../../services/aiService.js';

const BASE_AUTH_DIR = path.join(process.cwd(), 'auth_info');

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
    let clean = String(phone).replace(/[^0-9]/g, '');
    if (clean.length === 10) clean = '91' + clean;
    if (clean.startsWith('0')) clean = '91' + clean.slice(1);
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

  async init() {
    if (this.isConnecting || this.state.status === 'connected') return;
    this.isConnecting = true;
    this.state.status = 'connecting';
    this.state.lastEvent = 'Initializing isolated WhatsApp socket...';

    try {
      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      let version = [2, 3000, 1015901307];
      try {
        const v = await fetchLatestBaileysVersion();
        if (v?.version) version = v.version;
      } catch (e) {
        // use fallback version
      }

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.windows('Chrome'),
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
          } catch (err) {
            this.addLog(`QR Generation error: ${err.message}`);
          }
        }

        if (connection === 'open') {
          this.isConnecting = false;
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.state.status = 'connected';
          this.state.qrDataUrl = null;
          const rawMe = this.sock.user?.id || '';
          this.state.connectedNumber = rawMe.split(':')[0].split('@')[0];
          this.state.lastEvent = `Live & Connected as +${this.state.connectedNumber}`;
          this.addLog(`WhatsApp CONNECTED successfully (+${this.state.connectedNumber})`);
        }

        if (connection === 'close') {
          this.isConnecting = false;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          this.state.qrDataUrl = null;

          if (isLoggedOut) {
            this.state.status = 'disconnected';
            this.state.connectedNumber = null;
            this.state.lastEvent = 'Logged out from phone. Click Connect to scan again.';
            this.addLog('Session logged out. Cleared local auth state.');
            try {
              fs.rmSync(this.authDir, { recursive: true, force: true });
            } catch (e) {}
          } else {
            const isRestart = statusCode === DisconnectReason.restartRequired;
            this.state.status = 'connecting';
            this.state.lastEvent = isRestart
              ? 'Finalizing session handshake...'
              : `Connection interrupted (code: ${statusCode || 'unknown'}). Reconnecting...`;
            this.addLog(`Socket dropped. Attempting reconnect in 5s...`);

            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
              this.isConnecting = false;
              this.init();
            }, 5000);
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
            try {
              await this.sock.sendPresenceUpdate('composing', remoteJid);

              const aiReplyObj = await AIService.generateSalesReply({
                organizationId: this.orgId,
                lead,
                incomingText: text
              });

              if (aiReplyObj && aiReplyObj.reply) {
                await new Promise((r) => setTimeout(r, 2000));
                await this.sock.sendMessage(remoteJid, { text: aiReplyObj.reply });

                db.insert('messages', {
                  organization_id: this.orgId,
                  conversation_id: conv.id,
                  sender_type: 'ai',
                  content: aiReplyObj.reply,
                  delivery_status: 'sent'
                });

                this.addLog(`AI Auto-Reply sent to +${phone}: "${aiReplyObj.reply.slice(0, 40)}..."`);
              }
            } catch (err) {
              this.addLog(`AI Auto-Reply error: ${err.message}`);
            } finally {
              try {
                await this.sock.sendPresenceUpdate('paused', remoteJid);
              } catch (e) {}
            }
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
      await this.sock.sendPresenceUpdate('composing', jid);

      let sentMsg = null;
      if (attachmentPath && fs.existsSync(attachmentPath)) {
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
        sentMsg = await this.sock.sendMessage(jid, { text });
      }

      await this.sock.sendPresenceUpdate('paused', jid);
      return { ok: true, messageId: sentMsg?.key?.id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
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
    this.state.lastEvent = 'WhatsApp disconnected. Pairing data cleared.';
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch (e) {}
    this.addLog('Disconnected WhatsApp and cleared tenant session keys.');
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

  async init(orgId = 'default_org') {
    return this.getInstance(orgId).init();
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
