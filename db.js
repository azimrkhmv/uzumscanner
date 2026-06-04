/**
 * SQLite persistence (Phase 3, T17 + T18) using Node's built-in node:sqlite.
 *
 *   shops  — one row per shop, latest snapshot + sales-pipeline stage (T18)
 *   scans  — append-only history, one row per analyze/scan (growth tracking)
 *
 * No external deps, no server — a single scanner.db file in the working dir.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');

const DB_FILE = process.env.DB_FILE || 'scanner.db';

// Sales-pipeline stages (T18).
const STAGES = ['New', 'Contacted', 'Demo scheduled', 'Won', 'Lost'];

const db = new DatabaseSync(DB_FILE);

// WAL = concurrent reader (server) + writer (fetch-products/scan) without
// locking; busy_timeout waits instead of throwing SQLITE_BUSY on contention.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    shop_id     INTEGER PRIMARY KEY,
    title       TEXT,
    slug        TEXT,
    rating      REAL,
    orders      INTEGER,
    stage       TEXT NOT NULL DEFAULT 'New',
    notes       TEXT DEFAULT '',
    last_count  INTEGER,
    updated_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS scans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id       INTEGER NOT NULL,
    product_count INTEGER,
    approx_pages  INTEGER,
    images        INTEGER,
    quote         INTEGER,
    source        TEXT,
    scanned_at    TEXT NOT NULL,
    FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
  );

  CREATE INDEX IF NOT EXISTS idx_scans_shop ON scans(shop_id, scanned_at);

  CREATE TABLE IF NOT EXISTS products (
    product_id  INTEGER PRIMARY KEY,
    shop_id     INTEGER NOT NULL,
    title       TEXT,
    price       INTEGER,
    fetched_at  TEXT,
    FOREIGN KEY (shop_id) REFERENCES shops(shop_id)
  );
  CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);
`);

const stmts = {
  upsertShop: db.prepare(`
    INSERT INTO shops (shop_id, title, slug, rating, orders, last_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id) DO UPDATE SET
      title=excluded.title, slug=excluded.slug, rating=excluded.rating,
      orders=excluded.orders, last_count=excluded.last_count, updated_at=excluded.updated_at
  `),
  insertScan: db.prepare(`
    INSERT INTO scans (shop_id, product_count, approx_pages, images, quote, source, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  listShops: db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM scans WHERE scans.shop_id = s.shop_id) AS scan_count
    FROM shops s ORDER BY s.last_count DESC
  `),
  getShop: db.prepare(`SELECT * FROM shops WHERE shop_id = ?`),
  shopHistory: db.prepare(`
    SELECT scanned_at, product_count, images, quote FROM scans
    WHERE shop_id = ? ORDER BY scanned_at
  `),
  updateStage: db.prepare(`UPDATE shops SET stage = ?, updated_at = ? WHERE shop_id = ?`),
  updateNotes: db.prepare(`UPDATE shops SET notes = ?, updated_at = ? WHERE shop_id = ?`),
  upsertProduct: db.prepare(`
    INSERT INTO products (product_id, shop_id, title, price, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET
      shop_id=excluded.shop_id, title=excluded.title, price=excluded.price, fetched_at=excluded.fetched_at
  `),
  clearShopProducts: db.prepare(`DELETE FROM products WHERE shop_id = ?`),
};

/**
 * Record an analyze/scan result: upsert the shop + append a scan row.
 * @param {object} a - analyzeShop() result (+ optional source).
 */
function recordScan(a) {
  const now = new Date().toISOString();
  stmts.upsertShop.run(a.id, a.title, a.slug, a.rating, a.orders, a.productCount, now);
  stmts.insertScan.run(
    a.id, a.productCount, a.approxPages, a.imagesYouCanCreate, a.quote, a.source || 'web', now
  );
  return stmts.getShop.get(a.id);
}

/** Bulk-record a CLI batch scan's shops (used by the scanner). */
function recordBatch(shops, scannedAt) {
  const now = scannedAt || new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const s of shops) {
      if (s.status && s.status !== 'ok') continue;
      stmts.upsertShop.run(s.id, s.title, s.link, s.rating ?? null, s.orders ?? null, s.count ?? null, now);
      stmts.insertScan.run(
        s.id, s.count ?? null,
        s.count != null ? Math.ceil(s.count / 24) : null,
        s.count ?? null, null, s.source || 'batch', now
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const listShops = () => stmts.listShops.all();
const getShop = (id) => stmts.getShop.get(id);
const getHistory = (id) => stmts.shopHistory.all(id);

function setStage(shopId, stage) {
  if (!STAGES.includes(stage)) throw new Error(`Invalid stage "${stage}". One of: ${STAGES.join(', ')}`);
  const r = stmts.updateStage.run(stage, new Date().toISOString(), shopId);
  if (r.changes === 0) throw new Error(`Shop ${shopId} not tracked.`);
  return getShop(shopId);
}

function setNotes(shopId, notes) {
  const r = stmts.updateNotes.run(String(notes || ''), new Date().toISOString(), shopId);
  if (r.changes === 0) throw new Error(`Shop ${shopId} not tracked.`);
  return getShop(shopId);
}

/**
 * Replace a shop's stored products with a fresh fetch (transactional).
 * @param {number} shopId
 * @param {Array<{productId, title, price}>} products
 */
function recordProducts(shopId, products) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    stmts.clearShopProducts.run(shopId);
    for (const p of products) {
      stmts.upsertProduct.run(p.productId, shopId, p.title ?? null, p.price ?? null, now);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Paginated product listing across all shops, with optional shop filter and
 * title search. Joins shop title/slug. Returns { total, rows }.
 */
function listProducts({ shop = null, q = '', limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (shop) { where.push('p.shop_id = ?'); params.push(shop); }
  if (q) { where.push('p.title LIKE ?'); params.push(`%${q}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p ${clause}`).get(...params).n;
  const rows = db.prepare(`
    SELECT p.product_id, p.shop_id, p.title, p.price, s.title AS shop_title, s.slug AS shop_slug
    FROM products p JOIN shops s ON s.shop_id = p.shop_id
    ${clause}
    ORDER BY p.price DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { total, rows };
}

const productCount = () => db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
const shopProductCount = (id) =>
  db.prepare('SELECT COUNT(*) AS n FROM products WHERE shop_id = ?').get(id).n;

module.exports = {
  db, STAGES, recordScan, recordBatch, listShops, getShop, getHistory,
  setStage, setNotes, recordProducts, listProducts, productCount, shopProductCount,
};
