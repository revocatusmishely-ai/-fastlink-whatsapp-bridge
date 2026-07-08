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
app.use((req, res, next) => { if (req.path !== '/') console.log('HTTP', req.method, req.path); next(); });

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
const POLL_MS        = parseInt(process.env.POLL_MS || '4000', 10);
const WABA_ID        = process.env.WABA_ID || '4649914108589249';
const APP_ID         = process.env.APP_ID || '1785915835708459';
const FB_API_KEY     = process.env.FB_API_KEY || '';
const FB_AUTH_EMAIL  = process.env.FB_AUTH_EMAIL || '';
const FB_AUTH_PASS   = process.env.FB_AUTH_PASS || '';             // how often to check for outbound replies

// ---- Firebase Auth (service login) ----
let _dbToken = '';
let _dbTokenExp = 0;
async function dbSignIn() {
  if (!FB_API_KEY || !FB_AUTH_EMAIL || !FB_AUTH_PASS) return false; // open mode
  try {
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FB_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: FB_AUTH_EMAIL, password: FB_AUTH_PASS, returnSecureToken: true })
    });
    const d = await r.json();
    if (r.ok && d.idToken) {
      _dbToken = d.idToken;
      _dbTokenExp = Date.now() + (parseInt(d.expiresIn || '3600', 10) - 600) * 1000;
      console.log('Firebase auth: signed in as', FB_AUTH_EMAIL);
      return true;
    }
    console.error('Firebase auth failed:', (d.error && d.error.message) || r.status);
  } catch (e) { console.error('Firebase auth error:', e.message); }
  return false;
}
function fbQ() { return _dbToken ? ('?auth=' + _dbToken) : ''; }
async function ensureDbAuth() {
  if (FB_API_KEY && (!_dbToken || Date.now() > _dbTokenExp)) await dbSignIn();
}
setInterval(() => { ensureDbAuth().catch(()=>{}); }, 10 * 60 * 1000);
dbSignIn().catch(()=>{});

