/**
 * MartFlow AI — Dedicated Baileys Multi-Device WhatsApp Socket Manager
 * Handles socket lifecycle, QR generation, Indian number normalization,
 * message streaming, and automatic catalog brochure dispatch.
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

const AUTH_DIR = path.join(process.cwd(), 'auth_info');

export class BaileysManager {
  constructor() {
    this.sock = null;
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
    const line = `[${timestamp}] ${msg}`;
    this.state.logs.unshift(line);
    if (this.state.logs.length > 20) this.state.logs.pop();
    console.log(line);
  }

  // Normalize Indian mobile numbers: 10 digits -> 91XXXXXXXXXX@s.whatsapp.net
  normalizeJid(phone) {
    if (!phone) return null;
    let clean = String(phone).replace(/[^0-9]/g, '');
    if (clean.length === 10) clean = '91' + clean;
    if (clean.startsWith('0')) clean = '91' + clean.slice(1);
    return clean ? `${clean}@s.whatsapp.net` : null;
  }

  getState() {
    return {
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
    this.state.lastEvent = 'Initializing WhatsApp multi-device engine...';

    try {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
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
              fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            } catch (e) {}
          } else {
            const isRestart = statusCode === DisconnectReason.restartRequired;
            this.state.status = 'connecting';
            this.state.lastEvent = isRestart
              ? 'Finalizing session handshake...'
              : `Connection interrupted (code: ${statusCode || 'net'}). Auto-reconnecting...`;
            this.addLog(`Socket closed (code: ${statusCode || 'network'}). Reconnecting in 2s...`);
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.init(), 2000);
          }
        }
      });

      // Handle Inbound WhatsApp Messages
      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const remoteJid = msg.key.remoteJid || '';
          // Ignore status broadcasts and WhatsApp groups
          if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) continue;

          // Resolve sender phone number
          const phone = remoteJid.split('@')[0];
          const text = msg.message.conversation ||
                       msg.message.extendedTextMessage?.text ||
                       msg.message.imageMessage?.caption ||
                       msg.message.audioMessage ? '[Audio Voice Note]' : '';

          if (!text) continue;
          this.addLog(`Inbound WhatsApp message from +${phone}: "${text.slice(0, 40)}"`);

          // Match lead across tenants
          let lead = db.findOne('leads', (l) => l.buyer_phone && l.buyer_phone.endsWith(phone.slice(-10)));
          let orgId = lead ? lead.organization_id : null;

          if (!orgId) {
            const defaultOrg = db.findOne('organizations', () => true);
            orgId = defaultOrg ? defaultOrg.id : null;
          }

          if (orgId) {
            if (!lead) {
              lead = db.insert('leads', {
                organization_id: orgId,
                source: 'WhatsApp Direct Inbound',
                buyer_phone: phone,
                status: 'new'
              });
            }

            let conv = db.findOne('conversations', (c) => c.lead_id === lead.id);
            if (!conv) {
              conv = db.insert('conversations', {
                organization_id: orgId,
                lead_id: lead.id,
                channel: 'whatsapp',
                mode: 'ai',
                is_unread: true
              });
            }

            // Save inbound message
            db.insert('messages', {
              organization_id: orgId,
              conversation_id: conv.id,
              sender_type: 'buyer',
              content: text,
              delivery_status: 'delivered',
              provider_message_id: msg.key.id
            });

            // If conversation is in AI Auto-Pilot mode, generate catalog-grounded reply
            if (conv.mode === 'ai') {
              try {
                // Show human-like typing presence
                await this.sock.sendPresenceUpdate('composing', remoteJid);

                const aiReplyObj = await AIService.generateSalesReply({
                  organizationId: orgId,
                  lead,
                  incomingText: text
                });

                if (aiReplyObj && aiReplyObj.reply) {
                  // Slight realistic delay before sending
                  await new Promise((r) => setTimeout(r, 2000));
                  await this.sock.sendMessage(remoteJid, { text: aiReplyObj.reply });

                  db.insert('messages', {
                    organization_id: orgId,
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
        }
      });

    } catch (err) {
      this.isConnecting = false;
      this.state.status = 'disconnected';
      this.state.lastEvent = `Failed to start WhatsApp socket: ${err.message}`;
      this.addLog(`Initialization error: ${err.message}`);
    }
  }

  // Send Outbound Message via Live Socket
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

  // Disconnect & Clear Session
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
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch (e) {}
    this.addLog('Disconnected WhatsApp and cleared session keys.');
    return { ok: true };
  }
}

export const baileysManager = new BaileysManager();
export default baileysManager;

