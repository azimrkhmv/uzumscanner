# Uzum Shop Intelligence Scanner

Lead-generation tool for [Uzum Market](https://uzum.uz). Discovers the biggest
shops, counts their products, estimates an image-creation opportunity/quote, and
exposes it as a CLI (Excel report) **and** a web app (analyze + catalog browser).

## What it does

- **Discovers top shops** — samples the most-ordered products across top
  categories, ranks sellers by how often they appear.
- **Exact product counts** per shop, plus rating & lifetime orders.
- **Instant quote** = products × price-per-image.
- **Web UI** — paste a shop URL for an instant analysis; browse the combined
  product catalog of all tracked shops; see top-shop rankings & totals.

## Stack

Node.js · [Playwright](https://playwright.dev) (drives a real browser to inherit
Uzum's auth) · [xlsx](https://www.npmjs.com/package/xlsx) · Express · built-in
`node:sqlite` (no external DB).

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
npm run scan        # crawl → uzum-results.xlsx + scanner.db
npm run products    # fetch every tracked shop's product catalog into the DB
npm run serve       # web UI at http://localhost:3000
```

### Web pages
- `/` — analyze a single shop (paste URL/slug) → count, pages, images, quote
- `/crm.html` — top shops ranked, with totals
- `/products.html` — combined product catalog (search + filter + paginate)

## Configuration

Tunables live in the `CONFIG` block of `uzum-scanner.js`; most are
env-overridable for one-off runs:

| Env var | Default | Meaning |
|---|---|---|
| `MAX_CATEGORIES` | 10 | top categories to crawl |
| `PRODUCTS_PER_CATEGORY` | 50 | most-ordered products sampled per category |
| `TOP_SHOPS_TO_KEEP` | 40 | shops kept after ranking |
| `MIN_PRODUCTS` | 0 | drop shops under N products (0 = off) |
| `IMAGES_PER_PRODUCT` | 1 | multiplier for "images you can create" |
| `PRICE_PER_IMAGE` | 5000 | quote = images × this (so'm) |
| `MAX_PRODUCTS_PER_SHOP` | 0 | cap per-shop catalog fetch (0 = all) |
| `PORT` | 3000 | web server port |

```bash
TOP_SHOPS_TO_KEEP=100 npm run scan
FORCE=1 npm run products        # refetch shops already done
```

## How it works (notes)

- **Auth**: Uzum's API needs an anonymous `Bearer` JWT + `x-iid`, minted
  client-side. The scanner boots a real browser, sniffs those headers off the
  SPA's own requests, and reuses them — no token juggling.
- **Captcha**: headless mode trips Yandex SmartCaptcha, so the browser runs
  headed (`SHOW_BROWSER=true`). Run on a machine with a display.
- **Hosts**: `api.uzum.uz` (REST) + `graphql.uzum.uz` (`makeSearch`).
- **Product counts** include color/size variants (Uzum lists each as a card);
  the browsable catalog de-duplicates to **distinct** products, so a shop's
  headline count can exceed its distinct-product count.

## Files

| File | Role |
|---|---|
| `uzum-scanner.js` | CLI pipeline + reusable scraper core |
| `server.js` | Express API + web server |
| `db.js` | SQLite persistence |
| `fetch-products.js` | bulk product-catalog fetcher (resumable) |
| `public/` | web frontend |

## Caveats

- Single-user/internal tool: the web server has no auth — don't expose it
  publicly as-is.
- The quote formula (`PRICE_PER_IMAGE`) is a placeholder — set real pricing.
- Unofficial: depends on Uzum's private API shapes, which can change.
