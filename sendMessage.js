const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
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

function isBrowserAlreadyRunningError(error) {
  return /The browser is already running for/i.test(String(error?.message || error));
}

function getChromiumLockFiles(userDataDir) {
  return [
    'SingletonCookie',
    'SingletonLock',
    'SingletonSocket',
  ].map((name) => path.join(userDataDir, name));
}

function removeStaleChromiumLocks(userDataDir, logger) {
  if (!fs.existsSync(userDataDir)) return;

  for (const file of getChromiumLockFiles(userDataDir)) {
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        logger.warn({ file }, 'Removed stale Chromium profile lock');
      }
    } catch (error) {
      logger.warn({ file, err: error }, 'Could not remove Chromium profile lock');
    }
  }
}

function terminateChromiumUsingProfile(userDataDir, logger) {
  if (process.platform !== 'win32' || !userDataDir) return Promise.resolve();

  const normalizedProfile = path.resolve(userDataDir).replace(/\\/g, '\\\\');
  const command = [
    '$profile = [IO.Path]::GetFullPath(\'' + normalizedProfile.replace(/'/g, "''") + '\');',
    '$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("chrome.exe","chromium.exe","msedge.exe") -and $_.CommandLine -and $_.CommandLine -like ("*" + $profile + "*") };',
    '$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }'
  ].join(' ');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: 10000 },
      (error, stdout) => {
        if (error) {
          logger.warn({ err: error, userDataDir }, 'Could not inspect/terminate Chromium profile process');
        }
        const pids = String(stdout || '').trim();
        if (pids) logger.warn({ userDataDir, pids }, 'Terminated Chromium process holding WhatsApp profile');
        resolve();
      }
    );
  });
}

