require('dotenv').config();

const express = require('express');
const cors = require('cors');
const pino = require('pino');
const { WhatsAppManager } = require('./sendMessage');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

const app = express();
const port = Number(process.env.PORT || 9000);
const host = process.env.HOST || '0.0.0.0';
const apiKey = process.env.API_KEY || '';

app.disable('x-powered-by');
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: process.env.JSON_LIMIT || '2mb' }));

const whatsapp = new WhatsAppManager({ logger });

function requireApiKey(req, res, next) {
  if (!apiKey) return next();
  const provided = req.get('X-API-KEY');
  if (!provided || provided !== apiKey) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  const status = whatsapp.getStatus();
  const healthy = status.connected && status.ready && status.authenticated;
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    service: 'whatsapp-gateway',
    whatsapp: {
      connected: status.connected,
      ready: status.ready,
      authenticated: status.authenticated,
      state: status.state,
    },
    uptime: Math.floor(process.uptime()),
  });
});

app.get('/status', (req, res) => {
  res.json({ success: true, ...whatsapp.getStatus() });
});

app.get('/qr', (req, res) => {
  const status = whatsapp.getStatus();
  res.json({
    success: true,
    available: Boolean(status.qr),
    authenticated: status.authenticated,
    connected: status.connected,
    ready: status.ready,
    qr: status.qr || null,
  });
});

app.post('/send-message', requireApiKey, async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (typeof phone !== 'string' || typeof message !== 'string' || !phone.trim() || !message.trim()) {
      return res.status(400).json({ success: false, message: 'phone dan message wajib diisi' });
    }
    const result = await whatsapp.sendText(phone, message);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    const statusCode = error.code === 'WHATSAPP_NOT_READY' ? 503 : 400;
    logger.error({ err: error }, 'send-message failed');
    return res.status(statusCode).json({ success: false, message: error.message });
  }
});

app.post('/send-bulk', requireApiKey, async (req, res) => {
  try {
    const { numbers, message, delayMs } = req.body || {};
    if (!Array.isArray(numbers) || typeof message !== 'string' || !numbers.length || !message.trim()) {
      return res.status(400).json({ success: false, message: 'numbers harus array dan message wajib diisi' });
    }
    const results = await whatsapp.sendBulk(numbers, message, delayMs);
    const failed = results.filter((item) => !item.success).length;
    return res.status(failed ? 207 : 200).json({ success: failed === 0, data: results });
  } catch (error) {
    logger.error({ err: error }, 'send-bulk failed');
    return res.status(error.code === 'WHATSAPP_NOT_READY' ? 503 : 400).json({
      success: false,
      message: error.message,
    });
  }
});

app.post('/logout', requireApiKey, async (req, res) => {
  try {
    await whatsapp.logout();
    res.json({ success: true, message: 'WhatsApp logged out' });
  } catch (error) {
    logger.error({ err: error }, 'logout failed');
    res.status(500).json({ success: false, message: error.message });
  }
});

app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled HTTP error');
  res.status(500).json({ success: false, message: 'Internal server error' });
});

process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled promise rejection'));
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});

async function start() {
  await whatsapp.start();
  app.listen(port, host, () => {
    logger.info({ host, port }, 'WhatsApp Gateway server started');
  });
}

start().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start server');
  process.exit(1);
});

module.exports = { app, whatsapp };
