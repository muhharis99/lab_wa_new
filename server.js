require('dotenv').config();

const express = require('express');
const cors = require('cors');
const pino = require('pino');
const { WhatsAppManager } = require('./sendMessage');

const logger = pino({ level: process.env.LOG_LEVEL || 'info', base: undefined, timestamp: pino.stdTimeFunctions.isoTime });
const app = express();
const port = Number(process.env.PORT || 9000);
const host = process.env.HOST || '0.0.0.0';
const apiKey = process.env.API_KEY || '';

const LAB_PDF_BASE_URL = process.env.LAB_PDF_BASE_URL || 'http://192.168.0.16/serverx/assets/rme/pdf/172.16.18.18';
const LAB_PDF_PREFIX = process.env.LAB_PDF_PREFIX || 'Hasil-Pemeriksaan-Laboratorium-';

app.disable('x-powered-by');
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: process.env.JSON_LIMIT || '2mb' }));

const whatsapp = new WhatsAppManager({ logger });

function requireApiKey(req, res, next) {
  if (!apiKey) return next();
  const provided = req.get('X-API-KEY');
  if (!provided || provided !== apiKey) return res.status(401).json({ success: false, message: 'Unauthorized' });
  next();
}

function buildLabPdfUrl(noReg) {
  const cleanNoReg = String(noReg || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!cleanNoReg) throw new Error('Nomor registrasi tidak valid.');
  return `${LAB_PDF_BASE_URL.replace(/\/$/, '')}/${LAB_PDF_PREFIX}${cleanNoReg}.pdf`;
}

app.get('/health', (req, res) => {
  const status = whatsapp.getStatus();
  const healthy = status.connected && status.ready && status.authenticated;
  res.status(healthy ? 200 : 503).json({ success: healthy, service: 'whatsapp-gateway', whatsapp: { connected: status.connected, ready: status.ready, authenticated: status.authenticated, state: status.state }, uptime: Math.floor(process.uptime()) });
});

app.get('/status', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ success: true, ...whatsapp.getStatus() }); });
app.get('/qr', (req, res) => { const status = whatsapp.getStatus(); res.json({ success: true, available: Boolean(status.qr), authenticated: status.authenticated, connected: status.connected, ready: status.ready, qr: status.qr || null }); });

app.get('/', (req, res) => {
  const status = whatsapp.getStatus();
  const label = status.ready ? 'WhatsApp Terhubung' : status.qr ? 'Scan QR WhatsApp' : 'Menyiapkan WhatsApp';
  const qr = status.qr ? `<pre style="white-space:pre-wrap;word-break:break-all;background:#fff;color:#111;padding:12px;border-radius:8px">${String(status.qr).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>` : '';
  res.send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp Gateway</title></head><body><main style="font-family:Arial;max-width:720px;margin:40px auto;padding:24px"><h1>WhatsApp Gateway</h1><p>Status: <strong>${label}</strong></p>${qr}<p>Endpoint: <code>POST /send</code></p></main></body></html>`);
});

app.post('/send', async (req, res) => {
  const numbers = String(req.body?.numbers || '').trim();
  const message = String(req.body?.message || '');

  if (!numbers || !message.trim()) return res.status(422).json({ success: false, message: 'Nomor dan pesan WhatsApp wajib diisi.' });

  const noReg = message.substring(0, 7).trim();
  const caption = message.substring(7).trim();

  if (!/^\d{7}$/.test(noReg)) {
    return res.status(422).json({ success: false, message: 'Format nomor registrasi pada message tidak valid. 7 karakter pertama harus nomor registrasi.' });
  }

  let pdfUrl;
  try {
    pdfUrl = buildLabPdfUrl(noReg);
  } catch (error) {
    return res.status(422).json({ success: false, message: error.message });
  }

  const list = [...new Set(numbers.split(',').map((value) => value.trim()).filter(Boolean))];

  try { whatsapp.assertReady(); }
  catch (error) { return res.status(503).json({ success: false, message: error.message, state: whatsapp.getStatus().state }); }

  const results = [];
  for (const phone of list) {
    try {
      const result = await whatsapp.sendPdf(phone, pdfUrl, caption);
      results.push({ success: true, ...result, noReg, pdfUrl });
    } catch (error) {
      logger.error({ err: error, phone, noReg, pdfUrl }, 'WhatsApp /send PDF failed');
      results.push({ success: false, phone, noReg, pdfUrl, message: error.message || String(error) });
    }
    if (list.length > 1 && whatsapp.messageDelay > 0) await new Promise((resolve) => setTimeout(resolve, whatsapp.messageDelay));
  }

  const failed = results.filter((item) => !item.success).length;
  return res.status(failed ? 207 : 200).json({ success: failed === 0, noReg, pdfUrl, data: results });
});

app.post('/send-message', requireApiKey, async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (typeof phone !== 'string' || typeof message !== 'string' || !phone.trim() || !message.trim()) return res.status(400).json({ success: false, message: 'phone dan message wajib diisi' });
    const result = await whatsapp.sendText(phone, message);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error({ err: error }, 'send-message failed');
    return res.status(error.code === 'WHATSAPP_NOT_READY' ? 503 : 400).json({ success: false, message: error.message });
  }
});

app.post('/send-bulk', requireApiKey, async (req, res) => {
  try {
    const { numbers, message, delayMs } = req.body || {};
    if (!Array.isArray(numbers) || typeof message !== 'string' || !numbers.length || !message.trim()) return res.status(400).json({ success: false, message: 'numbers harus array dan message wajib diisi' });
    const results = await whatsapp.sendBulk(numbers, message, delayMs);
    const failed = results.filter((item) => !item.success).length;
    return res.status(failed ? 207 : 200).json({ success: failed === 0, data: results });
  } catch (error) { logger.error({ err: error }, 'send-bulk failed'); return res.status(error.code === 'WHATSAPP_NOT_READY' ? 503 : 400).json({ success: false, message: error.message }); }
});

app.post('/logout', requireApiKey, async (req, res) => {
  try { await whatsapp.logout(); return res.json({ success: true, message: 'WhatsApp logged out' }); }
  catch (error) { logger.error({ err: error }, 'logout failed'); return res.status(500).json({ success: false, message: error.message }); }
});

app.use((err, req, res, next) => { logger.error({ err }, 'Unhandled HTTP error'); res.status(500).json({ success: false, message: 'Internal server error' }); });
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled promise rejection'));
process.on('uncaughtException', (error) => { logger.fatal({ err: error }, 'Uncaught exception'); process.exit(1); });

async function start() { await whatsapp.start(); app.listen(port, host, () => logger.info({ host, port }, 'WhatsApp Gateway server started')); }
start().catch((error) => { logger.fatal({ err: error }, 'Failed to start server'); process.exit(1); });
module.exports = { app, whatsapp };