class WhatsAppManager {
  constructor({ logger = P({ level: process.env.LOG_LEVEL || 'info' }) } = {}) {
    this.logger = logger;
    this.client = null;
    this.state = 'STARTING';
    this.qr = null;
    this.lastError = null;
    this.starting = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.stopped = false;
    this.sessionPath = path.resolve(process.env.WHATSAPP_SESSION_PATH || './tokens/session01');
    this.clientId = process.env.WHATSAPP_CLIENT_ID || 'lab-wa-gateway';
    this.browserProfilePath = path.join(this.sessionPath, `session-${this.clientId}`);
    this.messageDelay = Number(process.env.MESSAGE_DELAY_MS || 1500);
    this.maxReconnectDelay = Number(process.env.MAX_RECONNECT_DELAY_MS || 30000);
    this.chromiumLockRetryCount = Number(process.env.CHROMIUM_LOCK_RETRY_COUNT || 1);
    this.initializeTimeoutMs = Number(process.env.WHATSAPP_INIT_TIMEOUT_MS || 120000);
    this.readyProbePromise = null;
    this.readyProbeTimeoutMs = Number(process.env.WHATSAPP_READY_PROBE_TIMEOUT_MS || 15000);
    this.socketHealthyCheckTimeoutMs = Number(process.env.WHATSAPP_SOCKET_CHECK_TIMEOUT_MS || 5000);
    this.restarting = null;
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

    fs.mkdirSync(this.sessionPath, { recursive: true });

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.clientId,
        dataPath: this.sessionPath,
      }),
      puppeteer: {
        headless: 'new',
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
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      },
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
    });

    this.client = client;
    this.bindEvents(client);

    let initialized = false;
    let lastError = null;

    for (let attempt = 0; attempt <= this.chromiumLockRetryCount; attempt += 1) {
      try {
        await Promise.race([
          client.initialize(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`WhatsApp initialization timeout after ${this.initializeTimeoutMs} ms`)),
              this.initializeTimeoutMs
            )
          ),
        ]);
        initialized = true;
        break;
      } catch (error) {
        lastError = error;

        if (!isBrowserAlreadyRunningError(error) || attempt >= this.chromiumLockRetryCount) {
          break;
        }

        this.logger.warn(
          { attempt: attempt + 1, sessionPath: this.sessionPath },
          'Chromium profile appears locked; cleaning stale lock files and retrying'
        );

        // LocalAuth uses session-<clientId> as Puppeteer's actual userDataDir.
        // Clean that profile, not the parent session directory.
        try { await client.destroy(); } catch {}
        await terminateChromiumUsingProfile(this.browserProfilePath, this.logger);
        removeStaleChromiumLocks(this.browserProfilePath, this.logger);
        await delay(700);
      }
    }

    if (!initialized) {
      // Important: client.initialize() may have started Chromium before failing.
      // Always destroy that client here, otherwise its Chrome process can keep
      // session-lab-wa-gateway locked and every reconnect will fail with
      // "The browser is already running".
      try {
        await client.destroy();
      } catch (destroyError) {
        this.logger.warn({ err: destroyError }, 'Could not destroy failed WhatsApp client');
      }
      await terminateChromiumUsingProfile(this.browserProfilePath, this.logger);

      if (this.client === client) {
        this.client = null;
        this.state = 'ERROR';
        this.lastError = lastError?.message || String(lastError);
      }

      throw lastError || new Error('WhatsApp client failed to initialize.');
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
      void this.probeReady(client);
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
    if (this.stopped || this.reconnectTimer || this.starting) return;
    const delayMs = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelay);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      try {
        await this.start();
      } catch (error) {
        this.lastError = error.message || String(error);
        this.logger.error({ err: error }, 'WhatsApp reconnect failed');
        this.scheduleReconnect();
      }
    }, delayMs);
    this.logger.info({ delayMs, attempt: this.reconnectAttempt }, 'WhatsApp reconnect scheduled');
  }

  async probeReady(client, timeoutMs = this.readyProbeTimeoutMs) {
    if (this.client !== client) return false;
    if (this.state === 'READY') return true;
    if (this.readyProbePromise) return this.readyProbePromise;

    this.readyProbePromise = (async () => {
      const deadline = Date.now() + timeoutMs;

      while (this.client === client && Date.now() < deadline) {
        try {
          const pageReady = await client.pupPage?.evaluate(() => {
            const hasWWebJS = typeof window.WWebJS !== 'undefined';
            let hasCollections = false;

            try {
              hasCollections = Boolean(
                window.require &&
                window.require('WAWebCollections') &&
                window.require('WAWebCollections').Msg
              );
            } catch (_) {}

            let socket = null;
            try {
              const socketModel = window.require('WAWebSocketModel');
              const s = socketModel?.Socket;
              socket = {
                state: s?.state ?? null,
                stream: s?.stream ?? null,
                wsReadyState: s?.socket?.readyState ?? null,
                hasSynced: s?.hasSynced ?? null,
              };
            } catch (_) {}

            return { hasWWebJS, hasCollections, socket };
          });

          const socketOpen =
            pageReady?.socket?.wsReadyState === 1 ||
            pageReady?.socket?.wsReadyState === null;

          const connectedEnough =
            pageReady?.hasWWebJS &&
            pageReady?.hasCollections &&
            pageReady?.socket &&
            pageReady.socket.state !== 'OPENING' &&
            pageReady.socket.stream !== 'DISCONNECTED' &&
            socketOpen;

          if (connectedEnough) {
            this.qr = null;
            this.state = 'READY';
            this.lastError = null;
            this.reconnectAttempt = 0;
            this.logger.info({ socket: pageReady.socket }, 'WhatsApp gateway READY (page probe)');
            return true;
          }
        } catch (error) {
          this.logger.debug({ err: error }, 'WhatsApp ready probe pending');
        }

        await delay(250);
      }

      return this.client === client && this.state === 'READY';
    })();

    try {
      return await this.readyProbePromise;
    } finally {
      this.readyProbePromise = null;
    }
  }

  async getSocketHealth(client = this.client) {
    if (!client?.pupPage) {
      return { healthy: false, reason: 'NO_PAGE', state: null, stream: null, wsReadyState: null };
    }

    try {
      const info = await Promise.race([
        client.pupPage.evaluate(() => {
          try {
            const socketModel = window.require('WAWebSocketModel');
            const socket = socketModel?.Socket;
            const ws = socket?.socket;

            return {
              state: socket?.state ?? null,
              stream: socket?.stream ?? null,
              wsReadyState: ws?.readyState ?? null,
              hasSynced: socket?.hasSynced ?? null,
            };
          } catch (error) {
            return {
              state: null,
              stream: null,
              wsReadyState: null,
              hasSynced: null,
              error: String(error?.message || error),
            };
          }
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Socket health check timeout')), this.socketHealthyCheckTimeoutMs)
        ),
      ]);

      const healthy =
        info?.state === 'CONNECTED' &&
        info?.stream !== 'DISCONNECTED' &&
        (info?.wsReadyState === 1 || info?.wsReadyState === null);

      return { ...info, healthy };
    } catch (error) {
      return {
        healthy: false,
        reason: error.message || String(error),
        state: null,
        stream: null,
        wsReadyState: null,
      };
    }
  }

  async restartClient(reason = 'unhealthy WhatsApp socket') {
    if (this.restarting) return this.restarting;

    this.restarting = (async () => {
      this.logger.warn({ reason }, 'Restarting WhatsApp client');
      this.stopped = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      const oldClient = this.client;
      this.client = null;
      this.qr = null;
      this.state = 'RECONNECTING';

      if (oldClient) {
        try { await oldClient.destroy(); } catch (error) {
          this.logger.warn({ err: error }, 'Could not destroy unhealthy WhatsApp client');
        }
      }

      await terminateChromiumUsingProfile(this.browserProfilePath, this.logger);
      removeStaleChromiumLocks(this.browserProfilePath, this.logger);
      await delay(500);

      try {
        await this.start();
        return this.client;
      } catch (error) {
        this.logger.error({ err: error }, 'WhatsApp restart failed');
        throw error;
      }
    })();

    try {
      return await this.restarting;
    } finally {
      this.restarting = null;
    }
  }

  async ensureSocketHealthy() {
    if (!this.client) {
      await this.start();
      return;
    }

    const health = await this.getSocketHealth(this.client);
    if (health.healthy) {
      if (this.state !== 'READY') {
        this.state = 'READY';
        this.logger.info({ health }, 'WhatsApp gateway READY (socket healthy)');
      }
      return;
    }

    this.logger.warn({ health }, 'WhatsApp socket is not healthy; reconnecting before send');
    await this.restartClient('socket health check failed');
  }

  async assertReady() {
    await this.ensureSocketHealthy();

    if (!this.client || this.state !== 'READY') {
      const error = new Error('WhatsApp belum siap mengirim.');
      error.code = 'WHATSAPP_NOT_READY';
      throw error;
    }
  }

  async sendText(phone, message) {
    const normalized = normalizePhone(phone);
    if (!isValidIndonesianPhone(normalized)) throw new Error('Format nomor WhatsApp tidak valid.');
    if (typeof message !== 'string' || !message.trim()) throw new Error('Pesan WhatsApp kosong.');
    await this.assertReady();

    const numberId = await this.client.getNumberId(normalized);
    if (!numberId) throw new Error('Nomor tidak terdaftar di WhatsApp.');

    const sent = await this.client.sendMessage(numberId._serialized, message, { sendSeen: false });
    this.logger.info({ phone: normalized, messageId: sent?.id?._serialized || null }, 'WhatsApp message sent');
    return { phone: normalized, messageId: sent?.id?._serialized || null };
  }

  async sendPdf(phone, pdfUrl, caption = '') {
    const normalized = normalizePhone(phone);
    if (!isValidIndonesianPhone(normalized)) throw new Error('Format nomor WhatsApp tidak valid.');
    await this.assertReady();

    const response = await fetch(pdfUrl);
    if (!response.ok) throw new Error(`Gagal mengambil PDF: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 16 * 1024 * 1024) throw new Error('PDF lebih dari 16MB');

    const numberId = await this.client.getNumberId(normalized);
    if (!numberId) throw new Error('Nomor tidak terdaftar di WhatsApp.');

    const media = new MessageMedia('application/pdf', buffer.toString('base64'), 'Hasil-Pemeriksaan-Laboratorium.pdf');
    const sent = await this.client.sendMessage(numberId._serialized, media, { caption, sendSeen: false });
    this.logger.info({ phone: normalized, messageId: sent?.id?._serialized || null }, 'WhatsApp PDF sent');
    return { phone: normalized, messageId: sent?.id?._serialized || null };
  }

  async sendBulk(numbers, message, delayMs = this.messageDelay) {
    if (!Array.isArray(numbers) || numbers.length === 0) throw new Error('numbers harus array dan tidak boleh kosong');
    await this.assertReady();
    const results = [];
    for (const rawNumber of [...new Set(numbers.map((value) => normalizePhone(String(value))))]) {
      try {
        results.push({ success: true, ...(await this.sendText(rawNumber, message)) });
      } catch (error) {
        results.push({ success: false, phone: rawNumber, message: error.message || String(error) });
        this.logger.error({ err: error, phone: rawNumber }, 'WhatsApp message failed');
      }
      if (delayMs > 0) await delay(delayMs);
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
        this.logger.warn({ err: error }, 'WhatsApp client close returned an error');
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
