# WhatsApp Gateway — whatsapp-web.js

Stable Node.js WhatsApp Gateway using Express and whatsapp-web.js.

## Requirements

- Node.js 20+
- A WhatsApp account for device linking
- Chromium/Chrome managed by Puppeteer, installed by `whatsapp-web.js`

## Install

```bash
git clone https://github.com/muhharis99/lab_wa_new.git
cd lab_wa_new
npm install
cp .env.example .env
```

Set a real `API_KEY` in `.env` before exposing the API outside localhost.

## Run

```bash
npm start
```

On the first run, scan the QR code shown in the terminal from WhatsApp → Settings → Linked devices → Link a device. The LocalAuth session is persisted under `WHATSAPP_SESSION_PATH` and reused after restart.

## API

### GET /health

Returns HTTP 200 only when WhatsApp is connected and ready; otherwise HTTP 503.

### GET /status

Returns the current gateway state.

### GET /qr

Returns whether a QR login is currently required. The QR is also rendered in the terminal.

### POST /send-message

Headers:

```http
X-API-KEY: your-secret
Content-Type: application/json
```

Body:

```json
{
  "phone": "081234567890",
  "message": "Test pesan"
}
```

Supported phone formats include `081234567890`, `6281234567890`, and `+6281234567890`.

### POST /send-bulk

```json
{
  "numbers": ["081234567890", "62812345678901"],
  "message": "Test pesan",
  "delayMs": 1500
}
```

### POST /logout

Logs out the currently connected WhatsApp account, clears the LocalAuth session, and requires a new QR/login afterwards.

## Architecture

```text
Express API
    ↓
WhatsAppManager
    ↓
Single whatsapp-web.js Client
    ↓
WhatsApp Web
```

Connection state is centralized. Only one client instance is maintained at a time, reconnect uses bounded exponential backoff, and messages are rejected until the `ready` event has established an operational client.

## Environment

See `.env.example`. Do not commit `.env`, session directories, `node_modules`, or logs.
