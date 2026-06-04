# PRD — Uzum Shop Intelligence Scanner

**Version:** 1.1  
**Project:** Lead generation tool for product photography service  
**Status:** Ready to build  
**Last updated:** June 2026

---

## 1. Problem

The photography platform sells product image creation to Uzum Market sellers. The sales process starts with identifying large shops — ones with many products = many images to sell. Right now this is done by hand: open a shop, count pages × 24 ≈ product total, write it down somewhere. For 20 shops this takes an hour and produces nothing structured.

There is no tool that automatically answers: *"Which shops on Uzum have the most products, and how many images could we sell them?"*

---

## 2. Goal

Build a tool that automatically discovers the biggest shops on Uzum, counts their products, calculates the image opportunity, and produces a ready Excel file that goes straight into a sales pipeline — with no manual URL hunting required.

**Success looks like:** run one command → get a sorted Excel of the top shops with exact product counts, in under 15 minutes, with zero manual work.

---

## 3. Non-goals (v1)

- Revenue or GMV estimates per shop
- Real-time monitoring or alerts
- CRM integration
- Scheduled/recurring auto-runs

---

## 4. Users

**Right now:** Azim (founder), running it from his own laptop before sales calls.  
**Later:** Any sales or BD person on the team — which means the tool needs to run with one command, no setup per run.

---

## 5. Features

### Phase 1 — CLI script (this week)

**Auto-discovery (no manual URL list needed):**

The script finds big shops on its own by:
1. Opening uzum.uz — the browser handles auth automatically, no token copying
2. Pulling the full category list from Uzum's API
3. For each of the top 10 categories, fetching the 50 most-ordered products
4. For each product, calling the product detail API to find which shop it belongs to
5. Ranking shops by how often they appear across categories — a shop appearing in many top-product lists is a large, active seller
6. Taking the top 40 discovered shops and counting their exact product total via Uzum's GraphQL API

**Manual additions:**

A `MANUAL_SHOPS` array at the top of the script lets you add specific shop URLs on top of the auto-discovered list. If a shop you care about wasn't caught by discovery, paste its URL there — it gets counted and merged into the same Excel output, deduplicated automatically.

```js
const MANUAL_SHOPS = [
  { label: 'Nivea', url: 'https://uzum.uz/uz/shop/nivea-official' },
];
```

**Output — Excel file with these columns:**

| Column | What it means |
|---|---|
| Shop | Name of the seller |
| Source | "Auto-discovered" or "Manual" |
| Appears in top products | How many times this shop appeared across category scans — a discovery quality signal |
| Product count | Exact number from Uzum's API |
| Approx. pages on site | Visual sanity check (product count ÷ 24) |
| Images you can create | Product count × your images-per-product setting |
| Shop URL | Direct link for outreach |
| Scanned at | Timestamp |
| Status | "ok" or error message |

Sorted largest → smallest automatically. Errors go to the bottom, not mixed in.

**Tunable settings at the top of the script:**

| Setting | Default | What it controls |
|---|---|---|
| `IMAGES_PER_PRODUCT` | 1 | Multiplier for the images column |
| `MAX_CATEGORIES` | 10 | How many categories to scan for discovery |
| `PRODUCTS_PER_CATEGORY` | 50 | Products sampled per category |
| `TOP_SHOPS_TO_KEEP` | 40 | How many discovered shops to count |
| `SHOW_BROWSER` | true | Watch it run (true) or silent (false) |

**How to run:**
```
npm install playwright xlsx
npx playwright install chromium
node uzum-scanner.js
```

---

### Phase 2 — Smarter script (1–2 weeks)

- Add seller rating and total order count as extra columns (better lead qualification)
- CSV input option: drop a `manual-shops.csv` instead of editing the script
- Weekly auto-run via cron — appends new rows to the same Excel with the current date so you can track shop growth over time
- Configurable minimum threshold: skip shops with fewer than N products (e.g. filter out anything under 50)

---

### Phase 3 — In-platform feature (1–2 months)

Embed this as a page inside the photography platform:

- A team member pastes a shop URL or types a shop name → clicks "Analyze"
- Runs the scan in the background (same Node.js logic, wrapped as an API endpoint)
- Shows on screen: product count, pages, estimated quote
- Stores history of all scanned shops
- Pipeline columns: Contacted / Demo scheduled / Won / Lost

This turns the lead research tool into part of the product itself. Could also be customer-facing: sellers paste their own shop to get an instant quote for how many images they need.

---

## 6. Technical approach

**Runtime:** Node.js (matches existing stack)

**Browser automation:** Playwright — opens a real Chrome browser. The browser handles Uzum's authentication automatically, exactly like a regular visitor. No token management.

**Key technique — `page.evaluate(fetch)`:**  
Instead of scraping HTML or managing auth headers manually, the script runs `fetch()` calls from inside the browser's JavaScript context using `page.evaluate()`. Since the browser is already on uzum.uz and has its auth session, these fetch calls inherit the auth automatically. This means:
- No manual token copying ever
- No token expiry issues
- Works just like the Uzum website itself making API calls

**Data sources used:**
- `GET api.umarket.uz/api/main/root-categories` → category list
- GraphQL `makeSearch` with `categoryId + sort: BY_ORDERS_NUMBER_DESC` → top products per category
- `GET api.umarket.uz/api/v2/product/{id}` → shop info per product
- GraphQL `makeSearch` with `shopId` → exact product count per shop (the `total` field)

**Rate limiting:** 150–400ms delay between requests. Respectful, won't trigger blocks.

**Output:** `xlsx` npm package → `uzum-results.xlsx` in the working directory.

**For Phase 3:** wrap the same logic in an Express.js endpoint. Frontend POSTs a shop URL → backend returns count → stored in MySQL.

---

## 7. Risks

| Risk | How likely | What to do |
|---|---|---|
| Product detail API field names differ from expected | Medium | Script logs the raw response keys if discovery returns nothing — fix takes 2 minutes |
| Uzum changes the GraphQL endpoint | Medium | Update the URL constant at the top of the script |
| Discovery misses some large shops | Low-medium | Add them manually via `MANUAL_SHOPS` — that's what it's there for |
| Playwright gets flagged as a bot | Very low | It acts as a real browser; if it happens, add a longer delay |

---

## 8. Milestones

| Phase | What | When |
|---|---|---|
| ✅ Phase 1 | Auto-discovery + manual additions, Excel output | Done |
| Phase 2 | CSV input, rating column, weekly auto-run, minimum threshold filter | 1–2 weeks |
| Phase 3 | In-platform page, stored history, pipeline columns | 4–8 weeks |

---

## 9. Open questions

1. How many images per product does the service create? (Currently 1 — update `IMAGES_PER_PRODUCT`)
2. What's the minimum product count to qualify a shop as a lead? (Suggested: 50+)
3. Should the Phase 3 scanner be internal-only or customer-facing ("scan your shop for an instant quote")?

---

*Uzum Shop Intelligence Scanner — lead generation component of the product photography platform.*
