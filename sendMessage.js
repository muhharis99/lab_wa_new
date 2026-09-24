const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizePhone(value) {
  let phone = String(value || '').replace(/\D+/g, '');
  if (phone.startsWith('0')) phone = '62' + phone.slice(1);
  return phone;
}

function isValidIndonesianPhone(value) {
  return /^62\d{8,15}$/.test(normalizePhone(value));
}



class WhatsAppManager {
  constructor({ logger = P({ level: process.env.LOG_LEVEL || 'info' }) } = {}) {
    this.logger = logger;
    this.client = null;
    this.state = 'STARTING';
    this.qr = null;
    this.lastError = null;
    this.starting = null;
    this.stopped = false;
    this.sessionPath = path.resolve(process.env.WHATSAPP_SESSION_PATH || './tokens/session01');
    this.clientId = process.env.WHATSAPP_CLIENT_ID || 'lab-wa-gateway';
    this.messageDelay = Number(process.env.MESSAGE_DELAY_MS || 1500);
  }


  getStatus() {
    const ready = this.state === 'READY' && Boolean(this.client);
    return {
      state: this.state,
      ready,
      connected: ready,
      authenticated: ['AUTHENTICATED', 'READY'].includes(this.state),
      qr: this.qr,
      lastError: this.lastError,
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
      const status = this.getStatus();
      if (status.ready || ['CONNECTING', 'AUTHENTICATED', 'QR_REQUIRED'].includes(this.state)) return;
      try { await this.client.destroy(); } catch {}
      this.client = null;
    }

    this.state = 'CONNECTING';
    this.qr = null;
    this.lastError = null;
    this.logger.info('WhatsApp connecting');

    fs.  async initialize() {
    if (this.client) {
      const status = this.getStatus();
      if (status.ready || ['CONNECTING', 'AUTHENTICATED', 'QR_REQUIRED'].includes(this.state)) return;
      try { await this.client.destroy(); } catch {}
      this.client = null;
    }

    this.state = 'CONNECTING';
    this.qr = null;
    this.lastError = null;
    this.logger.info('WhatsApp connecting');

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.clientId,
        dataPath: this.sessionPath,
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      },
    });

    this.client = client;
    this.bindEvents(client);

    try {
      await client.initialize();
    } catch (error) {
      if (this.client === client) {
        this.client = null;
        this.state = 'ERROR';
        this.lastError = error.message || String(error);
      }
      try { await client.destroy(); } catch {}
      throw error;
    }
  }


  bindEvents(client) {
    client.on('qr', (qr) => {
      if (this.client !== client) return;
      this.qr = qr;
      this.state = 'QR_REQUIRED';
      this.lastError = null;
      this.logger.info('WhatsApp QR generated');
      qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
      if (this.client !== client) return;
      this.qr = null;
      this.state = 'AUTHENTICATED';
      this.lastError = null;
      this.logger.info('WhatsApp authenticated');
    });

    client.on('ready', () => {
      if (this.client !== client) return;
      this.qr = null;
      this.state = 'READY';
      this.lastError = null;
      this.reconnectAttempt = 0;
      this.logger.info('WhatsApp gateway READY');
    });

    client.on('auth_failure', (message) => {
      if (this.client !== client) return;
      this.state = 'AUTH_FAILURE';
      this.qr = null;
      this.lastError = String(message || 'Authentication failure');
      this.logger.error({ message }, 'WhatsApp auth failure');
    });

    client.on('disconnected', (reason) => {
      if (this.client !== client) return;
      this.client = null;
      this.qr = null;
      this.state = reason === 'LOGOUT' ? 'LOGGED_OUT' : 'RECONNECTING';
      this.lastError = String(reason || 'Disconnected');
      this.logger.warn({ reason }, 'WhatsApp disconnected');
      if (reason !== 'LOGOUT' && !this.stopped) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.starting) return;
    setTimeout(async () => {
      if (this.stopped) return;
      try {
        await this.start();
      } catch (error) {
        this.lastError = error.message || String(error);
        this.logger.error({ err: error }, 'WhatsApp reconnect failed');
      }
    }, 3000);
  }

  assertReady() {
    if (!this.client || this.state !== 'READY') {
      const error = new Error('WhatsApp belum terhubung. Scan QR terlebih dahulu.');
      error.code = 'WHATSAPP_NOT_READY';
      throw error;
    }
  }


