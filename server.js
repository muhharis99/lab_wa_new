const mysql = require('mysql');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { sendMessage } = require('./sendMessage');

const app = express();
const port = 9000;

app.use(cors({ origin: '*' }));
app.use(bodyParser.json({ limit: '50mb' }));

const db = mysql.createPool({
  host: '192.168.0.33',
  user: 'admin',
  password: 'admin3dp',
  database: 'rsiklaten',
  connectionLimit: 10,
});

app.post('/send', async (req, res) => {
  const { numbers, message } = req.body;

  if (!numbers || !message) {
    return res.status(400).json({
      success: false,
      message: 'numbers dan message wajib diisi',
    });
  }

  try {
    const results = await sendMessage(numbers, message);
    res.json({
      success: true,
      data: results,
    });
  } catch (error) {
    console.error('❌ Error /send:', error.message);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 WhatsApp Gateway Server');
  console.log(`📡 http://192.168.0.93:${port}`);
  console.log('='.repeat(60) + '\n');
});