// ---- Small Firebase REST helpers (auth-aware, retry once on 401) ----
async function _fbCall(method, path, data) {
  await ensureDbAuth();
  const doFetch = () => fetch(`${FB_URL}/${path}.json${fbQ()}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  let r = await doFetch();
  if (r.status === 401 && FB_API_KEY) { await dbSignIn(); r = await doFetch(); }
  if (!r.ok) throw new Error(method + ' ' + path + ' -> ' + r.status);
  return r.json();
}
async function fbPut(path, data)  { return _fbCall('PUT', path, data); }
async function fbPatch(path, data){ return _fbCall('PATCH', path, data); }
async function fbGet(path)        { return _fbCall('GET', path); }

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
const lastWebhookHits = [];

app.post('/webhook', async (req, res) => {
  // Respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);
  try {
    const entry  = (req.body && req.body.entry || [])[0];
    const change = (entry && entry.changes || [])[0];
    const value  = (change && change.value) || {};

    // Record EVERY delivery so /diagnose can show ground truth
    const hit = {
      at: new Date().toISOString(),
      messages: (value.messages || []).length,
      statuses: (value.statuses || []).length,
      preview: (value.messages && value.messages[0])
        ? ((value.messages[0].type || 'msg') + ': ' + ((value.messages[0].text && value.messages[0].text.body) || '')).slice(0, 70)
        : ((value.statuses && value.statuses[0]) ? ('status: ' + value.statuses[0].status) : 'other/' + (change && change.field))
    };
    lastWebhookHits.unshift(hit);
    if (lastWebhookHits.length > 10) lastWebhookHits.pop();
    console.log('WEBHOOK POST:', hit.messages, 'msg /', hit.statuses, 'status —', hit.preview);

    if (!value.messages) return; // status update, not a new message

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
        thread.push(await buildInboundEntry(msg));
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
        thread: [await buildInboundEntry(msg)]
      };
      await fbPut(`reservationRequests/${id}`, record);
      console.log('New reservation request from', waName, '(' + from + ')');
    }
  } catch (e) {
    console.error('Incoming handler error:', e.message);
  }
});


// ---- Media helpers (images & documents) ----
const MAX_MEDIA_BYTES = 4.5 * 1024 * 1024; // keep DB writes sane
async function fetchInboundMedia(mediaId) {
  // 1) resolve media URL  2) download bytes  3) return base64 data URL
  const r1 = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
    { headers: { Authorization: 'Bearer ' + WA_TOKEN } });
  const meta = await r1.json();
  if (!r1.ok || !meta.url) throw new Error('media meta: ' + JSON.stringify(meta.error || meta));
  if (meta.file_size && meta.file_size > MAX_MEDIA_BYTES) throw new Error('too large (' + meta.file_size + ' bytes)');
  const r2 = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + WA_TOKEN } });
  if (!r2.ok) throw new Error('media download ' + r2.status);
  const buf = Buffer.from(await r2.arrayBuffer());
  if (buf.length > MAX_MEDIA_BYTES) throw new Error('too large (' + buf.length + ' bytes)');
  const mime = meta.mime_type || 'application/octet-stream';
  return { mime, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'), size: buf.length };
}

// Build the thread entry for an inbound message; stores media in chatMedia/{id}
async function buildInboundEntry(msg) {
  const nowMs = Date.now();
  const base = { from: 'client', at: nowMs, via: 'whatsapp' };
  const mediaMsg = (msg.type === 'image' && msg.image) ? { obj: msg.image, kind: 'image', name: 'photo.jpg' }
                 : (msg.type === 'document' && msg.document) ? { obj: msg.document, kind: 'document', name: msg.document.filename || 'document' }
                 : null;
  if (!mediaMsg) return Object.assign(base, { text: extractText(msg) });
  const caption = mediaMsg.obj.caption || '';
  try {
    const media = await fetchInboundMedia(mediaMsg.obj.id);
    const mid = 'MED' + nowMs + Math.floor(Math.random() * 1000);
    await fbPut('chatMedia/' + mid, { name: mediaMsg.name, mime: media.mime, dataUrl: media.dataUrl, size: media.size, at: nowMs });
    return Object.assign(base, {
      text: (mediaMsg.kind === 'image' ? '📷 ' : '📄 ') + (caption || mediaMsg.name),
      media: { id: mid, kind: mediaMsg.kind, name: mediaMsg.name }
    });
  } catch (e) {
    console.error('inbound media error:', e.message);
    return Object.assign(base, { text: '[' + mediaMsg.kind + ' received: ' + mediaMsg.name + ' — could not be saved: ' + e.message + ']' });
  }
}

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
      let payload;
      if (item.media && item.media.id) {
        // fetch the file from Firebase, upload to Meta, send as image/document
        const m = await fbGet('chatMedia/' + item.media.id);
        if (!m || !m.dataUrl) throw new Error('media not found: ' + item.media.id);
        const b64 = m.dataUrl.split(',')[1];
        const buf = Buffer.from(b64, 'base64');
        const fd = new FormData();
        fd.append('messaging_product', 'whatsapp');
        fd.append('type', m.mime);
        fd.append('file', new Blob([buf], { type: m.mime }), m.name || 'file');
        const up = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/media`, {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + WA_TOKEN }, body: fd
        });
        const ud = await up.json();
        if (!up.ok || !ud.id) throw new Error('media upload: ' + JSON.stringify(ud.error || ud));
        if (item.media.kind === 'image') {
          payload = { messaging_product: 'whatsapp', to, type: 'image', image: Object.assign({ id: ud.id }, item.text ? { caption: item.text } : {}) };
        } else {
          payload = { messaging_product: 'whatsapp', to, type: 'document', document: Object.assign({ id: ud.id, filename: m.name || 'document.pdf' }, item.text ? { caption: item.text } : {}) };
        }
      } else {
        payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: item.text } };
      }
      const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/messages`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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
        const names = apps.map(a => ((a.whatsapp_business_api_data && ((a.whatsapp_business_api_data.name||'app') + ' [' + a.whatsapp_business_api_data.id + ']')) || a.id || 'unknown'));
        out.push('2) WABA SUBSCRIPTION: ' + apps.length + ' app(s) subscribed: ' + names.join(', '));
        const ours = apps.some(a => String((a.whatsapp_business_api_data && a.whatsapp_business_api_data.id) || a.id || '') === String(APP_ID));
        if (ours) out.push('   -> OUR app (' + APP_ID + ') IS subscribed. Good.');
        else {
          out.push('   -> OUR app (' + APP_ID + ') is NOT among them — THIS IS THE PROBLEM. Subscribing now…');
          const rf = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/subscribed_apps`, { method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN } });
          const df = await rf.json();
          out.push('   AUTO-FIX result: ' + JSON.stringify(df));
        }
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



  // 2b) Per-phone-number webhook override — can silently redirect deliveries
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}?fields=webhook_configuration`,
      { headers: { Authorization: 'Bearer ' + WA_TOKEN } });
    const d = await r.json();
    if (r.ok) {
      const wc = d.webhook_configuration;
      if (!wc) {
        out.push('2b) PHONE WEBHOOK OVERRIDE: none — deliveries use the app-level URL (good).');
      } else {
        out.push('2b) PHONE WEBHOOK OVERRIDE: ' + JSON.stringify(wc));
        const uri = String(wc.override_callback_uri || '');
        if (uri && uri.indexOf('fastlink-whatsapp-bridge.onrender.com') === -1) {
          out.push('   -> AN OVERRIDE POINTS SOMEWHERE ELSE — THIS IS THE PROBLEM. Deliveries for this number go to that URL, not ours.');
        }
      }
    } else out.push('2b) PHONE WEBHOOK CHECK FAILED: ' + JSON.stringify(d.error || d));
  } catch (e) { out.push('2b) PHONE WEBHOOK CHECK ERROR: ' + e.message); }

  // 3) App-level webhook registration — what URL Meta ACTUALLY delivers to
  const APP_SECRET = process.env.APP_SECRET || '';
  if (!APP_SECRET) {
    out.push('3) APP WEBHOOK CONFIG: skipped — add APP_SECRET in Render Environment (Meta -> App settings -> Basic -> App secret -> Show) to inspect this.');
  } else {
    try {
      const tok = encodeURIComponent(APP_ID + '|' + APP_SECRET);
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${APP_ID}/subscriptions?access_token=${tok}`);
      const d = await r.json();
      if (r.ok && d.data) {
        if (!d.data.length) out.push('3) APP WEBHOOK CONFIG: NO SUBSCRIPTIONS REGISTERED — Meta has no webhook to deliver to! Re-do Verify and save in the WhatsApp webhook settings.');
        d.data.forEach(s => {
          out.push('3) APP WEBHOOK [' + s.object + ']: url=' + (s.callback_url || '(none)') + ' | active=' + s.active + ' | fields=' + (s.fields ? s.fields.map(f => f.name || f).join(',') : ''));
          if (s.object === 'whatsapp_business_account') {
            const urlOk = (s.callback_url || '').indexOf('fastlink-whatsapp-bridge.onrender.com/webhook') > -1;
            const fieldsArr = (s.fields || []).map(f => (f.name || f));
            const msgOk = fieldsArr.indexOf('messages') > -1;
            out.push('   -> URL correct: ' + (urlOk ? 'YES' : 'NO — THIS IS THE PROBLEM, fix the Callback URL in Meta webhook settings'));
            out.push('   -> messages field: ' + (msgOk ? 'YES' : 'NO — THIS IS THE PROBLEM, subscribe the messages field'));
          }
        });
      } else out.push('3) APP WEBHOOK CHECK FAILED: ' + JSON.stringify(d.error || d));
    } catch (e) { out.push('3) APP WEBHOOK CHECK ERROR: ' + e.message); }
  }

  out.push('');
  out.push('4) SERVER: reachable (you are reading this) — webhook endpoint is /webhook.');
  out.push('5) FIREBASE: ' + FB_URL);
  if (!FB_API_KEY) out.push('   DB AUTH: not configured (open-rules mode). Add FB_API_KEY / FB_AUTH_EMAIL / FB_AUTH_PASS to enable.');
  else {
    await ensureDbAuth();
    out.push('   DB AUTH: ' + (_dbToken ? ('signed in as ' + FB_AUTH_EMAIL) : 'SIGN-IN FAILED — check FB_API_KEY / email / password'));
    try { await fbGet('settings'); out.push('   DB ACCESS: OK (read succeeded with current rules)'); }
    catch (e) { out.push('   DB ACCESS: FAILED — ' + e.message); }
  }
  out.push('');
  out.push('6) RECENT WEBHOOK DELIVERIES (since server start):');
  if (!lastWebhookHits.length) {
    out.push('   NONE — Meta has not POSTed anything to /webhook since this server started.');
  } else {
    lastWebhookHits.forEach(h => out.push('   ' + h.at + ' — ' + h.messages + ' msg / ' + h.statuses + ' status — ' + h.preview));
  }
  res.type('text/plain').send(out.join('\n'));
});


