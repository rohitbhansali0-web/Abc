# Setu Darshan — Northflank-ready

A single Node/Express service with PostgreSQL for the Setu temple darshan workflow.

## Portals

- `/` — Devotee
- `/counter` — Temple Counter
- `/gate` — Gate Entry

Roles are enforced by the server. The counter cannot access gate APIs, and the gate cannot access counter payment APIs.

## Real OTP

This project supports Twilio Verify for real SMS OTP.

Required:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_VERIFY_SERVICE_SID`

For India, verify that your Twilio account/sender is approved for Indian SMS delivery.

## WhatsApp

After offline payment, the server can send a WhatsApp template message through Meta WhatsApp Cloud API.

Required:
- `WHATSAPP_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_TEMPLATE_NAME`
- `WHATSAPP_TEMPLATE_LANGUAGE` (example: `en_US`)

The template must be approved in Meta Business Manager. The code sends booking details as template parameters.

## Database

Required:
- `DATABASE_URL`

Northflank PostgreSQL should be connected to the service and exposed as `DATABASE_URL`.

## Staff access

Set:
- `COUNTER_USERNAME`
- `COUNTER_PASSWORD`
- `GATE_USERNAME`
- `GATE_PASSWORD`
- `SESSION_SECRET`

For a real launch, replace the simple staff login with a proper identity provider/SSO and per-staff accounts.

## Demo mode

If `DEMO_OTP=true`, the UI accepts `123456` as a local demo OTP without sending SMS. Keep this OFF for real OTP.

## Start

```bash
npm install
DATABASE_URL=... npm start
```

The app listens on `PORT` (default 3000).
