/**
 * Uzum Shop Intelligence Scanner
 * Phase 1 — CLI lead-generation tool.
 *
 * Discovers the biggest shops on Uzum Market, counts their products,
 * calculates the image-creation opportunity, and writes a sorted Excel file.
 *
 * Run:
 *   node uzum-scanner.js
 *
 * See PRD.md and TASKS.md for the full spec.
 */

'use strict';

const fs = require('fs');
const { chromium } = require('playwright');
const XLSX = require('xlsx');

// ---------------------------------------------------------------------------
// CONFIG — tune these
// ---------------------------------------------------------------------------

// Allow env overrides for quick test runs, e.g. MAX_CATEGORIES=2 node uzum-scanner.js
const envInt = (name, fallback) =>
  process.env[name] !== undefined ? parseInt(process.env[name], 10) : fallback;

const CONFIG = {
  // Multiplier for the "Images you can create" column.
  IMAGES_PER_PRODUCT: envInt('IMAGES_PER_PRODUCT', 1),

  // ASSUMPTION (PRD didn't specify): price per generated image, for the
  // "instant quote" = imagesYouCanCreate × PRICE_PER_IMAGE. Tune to real pricing.
  PRICE_PER_IMAGE: envInt('PRICE_PER_IMAGE', 5000), // in so'm

  // Web server port (T15).
  PORT: envInt('PORT', 3000),

  // How many top categories to scan during auto-discovery.
  MAX_CATEGORIES: envInt('MAX_CATEGORIES', 10),

  // Products sampled per category (most-ordered first).
  PRODUCTS_PER_CATEGORY: envInt('PRODUCTS_PER_CATEGORY', 50),

  // How many discovered shops to keep and count.
  TOP_SHOPS_TO_KEEP: envInt('TOP_SHOPS_TO_KEEP', 40),

  // T14: drop shops with fewer than this many products from the final output.
  // 0 = disabled (keep all). PRD suggests ~50 to qualify a lead.
  MIN_PRODUCTS: envInt('MIN_PRODUCTS', 0),

  // true = watch the browser run, false = headless/silent.
  SHOW_BROWSER: true,

  // Output file written to the working directory.
  OUTPUT_FILE: 'uzum-results.xlsx',

  // Products per page on Uzum (for the "Approx. pages" sanity column).
  PRODUCTS_PER_PAGE: 24,

  // Rate limiting between API requests (random ms in this range).
  DELAY_MIN_MS: 150,
  DELAY_MAX_MS: 400,
};

// Add specific shops on top of the auto-discovered list.
// Example: { label: 'Nivea', url: 'https://uzum.uz/uz/shop/nivea-official' }
const MANUAL_SHOPS = [
  // { label: 'Nivea', url: 'https://uzum.uz/uz/seller/nivea-official' },
];

// T12: optional CSV input. If this file exists in the working dir, its rows
// are merged with MANUAL_SHOPS. Format: "label,url" per line (header optional);
// a single column is treated as the URL. URLs never contain commas, so we
// split on the LAST comma (labels may contain commas).
const MANUAL_SHOPS_CSV = 'manual-shops.csv';

