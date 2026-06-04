# Uzum Shop Intelligence Scanner — Task List

> Working reminder derived from `PRD.md` (v1.1). Phase 1 = current focus.
> Critical path: T1 → T2 → **T3** → T4 → T5 → T6 → T7 → T8 → T9 → T10
> T3 (verify API contracts) gates all discovery logic — do it before T4+.

---

## Phase 1 — CLI script (this week)

Single file: `uzum-scanner.js`. Stack: Node.js + `playwright` + `xlsx`.

### T1 — Project setup ✅ DONE
- [x] `npm init -y`
- [x] `npm install playwright xlsx`
- [x] `npx playwright install chromium`
- [x] Create `uzum-scanner.js` skeleton
- [x] Config block at top with all tunables:
  - `IMAGES_PER_PRODUCT` = 1
  - `MAX_CATEGORIES` = 10
  - `PRODUCTS_PER_CATEGORY` = 50
  - `TOP_SHOPS_TO_KEEP` = 40
  - `SHOW_BROWSER` = true
  - `MANUAL_SHOPS` = [] (array of { label, url })

### T2 — Browser boot + auth ✅ DONE
- [x] Launch Playwright Chrome; `SHOW_BROWSER` toggles headless
- [x] Navigate to uzum.uz, wait until session/auth ready
- [x] `apiFetch()` helper → inherits browser auth (no tokens)
- [x] Rate-limit helper: random 150–400ms delay between requests

**T2 notes / drift found:**
- PRD host `api.umarket.uz` is WRONG → real host `api.uzum.uz` + `graphql.uzum.uz`. ENDPOINTS updated.
- Auth = anonymous `Bearer` JWT (minted by Uzum ID) + `x-iid` install id. Faking them → HTTP 400 `bad-request-001`. Fix: sniff real headers off the SPA's own first API call at boot, reuse in `apiFetch`.
- `page.evaluate(fetch)` approach (per PRD) FAILS — cross-origin CORS + site's wrapped `window.fetch`. Switched to `context.request.fetch` (Node-side, shares cookie jar, no CORS).
- **Headless triggers Yandex SmartCaptcha** → no API fires. Must run with `SHOW_BROWSER=true` (headed). JWT `exp` ≈ 6h, fine for a <15min run.

### T3 — Verify API contracts  ✅ DONE — all 4 verified end-to-end
Locked exact field names against the LIVE site (sample run: Mebel cat 2894 → product 692230 → shop 10231/DAFNA → 108 products):

- [x] `GET api.uzum.uz/api/main/root-categories` → **array of 23**, each `{ id, title, iconSvg, iconLink, children[], path[] }`. Children recurse, each child has `productAmount`.
- [x] GraphQL `makeSearch` (categoryId + `sort: BY_ORDERS_NUMBER_DESC`) → `{ total, items[] }`. Each item = `{ catalogCard: { productId, title, minSellPrice, ... } }`. **productId is on `item.catalogCard.productId`** (not item.id).
- [x] `GET api.uzum.uz/api/v2/product/{id}` → **double-wrapped**: `{ payload: { data: {...}, ... }, timestamp }`. Shop = `payload.data.seller` = `{ id, title, link (slug), orders, rating, reviews, official, sellerAccountId, ... }`. Shop URL = `https://uzum.uz/uz/seller/{link}`.
- [x] GraphQL `makeSearch` (shopId) → `total` = exact product count. (DAFNA shopId 10231 → total 108.)

**Checkup verifications (post-T3):**
- `makeSearch` honors `pagination.limit: 50` — returns 50 items, not capped. PRODUCTS_PER_CATEGORY=50 safe in one call.
- Shop URL: BOTH `https://uzum.uz/uz/seller/{slug}` and `/uz/shop/{slug}` return HTTP 200 (SPA accepts both). `/seller/` matches `seller.link`; use it for the output column.
- ⚠️ **T7 gap:** shop pages do NOT fire a GraphQL `makeSearch(shopId)` (use a REST shop-products endpoint instead). So pasted MANUAL_SHOPS URL → shopId resolution needs a yet-undiscovered endpoint (e.g. shop-by-slug). Discover during T7. Does NOT affect T8 (we call makeSearch(shopId) directly — already proven).

