# Fastlink SalesDesk — WhatsApp Bridge Server

This small server connects the **WhatsApp Business Cloud API** to your **Fastlink SalesDesk** so corporate booking requests flow in and replies go out automatically.

- Client messages **+255 750 611 611** → appears in the SalesDesk **Reservations** tab.
- Staff reply in the app → this server sends it back to the client on WhatsApp.

It talks to your Firebase database over REST, the same way the SalesDesk app does. No database SDK, no Google billing needed — it runs on a free host.

---

## What you need before deploying

1. A **Meta (Facebook) developer account** — https://developers.facebook.com
2. A **WhatsApp Business Account (WABA)** with **+255 750 611 611** registered.
3. From Meta you'll collect three values:
   - **Access token** (System User token — set it to never expire)
   - **Phone Number ID** (for +255 750 611 611 — this is an ID, not the phone number)
   - **Verify token** — a password you invent (e.g. `fastlink_verify_2026`)

---

## Step 1 — Put this folder on GitHub

1. Create a free GitHub account if you don't have one.
2. Make a new repository called `fastlink-whatsapp-bridge`.
3. Upload these files: `server.js`, `package.json`, `.env.example`, `README.md`.
   (Do **not** upload a real `.env` file — secrets go in the host settings instead.)

## Step 2 — Deploy to Render (free)

1. Go to https://render.com and sign up (you can log in with GitHub).
2. Click **New → Web Service** and connect your `fastlink-whatsapp-bridge` repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Under **Environment**, add these variables (from `.env.example`):
   | Key | Value |
   |-----|-------|
   | `VERIFY_TOKEN` | `fastlink_verify_2026` (or your own) |
   | `WA_TOKEN` | your Meta access token |
   | `PHONE_ID` | your Meta Phone Number ID |
   | `FB_URL` | `https://fastlinksafaris-d6f22-default-rtdb.europe-west1.firebasedatabase.app` |
5. Click **Create Web Service**. When it's live, Render gives you a URL like
   `https://fastlink-whatsapp-bridge.onrender.com`.
6. Visit that URL in a browser — you should see *"Fastlink WhatsApp bridge is running."*

*(Railway works the same way if you prefer it: New Project → Deploy from GitHub → add the same environment variables.)*

## Step 3 — Connect the webhook in Meta

1. In your Meta app → **WhatsApp → Configuration**.
2. **Callback URL:** `https://YOUR-RENDER-URL.onrender.com/webhook`
3. **Verify token:** the same value you set for `VERIFY_TOKEN`.
4. Click **Verify and Save** — it should succeed (the server answers Meta's check).
5. Under **Webhook fields**, subscribe to **messages**.

## Step 4 — Go live & test

1. Complete Meta **Business Verification** and **App Review**, then switch the app to **Live** mode. (Real messages don't flow in Development mode.)
2. In SalesDesk → **Settings → WhatsApp reservations**, tick **"API server is connected"** and save. (This makes staff replies auto-send.)
3. From any other phone, send a WhatsApp message to **+255 750 611 611**.
4. Within a couple of seconds it appears in **Reservations**. Delegate it, reply from the app, and the reply lands back on the sender's WhatsApp. ✅

---

## How it maps to your app (data contract)

| Firebase node | Written by | Read by |
|---------------|-----------|---------|
| `reservationRequests/{id}` | this server (incoming) & the app | the app (Reservations tab) |
| `outbound/{id}` | the app (staff replies) | this server (sends them) |
| `presence/{userId}` | the app (who's online) | the app (delegation) |

Incoming record shape (what this server writes):
```json
{
  "id": "RQ...", "source": "whatsapp",
  "waNumber": "+255700111222", "waName": "KCMC University",
  "message": "…", "status": "new", "assignedTo": null,
  "createdAt": 0, "thread": [{ "from": "client", "text": "…", "at": 0, "via": "whatsapp" }]
}
```
Outbound record the app creates (what this server sends & marks `sent`):
```json
{ "id": "OUT...", "to": "+255700111222", "text": "…", "requestId": "RQ...", "status": "pending" }
```

---

## Notes & costs

- **API access is free.** Meta charges **per message** (rates vary by country; Tanzania has its own rate card). Replies inside a customer-initiated 24-hour window are cheapest.
- On Render's **free tier** the server may "sleep" after inactivity, adding a few seconds' delay on the first message. Meta **retries webhook delivery for up to 7 days**, so nothing is lost. A few dollars/month keeps it always-on if you prefer.
- **Security:** lock down your Firebase rules before wide rollout — the current open rules mean anyone with the URL can read/write. Ask and we'll set up authenticated rules.
- **Coexistence:** if +255 750 611 611 is currently used in the WhatsApp Business App, enable coexistence during Meta setup so you don't lose it.