/** Load manual-shop entries from MANUAL_SHOPS_CSV if present. */
function loadCsvShops() {
  if (!fs.existsSync(MANUAL_SHOPS_CSV)) return [];
  const lines = fs
    .readFileSync(MANUAL_SHOPS_CSV, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const out = [];
  for (const line of lines) {
    // skip a header row
    if (/^\s*(label|name)\s*,\s*url\s*$/i.test(line)) continue;
    const lastComma = line.lastIndexOf(',');
    let label, url;
    if (lastComma === -1) {
      url = line;
      label = '';
    } else {
      label = line.slice(0, lastComma).trim().replace(/^"|"$/g, '');
      url = line.slice(lastComma + 1).trim().replace(/^"|"$/g, '');
    }
    if (url) out.push({ label: label || url, url });
  }
  if (out.length) console.log(`T12: loaded ${out.length} shop(s) from ${MANUAL_SHOPS_CSV}.`);
  return out;
}

// ---------------------------------------------------------------------------
// Endpoints (update here if Uzum changes them — see PRD Risk table)
// ---------------------------------------------------------------------------

// Real hosts confirmed via network capture (T2): PRD's api.umarket.uz was
// wrong — live frontend uses api.uzum.uz + graphql.uzum.uz.
const ENDPOINTS = {
  ROOT_CATEGORIES: 'https://api.uzum.uz/api/main/root-categories',
  PRODUCT_DETAIL: (id) => `https://api.uzum.uz/api/v2/product/${id}`,
  // T7-verified: resolves a shop slug → { payload: { id, title, link, ... } }.
  SHOP_BY_SLUG: (slug) => `https://api.uzum.uz/api/shop/${slug}`,
  GRAPHQL: 'https://graphql.uzum.uz/',
};

// Slim makeSearch query (T3-verified). The SPA's real query is ~5KB of
// fragments we don't need; the server accepts any valid field subset, so we
// request only productId/title/total. Same operationName the SPA uses.
const MAKE_SEARCH_OP = 'MakeSearch_ItemsAndFilters';
const MAKE_SEARCH_QUERY = `query MakeSearch_ItemsAndFilters($queryInput: MakeSearchQueryInput!) {
  makeSearch(query: $queryInput) {
    total
    items {
      catalogCard {
        productId
        title
        minSellPrice
        __typename
      }
      __typename
    }
    __typename
  }
}`;

// Default makeSearch input. Override categoryId / shopId / pagination per call.
const MAKE_SEARCH_BASE_INPUT = {
  showAdultContent: 'NONE',
  filters: [],
  sort: 'BY_ORDERS_NUMBER_DESC', // T3-verified enum: most-ordered first
  pagination: { offset: 0, limit: 0 },
  correctQuery: false,
  getFastCategories: false,
  getPromotionItems: false,
  getFastFacets: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Random rate-limit delay between requests. */
function rateLimit() {
  const { DELAY_MIN_MS, DELAY_MAX_MS } = CONFIG;
  const ms = DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
  return sleep(ms);
}

// Transient failures worth retrying: DNS/network flakes (seen: ENOTFOUND),
// rate limiting (429), and gateway errors (5xx).
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
const isTransientError = (msg) =>
  /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|Timeout/i.test(msg || '');

/**
 * POST/GET via context.request with retry + exponential backoff on transient
 * failures. Always rate-limits before each attempt. Returns the APIResponse;
 * callers handle body parsing. Throws after RETRY_MAX exhausted.
 */
async function requestWithRetry(session, url, fetchOptions, label) {
  const RETRY_MAX = 3;
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    await rateLimit();
    try {
      const res = await session.context.request.fetch(url, fetchOptions);
      if (TRANSIENT_STATUS.has(res.status()) && attempt < RETRY_MAX) {
        const backoff = 1000 * 2 ** (attempt - 1);
        console.warn(`  ~ ${label} HTTP ${res.status()} (attempt ${attempt}/${RETRY_MAX}) — retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (isTransientError(err.message) && attempt < RETRY_MAX) {
        const backoff = 1000 * 2 ** (attempt - 1);
        console.warn(`  ~ ${label} ${err.message.slice(0, 60)} (attempt ${attempt}/${RETRY_MAX}) — retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`${label} failed after ${RETRY_MAX} attempts`);
}

// ---------------------------------------------------------------------------
// Browser boot + auth (T2)
// ---------------------------------------------------------------------------

// uzum.uz origin used for the session/auth context that apiFetch inherits.
const SITE_URL = 'https://uzum.uz/';

/**
 * Launch Chromium and open uzum.uz, then sniff the auth headers the SPA
 * attaches to its own API calls (an anonymous "Bearer" JWT minted by Uzum ID
 * plus an x-iid install id). Those headers are reused by apiFetch so our
 * requests look identical to the site's — the only way past the API's
 * bad-request-001 rejection of unauthenticated calls.
 *
 * NOTE: headless triggers Yandex SmartCaptcha, so keep SHOW_BROWSER=true.
 *
 * Returns a session { browser, context, page, headers, gqlHeaders }.
 * Caller closes browser.
 */
async function bootBrowser() {
  const browser = await chromium.launch({
    headless: !CONFIG.SHOW_BROWSER,
  });

  const context = await browser.newContext({
    locale: 'uz-UZ',
    // Real-ish UA so Uzum's edge doesn't reject the session outright.
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Capture two header sets off the SPA's own traffic:
  //  - REST auth (Bearer JWT + x-iid) from any api.uzum.uz call
  //  - the FULL GraphQL header set from a real makeSearch POST. The search
  //    gateway 429s any POST missing apollographql-client-name / city-* —
  //    so we must replay the exact headers Chrome sends, not a hand-built set.
  const captured = {};
  let gqlHeaders = null;
  let resolveAuth;
  const authReady = new Promise((r) => (resolveAuth = r));

  context.on('request', (req) => {
    const h = req.headers();
    if (!captured.authorization && req.url().includes('api.uzum.uz') && h['authorization']) {
      captured.authorization = h['authorization'];
      if (h['x-iid']) captured['x-iid'] = h['x-iid'];
      resolveAuth();
    }
    if (
      !gqlHeaders &&
      req.url().includes('graphql.uzum.uz') &&
      req.method() === 'POST' &&
      /makeSearch/.test(req.postData() || '')
    ) {
      gqlHeaders = { ...h };
      delete gqlHeaders['content-length'];
      delete gqlHeaders['host'];
    }
  });

  console.log(`Opening ${SITE_URL} ...`);
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await Promise.race([authReady, sleep(10000)]);

  if (!captured.authorization) {
    throw new Error(
      'Could not capture auth headers from uzum.uz — site may have blocked ' +
        'the session (captcha?). Ensure SHOW_BROWSER=true.'
    );
  }

  // Trigger a real makeSearch by visiting a category page, to harvest the
  // full GraphQL header set the gateway requires.
  if (!gqlHeaders) {
    const catHref = await page.evaluate(() => {
      const a = document.querySelector('a[href*="/category/"]');
      return a ? a.href : null;
    });
    if (catHref) {
      await page.goto(catHref, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await sleep(3000);
    }
  }

  if (!gqlHeaders) {
    throw new Error('Could not capture GraphQL headers — makeSearch never fired.');
  }

  console.log('Session ready — REST + GraphQL headers captured.');
  return { browser, context, page, headers: captured, gqlHeaders };
}

/**
 * Run a makeSearch GraphQL query. Pass { categoryId } or { shopId } plus any
 * pagination/sort override; merged over MAKE_SEARCH_BASE_INPUT.
 *
 * @param {{context: import('playwright').BrowserContext, gqlHeaders: object}} session
 * @param {object} inputOverride - merged into the queryInput.
 * @returns {Promise<{total: number, items: Array}>} the makeSearch payload.
 */
async function graphqlSearch(session, inputOverride = {}) {
  const body = JSON.stringify({
    operationName: MAKE_SEARCH_OP,
    query: MAKE_SEARCH_QUERY,
    variables: { queryInput: { ...MAKE_SEARCH_BASE_INPUT, ...inputOverride } },
  });

  // The search gateway signals throttling as HTTP 200 with a 429/Too Many
  // Requests entry in the GraphQL `errors` array — so requestWithRetry (which
  // only sees the transport status 200) can't catch it. Retry it here.
  const MAX = 4;
  let lastErrText = '';
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const res = await requestWithRetry(
      session,
      ENDPOINTS.GRAPHQL,
      { method: 'POST', headers: session.gqlHeaders, data: body },
      'makeSearch'
    );
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`makeSearch non-JSON (HTTP ${res.status()}): ${text.slice(0, 200)}`);
    }

    if (json.errors) {
      lastErrText = JSON.stringify(json.errors).slice(0, 300);
      if (/429|Too Many Requests/i.test(lastErrText) && attempt < MAX) {
        const backoff = 1000 * 2 ** (attempt - 1);
        console.warn(`  ~ makeSearch gateway-throttled (attempt ${attempt}/${MAX}) — retry in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw new Error(`makeSearch errors: ${lastErrText}`);
    }
    if (!json.data?.makeSearch) {
      throw new Error(`makeSearch returned no data: ${text.slice(0, 200)}`);
    }
    return json.data.makeSearch;
  }
  throw new Error(`makeSearch throttled after ${MAX} attempts: ${lastErrText}`);
}

/**
 * Fetch a URL using the browser context's request API. Runs Node-side but
 * shares the context's cookie jar, so it inherits the site's session/auth
 * without being subject to browser CORS rules (which block a cross-origin
 * page.evaluate fetch from uzum.uz → api.uzum.uz).
 *
 * @param {{context: import('playwright').BrowserContext, headers: object}} session
 * @param {string} url
 * @param {object} [options] - { method, headers, body }.
 *   body may be an object (auto JSON.stringified) or a string.
 * @returns {Promise<any>} parsed JSON (falls back to raw text on non-JSON).
 */
async function apiFetch(session, url, options = {}) {
  const headers = {
    Accept: 'application/json',
    // Uzum's API segments responses by language / app surface.
    'Accept-Language': 'uz-UZ',
    Referer: SITE_URL,
    Origin: SITE_URL.replace(/\/$/, ''),
    // Real auth captured at boot (Bearer JWT + x-iid).
    ...session.headers,
    ...(options.headers || {}),
  };

  const method = (options.method || 'GET').toUpperCase();
  const reqOpts = { method, headers };

  if (options.body !== undefined) {
    // Playwright's `data` accepts an object (auto-serialized) or a string.
    reqOpts.data = options.body;
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  const res = await requestWithRetry(session, url, reqOpts, `GET ${url.slice(0, 60)}`);
  const text = await res.text();

  if (!res.ok()) {
    throw new Error(
      `apiFetch ${url} → HTTP ${res.status()}: ${text.slice(0, 300)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return text; // non-JSON — hand back raw for T3 debugging
  }
}

// ---------------------------------------------------------------------------
// T4 — category discovery
// ---------------------------------------------------------------------------

/**
 * Pull root categories and keep the top MAX_CATEGORIES.
 * root-categories returns Uzum's own merchandising order, used as a proxy for
 * "biggest" categories (PRD has no better signal in Phase 1).
 *
 * @returns {Promise<Array<{id: number, title: string}>>}
 */
async function discoverCategories(session) {
  const raw = await apiFetch(session, ENDPOINTS.ROOT_CATEGORIES);
  const list = Array.isArray(raw) ? raw : raw?.payload ?? [];
  const top = list
    .filter((c) => c && c.id)
    .slice(0, CONFIG.MAX_CATEGORIES)
    .map((c) => ({ id: c.id, title: c.title }));
  // Risk #1 fallback: if the shape drifted and we got nothing, dump the raw
  // top-level keys so the field-name change is obvious instead of silent.
  if (top.length === 0) {
    console.error(
      'T4: NO categories parsed — response shape may have drifted. Raw top-level:',
      Array.isArray(raw) ? `array(${raw.length})` : JSON.stringify(raw).slice(0, 400)
    );
    throw new Error('root-categories returned no usable categories');
  }
  console.log(`T4: ${list.length} root categories → keeping top ${top.length}.`);
  return top;
}

// ---------------------------------------------------------------------------
// T5 — product sampling
// ---------------------------------------------------------------------------

/**
 * Fetch the top PRODUCTS_PER_CATEGORY most-ordered products for a category.
 *
 * @returns {Promise<Array<{productId: number, title: string}>>}
 */
async function sampleProducts(session, categoryId) {
  const search = await graphqlSearch(session, {
    categoryId: String(categoryId),
    pagination: { offset: 0, limit: CONFIG.PRODUCTS_PER_CATEGORY },
  });
  return (search.items || [])
    .map((it) => it.catalogCard)
    .filter((c) => c && c.productId)
    .map((c) => ({ productId: c.productId, title: c.title }));
}

// ---------------------------------------------------------------------------
// T6 — shop resolution + ranking
// ---------------------------------------------------------------------------

/**
 * Resolve the shop behind a product via the product-detail API.
 * Shape (T3): payload.data.seller = { id, title, link (slug), ... }.
 *
 * @returns {Promise<{id, title, link} | null>} null on failure (logged).
 */
async function resolveShop(session, productId) {
  try {
    const prod = await apiFetch(session, ENDPOINTS.PRODUCT_DETAIL(productId));
    const seller = prod?.payload?.data?.seller;
    if (!seller?.id) return null;
    return {
      id: seller.id,
      title: seller.title,
      link: seller.link,
      rating: seller.rating ?? null, // T11: seller rating (e.g. 4.9)
      orders: seller.orders ?? null, // T11: lifetime order count
    };
  } catch (err) {
    console.warn(`  ! product ${productId} shop lookup failed: ${err.message}`);
    return null;
  }
}

/**
 * Walk top categories → top products → shops, counting how often each shop
 * appears across the sampled top-products, then rank and keep TOP_SHOPS_TO_KEEP.
 *
 * @returns {Promise<Array<{id, title, link, appears: number}>>}
 *   sorted by appearance count desc.
 */
async function discoverTopShops(session, categories) {
  const shops = new Map(); // shopId -> { id, title, link, appears }

  for (const cat of categories) {
    const products = await sampleProducts(session, cat.id);
    console.log(`T5: category ${cat.id}/${cat.title} → ${products.length} products`);

    for (const p of products) {
      const shop = await resolveShop(session, p.productId);
      if (!shop) continue;
      const existing = shops.get(shop.id);
      if (existing) {
        existing.appears += 1;
      } else {
        shops.set(shop.id, { ...shop, appears: 1 });
      }
    }
  }

  const ranked = [...shops.values()].sort((a, b) => b.appears - a.appears);
  const kept = ranked.slice(0, CONFIG.TOP_SHOPS_TO_KEEP);
  console.log(
    `T6: ${shops.size} unique shops discovered → keeping top ${kept.length} by appearance.`
  );
  return kept;
}

// ---------------------------------------------------------------------------
// T7 — manual shops merge
// ---------------------------------------------------------------------------

/**
 * Extract the shop slug from a Uzum shop URL. Handles both /seller/{slug} and
 * /shop/{slug} (both resolve on the site). Strips locale + query/hash.
 * Also accepts a bare slug.
 *
 * @returns {string | null}
 */
function parseShopSlug(url) {
  if (!url) return null;
  const cleaned = String(url).trim();
  // bare slug (no slash, no protocol)
  if (!cleaned.includes('/')) return cleaned || null;
  const m = cleaned.match(/\/(?:seller|shop)\/([^/?#]+)/i);
  return m ? m[1] : null;
}

/**
 * Resolve MANUAL_SHOPS entries → shop objects via the shop-by-slug endpoint.
 * Each failure is captured per-entry (does not abort the others).
 *
 * @returns {Promise<Array<{id, title, link, label}>>}
 */
async function resolveManualShops(session) {
  const out = [];
  const entries = [...MANUAL_SHOPS, ...loadCsvShops()];
  for (const entry of entries) {
    const slug = parseShopSlug(entry.url || entry.label);
    if (!slug) {
      console.warn(`  ! manual shop "${entry.label}" — could not parse slug from ${entry.url}`);
      continue;
    }
    try {
      const res = await apiFetch(session, ENDPOINTS.SHOP_BY_SLUG(slug));
      const shop = res?.payload;
      if (!shop?.id) {
        console.warn(`  ! manual shop "${entry.label}" (slug ${slug}) — no id in response`);
        continue;
      }
      out.push({
        id: shop.id,
        title: shop.title || entry.label,
        link: shop.link || slug,
        rating: shop.rating ?? null,
        orders: shop.orders ?? null,
        label: entry.label,
      });
    } catch (err) {
      console.warn(`  ! manual shop "${entry.label}" (slug ${slug}) failed: ${err.message}`);
    }
  }
  return out;
}

/**
 * Merge auto-discovered + manual shops, dedup by shop id, tag Source.
 * A shop present in both keeps its auto `appears` count but is tagged Manual
 * (the user explicitly asked for it).
 *
 * @returns {Array<{id, title, link, appears, source}>}
 */
function mergeShops(autoShops, manualShops) {
  const byId = new Map();
  for (const s of autoShops) {
    byId.set(s.id, { ...s, source: 'Auto-discovered' });
  }
  for (const m of manualShops) {
    const existing = byId.get(m.id);
    if (existing) {
      existing.source = 'Manual';
      if (m.title) existing.title = m.title;
      if (existing.rating == null) existing.rating = m.rating;
      if (existing.orders == null) existing.orders = m.orders;
    } else {
      byId.set(m.id, {
        id: m.id, title: m.title, link: m.link,
        rating: m.rating ?? null, orders: m.orders ?? null,
        appears: 0, source: 'Manual',
      });
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// T8 — exact product count
// ---------------------------------------------------------------------------

/**
 * Get a shop's exact product count via makeSearch(shopId).total.
 * One failure must not crash the run — returns a status string per shop.
 *
 * @returns {Promise<{count: number|null, status: string}>}
 */
async function countShopProducts(session, shopId) {
  try {
    const search = await graphqlSearch(session, {
      shopId: String(shopId),
      categoryId: null,
      pagination: { offset: 0, limit: 1 },
    });
    return { count: search.total ?? 0, status: 'ok' };
  } catch (err) {
    return { count: null, status: err.message.slice(0, 200) };
  }
}

/**
 * Attach exact product counts to every shop (per-shop try/catch inside).
 * @returns {Promise<Array>} shops augmented with { count, status }.
 */
async function countAllShops(session, shops) {
  const out = [];
  for (const shop of shops) {
    const { count, status } = await countShopProducts(session, shop.id);
    if (status !== 'ok') console.warn(`  ! shop ${shop.id}/${shop.title} count failed: ${status}`);
    out.push({ ...shop, count, status });
  }
  console.log(`T8: counted ${out.filter((s) => s.status === 'ok').length}/${out.length} shops OK.`);
  return out;
}

// ---------------------------------------------------------------------------
// T15/T16 — single-shop analyze (used by the web endpoint)
// ---------------------------------------------------------------------------

const SHOP_URL = (slug) => `https://uzum.uz/uz/seller/${slug}`;

/**
 * Analyze ONE shop from a pasted URL or bare slug: resolve → exact count →
 * derive pages / image opportunity / quote. Fast (2 API calls), no crawl.
 *
 * @param {object} session
 * @param {string} input - shop URL (/seller/ or /shop/) or bare slug.
 * @returns {Promise<object>} shop analysis.
 */
async function analyzeShop(session, input) {
  const slug = parseShopSlug(input);
  if (!slug) throw new Error('Could not parse a shop URL or slug from input.');

  let res;
  try {
    res = await apiFetch(session, ENDPOINTS.SHOP_BY_SLUG(slug));
  } catch (err) {
    if (/HTTP 404/.test(err.message)) throw new Error(`Shop not found for "${slug}".`);
    throw err;
  }
  const shop = res?.payload;
  if (!shop?.id) throw new Error(`Shop not found for "${slug}".`);

  const { count, status } = await countShopProducts(session, shop.id);
  if (status !== 'ok') throw new Error(`Product count failed: ${status}`);

  const pages = Math.ceil(count / CONFIG.PRODUCTS_PER_PAGE);
  const images = count * CONFIG.IMAGES_PER_PRODUCT;
  return {
    id: shop.id,
    title: shop.title,
    slug: shop.link,
    url: SHOP_URL(shop.link),
    rating: shop.rating ?? null,
    orders: shop.orders ?? null,
    productCount: count,
    approxPages: pages,
    imagesYouCanCreate: images,
    quote: images * CONFIG.PRICE_PER_IMAGE, // see CONFIG.PRICE_PER_IMAGE note
  };
}

/**
 * Fetch a shop's products by paging makeSearch(shopId). Most-ordered first.
 *
 * @param {object} session
 * @param {number|string} shopId
 * @param {number} [max=0] - cap total products (0 = all).
 * @param {(fetched:number,total:number)=>void} [onProgress]
 * @returns {Promise<Array<{productId, title, price}>>}
 */
async function fetchShopProducts(session, shopId, max = 0, onProgress) {
  const PAGE = 50;
  // Dedup by productId: makeSearch `total` counts listing CARDS, and a product
  // with color/size variants yields several cards sharing one productId. We
  // want distinct products, so collect into a Map keyed by productId.
  const byId = new Map();
  let offset = 0;
  let total = Infinity;
  let emptyStreak = 0;

  while (offset < total) {
    const search = await graphqlSearch(session, {
      shopId: String(shopId),
      categoryId: null,
      pagination: { offset, limit: PAGE },
    });
    total = search.total ?? 0; // card count (≥ distinct products)
    const cards = (search.items || []).map((it) => it.catalogCard).filter((c) => c && c.productId);
    if (!cards.length) break; // no more results

    const before = byId.size;
    for (const c of cards) {
      if (!byId.has(c.productId)) {
        byId.set(c.productId, { productId: c.productId, title: c.title, price: c.minSellPrice ?? null });
      }
    }
    // Stop if several consecutive pages add nothing new (sort instability /
    // exhausted distinct products before reaching the card-count total).
    emptyStreak = byId.size === before ? emptyStreak + 1 : 0;
    offset += PAGE;
    if (onProgress) onProgress(byId.size, total);
    if (max > 0 && byId.size >= max) return [...byId.values()].slice(0, max);
    if (emptyStreak >= 3) break;
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// T9 — Excel output
// ---------------------------------------------------------------------------

/**
 * Build the columns (PRD §5 + T11), sorted largest→smallest by product count
 * with errored shops pushed to the bottom, and write the Excel workbook.
 *
 * T13 — two sheets:
 *   - "Shops"   = latest sorted snapshot (overwritten each run; actionable view)
 *   - "History" = every run's rows appended (dated via "Scanned at") so growth
 *                 week-over-week is visible. Preserved across runs.
 */
function writeExcel(shops, scannedAt) {
  const ok = shops.filter((s) => s.status === 'ok');
  const errored = shops.filter((s) => s.status !== 'ok');
  ok.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

  const toRow = (s) => ({
    Shop: s.title,
    Source: s.source,
    'Appears in top products': s.appears,
    'Product count': s.count ?? '',
    'Seller rating': s.rating ?? '', // T11
    'Total orders': s.orders ?? '', // T11
    'Approx. pages on site': s.count != null ? Math.ceil(s.count / CONFIG.PRODUCTS_PER_PAGE) : '',
    'Images you can create': s.count != null ? s.count * CONFIG.IMAGES_PER_PRODUCT : '',
    'Shop URL': SHOP_URL(s.link),
    'Scanned at': scannedAt,
    Status: s.status,
  });

  const rows = [...ok.map(toRow), ...errored.map(toRow)];

  // T13: carry forward prior History rows, then append this run's.
  let history = [];
  if (fs.existsSync(CONFIG.OUTPUT_FILE)) {
    try {
      const prev = XLSX.readFile(CONFIG.OUTPUT_FILE);
      if (prev.Sheets.History) history = XLSX.utils.sheet_to_json(prev.Sheets.History);
    } catch (err) {
      console.warn(`  ~ could not read existing history (${err.message}) — starting fresh.`);
    }
  }
  history = [...history, ...rows];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Shops');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(history), 'History');
  XLSX.writeFile(wb, CONFIG.OUTPUT_FILE);
  console.log(
    `T9/T13: wrote ${rows.length} rows → ${CONFIG.OUTPUT_FILE} ` +
      `(${ok.length} ok, ${errored.length} errored); History now ${history.length} rows.`
  );
}

// ---------------------------------------------------------------------------
// Pipeline (built out across T2–T9)
// ---------------------------------------------------------------------------

async function main() {
  console.log('Uzum Shop Intelligence Scanner — starting...');

  // T2 — browser boot + auth (apiFetch helper)
  const session = await bootBrowser();
  const { browser } = session;

  try {
    // T4 — category discovery
    const categories = await discoverCategories(session);

    // T5 + T6 — product sampling → shop resolution + ranking
    const topShops = await discoverTopShops(session, categories);

    // T7 — manual shops merge
    const manualShops = await resolveManualShops(session);
    const merged = mergeShops(topShops, manualShops);
    console.log(
      `T7: ${manualShops.length} manual shop(s) resolved → ${merged.length} total after merge.`
    );

    // T8 — exact product count
    const counted = await countAllShops(session, merged);

    // T14 — min product threshold filter (errored shops kept for visibility)
    let finalShops = counted;
    if (CONFIG.MIN_PRODUCTS > 0) {
      const before = counted.length;
      finalShops = counted.filter((s) => s.status !== 'ok' || (s.count ?? 0) >= CONFIG.MIN_PRODUCTS);
      const skipped = before - finalShops.length;
      console.log(`T14: filtered out ${skipped} shop(s) under ${CONFIG.MIN_PRODUCTS} products.`);
    }

    // T9 — Excel output
    const scannedAt = new Date().toISOString();
    writeExcel(finalShops, scannedAt);

    // T17 — also persist the batch to the shared SQLite store (feeds the CRM).
    try {
      require('./db').recordBatch(finalShops, scannedAt);
      console.log('T17: batch recorded to scanner.db.');
    } catch (err) {
      console.warn(`T17: DB record skipped (${err.message}).`);
    }

    console.log('\n=== Results (preview) ===');
    [...finalShops]
      .filter((s) => s.status === 'ok')
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
      .slice(0, 12)
      .forEach((s, i) => {
        console.log(`${String(i + 1).padStart(2)}. ${s.title} — ${s.count} products [${s.source}]`);
      });
  } finally {
    await browser.close();
  }

  console.log('\nT4-T9 done — full pipeline → Excel.');
}

// Run the full CLI pipeline only when invoked directly (node uzum-scanner.js).
// When require()'d (by the web server), just expose the reusable core.
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  CONFIG,
  ENDPOINTS,
  bootBrowser,
  apiFetch,
  graphqlSearch,
  resolveShop,
  countShopProducts,
  parseShopSlug,
  analyzeShop,
  fetchShopProducts,
  SHOP_URL,
};
