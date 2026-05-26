# ⚡ DSB-27-ALPHA — Backend Server v4.0

Free backend for the DSB-27 study dashboard. Handles AI proxying, web search,
and cross-device data sync — **all for $0**.

---

## What This Does

| Feature | Without Backend | With Backend |
|---------|----------------|-------------|
| AI Chat / Lens | User must paste their own Groq key | ✅ Works with no key — server has it |
| Web Search | Hits external APIs directly (CORS issues) | ✅ Server proxies all search cleanly |
| Data persistence | localStorage only (one device, cleared on browser wipe) | ✅ Saved to server, restored on any device |
| Rate limiting | Unlimited (anyone can hammer your API key) | ✅ 60 AI req/min per IP |
| Free-tier sleep | Server sleeps after 15 min inactivity (Render) | ✅ Keep-alive ping every 14 min |

---

## Deploy in 5 Minutes — Render (Free, Recommended)

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "dsb27 backend"
   gh repo create dsb27-backend --public --push
   ```

2. **Create a Render Web Service**
   - Go to [render.com](https://render.com) → **New** → **Web Service**
   - Connect your GitHub repo
   - Render auto-detects `render.yaml` — just click **Deploy**

3. **Set Environment Variables** (Render dashboard → Environment)
   | Key | Value |
   |-----|-------|
   | `GROQ_API_KEY` | `gsk_your_key_here` |
   | `ALLOWED_ORIGIN` | `*` (or your front-end URL) |
   | `DATA_DIR` | `/tmp/dsb27-data` |
   | `SELF_URL` | `https://dsb27-backend.onrender.com` (your own URL) |

4. **Your server is live!** Copy the URL (e.g. `https://dsb27-backend.onrender.com`)

> **Free tier note:** 750 hours/month. The `SELF_URL` keep-alive ping prevents
> the server from sleeping during active study sessions. First request after
> inactivity takes ~5s to wake — the client-integration fires an early wake ping
> on page load to minimize this.

---

## Other Free Platforms

### Railway
1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Add env vars: `GROQ_API_KEY`, `ALLOWED_ORIGIN`, `DATA_DIR=/tmp/dsb27-data`
3. Done — $5 free credit/month (~500 hours)

### Glitch (zero git setup)
1. [glitch.com](https://glitch.com) → **New Project** → **Import from GitHub**
2. Open `.env` in the editor and add `GROQ_API_KEY=gsk_...`
3. Your URL is `https://your-project.glitch.me` — live immediately!

### Local Development
```bash
git clone your-repo && cd dsb27-backend
npm install
cp .env.example .env    # then fill in GROQ_API_KEY
npm run dev             # hot-reload with --watch
# → http://localhost:3000
```

---

## Connect to Your Front-End

After deploying, add two lines to `dsb27_lens.html` just before `</body>`:

```html
<script>const BACKEND_URL = 'https://dsb27-backend.onrender.com'</script>
<script src="client-integration.js"></script>
```

Or if you're hosting everything on the same server (recommended), just drop
`dsb27_lens.html` next to `server.js` — it's automatically served at `/`.

**What happens:**
- Client fires a wake ping immediately on page load (warms up Render)
- Health check runs after 300ms
- If backend is up + Groq ready → AI functions are silently replaced, API key
  banners are hidden, data sync starts
- If backend is down → app falls back to user's local Groq key seamlessly

---

## API Reference

### `GET /api/health`
```json
{ "status": "ok", "version": "4.0.0", "groqReady": true, "uptimeSec": 3600 }
```

### `GET /api/wake`
Lightweight endpoint to warm up the server on cold start. The client fires this
immediately on page load before the health check.
```json
{ "awake": true, "ts": 1718000000000 }
```

### `POST /api/ai`
```json
{
  "messages":     [{ "role": "user", "content": "Explain Newton's laws" }],
  "systemPrompt": "You are a JEE tutor.",
  "model":        "llama-3.3-70b-versatile",
  "maxTokens":    1200,
  "temperature":  0.4,
  "stream":       false
}
```
Response:
```json
{ "content": "Newton's first law states…", "usage": { "total_tokens": 234 } }
```

### `GET /api/search?q=newton+laws&type=web`
`type` can be `web` (default), `wiki`, `wiki-summary`, or `ddg`.

### `GET /api/data/:uid` → `POST /api/data/:uid` → `DELETE /api/data/:uid`
Per-user JSON storage (512KB cap per user).

### `POST /api/sync`
Batch sync from client localStorage.
```json
{ "uid": "dev_abc123", "data": { "dsb_streak": "7", "dsb_profile": "{...}" } }
```

---

## Getting a Free Groq API Key

1. Go to [console.groq.com/keys](https://console.groq.com/keys)
2. Sign up free (Google or email)
3. Click **Create API Key**
4. Copy it — starts with `gsk_`
5. Paste into `GROQ_API_KEY` env var

**Free tier:** 14,400 requests/day on `llama-3.3-70b-versatile` — plenty for a
personal dashboard.

---

## File Structure

```
dsb27-backend/
├── server.js              ← Main server (all backend logic)
├── client-integration.js  ← Drop into dsb27_lens.html to connect
├── package.json
├── .env.example           ← Copy to .env and fill in values
├── .gitignore
├── render.yaml            ← One-click Render deployment config
└── data/                  ← Auto-created; stores user JSON files
                              (on Render free tier, set DATA_DIR=/tmp/…)
```

---

## Security Notes

- `GROQ_API_KEY` **never reaches the browser** — only your server calls Groq
- Rate limiting: 60 AI req/min, 120 search/min, 200 data/min per IP
- User data files are capped at 512KB each
- Path traversal protection on all file operations (`[^a-zA-Z0-9_-]` stripped)
- Set `ALLOWED_ORIGIN` to your specific front-end URL in production

---

## Changes in v4.0

- `GET /api/wake` endpoint for client-side cold-start warming
- Self-ping keep-alive every 14 min (set `SELF_URL` env var to enable)
- Request logger (compact: method + path + status + ms)
- `DELETE /api/data/:uid` for data deletion
- `app.set('trust proxy', 1)` for correct IP detection behind Render/Railway
- Improved message sanitisation (length cap, role normalisation)
- `Buffer.concat` for response body (handles binary-safe chunking)
- Client: early wake ping on page load, smoother toast fade animation
