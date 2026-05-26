/**
 * ═══════════════════════════════════════════════════════════════
 *  DSB-27  ·  Backend Integration Client  v4.0
 *
 *  Paste this <script> block anywhere before </body> in dsb27_lens.html
 *  OR add at the bottom:
 *
 *    <script>const BACKEND_URL='https://dsb27-backend.onrender.com'</script>
 *    <script src="client-integration.js"></script>
 * ═══════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // ── CONFIG ───────────────────────────────────────────────────
  // Priority: global BACKEND_URL variable → localhost fallback
  const BACKEND_URL = (
    (typeof window.BACKEND_URL !== 'undefined' && window.BACKEND_URL) ||
    'http://localhost:3000'
  ).replace(/\/$/, '');

  // ── User ID ──────────────────────────────────────────────────
  function getUserId() {
    try {
      const email = localStorage.getItem('dsb_user_email');
      if (email) return btoa(email).replace(/[^a-zA-Z0-9]/g, '').slice(0, 48);
    } catch (e) {}
    let id = localStorage.getItem('dsb_device_id');
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('dsb_device_id', id);
    }
    return id;
  }

  // ════════════════════════════════════════════════════════════
  //  1. AI PROXY  — routes callGroq through the backend
  // ════════════════════════════════════════════════════════════
  window.__backendAIEnabled = false;

  async function backendCallGroq(messages, systemPrompt, maxTokens, model) {
    const res = await fetch(`${BACKEND_URL}/api/ai`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ messages, systemPrompt, model, maxTokens }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Backend AI error ${res.status}`);
    }
    const data = await res.json();
    return data.content || '';
  }

  // ════════════════════════════════════════════════════════════
  //  2. WAKE PING  — hit /api/wake early to warm up Render
  // ════════════════════════════════════════════════════════════
  function wakePing() {
    fetch(`${BACKEND_URL}/api/wake`, { signal: AbortSignal.timeout(3000) })
      .catch(() => {}); // fire-and-forget, just wakes the server
  }

  // ════════════════════════════════════════════════════════════
  //  3. INIT  — health check, then wire up everything
  // ════════════════════════════════════════════════════════════
  async function initBackend() {
    // Fire a wake ping immediately (in case Render is sleeping)
    wakePing();

    try {
      const r = await fetch(`${BACKEND_URL}/api/health`, {
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) throw new Error('not ok');
      const info = await r.json();

      if (!info.groqReady) {
        console.warn('[DSB27 Backend] Server up but GROQ_API_KEY not configured.');
        showBackendToast('⚠️ Backend online but AI key not set');
        return;
      }

      // ── Override AI functions ──────────────────────────────
      window.__backendAIEnabled  = true;
      window.__origCallGroq      = window.callGroq;
      window.callGroq            = backendCallGroq;
      window.callClaude          = backendCallGroq; // alias

      // ── Hide "add your API key" banners ───────────────────
      document.querySelectorAll(
        '#chatKeyBanner, #lensKeyBanner, .aic-key-bar, .pm-api-guide'
      ).forEach(el => (el.style.display = 'none'));

      console.log(`[DSB27 Backend] ✅ Connected to ${BACKEND_URL} (v${info.version})`);
      showBackendToast('⚡ Backend connected — AI ready, no key needed!');

      startAutoSync();

    } catch (err) {
      console.info('[DSB27 Backend] Not reachable — using direct Groq key.', err.message);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  4. SEARCH PROXY  — expose as window.__backendSearch
  // ════════════════════════════════════════════════════════════
  window.__backendSearch = async function (query, type = 'web') {
    const res = await fetch(
      `${BACKEND_URL}/api/search?q=${encodeURIComponent(query)}&type=${type}`
    );
    if (!res.ok) throw new Error('Search proxy failed');
    return res.json();
  };

  // ════════════════════════════════════════════════════════════
  //  5. DATA SYNC  — persist localStorage → server every 90s
  // ════════════════════════════════════════════════════════════
  const SYNC_KEYS = [
    'dsb_profile', 'dsb_streak', 'dsb_heatmap', 'dsb_qs',
    'dsb_done_today', 'dsb_last_mark', 'dsb_checklist',
    'dsb_targets_phy', 'dsb_targets_chem', 'dsb_targets_math',
    'dsb_backlog', 'dsb_mock_scores', 'dsb_ta_saved', 'dsb_ta_wrong_log',
    'dsb_nwz_state', 'dsb_avatar', 'dsb_theme',
  ];

  async function syncToBackend() {
    if (!window.__backendAIEnabled) return;
    const uid  = getUserId();
    const data = {};
    SYNC_KEYS.forEach(k => {
      try {
        const v = localStorage.getItem(k);
        if (v !== null) data[k] = v;
      } catch (e) {}
    });
    if (!Object.keys(data).length) return;
    try {
      await fetch(`${BACKEND_URL}/api/sync`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ uid, data }),
      });
    } catch (e) { /* silent */ }
  }

  async function loadFromBackend() {
    if (!window.__backendAIEnabled) return;
    const uid = getUserId();
    try {
      const r    = await fetch(`${BACKEND_URL}/api/data/${uid}`);
      const resp = await r.json();
      if (!resp.exists) return;
      Object.entries(resp.data).forEach(([k, v]) => {
        if (k.startsWith('_')) return;
        const local = localStorage.getItem(k);
        if (!local && v !== null) {
          try { localStorage.setItem(k, v); } catch (e) {}
        }
      });
      console.log('[DSB27 Backend] Data restored from server ✅');
    } catch (e) { /* silent */ }
  }

  function startAutoSync() {
    loadFromBackend();
    setInterval(syncToBackend, 90_000);
    window.addEventListener('beforeunload', syncToBackend);
  }

  // ════════════════════════════════════════════════════════════
  //  TOAST HELPER
  // ════════════════════════════════════════════════════════════
  function showBackendToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position      : 'fixed',
      bottom        : '80px',
      left          : '50%',
      transform     : 'translateX(-50%)',
      background    : 'rgba(0,230,118,0.12)',
      border        : '1px solid rgba(0,230,118,0.4)',
      borderRadius  : '20px',
      padding       : '8px 20px',
      fontFamily    : "'JetBrains Mono', monospace",
      fontSize      : '10px',
      color         : '#00e676',
      letterSpacing : '.1em',
      zIndex        : '9999999',
      backdropFilter: 'blur(10px)',
      pointerEvents : 'none',
      opacity       : '0',
      transition    : 'opacity 0.3s ease',
    });
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 4000);
  }

  // ════════════════════════════════════════════════════════════
  //  BOOT
  // ════════════════════════════════════════════════════════════
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBackend);
  } else {
    setTimeout(initBackend, 300); // slight delay lets the app JS load first
  }

})();
