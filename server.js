/**
 * ═══════════════════════════════════════════════════════════════
 *  DSB-27-ALPHA  ·  Backend Server  v5.0
 *  PostgreSQL edition — data survives forever, like big companies
 * ═══════════════════════════════════════════════════════════════
 *
 *  ENV VARS  (Render dashboard → Environment)
 *  ─────────────────────────────────────────────────────────────
 *  GROQ_API_KEY      your Groq key gsk_xxxx           (required)
 *  DATABASE_URL      Render PostgreSQL URL             (required)
 *  PORT              server port (default 3000)        (optional)
 *  ALLOWED_ORIGIN    your Netlify URL or *             (optional)
 *  SELF_URL          your Render URL for keep-alive   (optional)
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const compression = require('compression');
const { Pool }   = require('pg');
const https      = require('https');
const http       = require('http');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const app  = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const GROQ_KEY       = process.env.GROQ_API_KEY   || '';
const SELF_URL       = process.env.SELF_URL        || '';
const VERSION        = '5.0.0';
const START_TIME     = Date.now();

// ════════════════════════════════════════════════════════════════
//  DATABASE SETUP  (PostgreSQL via Render free tier)
// ════════════════════════════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }   // required for Render PostgreSQL
    : false,
  max: 5,                             // max connections (free tier limit)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Create table on startup if it doesn't exist
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_data (
        uid         TEXT PRIMARY KEY,
        data        JSONB NOT NULL DEFAULT '{}',
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS user_data_uid_idx ON user_data(uid);
    `);
    console.log('✅  Database ready');
  } catch (err) {
    console.error('❌  Database init failed:', err.message);
    console.error('    Make sure DATABASE_URL is set in Render environment');
  }
}

// ════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ════════════════════════════════════════════════════════════════
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin         : ALLOWED_ORIGIN,
  methods        : ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders : ['Content-Type', 'X-User-ID'],
}));
app.options('*', cors());

// Compact request logger
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    const icon = res.statusCode >= 400 ? '⚠' : '→';
    console.log(`${icon} ${req.method} ${req.path} ${res.statusCode} (${Date.now()-t}ms)`);
  });
  next();
});

// ── Rate limiters ─────────────────────────────────────────────
const aiLimiter     = rateLimit({ windowMs: 60_000, max: 60,  message: { error: 'Too many AI requests ⚡' } });
const searchLimiter = rateLimit({ windowMs: 60_000, max: 120, message: { error: 'Too many search requests' } });
const dataLimiter   = rateLimit({ windowMs: 60_000, max: 300, message: { error: 'Too many data requests' } });

// ════════════════════════════════════════════════════════════════
//  HEALTH + WAKE
// ════════════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try { await pool.query('SELECT 1'); dbOk = true; } catch (e) {}
  res.json({
    status    : 'ok',
    version   : VERSION,
    groqReady : !!GROQ_KEY,
    dbReady   : dbOk,
    uptimeSec : Math.floor((Date.now() - START_TIME) / 1000),
    ts        : new Date().toISOString(),
  });
});

app.get('/api/wake', (req, res) => res.json({ awake: true, ts: Date.now() }));

// ════════════════════════════════════════════════════════════════
//  AI PROXY  →  Groq
// ════════════════════════════════════════════════════════════════
app.post('/api/ai', aiLimiter, async (req, res) => {
  if (!GROQ_KEY) return res.status(503).json({ error: 'GROQ_API_KEY not set on server' });

  const {
    messages,
    systemPrompt,
    model       = 'llama-3.3-70b-versatile',
    maxTokens   = 1200,
    temperature = 0.4,
    stream      = false,
  } = req.body;

  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: 'messages array required' });

  const clean = messages
    .filter(m => m && typeof m.content === 'string')
    .slice(0, 40)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 8000) }));

  const body = {
    model,
    max_tokens : Math.min(maxTokens, 4096),
    temperature: Math.min(Math.max(temperature, 0), 2),
    messages   : systemPrompt
      ? [{ role: 'system', content: systemPrompt.slice(0, 4000) }, ...clean]
      : clean,
    stream,
  };

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();
      const gr = https.request({
        hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      }, r => { r.pipe(res); r.on('end', () => res.end()); });
      gr.on('error', e => { res.write(`data: {"error":"${e.message}"}\n\n`); res.end(); });
      gr.write(JSON.stringify(body)); gr.end();
    } else {
      const data = await fetchJSON('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify(body),
      });
      res.json({ content: data.choices?.[0]?.message?.content || '', usage: data.usage });
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  SEARCH PROXY  →  Wikipedia + DuckDuckGo
// ════════════════════════════════════════════════════════════════
app.get('/api/search', searchLimiter, async (req, res) => {
  const { q = '', type = 'web' } = req.query;
  if (!q.trim()) return res.status(400).json({ error: 'q param required' });
  const query = q.trim().slice(0, 200);

  try {
    if (type === 'wiki') {
      const d = await fetchJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(query)}&srlimit=6&format=json&origin=*`);
      return res.json({ results: d.query?.search || [], type: 'wiki' });
    }
    if (type === 'wiki-summary') {
      const d = await fetchJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(query.replace(/ /g,'_'))}`);
      return res.json({ summary: d, type: 'wiki-summary' });
    }
    if (type === 'ddg') {
      const d = await fetchJSON(`https://api.duckduckgo.com/?q=${enc(query)}&format=json&no_html=1&skip_disambig=1`);
      return res.json({ result: d, type: 'ddg' });
    }
    // default: combined
    const [ddg, wikiSum, wikiSearch] = await Promise.allSettled([
      fetchJSON(`https://api.duckduckgo.com/?q=${enc(query)}&format=json&no_html=1&skip_disambig=1`),
      fetchJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(query.replace(/ /g,'_'))}`),
      fetchJSON(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${enc(query)}&limit=5&format=json&origin=*`),
    ]);
    res.json({
      type: 'web',
      ddg        : ddg.status      === 'fulfilled' ? ddg.value      : null,
      wikiSummary: wikiSum.status  === 'fulfilled' ? wikiSum.value  : null,
      wikiSearch : wikiSearch.status=== 'fulfilled' ? wikiSearch.value : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  DATA  →  PostgreSQL  (replaces JSON files)
//
//  Table: user_data
//  Columns: uid (text PK), data (jsonb), updated_at (timestamptz)
//
//  Every user gets ONE row. Their data is a JSON object.
//  This is exactly how companies like Notion store user settings.
// ════════════════════════════════════════════════════════════════

// Sanitise uid — alphanumeric + _ - only, max 72 chars
function safeUid(uid) {
  const s = String(uid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 72);
  if (!s) throw Object.assign(new Error('Invalid user ID'), { status: 400 });
  return s;
}

// GET all data for a user
app.get('/api/data/:uid', dataLimiter, async (req, res) => {
  try {
    const uid = safeUid(req.params.uid);
    const { rows } = await pool.query(
      'SELECT data FROM user_data WHERE uid = $1', [uid]
    );
    if (!rows.length) return res.json({ data: {}, exists: false });
    res.json({ data: rows[0].data, exists: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET single key for a user
app.get('/api/data/:uid/:key', dataLimiter, async (req, res) => {
  try {
    const uid = safeUid(req.params.uid);
    const key = req.params.key.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64);
    const { rows } = await pool.query(
      `SELECT data->$2 AS value FROM user_data WHERE uid = $1`, [uid, key]
    );
    res.json({ value: rows[0]?.value ?? null });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST merge data for a user (upsert)
app.post('/api/data/:uid', dataLimiter, async (req, res) => {
  try {
    const uid  = safeUid(req.params.uid);
    const body = req.body;
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'JSON body required' });

    await pool.query(`
      INSERT INTO user_data (uid, data, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (uid) DO UPDATE
        SET data = user_data.data || $2::jsonb,
            updated_at = NOW()
    `, [uid, JSON.stringify(body)]);

    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST batch sync (called every 60s by client-integration.js)
app.post('/api/sync', dataLimiter, async (req, res) => {
  const { uid: rawUid, data } = req.body;
  if (!rawUid || !data || typeof data !== 'object')
    return res.status(400).json({ error: 'uid and data required' });

  try {
    const uid = safeUid(rawUid);

    // Handle deletions (null values) separately
    const toSet = {};
    const toDelete = [];
    Object.entries(data).forEach(([k, v]) => {
      if (v === null) toDelete.push(k);
      else toSet[k] = v;
    });

    // Upsert non-null values
    if (Object.keys(toSet).length) {
      await pool.query(`
        INSERT INTO user_data (uid, data, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (uid) DO UPDATE
          SET data = user_data.data || $2::jsonb,
              updated_at = NOW()
      `, [uid, JSON.stringify(toSet)]);
    }

    // Delete null-marked keys using jsonb - operator
    if (toDelete.length) {
      await pool.query(`
        UPDATE user_data
        SET data = data - $2::text[],
            updated_at = NOW()
        WHERE uid = $1
      `, [uid, toDelete]);
    }

    res.json({ ok: true, saved: Object.keys(toSet).length, deleted: toDelete.length });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE all data for a user
app.delete('/api/data/:uid', dataLimiter, async (req, res) => {
  try {
    const uid = safeUid(req.params.uid);
    await pool.query('DELETE FROM user_data WHERE uid = $1', [uid]);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  404 + ERROR HANDLER
// ════════════════════════════════════════════════════════════════
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════
initDB().then(() => {
  // ═══════════════════════════════════════════════════════════════
//  DSB-27 OTP Routes — paste this into your Express server
//  Uses Resend.com (free: 3000 emails/month, no credit card)
//
//  SETUP:
//  1. npm install resend
//  2. Set env var:  RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
//     (get it from https://resend.com → API Keys)
//  3. In Resend dashboard → Domains → verify your domain
//     OR use Resend's free sandbox: onboarding@resend.dev (sends to your own email only)
//  4. Paste these routes into your server before app.listen()
// ═══════════════════════════════════════════════════════════════

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// In-memory OTP store  (for production, swap with Redis or your DB)
// Structure: { [token]: { email, code, expires } }
const otpStore = new Map();

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function genToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function cleanupExpired() {
  const now = Date.now();
  for (const [token, rec] of otpStore) {
    if (rec.expires < now) otpStore.delete(token);
  }
}

// ── POST /api/send-otp ────────────────────────────────────────
// Body: { email: string }
// Returns: { success: true, token: string }
async function sendOtpHandler(req, res) {
  const { email } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  // Rate limit: max 3 OTPs per email per 10 minutes
  cleanupExpired();
  const recentCount = [...otpStore.values()].filter(
    r => r.email === email.toLowerCase() && r.expires > Date.now()
  ).length;
  if (recentCount >= 3) {
    return res.status(429).json({ error: 'Too many requests. Wait a few minutes.' });
  }

  const code  = genOtp();
  const token = genToken();
  const expires = Date.now() + 10 * 60 * 1000; // 10 minutes

  otpStore.set(token, { email: email.toLowerCase(), code, expires });

  try {
    await resend.emails.send({
      from   : 'DSB-27 <otp@yourdomain.com>',   // ← change to your verified Resend domain
      // For sandbox testing use: 'onboarding@resend.dev'
      to     : [email],
      subject: 'Your DSB-27 Verification Code',
      html   : `
        <div style="font-family:monospace;background:#05070f;color:#e0e8ff;padding:32px;border-radius:16px;max-width:480px;margin:0 auto">
          <div style="font-size:11px;letter-spacing:.2em;color:#5a78ff;margin-bottom:8px">DSB · COMMAND CENTER · SECURE ACCESS</div>
          <div style="font-size:28px;font-weight:900;letter-spacing:.05em;margin-bottom:24px">DSB&#8209;27 ALPHA</div>
          <div style="font-size:13px;color:#8a96c0;margin-bottom:20px;line-height:1.6">
            Your one-time verification code is:
          </div>
          <div style="font-size:48px;font-weight:900;letter-spacing:.18em;color:#00eeff;text-align:center;
                      background:#0d1120;border:1px solid rgba(0,238,255,0.25);border-radius:12px;
                      padding:16px;margin-bottom:20px;text-shadow:0 0 24px rgba(0,238,255,0.5)">
            ${code}
          </div>
          <div style="font-size:11px;color:#4a5580;line-height:1.7">
            This code expires in <strong style="color:#8a96c0">10 minutes</strong>.<br>
            If you didn't request this, you can safely ignore it.
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('[DSB27 OTP] Resend error:', err);
    return res.status(500).json({ error: 'Failed to send email. Try again.' });
  }

  return res.json({ success: true, token });
}

// ── POST /api/verify-otp ──────────────────────────────────────
// Body: { email: string, code: string, token: string }
// Returns: { valid: true } or 400 { error, valid: false }
function verifyOtpHandler(req, res) {
  const { email, code, token } = req.body || {};

  if (!email || !code || !token) {
    return res.status(400).json({ valid: false, error: 'Missing fields' });
  }

  const rec = otpStore.get(token);

  if (!rec) {
    return res.status(400).json({ valid: false, error: 'Code expired or invalid. Request a new one.' });
  }
  if (rec.expires < Date.now()) {
    otpStore.delete(token);
    return res.status(400).json({ valid: false, error: 'Code has expired. Please request a new one.' });
  }
  if (rec.email !== email.toLowerCase() || rec.code !== code) {
    return res.status(400).json({ valid: false, error: 'Incorrect code. Please try again.' });
  }

  // ✓ Valid — delete so it can't be reused
  otpStore.delete(token);
  return res.json({ valid: true });
}

// ── Mount routes ──────────────────────────────────────────────
// Call this function with your Express `app` instance:
//
//   const { mountOtpRoutes } = require('./otp-routes');
//   mountOtpRoutes(app);
//
function mountOtpRoutes(app) {
  app.post('/api/send-otp',   sendOtpHandler);
  app.post('/api/verify-otp', verifyOtpHandler);
  console.log('[DSB27] OTP routes mounted: POST /api/send-otp, POST /api/verify-otp');
}

module.exports = { mountOtpRoutes, sendOtpHandler, verifyOtpHandler };
  app.listen(PORT, () => {
    console.log(`\n⚡  DSB-27 Backend v${VERSION}  →  http://localhost:${PORT}`);
    console.log(`   GROQ_API_KEY  : ${GROQ_KEY ? '✅ (' + GROQ_KEY.slice(0,8) + '…)' : '❌ NOT SET'}`);
    console.log(`   DATABASE_URL  : ${process.env.DATABASE_URL ? '✅ connected' : '❌ NOT SET'}`);
    console.log(`   ALLOWED_ORIGIN: ${ALLOWED_ORIGIN}`);
    console.log(`   SELF_URL      : ${SELF_URL || '(keep-alive disabled)'}\n`);

    if (SELF_URL) {
      setInterval(() => {
        try {
          const url = new URL(`${SELF_URL}/api/wake`);
          const mod = url.protocol === 'https:' ? https : http;
          mod.get({ hostname: url.hostname, path: url.pathname, timeout: 5000 }, r => {
            console.log(`[keep-alive] → ${r.statusCode}`);
          }).on('error', e => console.warn('[keep-alive] failed:', e.message));
        } catch (e) {}
      }, 14 * 60 * 1000);
      console.log(`🏓  Keep-alive → pinging every 14 min`);
    }
  });
});

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
function enc(s) { return encodeURIComponent(s); }

function fetchJSON(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const req = https.request({
      hostname: p.hostname,
      path    : p.pathname + p.search,
      method  : opts.method || 'GET',
      headers : { 'User-Agent': `DSB27/${VERSION}`, 'Accept': 'application/json', ...opts.headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode >= 400) return reject(Object.assign(new Error(data.error?.message || `HTTP ${res.statusCode}`), { status: res.statusCode }));
          resolve(data);
        } catch { reject(new Error(`Non-JSON from ${p.hostname}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error(`Timeout: ${p.hostname}`)); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
