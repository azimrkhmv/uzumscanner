/**
 * Fetch ALL products for every tracked shop in scanner.db and store them in
 * the products table, for the combined "All products" view.
 *
 * Heavy: total products across 50 shops can be tens of thousands. Cap per shop
 * with MAX_PRODUCTS_PER_SHOP=N (0 = all, default).
 *
 *   npm run products
 *   MAX_PRODUCTS_PER_SHOP=200 npm run products   # faster sample
 *   FORCE=1 npm run products                     # refetch shops already done
 *
 * Resumable: shops that already have stored products are skipped (so a crash
 * mid-run can be resumed without redoing everything). FORCE=1 refetches all.
 */
'use strict';

const { bootBrowser, fetchShopProducts } = require('./uzum-scanner');
const store = require('./db');

const MAX_PER_SHOP = parseInt(process.env.MAX_PRODUCTS_PER_SHOP || '0', 10);
const FORCE = process.env.FORCE === '1';

(async () => {
  const shops = store.listShops();
  if (!shops.length) {
    console.error('No shops in scanner.db — run `npm run scan` first.');
    process.exit(1);
  }
  console.log(`Fetching products for ${shops.length} shops${MAX_PER_SHOP ? ` (max ${MAX_PER_SHOP}/shop)` : ' (all)'}...`);

  const session = await bootBrowser();
  let grand = 0;
  let skipped = 0;
  let failed = 0;
  try {
    for (let i = 0; i < shops.length; i++) {
      const s = shops[i];
      // Resume: skip shops already populated unless FORCE.
      if (!FORCE && store.shopProductCount(s.shop_id) > 0) {
        skipped++;
        console.log(`[${i + 1}/${shops.length}] ${s.title} (#${s.shop_id}) ... skip (already fetched)`);
        continue;
      }
      process.stdout.write(`[${i + 1}/${shops.length}] ${s.title} (#${s.shop_id}) ... `);
      try {
        const products = await fetchShopProducts(session, s.shop_id, MAX_PER_SHOP);
        store.recordProducts(s.shop_id, products);
        grand += products.length;
        console.log(`${products.length} products`);
      } catch (err) {
        failed++;
        console.log(`FAILED: ${err.message.slice(0, 80)}`);
      }
    }
  } finally {
    await session.browser.close();
  }
  console.log(
    `\nDone. ${grand} new products stored; ${skipped} shops skipped, ${failed} failed. ` +
      `DB total: ${store.productCount()} products.`
  );
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });
