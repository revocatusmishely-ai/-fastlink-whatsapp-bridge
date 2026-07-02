/**
 * Fastlink SalesDesk — WhatsApp Business API Bridge
 * ------------------------------------------------------------
 * Two jobs:
 *   1) RECEIVE: Meta POSTs incoming WhatsApp messages to /webhook.
 *      We write them into Firebase  ->  reservationRequests/{id}
 *      so they appear in the SalesDesk "Reservations" tab instantly.
 *   2) SEND:    We watch Firebase   ->  outbound/{id} (status:"pending")
 *      and send each one to the client via Meta's Graph API, then mark it "sent".
 *
 * No database SDK needed — we talk to Firebase over its REST API,
 * exactly like the SalesDesk app does.
 *
 * All secrets come from environment variables (see .env.example).
 */

const express = require('express');
const app = express();
app.use(express.json());

// Allow browser-based tools to call this server (CORS)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});


// ---- Config (from environment variables) ----
const PORT           = process.env.PORT || 3000;
const VERIFY_TOKEN   = process.env.VERIFY_TOKEN   || 'fastlink_verify';        // you choose this; paste same value in Meta
const WA_TOKEN       = process.env.WA_TOKEN       || '';                        // Meta System User access token
const PHONE_ID       = process.env.PHONE_ID       || '';                        // Meta Phone Number ID for +255750611611
const FB_URL         = (process.env.FB_URL || 'https://fastlinksafaris-d6f22-default-rtdb.europe-west1.firebasedatabase.app').replace(/\/+$/, '');
const GRAPH_VERSION  = process.env.GRAPH_VERSION  || 'v21.0';
const POLL_MS        = parseInt(process.env.POLL_MS || '4000', 10);             // how often to check for outbound replies

// ---- Small Firebase REST helpers ----
async function fbPut(path, data) {
  const r = await fetch(`${FB_URL}/${path}.json`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error('fbPut ' + path + ' -> ' + r.status);
  return r.json();
}
async function fbPatch(path, data) {
  const r = await fetch(`${FB_URL}/${path}.json`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error('fbPatch ' + path + ' -> ' + r.status);
  return r.json();
}
async function fbGet(path) {
  const r = await fetch(`${FB_URL}/${path}.json`);
  if (!r.ok) throw new Error('fbGet ' + path + ' -> ' + r.status);
  return r.json();
}

// =====================================================================
// 1) WEBHOOK VERIFICATION  (Meta calls this once with GET when you save the webhook)
// =====================================================================
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified by Meta.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =====================================================================
// 1b) INCOMING MESSAGES  (Meta POSTs here whenever a client messages you)
// =====================================================================
app.post('/webhook', async (req, res) => {
  // Respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);
  try {
    const entry  = (req.body.entry || [])[0];
    const change = (entry && entry.changes || [])[0];
    const value  = change && change.value;
    if (!value || !value.messages) return; // status update, not a new message

    const contacts = value.contacts || [];
    for (const msg of value.messages) {
      const from     = msg.from;                                   // client's WhatsApp number (E.164, no +)
      const waName   = (contacts[0] && contacts[0].profile && contacts[0].profile.name) || from;
      const text     = extractText(msg);
      const id        = 'RQ' + Date.now() + Math.floor(Math.random() * 1000);
      const nowMs     = Date.now();

      // Has this client already got an open request? If so, append to its thread instead of duplicating.
      const existingId = await findOpenRequestFor('+' + from);
      if (existingId) {
        const thread = (await fbGet(`reservationRequests/${existingId}/thread`)) || [];
        thread.push({ from: 'client', text, at: nowMs, via: 'whatsapp' });
        await fbPatch(`reservationRequests/${existingId}`, { thread, unread: true });
        console.log('Appended message to existing request', existingId);
        continue;
      }

      const record = {
        id, source: 'whatsapp',
        waNumber: '+' + from,
        waName,
        message: text,
        route: '', dates: '', pax: 1, station: '',
        status: 'new',
        assignedTo: null, assignedToName: '',
        createdAt: nowMs,
        unread: true,
        thread: [{ from: 'client', text, at: nowMs, via: 'whatsapp' }]
      };
      await fbPut(`reservationRequests/${id}`, record);
      console.log('New reservation request from', waName, '(' + from + ')');
    }
  } catch (e) {
    console.error('Incoming handler error:', e.message);
  }
});

function extractText(msg) {
  if (msg.type === 'text' && msg.text) return msg.text.body;
  if (msg.type === 'button' && msg.button) return msg.button.text;
  if (msg.type === 'interactive' && msg.interactive) {
    const i = msg.interactive;
    if (i.button_reply) return i.button_reply.title;
    if (i.list_reply)   return i.list_reply.title;
  }
  if (msg.type === 'image')    return '[image] ' + ((msg.image && msg.image.caption) || '');
  if (msg.type === 'document') return '[document] ' + ((msg.document && msg.document.filename) || '');
  if (msg.type === 'audio')    return '[voice note]';
  if (msg.type === 'location') return '[location shared]';
  return '[' + (msg.type || 'message') + ']';
}

async function findOpenRequestFor(waNumber) {
  try {
    const all = (await fbGet('reservationRequests')) || {};
    let match = null, latest = 0;
    for (const key of Object.keys(all)) {
      const r = all[key];
      if (r.waNumber === waNumber && r.status !== 'closed' && r.status !== 'booked') {
        if ((r.createdAt || 0) >= latest) { latest = r.createdAt || 0; match = key; }
      }
    }
    return match;
  } catch (e) { return null; }
}

// =====================================================================
// 2) OUTBOUND SENDER  (watch Firebase for staff replies, send via Meta)
// =====================================================================
async function processOutbound() {
  if (!WA_TOKEN || !PHONE_ID) return; // not configured yet
  let queue;
  try { queue = (await fbGet('outbound')) || {}; }
  catch (e) { console.error('outbound read error:', e.message); return; }

  for (const key of Object.keys(queue)) {
    const item = queue[key];
    if (!item || item.status !== 'pending') continue;
    try {
      const to = String(item.to || '').replace(/[^0-9]/g, '');
      const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/messages`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: item.text } })
      });
      const data = await resp.json();
      if (resp.ok) {
        await fbPatch(`outbound/${key}`, { status: 'sent', sentAt: Date.now(), waMessageId: (data.messages && data.messages[0] && data.messages[0].id) || '' });
        console.log('Sent reply to', to);
      } else {
        const err = (data.error && data.error.message) || ('HTTP ' + resp.status);
        await fbPatch(`outbound/${key}`, { status: 'failed', error: err, failedAt: Date.now() });
        console.error('Send failed to', to, '->', err);
      }
    } catch (e) {
      await fbPatch(`outbound/${key}`, { status: 'failed', error: e.message, failedAt: Date.now() });
      console.error('Send exception:', e.message);
    }
  }
}
setInterval(processOutbound, POLL_MS);


// =====================================================================
// TEST ENDPOINT — open /test-inject in a browser to simulate an incoming
// WhatsApp message. Proves the server->Firebase->app pipeline end to end.
// =====================================================================
app.get('/test-inject', async (req, res) => {
  const id = 'RQ' + Date.now();
  const nowMs = Date.now();
  const record = {
    id, source: 'whatsapp',
    waNumber: '+255742221911',
    waName: 'Bridge Test',
    message: 'TEST booking request: 2 tickets DAR-JRO (injected at ' + new Date().toISOString() + ')',
    route: '', dates: '', pax: 1, station: '',
    status: 'new', assignedTo: null, assignedToName: '',
    createdAt: nowMs, unread: true,
    thread: [{ from: 'client', text: 'TEST booking request: 2 tickets DAR-JRO', at: nowMs, via: 'whatsapp' }]
  };
  try {
    await fbPut(`reservationRequests/${id}`, record);
    res.send('SUCCESS - Test request ' + id + ' written to Firebase.\n\nNow check:\n1) SalesDesk -> Reservations: a "Bridge Test" card should appear\n2) ' + FB_URL + '/reservationRequests.json should no longer be null\n\nIf you can see the card, the server + Firebase + app all work, and the remaining problem is ONLY Meta webhook delivery (publish the app / WABA subscription).');
  } catch (e) {
    res.send('FIREBASE WRITE FAILED: ' + e.message + '\n\nThis means the server cannot write to your database. Most likely the Firebase rules are blocking writes. Check the Rules tab in Firebase console: {".read": true, ".write": true} and Publish.');
  }
});


// =====================================================================
// KEEP-ALIVE — ping our own public URL every 10 minutes so the free
// Render instance never spins down (Render sleeps after ~15 min idle).
// =====================================================================
const SELF_URL = (process.env.SELF_URL || 'https://fastlink-whatsapp-bridge.onrender.com').replace(/\/+$/, '');
setInterval(() => {
  fetch(SELF_URL)
    .then(r => console.log('keep-alive ping ->', r.status))
    .catch(e => console.log('keep-alive ping failed:', e.message));
}, 10 * 60 * 1000);


// =====================================================================
// DIAGNOSE — open /diagnose in a browser. Checks the token, checks whether
// the WhatsApp Business Account is subscribed to this app (the usual reason
// webhooks are never delivered), and AUTO-FIXES the subscription if missing.
// =====================================================================
app.get('/diagnose', async (req, res) => {
  const WABA_ID = process.env.WABA_ID || '4649914108589249';
  const out = [];
  out.push('FASTLINK BRIDGE DIAGNOSTICS');
  out.push('Time: ' + new Date().toISOString());
  out.push('');

  // 1) Access token validity
  if (!WA_TOKEN) {
    out.push('1) TOKEN: MISSING — set WA_TOKEN in Render Environment.');
  } else {
    try {
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: 'Bearer ' + WA_TOKEN } });
      const d = await r.json();
      if (r.ok) out.push('1) TOKEN: VALID — phone ' + (d.display_phone_number || '') + ' (' + (d.verified_name || '') + ')');
      else out.push('1) TOKEN: INVALID or EXPIRED — ' + ((d.error && d.error.message) || r.status) +
        '\n   FIX: Meta -> Step 1 -> Generate token, then update WA_TOKEN in Render Environment and re-run /diagnose.');
    } catch (e) { out.push('1) TOKEN CHECK ERROR: ' + e.message); }
  }

  // 2) WABA -> app webhook subscription (the usual missing piece)
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/subscribed_apps`,
      { headers: { Authorization: 'Bearer ' + WA_TOKEN } });
    const d = await r.json();
    if (r.ok) {
      const apps = d.data || [];
      if (apps.length) {
        out.push('2) WABA SUBSCRIPTION: OK — this WhatsApp Business Account is subscribed to ' + apps.length + ' app(s). Webhook delivery should work.');
      } else {
        out.push('2) WABA SUBSCRIPTION: MISSING — THIS IS WHY WEBHOOKS ARE NOT DELIVERED. Attempting auto-fix…');
        const rf = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/subscribed_apps`,
          { method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN } });
        const df = await rf.json();
        if (rf.ok && df.success) out.push('   AUTO-FIX: SUCCESS — the app is now subscribed to the WABA. Send a WhatsApp test message NOW and watch Reservations.');
        else out.push('   AUTO-FIX FAILED: ' + JSON.stringify(df));
      }
    } else {
      out.push('2) WABA CHECK FAILED: ' + JSON.stringify(d.error || d) +
        (WA_TOKEN ? '' : ' (no token)'));
    }
  } catch (e) { out.push('2) WABA CHECK ERROR: ' + e.message); }

  out.push('');
  out.push('3) SERVER: reachable (you are reading this) — webhook endpoint is /webhook.');
  out.push('4) FIREBASE: ' + FB_URL);
  res.type('text/plain').send(out.join('\n'));
});

// ---- Health check ----
app.get('/', (req, res) => res.send('Fastlink WhatsApp bridge is running. Webhook at /webhook'));

app.listen(PORT, () => {
  console.log('Fastlink WhatsApp bridge listening on port ' + PORT);
  console.log('Firebase:', FB_URL);
  console.log('WhatsApp API configured:', !!(WA_TOKEN && PHONE_ID));
});