**T3 contract notes / locked decisions:**
- GraphQL endpoint = `POST https://graphql.uzum.uz/`. **Search gateway 429s any POST missing `apollographql-client-name: web-customers` + `apollographql-client-version` + `city-*`/`latitude` headers.** Fix: capture the FULL header set off a real makeSearch at boot (`bootBrowser` navigates one category page to harvest `gqlHeaders`), reuse for all GraphQL calls. Hand-built headers → 429.
- Using a SLIM custom query (productId/title/total only) instead of the SPA's ~5KB fragment query — server accepts any valid field subset. Embedded as `MAKE_SEARCH_QUERY`, opName `MakeSearch_ItemsAndFilters`.
- `seller.totalProducts` in product-detail = 0 (useless) → exact count MUST come from makeSearch(shopId).total. Confirmed.
- Per-product detail double-wrap (`payload.data`) differs from makeSearch wrap — easy to trip on.
- Transient `getaddrinfo ENOTFOUND api.uzum.uz` seen once (DNS flake) → T10 must add retry on transient request failures.

### T4 — Category discovery ✅ DONE
- [x] Pull root categories (`discoverCategories`)
- [x] Take top `MAX_CATEGORIES` (10) — uses root-categories order as "biggest" proxy

### T5 — Product sampling ✅ DONE
- [x] Per category: fetch top `PRODUCTS_PER_CATEGORY` (50) most-ordered via `makeSearch` (`sampleProducts`). limit:50 verified OK.

### T6 — Shop resolution + ranking ✅ DONE
- [x] Per product: product detail API → `payload.data.seller` → {id, title, link} (`resolveShop`, per-product try/catch)
- [x] Count shop frequency across categories → `appears` (`discoverTopShops`)
- [x] Rank by appearance desc, keep top `TOP_SHOPS_TO_KEEP` (40)

**T4-T6 notes:** Verified at small scale (MAX_CATEGORIES=2, PRODUCTS_PER_CATEGORY=5 → 8 shops ranked correctly). Env overrides added to CONFIG for test runs. Full 10×50 = ~500 product-detail calls — deferred to T10 end-to-end run (rate-limit risk to validate then).

### T7 — Manual shops merge ✅ DONE
- [x] Parse each `MANUAL_SHOPS` URL → slug (`parseShopSlug`, handles /seller/ + /shop/ + bare slug)
- [x] Resolve slug → shop via **`GET api.uzum.uz/api/shop/{slug}`** → `payload.{id,title,link}` (T7-discovered endpoint)
- [x] Merge with auto-discovered (`mergeShops`)
- [x] Dedup by shop ID (verified: DAFNA in both lists → 1 row, not 2)
- [x] Tag `Source` = "Auto-discovered" / "Manual" (shop in both → tagged Manual, keeps `appears` count)

**T7 note:** slug→shopId endpoint (the earlier-flagged gap) = `GET /api/shop/{slug}` (NOT /shops/, /seller/, /v2/ — those 404/401). Per-entry try/catch so one bad URL doesn't abort.

### T8 — Exact product count ✅ DONE
- [x] Per shop: `makeSearch` with shopId → `total` (`countShopProducts`)
- [x] Per-shop try/catch — one failure must not crash whole run (`countAllShops`)
- [x] Capture error message into `Status` per shop

### T9 — Excel output ✅ DONE
Build rows, 9 columns (PRD §5) — verified in written file:
- [x] Shop / Source / Appears in top products / Product count
- [x] Approx. pages on site (`Math.ceil(count ÷ 24)`)
- [x] Images you can create (count × `IMAGES_PER_PRODUCT`)
- [x] Shop URL (`https://uzum.uz/uz/seller/{link}`)
- [x] Scanned at (ISO timestamp)
- [x] Status ("ok" or error message)
- [x] Sort largest → smallest; errors pushed to bottom
- [x] Write `uzum-results.xlsx` to working dir (`writeExcel`)

