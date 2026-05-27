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
