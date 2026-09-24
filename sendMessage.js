const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizePhone(value) {
  let phone = String(value || '').replace(/\D+/g, '');

  if (phone.startsWith('0')) {
    phone = '62' + phone.slice(1);
  }

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

    // Keep the existing lab_wa_gateway session location.
    this.sessionPath = path.resolve(
      process.env.WHATSAPP_SESSION_PATH || './tokens/session01'
    );
    this.clientId = process.env.WHATSAPP_CLIENT_ID || 'lab-wa-gateway';

    this.messageDelay = Number(process.env.MESSAGE_DELAY_MS || 1500);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.maxReconnectDelay = Number(
      process.env.MAX_RECONNECT_DELAY_MS || 30000
    );
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
      reconnectAttempt: this.reconnectAttempt
    };
  }

  async start() {
    if (this.starting) {
      return this.starting;
    }

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

      if (
        status.ready ||
        ['CONNECTING', 'AUTHENTICATED', 'QR_REQUIRED'].includes(this.state)
      ) {
        return;
      }

      try {
        await this.client.destroy();
      } catch (_) {
      }

      this.client = null;
    }

    this.state = 'CONNECTING';
    this.qr = null;
    this.lastError = null;

    this.logger.info('WhatsApp connecting');

    fs.mkdirSync(this.sessionPath, { recursive: true });

    // Configuration follows bot_wa_ijin_dokter_v2.
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.clientId,
        dataPath: this.sessionPath
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
          '--no-default-browser-check'
        ]
      }
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

      try {
        await client.destroy();
      } catch (_) {
      }

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

      if (reason !== 'LOGOUT' && !this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer || this.starting) {
      return;
    }

    const delayMs = Math.min(
      1000 * 2 ** this.reconnectAttempt,
      this.maxReconnectDelay
    );

    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      if (this.stopped) {
        return;
      }

      try {
        await this.start();
      } catch (error) {
        this.lastError = error.message || String(error);

        this.logger.error(
          { err: error },
          'WhatsApp reconnect failed'
        );

        this.scheduleReconnect();
      }
    }, delayMs);

    this.logger.info(
      { delayMs, attempt: this.reconnectAttempt },
      'WhatsApp reconnect scheduled'
    );
  }

  assertReady() {
    if (!this.client || this.state !== 'READY') {
      const error = new Error(
        'WhatsApp belum terhubung. Scan QR terlebih dahulu.'
      );

      error.code = 'WHATSAPP_NOT_READY';
      throw error;
    }
  }

  async sendText(phone, message) {
    const normalized = normalizePhone(phone);

    if (!isValidIndonesianPhone(normalized)) {
      throw new Error('Format nomor WhatsApp tidak valid.');
    }

    if (typeof message !== 'string' || !message.trim()) {
      throw new Error('Pesan WhatsApp kosong.');
    }

    this.assertReady();

    // Same sending sequence as bot_wa_ijin_dokter_v2:
    // phone -> getNumberId -> sendMessage(numberId._serialized, message)
    const numberId = await this.client.getNumberId(normalized);

    if (!numberId) {
      throw new Error('Nomor tidak terdaftar di WhatsApp.');
    }

    const sent = await this.client.sendMessage(
      numberId._serialized,
      message
    );

    this.logger.info(
      {
        phone: normalized,
        messageId: sent?.id?._serialized || null
      },
      'WhatsApp message sent'
    );

    return {
      phone: normalized,
      messageId: sent?.id?._serialized || null
    };
  }

  async sendPdf(phone, pdfUrl, caption = '') {
    const normalized = normalizePhone(phone);

    if (!isValidIndonesianPhone(normalized)) {
      throw new Error('Format nomor WhatsApp tidak valid.');
    }

    this.assertReady();

    const response = await fetch(pdfUrl);

    if (!response.ok) {
      throw new Error(
        `Gagal mengambil PDF: HTTP ${response.status}`
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > 16 * 1024 * 1024) {
      throw new Error('PDF lebih dari 16MB');
    }

    const numberId = await this.client.getNumberId(normalized);

    if (!numberId) {
      throw new Error('Nomor tidak terdaftar di WhatsApp.');
    }

    const media = new MessageMedia(
      'application/pdf',
      buffer.toString('base64'),
      'Hasil-Pemeriksaan-Laboratorium.pdf'
    );

    const sent = await this.client.sendMessage(
      numberId._serialized,
      media,
      { caption }
    );

    this.logger.info(
      {
        phone: normalized,
        messageId: sent?.id?._serialized || null
      },
      'WhatsApp PDF sent'
    );

    return {
      phone: normalized,
      messageId: sent?.id?._serialized || null
    };
  }

  async sendBulk(numbers, message, delayMs = this.messageDelay) {
    if (!Array.isArray(numbers) || numbers.length === 0) {
      throw new Error(
        'numbers harus array dan tidak boleh kosong'
      );
    }

    this.assertReady();

    const results = [];

    for (const rawNumber of [
      ...new Set(numbers.map((value) => normalizePhone(String(value))))
    ]) {
      try {
        results.push({
          success: true,
          ...(await this.sendText(rawNumber, message))
        });
      } catch (error) {
        results.push({
          success: false,
          phone: rawNumber,
          message: error.message || String(error)
        });

        this.logger.error(
          { err: error, phone: rawNumber },
          'WhatsApp message failed'
        );
      }

      if (delayMs > 0) {
        await delay(delayMs);
      }
    }

    return results;
  }

  async close() {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const client = this.client;
    this.client = null;

    if (client) {
      try {
        await client.destroy();
      } catch (error) {
        this.logger.warn(
          { err: error },
          'WhatsApp client close returned an error'
        );
      }
    }

    this.state = 'STOPPED';
    this.qr = null;
    this.lastError = null;
  }

  async logout() {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const client = this.client;

    this.client = null;
    this.state = 'LOGGED_OUT';
    this.qr = null;
    this.lastError = null;

    if (client) {
      try {
        await client.logout();
      } catch (error) {
        this.logger.warn(
          { err: error },
          'WhatsApp logout returned an error'
        );
      }

      try {
        await client.destroy();
      } catch (_) {
      }
    }

    await delay(300);

    try {
      if (fs.existsSync(this.sessionPath)) {
        fs.rmSync(this.sessionPath, {
          recursive: true,
          force: true
        });
      }
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Could not clear WhatsApp session directory'
      );
    }
  }
}

module.exports = { WhatsAppManager, normalizePhone };
