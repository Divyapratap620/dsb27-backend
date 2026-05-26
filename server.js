/**
 * ═══════════════════════════════════════════════════════════════
 *  DSB-27-ALPHA  ·  Backend Server  v4.0
 *  Free-tier ready · Render / Railway / Glitch / Local
 * ═══════════════════════════════════════════════════════════════
 *
 *  FEATURES
 *  ─────────
 *  1. /api/ai          – Groq LLM proxy (key never reaches browser)
 *  2. /api/search      – Wikipedia + DuckDuckGo proxy (fixes CORS)
 *  3. /api/data/:uid   – Per-user JSON persistence (GET / POST)
 *  4. /api/sync        – Batch-save multiple localStorage keys
 *  5. /api/health      – Health check + uptime ping
 *  6. /api/wake        – Wakes the server (free-tier cold start)
 *  7. Rate limiting    – 60 AI req/min, 120 search/min, 200 data/min
 *  8. Keep-alive ping  – Self-pings every 14 min to avoid Render sleep
 *  9. Static HTML      – Serves dsb27_lens.html if placed next to server
 *
 *  ENV VARS  (Render / Railway dashboard or .env file)
 *  ─────────────────────────────────────────────────────────────
 *  GROQ_API_KEY      your Groq key  gsk_xxxx            (required)
 *  PORT              server port    (default 3000)       (optional)
 *  ALLOWED_ORIGIN    your front-end URL or *             (optional)
 *  DATA_DIR          folder for JSON data files          (optional)
 *  SELF_URL          your deployed URL for keep-alive    (optional)
 *                    e.g. https://dsb27-backend.onrender.com
 */

'use strict';

const express     = require('express');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const compression = require('compression');
const path        = require('path');
const fs          = require('fs');
const https       = require('https');
const http        = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const GROQ_KEY       = process.env.GROQ_API_KEY   || '';
const DATA_DIR       = process.env.DATA_DIR        || path.join(__dirname, 'data');
const SELF_URL       = process.env.SELF_URL        || '';
const VERSION        = '4.0.0';

// Uptime counter
const START_TIME = Date.now();

// ── Ensure data directory exists ──────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ════════════════════════════════════════════════════════════════
app.set('trust proxy', 1);   // needed for rate limiter behind Render/Railway proxy
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin : ALLOWED_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-User-ID', 'X-DSB-Token'],
}));
app.options('*', cors());

