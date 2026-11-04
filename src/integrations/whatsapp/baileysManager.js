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
import { ConversationMemoryService } from '../../services/conversationMemoryService.js';
import { FollowUpService } from '../../services/followUpService.js';
import {
  backupSessionToSupabase,
  debouncedBackupSession,
  restoreSessionFromSupabase,
  deleteRemoteSession
} from './sessionSync.js';
import {
  getSafeTenantAuthDir,
  getSafeAttachmentBuffer,
  validateSafeIdentifier
} from '../../services/storageSecurity.js';

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
async function getPdfBuffer(orgId, url) {
  if (!url) return null;
  const cacheKey = `${orgId || 'global'}:${url}`;
  if (pdfBufferCache.has(cacheKey)) return pdfBufferCache.get(cacheKey);
  try {
    const { getSafeAttachmentBuffer } = await import('../../services/storageSecurity.js');
    const buf = await getSafeAttachmentBuffer(orgId, url);
    if (buf) {
      pdfBufferCache.set(cacheKey, buf);
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
    this.orgId = validateSafeIdentifier(orgId, 'Organization ID');
    this.sock = null;
    this.authDir = getSafeTenantAuthDir(orgId);
    this.state = {
      status: 'disconnected', // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
      qrDataUrl: null,
      connectedNumber: null,
      lastEvent: 'WhatsApp socket offline. Click Connect to pair.',
      logs: []
    };
    this.reconnectTimer = null;
    this.isConnecting = false;
    this.isConnected = false;
    this.sentPdfs = new Set();
    this.reverseLidMap = new Map([
      ['148004724064491', '919781018975'],
      ['82012517978236', '919463591820'],
      ['99273974743237', '916280844278']
    ]);
  }

  resolvePhoneFromJid(remoteJid, altJid) {
    let raw = (remoteJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    const alt = (altJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    if (alt && alt.length >= 10 && alt.length <= 13) {
      if (raw) this.reverseLidMap.set(raw, alt);
      return alt;
    }
    if (this.reverseLidMap.has(raw)) {
      return this.reverseLidMap.get(raw);
    }
    try {
      const revFile = path.join(this.authDir, `lid-mapping-${raw}_reverse.json`);
      if (fs.existsSync(revFile)) {
        const val = JSON.parse(fs.readFileSync(revFile, 'utf8'));
        if (val) {
          const cleanVal = String(val).replace(/\D/g, '');
          this.reverseLidMap.set(raw, cleanVal);
          return cleanVal;
        }
      }
      if (fs.existsSync(this.authDir)) {
        const files = fs.readdirSync(this.authDir);
        for (const f of files) {
          if (f.startsWith('lid-mapping-') && f.endsWith('.json') && !f.includes('_reverse')) {
            try {
              const content = fs.readFileSync(path.join(this.authDir, f), 'utf8').trim().replace(/["']/g, '');
              if (content === raw) {
                const realPhone = f.replace('lid-mapping-', '').replace('.json', '').replace(/\D/g, '');
                if (realPhone) {
                  this.reverseLidMap.set(raw, realPhone);
                  return realPhone;
                }
              }
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
    if (raw.length === 10 && /^[6-9]/.test(raw)) return '91' + raw;
    return raw;
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
      isConnected: this.isConnected,
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
        } catch (e) { }
        this.sock = null;
      }
      this.isConnecting = false;
      this.state.status = 'connecting';
      this.state.qrDataUrl = null;
      try {
        fs.rmSync(this.authDir, { recursive: true, force: true });
      } catch (e) { }
      try {
        await deleteRemoteSession(this.orgId);
      } catch (e) { }
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

      // If credentials do not exist on disk, pull from Supabase Cloud Storage
      const credsFile = path.join(this.authDir, 'creds.json');
      if (!fs.existsSync(credsFile)) {
        await restoreSessionFromSupabase(this.orgId);
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

      this.sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
          debouncedBackupSession(this.orgId);
        } catch (e) {}
      });

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
          this.isConnected = true;
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
          // Sync fresh connection state to Supabase Cloud Storage
          try {
            await backupSessionToSupabase(this.orgId);
          } catch (e) {}
        }

        if (connection === 'close') {
          this.isConnecting = false;
          this.isConnected = false;
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
            } catch (e) { }
            try {
              await deleteRemoteSession(this.orgId);
            } catch (e) { }
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

          // Resolve WhatsApp multi-device LID (Linked ID) to genuine mobile number
          const altJid = msg.key.remoteJidAlt || msg.key.participant || '';
          let phone = this.resolvePhoneFromJid(remoteJid, altJid);
          if (phone.length === 10 && /^[6-9]/.test(phone)) phone = '91' + phone;

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

          // Supabase sync for lead, conversation & inbound message
          const admin = getSupabaseAdmin();
          let sbConvId = null;
          let quotaAdmitted = true;
          if (admin && this.orgId) {
            try {
              const { data: leadRows, error: leadRpcErr } = await admin.rpc('reserve_and_create_lead', {
                p_org_id: this.orgId,
                p_buyer_phone: phone,
                p_buyer_name: msg.pushName || 'WhatsApp Customer',
                p_query_message: text,
                p_requirement: text,
                p_bypass_quota: false
              });

              if (leadRpcErr) {
                this.addLog(`[Quota/Lead Error] Atomic lead reservation failed: ${leadRpcErr.message}`);
                continue;
              }

              const res = Array.isArray(leadRows) ? leadRows[0] : leadRows;
              const leadId = res ? (res.out_lead_id || res.lead_id) : null;
              if (!leadId) {
                this.addLog(`[Quota/Lead Error] No lead returned from atomic reservation`);
                continue;
              }
              quotaAdmitted = Boolean(res.out_quota_admitted ?? res.quota_admitted);

              let { data: existingConv } = await admin
                .from('conversations')
                .select('id, lead_id, mode')
                .eq('org_id', this.orgId)
                .ilike('buyer_phone', `%${phone.slice(-10)}`)
                .maybeSingle();

              if (!existingConv) {
                const { data: newConv } = await admin.from('conversations').insert({
                  org_id: this.orgId,
                  lead_id: leadId,
                  buyer_phone: phone,
                  mode: 'auto'
                }).select('id, mode').single();
                existingConv = newConv;
              } else if (!existingConv.lead_id && leadId) {
                await admin.from('conversations').update({ lead_id: leadId }).eq('id', existingConv.id);
              }
              // Process inbound message for opt-out keywords ('STOP') and cancel pending follow-up on reply
              FollowUpService.handleInboundMessage(this.orgId, phone, text);
              sbConvId = existingConv?.id;

              if (sbConvId) {
                await admin.from('messages').insert({
                  org_id: this.orgId,
                  conversation_id: sbConvId,
                  sender: 'buyer',
                  text: text
                });
                await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', sbConvId);
              }

              if (existingConv && (existingConv.mode === 'manual' || existingConv.mode === 'human')) {
                this.addLog(`[Manual Mode] Conversation for +${phone} is paused in manual mode.`);
                continue;
              }

              if (!quotaAdmitted) {
                this.addLog(`[Quota Reached] AI reply withheld for organization ${this.orgId}.`);
                continue;
              }
            } catch (syncErr) {
              this.addLog(`Supabase inbound sync error: ${syncErr.message}`);
              if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_DB !== 'true') {
                continue;
              }
            }
          }

          if (conv.mode === 'manual' || conv.mode === 'human') {
            this.addLog(`[Manual Mode] Conversation for +${phone} is paused in manual mode.`);
            continue;
          }

            this.sock.sendPresenceUpdate('composing', remoteJid).catch(() => { });

            // Retrieve latest tenant-scoped messages deterministically in chronological order
            const conversationHistory = await ConversationMemoryService.getRecentHistory(this.orgId, conv.id, 20);

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
                this.sock.sendPresenceUpdate('paused', remoteJid).catch(() => { });

                // Save message & handle async brochure delivery in background
                db.insert('messages', {
                  organization_id: this.orgId,
                  conversation_id: conv.id,
                  sender_type: 'ai',
                  content: aiReplyObj.reply,
                  delivery_status: 'sent'
                });

                // Sync AI reply to Supabase
                if (admin && this.orgId && sbConvId) {
                  try {
                    await admin.from('messages').insert({
                      org_id: this.orgId,
                      conversation_id: sbConvId,
                      sender: 'ai',
                      text: aiReplyObj.reply
                    });
                    await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', sbConvId);
                  } catch (sbMsgErr) {
                    this.addLog(`Supabase AI reply sync error: ${sbMsgErr.message}`);
                  }
                }

                // Product Photo / Image Dispatch
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
                      const imgCaption = aiReplyObj.matchedImageCaption ? `📸 ${aiReplyObj.matchedImageCaption}` : 'Live Product Photo & Machine View';
                      await this.sock.sendMessage(remoteJid, {
                        image: imgSource,
                        caption: imgCaption
                      });
                      this.addLog(`Product photo sent to +${phone}: "${imgCaption}"`);
                    }

                    const imgLogText = `[Product Photo Sent: ${aiReplyObj.matchedImageCaption || 'Image'}]`;
                    db.insert('messages', {
                      organization_id: this.orgId,
                      conversation_id: conv.id,
                      sender_type: 'ai',
                      content: imgLogText,
                      delivery_status: 'sent'
                    });

                    if (admin && this.orgId && sbConvId) {
                      try {
                        await admin.from('messages').insert({
                          org_id: this.orgId,
                          conversation_id: sbConvId,
                          sender: 'ai',
                          text: imgLogText
                        });
                        await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', sbConvId);
                      } catch (e) {}
                    }
                  } catch (imgErr) {
                    this.addLog(`Product photo delivery error: ${imgErr.message}`);
                  }
                }

                const fileName = aiReplyObj.matchedBrochureName || 'Catalog.pdf';
                const pdfKey = `${phone}:${aiReplyObj.matchedBrochureUrl}`;
                const isExplicitResend = /again|dobara|phir\s*se|resend|re-send|mila\s*nahi|open\s*nahi|bhejo\s*phir/i.test(text);

                // Anti-Spam Check: In-memory set, DB lead marked sent, or logged in recent messages
                const hasSentInMemory = this.sentPdfs.has(pdfKey);
                const hasSentInLead = Boolean(lead?.pdf_brochure_sent || lead?.pdfSent);
                const hasSentInHistory = conversationHistory.some(m => (m.content || m.text || '').includes('[Brochure Sent:'));

                const shouldSendPdf = isExplicitResend || (!hasSentInMemory && !hasSentInLead && !hasSentInHistory);

                if (aiReplyObj.matchedBrochureUrl && shouldSendPdf) {
                  try {
                    const pdfBuf = await getPdfBuffer(this.orgId, aiReplyObj.matchedBrochureUrl);
                    if (!pdfBuf) return;
                    const docPayload = { document: pdfBuf, mimetype: 'application/pdf', fileName, caption: 'Official Product Brochure & Specifications' };
                    await this.sock.sendMessage(remoteJid, docPayload);
                    this.sentPdfs.add(pdfKey);
                    this.addLog(`PDF Brochure dispatched to +${phone}`);

                    // Record brochure dispatch event in local and Supabase DB
                    db.update('leads', lead.id, { pdf_brochure_sent: true, pdfSent: true });
                    lead.pdf_brochure_sent = true;
                    lead.pdfSent = true;

                    const brochureMsgText = `[Brochure Sent: ${fileName}]`;
                    db.insert('messages', {
                      organization_id: this.orgId,
                      conversation_id: conv.id,
                      sender_type: 'ai',
                      content: brochureMsgText,
                      delivery_status: 'sent'
                    });

                    if (admin && this.orgId && sbConvId) {
                      try {
                        await admin.from('messages').insert({
                          org_id: this.orgId,
                          conversation_id: sbConvId,
                          sender: 'ai',
                          text: brochureMsgText
                        });
                        await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', sbConvId);
                      } catch (e) {}
                    }
                  } catch (pdfErr) {
                    this.addLog(`Brochure delivery error: ${pdfErr.message}`);
                  }
                }
              }
            }).catch((err) => {
              this.addLog(`AI Auto-Reply error: ${err.message}`);
            });
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
      this.sock.sendPresenceUpdate('composing', jid).catch(() => { });

      let sentMsg = null;
      if (attachmentPath) {
        let fileBuffer = null;
        try {
          fileBuffer = await getSafeAttachmentBuffer(this.orgId, attachmentPath);
        } catch (bufErr) {
          console.warn(`[Attachment Security] Rejected attachment "${attachmentPath}":`, bufErr.message);
        }

        if (fileBuffer) {
          const ext = path.extname(attachmentPath).toLowerCase();
          const filename = path.basename(attachmentPath) || 'Brochure.pdf';

          if (['.jpg', '.jpeg', '.png'].includes(ext)) {
            sentMsg = await this.sock.sendMessage(jid, {
              image: fileBuffer,
              caption: caption || text
            });
          } else {
            sentMsg = await this.sock.sendMessage(jid, {
              document: fileBuffer,
              mimetype: ext === '.pdf' ? 'application/pdf' : 'application/octet-stream',
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

      this.sock.sendPresenceUpdate('paused', jid).catch(() => { });
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
    let rawCode = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      if (!this.sock || typeof this.sock.requestPairingCode !== 'function') {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      try {
        rawCode = await this.sock.requestPairingCode(clean);
        if (rawCode) break;
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    if (!rawCode) {
      throw new Error(lastErr?.message || 'WhatsApp engine is initializing, please retry in a few seconds.');
    }
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
    this.isConnected = false;
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (e) { }
      this.sock = null;
    }
    this.state.status = 'disconnected';
    this.state.connectedNumber = null;
    this.state.qrDataUrl = null;
    this.state.pairingCode = null;
    this.state.lastEvent = 'WhatsApp disconnected. Pairing data cleared.';
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch (e) { }
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
      } catch (e) { }
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

  isConnected(orgId = 'default_org') {
    return !!this.getInstance(orgId).isConnected;
  }

  async sendMessage(orgId, toPhone, text, attachmentPath = null, caption = '') {
    if (!orgId || typeof orgId !== 'string') {
      throw new Error('Tenant organization ID is strictly required to route WhatsApp messages.');
    }
    const cleanOrgId = validateSafeIdentifier(orgId, 'Organization ID');
    return this.getInstance(cleanOrgId).sendMessage(toPhone, text, attachmentPath, caption);
  }

  async requestPairing(orgId, phoneDigits) {
    if (!orgId) throw new Error('Tenant organization ID is required.');
    const cleanOrgId = validateSafeIdentifier(orgId, 'Organization ID');
    return this.getInstance(cleanOrgId).requestPairing(phoneDigits);
  }

  async disconnect(orgId) {
    if (!orgId) throw new Error('Tenant organization ID is required.');
    const cleanOrgId = validateSafeIdentifier(orgId, 'Organization ID');
    return this.getInstance(cleanOrgId).disconnect();
  }
}

export const baileysManager = new MultiTenantBaileysManager();
export default baileysManager;

// Unified Tenant WhatsApp Sender (Meta Cloud API if configured, else isolated Baileys)
export async function sendTenantWhatsApp(orgId, { toPhone, text, pdfBuffer = null, fileName = null, attachmentPath = null }) {
  if (!orgId) throw new Error('orgId is required to send tenant WhatsApp message');
  const cleanOrgId = validateSafeIdentifier(orgId, 'Organization ID');
  const org = db.findById('organizations', cleanOrgId);

  // 1. Check for Meta WhatsApp Cloud API credentials
  const wabaPhoneId = org?.waba_phone_id;
  const wabaToken = org?.waba_token;

  if (wabaPhoneId && wabaToken) {
    const cleanTo = String(toPhone).replace(/[^0-9]/g, '');
    try {
      let payload;
      let mediaId = null;

      if (attachmentPath) {
        const fileBuffer = await getSafeAttachmentBuffer(cleanOrgId, attachmentPath);
        if (fileBuffer) {
          const formData = new FormData();
          formData.append('messaging_product', 'whatsapp');
          formData.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), fileName || path.basename(attachmentPath));
          formData.append('type', 'application/pdf');

          const uploadResp = await fetch(`https://graph.facebook.com/v21.0/${wabaPhoneId}/media`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${wabaToken}` },
            body: formData
          });
          const uploadData = await uploadResp.json();
          mediaId = uploadData?.id || null;
        }
      }

      if (mediaId) {
        payload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'document',
          document: {
            id: mediaId,
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
  return baileysManager.sendMessage(cleanOrgId, toPhone, text, attachmentPath);
}
