const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

let client;
let clientReady = false;
let waitingConnect = false;
let isResetting = false; 

const CONFIG = {
  MESSAGE_DELAY: 4000,
  READY_TIMEOUT: 60000,
  DOWNLOAD_TIMEOUT: 30000,
};

function createClient() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
    },
    bypassCSP: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    patchMessageBeforeSending: (message) => {
      if (message?.markedUnread !== undefined) delete message.markedUnread;
      return message;
    },
  });

  client.on('qr', async (qr) => {
    console.log('\n📸 Scan QR berikut untuk login WhatsApp:\n');
    qrcodeTerminal.generate(qr, { small: true });
    try {
      await QRCode.toFile('./qr_code.png', qr);
      console.log('🖼️ QR disimpan: ./qr_code.png');
    } catch (err) {
      console.error('❌ Gagal simpan QR:', err.message);
    }
  });

  client.on('authenticated', async () => {
    console.log('🔐 WhatsApp authenticated');
    if (!waitingConnect) {
      waitingConnect = true;
      await waitUntilConnected();
    }
  });

  client.on('ready', () => {
    console.log('ℹ️ Event ready terpanggil');
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Auth failure:', msg);
    clientReady = false;
  });

  client.on('disconnected', async (reason) => {
    console.log('⚠️ WhatsApp disconnected:', reason);
    clientReady = false;
    waitingConnect = false;
    if (reason === 'LOGOUT') await cleanupSession();
  });

  return client;
}

async function waitUntilConnected() {
  const start = Date.now();
  while (Date.now() - start < CONFIG.READY_TIMEOUT) {
    try {
      const state = await client.getState();
      if (state === 'CONNECTED') {
        clientReady = true;
        console.log('🟢 WhatsApp CONNECTED & SIAP KIRIM');
        return;
      }
    } catch {}
    await delay(1000);
  }
  console.error('❌ Timeout: WhatsApp tidak CONNECTED');
}


async function resetClient() {
  if (isResetting) {
    console.log('🔄 Reset sudah berjalan, tunggu...');

    const start = Date.now();
    while (isResetting && Date.now() - start < 30000) {
      await delay(1000);
    }
    return;
  }

  isResetting = true;
  clientReady = false;
  waitingConnect = false;

  console.log('🔄 Mereset WhatsApp client...');
  try {
    await client.destroy();
  } catch (e) {
    console.log('ℹ️ destroy error (diabaikan):', e.message);
  }

  await delay(3000);
  createClient();
  client.initialize();


  const start = Date.now();
  while (Date.now() - start < CONFIG.READY_TIMEOUT) {
    if (clientReady) break;
    await delay(1000);
  }

  isResetting = false;

  if (!clientReady) {
    throw new Error('Gagal reconnect setelah reset');
  }

  console.log('✅ Client berhasil direset & reconnected');
}

const delay = (ms) => new Promise(res => setTimeout(res, ms));

function normalizeNumber(number) {
  const n = number.replace(/\D/g, '');
  if (n.startsWith('0')) return '62' + n.slice(1);
  if (n.startsWith('8')) return '62' + n;
  return n;
}

async function downloadPDF(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: CONFIG.DOWNLOAD_TIMEOUT,
  });
  const buffer = Buffer.from(res.data);
  if (buffer.length / 1024 / 1024 > 16)
    throw new Error('PDF lebih dari 16MB');
  return new MessageMedia('application/pdf', buffer.toString('base64'), 'Hasil-Lab.pdf');
}

async function cleanupSession() {
  try {
    console.log('🧹 Membersihkan session...');
    if (client) await client.destroy().catch(() => {});
    const sessionPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    setTimeout(() => { createClient(); client.initialize(); }, 3000);
  } catch (e) {
    console.error('❌ Cleanup gagal:', e.message);
  }
}


function isProtocolError(err) {
  return (
    err?.message?.includes('Target closed') ||
    err?.message?.includes('Protocol error') ||
    err?.message?.includes('Session closed') ||
    err?.name === 'ProtocolError'
  );
}

const sendMessage = async (numbers, message) => {
  if (!clientReady) {

    console.log('⚠️ Client belum ready, mencoba reset...');
    await resetClient();
  }

  const list = numbers.split(',').map(n => n.trim()).filter(Boolean);
  const results = [];

  for (const number of list) {
    let retries = 2;  

    while (retries >= 0) {
      try {
        const no_reg   = message.substring(0, 7);
        const caption  = message.substring(7).trim();
        const intl     = normalizeNumber(number);
        const chatId   = `${intl}@s.whatsapp.net`;
        const pdfUrl   = `http://192.168.0.16/serverx/assets/rme/pdf/172.16.18.18/Hasil-Pemeriksaan-Laboratorium-${no_reg}.pdf`;

        const media = await downloadPDF(pdfUrl);

        await client.sendMessage(chatId, media, {
          caption,
          sendSeen: false,
        });

        console.log(`✅ Terkirim ke ${intl}`);
        results.push({ number: intl, status: 1, message: 'Terkirim' });
        break;

      } catch (e) {
        if (isProtocolError(e) && retries > 0) {

          console.warn(`⚠️ ProtocolError ke ${number}, mencoba reset client... (sisa retry: ${retries})`);
          try {
            await resetClient();
          } catch (resetErr) {
            console.error('❌ Reset gagal:', resetErr.message);
            results.push({ number, status: 2, message: resetErr.message });
            break;
          }
          retries--;
          continue;
        }

        console.error(`❌ Gagal ke ${number}:`, e.message);
        results.push({ number, status: 2, message: e.message });
        break;
      }
    }

    await delay(CONFIG.MESSAGE_DELAY);
  }

  return results;
};


createClient();
client.initialize();

module.exports = { sendMessage };