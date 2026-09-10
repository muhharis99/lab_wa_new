# WhatsApp Gateway — Baileys

Stable Node.js WhatsApp Gateway using Express and Baileys.

## Requirements

- Node.js 20+
- A WhatsApp account for device linking

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

On the first run, scan the QR code shown in the terminal from WhatsApp → Settings → Linked devices → Link a device. The session is persisted under `WHATSAPP_SESSION_PATH` and is reused after restart.

## API

### GET /health

Returns HTTP 200 only when WhatsApp is connected and ready; otherwise HTTP 503.

### GET /status

Returns the current gateway state.

### GET /qr

Returns the current QR payload when login is required.

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

Logs out the currently connected WhatsApp account. A new QR/login is required afterwards.

## Architecture

```text
Express API
    ↓
WhatsAppManager
    ↓
Single Baileys Socket
    ↓
WhatsApp
```

Connection state is centralized and reconnect uses bounded exponential backoff. Credentials are saved through Baileys `creds.update`.
