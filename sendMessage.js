const path = require('path');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const { Boom } = require('@hapi/boom');
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
} = baileys;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizePhone(input) {
  if (typeof input !== 'string') throw new Error('Nomor WhatsApp harus berupa string');
  let value = input.trim().replace(/[^0-9+]/g, '');
  if (value.startsWith('+')) value = value.slice(1);
  if (value.startsWith('0')) value = `62${value.slice(1)}`;
  else if (value.startsWith('8')) value = `62${value}`;
  if (!/^62\d{8,14}$/.test(value)) throw new Error('Format nomor WhatsApp tidak valid');
  return value;
}

class WhatsAppManager {
  constructor({ logger = P({ level: process.env.LOG_LEVEL || 'info' }) } = {}) {
    this.logger = logger;
    this.sock = null;
    this.state = 'DISCONNECTED';
    this.qr = null;
    this.authenticated = false;
    this.connected = false;
    this.ready = false;
    this.starting = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.stopped = false;
    this.sessionPath = path.resolve(process.env.WHATSAPP_SESSION_PATH || './tokens/session01');
    this.maxReconnectDelay = Number(process.env.MAX_RECONNECT_DELAY_MS || 30000);
  }

  getStatus() {
    return { state: this.state, connected: this.connected, ready: this.ready, authenticated: this.authenticated, qr: this.qr, sessionPath: this.sessionPath, reconnectAttempt: this.reconnectAttempt };
  }

  async start() {
    if (this.starting) return this.starting;
    this.stopped = false;
    this.starting = this.connect();
    try { await this.starting; } finally { this.starting = null; }
  }

  async connect() {
    if (this.stopped) return;
    if (this.sock && (this.connected || this.state === 'CONNECTING' || this.state === 'AUTHENTICATED')) return;
    this.state = 'CONNECTING'; this.connected = false; this.ready = false; this.qr = null;
    this.logger.info('WhatsApp connecting');

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
    const logger = P({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });
    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: Number(process.env.CONNECT_TIMEOUT_MS || 60000),
      defaultQueryTimeoutMs: Number(process.env.QUERY_TIMEOUT_MS || 60000),
    });

    this.sock = sock;
    this.authenticated = Boolean(state.creds.registered);
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => this.handleConnectionUpdate(sock, update));
    if (state.creds.registered) { this.state = 'AUTHENTICATED'; this.logger.info('WhatsApp session restored'); }
  }

  handleConnectionUpdate(sock, update) {
    if (this.sock !== sock) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr) { this.qr = qr; this.authenticated = false; this.connected = false; this.ready = false; this.state = 'QR_REQUIRED'; this.logger.info('WhatsApp QR generated'); qrcode.generate(qr, { small: true }); }
    if (connection === 'connecting') { this.state = 'CONNECTING'; this.connected = false; this.ready = false; this.logger.info('WhatsApp connecting'); }
    if (connection === 'open') { this.qr = null; this.authenticated = true; this.connected = true; this.ready = true; this.state = 'READY'; this.reconnectAttempt = 0; this.logger.info('WhatsApp CONNECTED & READY'); return; }
    if (connection === 'close') {
      this.connected = false; this.ready = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      if (loggedOut) { this.authenticated = false; this.state = 'LOGGED_OUT'; this.qr = null; this.logger.warn({ statusCode }, 'WhatsApp logged out'); return; }
      this.state = 'RECONNECTING'; this.logger.warn({ statusCode }, 'WhatsApp connection closed'); this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer || this.starting) return;
    const delayMs = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelay);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(async () => { this.reconnectTimer = null; if (this.stopped) return; try { await this.start(); } catch (error) { this.logger.error({ err: error }, 'WhatsApp reconnect failed'); this.scheduleReconnect(); } }, delayMs);
    this.logger.info({ delayMs, attempt: this.reconnectAttempt }, 'WhatsApp reconnect scheduled');
  }

  assertReady() {
    if (!this.sock || !this.connected || !this.ready || this.state !== 'READY') { const error = new Error('WhatsApp is not ready'); error.code = 'WHATSAPP_NOT_READY'; throw error; }
  }

  async sendText(phone, message) {
    const normalized = normalizePhone(phone);
    if (typeof message !== 'string' || !message.trim()) throw new Error('Message wajib diisi');
    this.assertReady();
    const jid = jidNormalizedUser(`${normalized}@s.whatsapp.net`);
    const result = await this.sock.sendMessage(jid, { text: message });
    this.logger.info({ phone: normalized }, 'WhatsApp message sent');
    return { phone: normalized, messageId: result?.key?.id || null };
  }

  async sendBulk(numbers, message, delayMs = Number(process.env.MESSAGE_DELAY_MS || 1500)) {
    this.assertReady();
    const list = [...new Set(numbers.map((number) => normalizePhone(String(number))))];
    const results = [];
    for (const phone of list) {
      try { results.push({ success: true, ...(await this.sendText(phone, message)) }); }
      catch (error) { results.push({ success: false, phone, message: error.message }); this.logger.error({ err: error, phone }, 'WhatsApp message failed'); }
      if (delayMs > 0) await delay(delayMs);
    }
    return results;
  }

  async logout() {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const sock = this.sock; this.sock = null; this.connected = false; this.ready = false; this.authenticated = false; this.qr = null; this.state = 'LOGGED_OUT';
    if (sock) { try { await sock.logout(); } catch (error) { this.logger.warn({ err: error }, 'WhatsApp logout returned an error'); } }
  }
}

module.exports = { WhatsAppManager, normalizePhone };
