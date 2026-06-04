/**
 * Uzum Shop Intelligence — web server (Phase 3, T15/T16).
 *
 * Wraps the scanner core in an Express API + a tiny single-page frontend:
 *   GET  /                  → analyze UI (public/index.html)
 *   GET  /api/analyze?input → { shop analysis } for one pasted URL / slug
 *
 * Keeps ONE browser session alive across requests (booting per-request would
 * be slow and re-trip the captcha). The anonymous JWT expires ~6h, so the
 * session is re-booted when it gets stale.
 *
 *   npm run serve   (then open http://localhost:3000)
 */
'use strict';

const path = require('path');
const express = require('express');
const { CONFIG, bootBrowser, analyzeShop } = require('./uzum-scanner');
const store = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- single kept-alive browser session, re-booted when the JWT goes stale ---
const SESSION_TTL_MS = 5 * 60 * 60 * 1000; // 5h (< the ~6h JWT exp)
let current = null; // { session, bootedAt }
let booting = null; // in-flight boot promise (de-dupes concurrent first hits)

async function getSession() {
  const fresh = current && Date.now() - current.bootedAt < SESSION_TTL_MS;
  if (fresh) return current.session;

  if (!booting) {
    booting = (async () => {
      if (current) {
        try { await current.session.browser.close(); } catch {}
        current = null;
      }
      console.log('Booting browser session...');
      const session = await bootBrowser();
      current = { session, bootedAt: Date.now() };
      console.log('Session ready.');
      return session;
    })().finally(() => { booting = null; });
  }
  return booting;
}

// --- lightweight abuse guards for /api/analyze (it fires LIVE Uzum calls) ---
const RL_WINDOW_MS = 10_000;
const RL_MAX = 15; // per IP per window
const RL_MAX_INFLIGHT = 4; // global concurrent analyze calls
const rlHits = new Map(); // ip -> number[] timestamps
let inflight = 0;

function rateLimited(ip) {
  const now = Date.now();
  const hits = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  hits.push(now);
  rlHits.set(ip, hits);
  return hits.length > RL_MAX;
}

// classify upstream vs client errors for the right HTTP status
const isClientError = (msg) => /not found|could not parse|provide /i.test(msg || '');

app.get('/api/analyze', async (req, res) => {
  const input = (req.query.input || '').toString().trim();
  if (!input) return res.status(400).json({ ok: false, error: 'Provide ?input=<shop URL or slug>' });

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many requests — slow down.' });
  }
  if (inflight >= RL_MAX_INFLIGHT) {
    return res.status(503).json({ ok: false, error: 'Server busy — try again shortly.' });
  }

  // T19: self-quote callers can pass ?save=false to avoid writing to the CRM.
  const save = req.query.save !== 'false';
  const source = (req.query.source || 'web').toString();

  inflight++;
  try {
    const session = await getSession();
    const result = await analyzeShop(session, input);
    let tracked = null;
    if (save) {
      try {
        tracked = store.recordScan({ ...result, source });
      } catch (e) {
        console.warn(`DB record failed: ${e.message}`);
      }
    }
    res.json({ ok: true, ...result, stage: tracked?.stage ?? null, saved: !!tracked });
  } catch (err) {
    console.warn(`analyze "${input}" failed: ${err.message}`);
    // 400 for bad input (shop not found / unparseable), 502 for upstream issues.
    res.status(isClientError(err.message) ? 400 : 502).json({ ok: false, error: err.message });
  } finally {
    inflight--;
  }
});

// expose server-side config so the frontend doesn't hardcode pricing
app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    pricePerImage: CONFIG.PRICE_PER_IMAGE,
    imagesPerProduct: CONFIG.IMAGES_PER_PRODUCT,
    productsPerPage: CONFIG.PRODUCTS_PER_PAGE,
  });
});

// --- tracked shops ---
app.get('/api/shops', (req, res) => {
  res.json({ ok: true, shops: store.listShops() });
});

app.get('/api/shops/:id/history', (req, res) => {
  res.json({ ok: true, history: store.getHistory(Number(req.params.id)) });
});

// --- products across all tracked shops ---
app.get('/api/products', (req, res) => {
  const shop = req.query.shop ? Number(req.query.shop) : null;
  const q = (req.query.q || '').toString().trim();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const { total, rows } = store.listProducts({ shop, q, limit, offset });
  res.json({ ok: true, total, limit, offset, products: rows });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, sessionActive: !!current, bootedAt: current?.bootedAt ?? null });
});

const server = app.listen(CONFIG.PORT, () => {
  console.log(`Uzum scanner web UI → http://localhost:${CONFIG.PORT}`);
});

// clean shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} — shutting down.`);
    server.close();
    if (current) { try { await current.session.browser.close(); } catch {} }
    process.exit(0);
  });
}