// ── Request logger (compact) ──────────────────────────────────────
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t;
    const icon = res.statusCode >= 400 ? '⚠' : '→';
    console.log(`${icon} ${req.method} ${req.path} ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ── Rate limiters ─────────────────────────────────────────────────
const aiLimiter = rateLimit({
  windowMs       : 60_000,
  max            : 60,
  message        : { error: 'Too many AI requests — slow down! ⚡' },
  standardHeaders: true,
  legacyHeaders  : false,
});

const searchLimiter = rateLimit({
  windowMs: 60_000,
  max     : 120,
  message : { error: 'Too many search requests.' },
});

const dataLimiter = rateLimit({
  windowMs: 60_000,
  max     : 200,
  message : { error: 'Too many data requests.' },
});

// ════════════════════════════════════════════════════════════════
//  HEALTH  +  WAKE
// ════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status    : 'ok',
    version   : VERSION,
    app       : 'DSB-27-ALPHA',
    ts        : new Date().toISOString(),
    uptimeSec : Math.floor((Date.now() - START_TIME) / 1000),
    groqReady : !!GROQ_KEY,
    dataDir   : DATA_DIR,
  });
});

// Lightweight wake endpoint — hit this from client to avoid cold-start lag
app.get('/api/wake', (req, res) => {
  res.json({ awake: true, ts: Date.now() });
});

// ════════════════════════════════════════════════════════════════
//  AI PROXY  →  Groq LLM
// ════════════════════════════════════════════════════════════════
app.post('/api/ai', aiLimiter, async (req, res) => {
  if (!GROQ_KEY) {
    return res.status(503).json({
      error: 'AI not configured. Add GROQ_API_KEY to your environment variables.',
    });
  }

  const {
    messages,
    systemPrompt,
    model       = 'llama-3.3-70b-versatile',
    maxTokens   = 1200,
    temperature = 0.4,
    stream      = false,
  } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (messages.length > 40) {
    return res.status(400).json({ error: 'Too many messages (max 40)' });
  }

  // Sanitise each message
  const clean = messages
    .filter(m => m && typeof m.content === 'string')
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
      // ── Streaming SSE passthrough ───────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const groqReq = https.request({
        hostname: 'api.groq.com',
        path    : '/openai/v1/chat/completions',
        method  : 'POST',
        headers : {
          'Content-Type' : 'application/json',
          'Authorization': `Bearer ${GROQ_KEY}`,
        },
      }, (groqRes) => {
        groqRes.pipe(res);
        groqRes.on('end', () => res.end());
      });
      groqReq.on('error', (e) => {
        console.error('[AI stream error]', e.message);
        res.write(`data: {"error":"${e.message}"}\n\n`);
        res.end();
      });
      groqReq.write(JSON.stringify(body));
      groqReq.end();

    } else {
      // ── Normal JSON response ───────────────────────────────────
      const groqRes = await fetchJSON('https://api.groq.com/openai/v1/chat/completions', {
        method : 'POST',
        headers: {
          'Content-Type' : 'application/json',
          'Authorization': `Bearer ${GROQ_KEY}`,
        },
        body: JSON.stringify(body),
      });

      res.json({
        content: groqRes.choices?.[0]?.message?.content || '',
        usage  : groqRes.usage,
        model  : groqRes.model,
      });
    }
  } catch (err) {
    console.error('[AI]', err.message);
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
    switch (type) {
      case 'wiki': {
        const data = await fetchJSON(
          `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(query)}&srlimit=6&format=json&origin=*`
        );
        return res.json({ results: data.query?.search || [], type: 'wiki' });
      }

      case 'wiki-summary': {
        const data = await fetchJSON(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${enc(query.replace(/ /g,'_'))}`
        );
        return res.json({ summary: data, type: 'wiki-summary' });
      }

      case 'ddg': {
        const data = await fetchJSON(
          `https://api.duckduckgo.com/?q=${enc(query)}&format=json&no_html=1&skip_disambig=1`
        );
        return res.json({ result: data, type: 'ddg' });
      }

      default: {
        // Combined web search — parallel requests
        const [ddg, wikiSummary, wikiSearch] = await Promise.allSettled([
          fetchJSON(`https://api.duckduckgo.com/?q=${enc(query)}&format=json&no_html=1&skip_disambig=1`),
          fetchJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(query.replace(/ /g,'_'))}`),
          fetchJSON(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${enc(query)}&limit=5&format=json&origin=*`),
        ]);

        return res.json({
          type       : 'web',
          ddg        : ddg.status        === 'fulfilled' ? ddg.value        : null,
          wikiSummary: wikiSummary.status === 'fulfilled' ? wikiSummary.value : null,
          wikiSearch : wikiSearch.status  === 'fulfilled' ? wikiSearch.value  : null,
        });
      }
    }
  } catch (err) {
    console.error('[SEARCH]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  DATA PERSISTENCE  →  per-user JSON files
// ════════════════════════════════════════════════════════════════
function safeDataPath(uid) {
  const safe = uid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safe) throw new Error('Invalid user ID');
  return path.join(DATA_DIR, `${safe}.json`);
}

function readUserData(uid) {
  const p = safeDataPath(uid);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function writeUserData(uid, data) {
  const str = JSON.stringify(data);
  if (str.length > 512 * 1024) throw Object.assign(new Error('Data too large (max 512KB)'), { status: 413 });
  fs.writeFileSync(safeDataPath(uid), str, 'utf8');
}

// GET all data for a user
app.get('/api/data/:uid', dataLimiter, (req, res) => {
  try {
    const data = readUserData(req.params.uid);
    if (!data) return res.json({ data: {}, exists: false });
    res.json({ data, exists: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// GET single key for a user
app.get('/api/data/:uid/:key', dataLimiter, (req, res) => {
  try {
    const data = readUserData(req.params.uid) || {};
    res.json({ value: data[req.params.key] ?? null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST (merge) data for a user
app.post('/api/data/:uid', dataLimiter, (req, res) => {
  try {
    const prev = readUserData(req.params.uid) || {};
    const next = { ...prev, ...req.body, _updatedAt: Date.now() };
    writeUserData(req.params.uid, next);
    res.json({ ok: true, keys: Object.keys(next).length });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// POST batch sync (client-integration.js calls this every 90s)
app.post('/api/sync', dataLimiter, (req, res) => {
  const { uid, data } = req.body;
  if (!uid || !data || typeof data !== 'object') {
    return res.status(400).json({ error: 'uid and data required' });
  }
  try {
    const prev = readUserData(uid) || {};
    const next = { ...prev, ...data, _syncAt: Date.now() };
    writeUserData(uid, next);
    res.json({ ok: true, saved: Object.keys(data).length });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// DELETE user data (GDPR / privacy)
app.delete('/api/data/:uid', dataLimiter, (req, res) => {
  try {
    const p = safeDataPath(req.params.uid);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  STATIC HTML FRONT-END (optional)
//  Drop dsb27_lens.html next to server.js and it'll be served at /
// ════════════════════════════════════════════════════════════════
const HTML_PATH = path.join(__dirname, 'dsb27_lens.html');
if (fs.existsSync(HTML_PATH)) {
  app.get('/', (req, res) => res.sendFile(HTML_PATH));
  app.get('/app', (req, res) => res.sendFile(HTML_PATH));
  console.log('🌐  Front-end → /  (dsb27_lens.html found)');
}

// ════════════════════════════════════════════════════════════════
//  404 CATCH-ALL
// ════════════════════════════════════════════════════════════════
app.use((req, res) => res.status(404).json({ error: 'Route not found', path: req.path }));

// Global error handler
app.use((err, req, res, _next) => {
  console.error('[UNHANDLED]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ════════════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n⚡  DSB-27 Backend v${VERSION}  →  http://localhost:${PORT}`);
  console.log(`   GROQ_API_KEY  : ${GROQ_KEY ? '✅ set (' + GROQ_KEY.slice(0,8) + '…)' : '❌ NOT SET — add GROQ_API_KEY env var'}`);
  console.log(`   DATA_DIR      : ${DATA_DIR}`);
  console.log(`   ALLOWED_ORIGIN: ${ALLOWED_ORIGIN}`);
  console.log(`   SELF_URL      : ${SELF_URL || '(not set — keep-alive disabled)'}`);
  console.log(`\n   Endpoints:`);
  console.log(`     GET  /api/health`);
  console.log(`     GET  /api/wake`);
  console.log(`     POST /api/ai`);
  console.log(`     GET  /api/search?q=…&type=web|wiki|ddg`);
  console.log(`     GET  /api/data/:uid`);
  console.log(`     POST /api/data/:uid`);
  console.log(`     POST /api/sync`);
  console.log(`     DEL  /api/data/:uid\n`);

  // ── Keep-alive self-ping for Render free tier ──────────────────
  // Render sleeps after 15 min inactivity. This pings /api/wake every
  // 14 minutes so the server stays awake during active study sessions.
  if (SELF_URL) {
    const pingInterval = 14 * 60 * 1000; // 14 minutes
    setInterval(() => {
      try {
        const url = new URL(`${SELF_URL}/api/wake`);
        const mod = url.protocol === 'https:' ? https : http;
        const req = mod.get({ hostname: url.hostname, path: url.pathname, timeout: 5000 }, (r) => {
          console.log(`[keep-alive] ping → ${r.statusCode}`);
        });
        req.on('error', (e) => console.warn('[keep-alive] ping failed:', e.message));
      } catch (e) {
        console.warn('[keep-alive] bad SELF_URL:', e.message);
      }
    }, pingInterval);
    console.log(`🏓  Keep-alive enabled → pinging ${SELF_URL} every 14 min`);
  } else {
    console.log(`💡  Tip: Set SELF_URL=https://your-app.onrender.com to keep free tier awake`);
  }
});

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
function enc(s) { return encodeURIComponent(s); }

/** Minimal HTTPS fetch that resolves to parsed JSON */
function fetchJSON(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path    : parsed.pathname + parsed.search,
      method  : opts.method || 'GET',
      headers : {
        'User-Agent'  : `DSB27-Backend/${VERSION}`,
        'Accept'      : 'application/json',
        ...opts.headers,
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(raw);
          if (res.statusCode >= 400) {
            const err = Object.assign(
              new Error(data.error?.message || `HTTP ${res.statusCode}`),
              { status: res.statusCode }
            );
            return reject(err);
          }
          resolve(data);
        } catch {
          reject(new Error(`Non-JSON response from ${parsed.hostname} (status ${res.statusCode})`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error(`Timeout: ${parsed.hostname}`)); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