### T10 — Hardening + first full run ✅ DONE
- [x] Try/catch + retry on transient request failures (`requestWithRetry`: 3 attempts, exp backoff, retries ENOTFOUND/ECONNRESET/timeouts + HTTP 429/5xx)
- [x] Raw-response-key logging fallback if discovery returns nothing (Risk #1 — `discoverCategories` dumps raw shape + throws)
- [x] End-to-end run: **8.4 min** (503s, target <15), zero manual work, 40/40 shops OK, 0 errors

**T10 full-run result:** 10 categories × 50 products → 196 unique shops → top 40 kept + counted. Output `uzum-results.xlsx`, 40 rows. No retries triggered (clean run). Top: CocoGlasses 3991, CAMEL-FISHING 649, J200 SHOP 612.

---

## Phase 2 — Smarter script (1–2 weeks)

- [x] T11 — Seller rating + total order columns ✅ (`resolveShop`/manual carry `rating`,`orders`; 2 new Excel cols. Verified: BRIGADA 4.8 / 22833 orders)
- [x] T12 — CSV input `manual-shops.csv` ✅ (`loadCsvShops`, merged with MANUAL_SHOPS; "label,url" per line, splits on LAST comma so labels may contain commas; header optional; single col = URL)
- [x] T13 — Append-history + weekly cron ✅
  - Excel now 2 sheets: **"Shops"** (latest sorted snapshot, overwritten) + **"History"** (every run's rows appended, dated via "Scanned at"). Verified: 2 runs → Shops=3, History=6.
  - `npm run scan` added.
  - Weekly cron = Windows Task Scheduler. **Must run interactive (`/IT`)** because SHOW_BROWSER=true is required (headless trips captcha, per T2). Command:
    `schtasks /Create /TN "UzumScanner" /SC WEEKLY /D MON /ST 09:00 /IT /TR "cmd /c cd /d C:\Users\PRESTIGE\Desktop\Scanner && node uzum-scanner.js >> scan.log 2>&1"`
    (User enables it — outward/persistent action, not auto-created.)
- [x] T14 — Min threshold filter ✅ (`CONFIG.MIN_PRODUCTS`, env-overridable, 0=off. Errored shops kept for visibility. Verified MIN_PRODUCTS=50 → dropped 3.)

---

## Phase 3 — In-platform feature ✅ DONE (vertical slice)

- [x] T15 — Express server (`server.js`). `GET /api/analyze?input=` + `/api/shops` + stage/notes/history endpoints. **Single kept-alive browser session** (re-boots when JWT >5h stale; concurrent-boot de-duped). `npm run serve` → http://localhost:3000
- [x] T16 — Analyze frontend (`public/index.html`): paste URL/slug → product count, pages, images, rating, orders, instant quote. Verified vs DAFNA/BRIGADA.
- [x] T17 — **SQLite** persistence (`db.js`, built-in `node:sqlite` — chose over MySQL: zero-config, single-user fit). Tables `shops` + append-only `scans` (growth history). Both web analyze AND CLI batch (`recordBatch`) populate it. Cross-process write verified.
- [x] T18 — Sales pipeline (`public/crm.html`): table of tracked shops, stage dropdown (New/Contacted/Demo scheduled/Won/Lost), inline notes, scan count. Stage/notes persist via POST. Invalid stage rejected.
- [x] T19 — Self-quote = the public analyze page. `?save=false` runs a quote WITHOUT writing to CRM (verified: home24 quoted, not tracked).

**Phase 3 notes:**
- Quote = `imagesYouCanCreate × PRICE_PER_IMAGE` (CONFIG, default 5000 so'm) — **ASSUMPTION**, PRD gave no formula. Tune to real pricing.
- Deviation from PRD: SQLite instead of MySQL (user-approved). Functionally equivalent for single-user; swap to mysql2 later if multi-user needed.
- Dev server needs the headed browser (captcha) → run on a desktop session, same as the CLI.
- Name-search input ("type name") not built — URL/slug only. Name→shop search is a future add (makeSearch has text search).
- Files: `server.js`, `db.js`, `public/index.html`, `public/crm.html`. DB = `scanner.db` (delete to reset).

---

## Open questions (resolve before / during T1)

1. `IMAGES_PER_PRODUCT` — keep default 1?
2. Min product count to qualify a lead — apply filter in v1 or defer to Phase 2 (T14)? PRD suggests 50+.
3. Phase 3 scanner — internal-only or customer-facing?

---

## Data sources (PRD §6)

| Purpose | Endpoint (T3-verified) |
|---|---|
| Category list | `GET api.uzum.uz/api/main/root-categories` |
| Top products / category | `POST graphql.uzum.uz` `makeSearch` — `categoryId` + `sort: BY_ORDERS_NUMBER_DESC` |
| Shop per product | `GET api.uzum.uz/api/v2/product/{id}` → `payload.data.seller` |
| Exact product count | `POST graphql.uzum.uz` `makeSearch` — `shopId` → `total` |

Rate limit: 150–400ms between requests.

## Run commands (PRD §5)
```
npm install playwright xlsx
npx playwright install chromium
node uzum-scanner.js
```
