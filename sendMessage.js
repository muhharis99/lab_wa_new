const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizePhone(input) {
  if (typeof input !== 'string') throw new Error('Nomor WhatsApp harus berupa string');
  let value = input.trim().replace(/\D/g, '');
  if (value.startsWith('0')) value = `62${value.slice(1)}`;
  else if (value.startsWith('8')) value = `62${value}`;
  if (!/^62\d{8,14}$/.test(value)) throw new Error('Format nomor WhatsApp tidak valid');
  return value;
}

class WhatsAppManager {
  constructor({ logger = P({ level: process.env.LOG_LEVEL || 'info' }) } = {}) {
    this.logger = logger;
    this.client = null;
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
    this.messageDelay = Number(process.env.MESSAGE_DELAY_MS || 1500);
    this.readyTimeout = Number(process.env.READY_TIMEOUT_MS || 60000);
    this.eventBound = false;
  }

  getStatus() {
    return {
      state: this.state,
      connected: this.connected,
      ready: this.ready,
      authenticated: this.authenticated,
      qr: this.qr,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  async start() {
    if (this.starting) return this.starting;
    this.stopped = false;
    this.starting = this.initialize();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async initialize() {
    if (this.client) {
      if (this.ready || this.state === 'CONNECTING' || this.state === 'AUTHENTICATED' || this.state === 'QR_REQUIRED') return;
      try { await this.client.destroy(); } catch {}
      this.client = null;
    }

    this.state = 'CONNECTING';
    this.qr = null;
    this.connected = false;
    this.ready = false;
    this.logger.info('WhatsApp connecting');

    fs.mkdirSync(this.sessionPath, { recursive: true });
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionPath }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
        ],
      },
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
    });

    this.client = client;
    this.bindEvents(client);
    await client.initialize();
  }

  bindEvents(client) {
    if (this.eventBound) this.eventBound = false;
    this.eventBound = true;

    client.on('qr', (qr) => {
      if (this.client !== client) return;
      this.qr = qr;
      this.authenticated = false;
      this.connected = false;
      this.ready = false;
      this.state = 'QR_REQUIRED';
      this.logger.info('WhatsApp QR generated');
      qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
      if (this.client !== client) return;
      this.qr = null;
      this.authenticated = true;
      this.state = 'AUTHENTICATED';
      this.logger.info('WhatsApp authenticated');
    });

    client.on('ready', () => {
      if (this.client !== client) return;
      this.qr = null;
      this.authenticated = true;
      this.connected = true;
      this.ready = true;
      this.state = 'READY';
      this.reconnectAttempt = 0;
      this.logger.info('WhatsApp CONNECTED & READY');
    });

    client.on('auth_failure', (message) => {
      if (this.client !== client) return;
      this.authenticated = false;
      this.connected = false;
      this.ready = false;
      this.state = 'ERROR';
      this.logger.error({ message }, 'WhatsApp authentication failure');
    });

    client.on('disconnected', (reason) => {
      if (this.client !== client) return;
      this.connected = false;
      this.ready = false;
      this.state = reason === 'LOGOUT' ? 'LOGGED_OUT' : 'RECONNECTING';
      this.logger.warn({ reason }, 'WhatsApp disconnected');
      this.client = null;
      if (reason === 'LOGOUT' || this.stopped) return;
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer || this.starting) return;
    const delayMs = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelay);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      try {
        await this.start();
      } catch (error) {
        this.logger.error({ err: error }, 'WhatsApp reconnect failed');
        this.scheduleReconnect();
      }
    }, delayMs);
    this.logger.info({ delayMs, attempt: this.reconnectAttempt }, 'WhatsApp reconnect scheduled');
  }

  assertReady() {
    if (!this.client || !this.connected || !this.ready || this.state !== 'READY') {
      const error = new Error('WhatsApp is not ready');
      error.code = 'WHATSAPP_NOT_READY';
      throw error;
    }
  }

  async sendText(phone, message) {
    const normalized = normalizePhone(phone);
    if (typeof message !== 'string' || !message.trim()) throw new Error('Message wajib diisi');
    this.assertReady();
    const chatId = `${normalized}@c.us`;
    const sent = await this.client.sendMessage(chatId, message, { sendSeen: false });
    return { phone: normalized, messageId: sent?.id?.id || null };
  }

  async sendPdf(phone, pdfUrl, caption = '') {
    const normalized = normalizePhone(phone);
    this.assertReady();
    const response = await fetch(pdfUrl);
    if (!response.ok) throw new Error(`Gagal mengambil PDF: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 16 * 1024 * 1024) throw new Error('PDF lebih dari 16MB');
    const media = new MessageMedia('application/pdf', buffer.toString('base64'), 'Hasil-Lab.pdf');
    const sent = await this.client.sendMessage(`${normalized}@c.us`, media, { caption, sendSeen: false });
    return { phone: normalized, messageId: sent?.id?.id || null };
  }

  async sendBulk(numbers, message, delayMs = this.messageDelay) {
    this.assertReady();
    if (!Array.isArray(numbers) || numbers.length === 0) throw new Error('numbers harus array dan tidak boleh kosong');
    const list = [...new Set(numbers.map((number) => normalizePhone(String(number))))];
    const results = [];
    for (const phone of list) {
      try {
        results.push({ success: true, ...(await this.sendText(phone, message)) });
      } catch (error) {
        results.push({ success: false, phone, message: error.message });
        this.logger.error({ err: error, phone }, 'WhatsApp message failed');
      }
      if (delayMs > 0) await delay(delayMs);
    }
    return results;
  }

  async logout() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    this.connected = false;
    this.ready = false;
    this.authenticated = false;
    this.qr = null;
    this.state = 'LOGGED_OUT';
    if (client) {
      try { await client.logout(); } catch (error) { this.logger.warn({ err: error }, 'WhatsApp logout returned an error'); }
      try { await client.destroy(); } catch {}
    }
    await delay(300);
    try {
      if (fs.existsSync(this.sessionPath)) fs.rmSync(this.sessionPath, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not clear WhatsApp session directory');
    }
  }
}

module.exports = { WhatsAppManager, normalizePhone };