// =====================================================================
// FORCE — open /force-webhook to (1) re-subscribe this app to the WABA and
// (2) set a per-phone-number webhook override pointing straight at this
// server. Meta verifies the override with a handshake to our /webhook.
// =====================================================================
app.get('/force-webhook', async (req, res) => {
  const out = ['FORCE WEBHOOK ROUTING', 'Time: ' + new Date().toISOString(), ''];
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/subscribed_apps`,
      { method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN } });
    const d = await r.json();
    out.push('1) Re-subscribe app to WABA: ' + JSON.stringify(d));
  } catch (e) { out.push('1) re-subscribe error: ' + e.message); }
  try {
    const body = { webhook_configuration: { override_callback_uri: SELF_URL + '/webhook', verify_token: VERIFY_TOKEN } };
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}`,
      { method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    out.push('2) Set per-number override to ' + SELF_URL + '/webhook: ' + JSON.stringify(d));
    if (d.success) out.push('   -> SUCCESS — deliveries for this number now route DIRECTLY here. Send a WhatsApp test NOW and watch Reservations.');
  } catch (e) { out.push('2) override error: ' + e.message); }
  res.type('text/plain').send(out.join('\n'));
});


// =====================================================================
// SEND-TEST — open /send-test to send a WhatsApp text to the test phone.
// Then REPLY to it on the phone; /diagnose section 6 shows whether Meta
// delivered your reply to this server.
// =====================================================================
app.get('/send-test', async (req, res) => {
  const to = String(req.query.to || '255742221911').replace(/[^0-9]/g, '');
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: 'Bridge live test — please REPLY to this message with any text.' } })
    });
    const d = await r.json();
    if (r.ok) res.type('text/plain').send('SENT to +' + to + '.\n\nNow:\n1) Open WhatsApp on that phone and REPLY to the message with any text\n2) Wait ~20 seconds\n3) Open /diagnose and read section 6 (RECENT WEBHOOK DELIVERIES)\n4) Check SalesDesk -> Reservations for a new card');
    else res.type('text/plain').send('SEND FAILED: ' + JSON.stringify(d) + '\n\nIf the error mentions a 24-hour window, first send any WhatsApp from the phone to the test number, then retry /send-test.');
  } catch (e) { res.type('text/plain').send('SEND ERROR: ' + e.message); }
});

// ---- Health check ----
app.get('/', (req, res) => res.send('Fastlink WhatsApp bridge is running. Webhook at /webhook'));

app.listen(PORT, () => {
  console.log('Fastlink WhatsApp bridge listening on port ' + PORT);
  console.log('Firebase:', FB_URL);
  console.log('WhatsApp API configured:', !!(WA_TOKEN && PHONE_ID));
});
