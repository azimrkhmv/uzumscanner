/**
 * Build a STATIC snapshot of the current scanner.db for Vercel (or any static
 * host). Exports shops/products/config to JSON and writes self-contained HTML
 * pages that read those files client-side. Output → ./web-static/
 *
 *   node build-static.js   (or: npm run build:static)
 *
 * No server, no browser. To refresh: re-run scan/products locally, rebuild,
 * redeploy. Live "Analyze" and scanning are NOT part of the static snapshot.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./db');
const { CONFIG } = require('./uzum-scanner');

const OUT = path.join(__dirname, 'web-static');
const DATA = path.join(OUT, 'data');
fs.mkdirSync(DATA, { recursive: true });

// --- data ---
const shops = store.listShops();
const { rows: products } = store.listProducts({ limit: 1e9, offset: 0 });
const config = {
  pricePerImage: CONFIG.PRICE_PER_IMAGE,
  imagesPerProduct: CONFIG.IMAGES_PER_PRODUCT,
  productsPerPage: CONFIG.PRODUCTS_PER_PAGE,
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(path.join(DATA, 'shops.json'), JSON.stringify(shops));
fs.writeFileSync(path.join(DATA, 'products.json'), JSON.stringify(products));
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(config));

const totalProducts = shops.reduce((a, s) => a + (s.last_count || 0), 0);

// --- shared head/style ---
const STYLE = `
  :root { --uzum: #7000ff; --bg: #f4f4f8; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:#1f2026; padding:32px; }
  .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; flex-wrap:wrap; gap:8px; }
  h1 { margin:0; font-size:22px; }
  .links a { text-decoration:none; color:var(--uzum); font-weight:600; font-size:14px; margin-left:16px; }
  .totals { display:flex; gap:14px; margin-bottom:20px; flex-wrap:wrap; }
  .tcard { background:#fff; border-radius:12px; padding:16px 20px; box-shadow:0 4px 18px rgba(0,0,0,.06); }
  .tcard .label { font-size:12px; color:#6b6b76; } .tcard .value { font-size:26px; font-weight:700; margin-top:2px; }
  .tcard.hl .value { color:var(--uzum); }
  table { width:100%; border-collapse:collapse; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 4px 18px rgba(0,0,0,.06); }
  th,td { text-align:left; padding:12px 14px; font-size:14px; border-bottom:1px solid #eee; }
  th { background:#faf8ff; color:#555; font-size:12px; text-transform:uppercase; letter-spacing:.3px; }
  tr:last-child td { border-bottom:0; } td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .rank { color:#999; width:36px; } .pill { font-size:11px; padding:2px 8px; border-radius:99px; background:#eee; color:#666; margin-left:6px; }
  a.cell { color:var(--uzum); text-decoration:none; font-weight:600; }
  .controls { display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap; }
  input,select { padding:10px 12px; font-size:14px; border:1px solid #d8d8e0; border-radius:10px; outline:none; }
  input:focus,select:focus { border-color:var(--uzum); } input#q { flex:1; min-width:220px; }
  .pager { display:flex; align-items:center; gap:12px; margin-top:16px; justify-content:center; }
  .pager button { padding:8px 16px; border:1px solid #d8d8e0; background:#fff; border-radius:8px; cursor:pointer; }
  .pager button:disabled { opacity:.4; cursor:default; } .count { color:#6b6b76; font-size:13px; }
  .note { color:#6b6b76; font-size:13px; margin-top:8px; }
`;
const ESC = `const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n)=>n==null?'—':Number(n).toLocaleString('en-US');`;
const NAV = (active) => `<div class="links">
  ${active !== 'home' ? '<a href="./index.html">Top shops</a>' : ''}
  ${active !== 'products' ? '<a href="./products.html">All products</a>' : ''}
  <a href="https://github.com/azimrkhmv/uzumscanner" target="_blank" rel="noopener">GitHub</a>
</div>`;

// --- index.html (top shops + totals) ---
fs.writeFileSync(path.join(OUT, 'index.html'), `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Uzum — Top Shops</title><style>${STYLE}</style></head><body>
<div class="head"><h1>Uzum Top Shops</h1>${NAV('home')}</div>
<div class="totals">
  <div class="tcard"><div class="label">Shops</div><div class="value">${shops.length}</div></div>
  <div class="tcard hl"><div class="label">Total products (all shops)</div><div class="value">${totalProducts.toLocaleString('en-US')}</div></div>
</div>
<table><thead><tr><th class="rank">#</th><th>Shop</th><th class="num">Products</th><th class="num">Rating</th><th class="num">Orders</th><th class="num">Quote (so'm)</th><th>Catalog</th></tr></thead>
<tbody id="rows"><tr><td colspan="7">Loading…</td></tr></tbody></table>
<p class="note">Static snapshot · generated ${config.generatedAt}. Live analyze & scanning run from the local app.</p>
<script>${ESC}
fetch('./data/config.json').then(r=>r.json()).then(cfg=>{
 fetch('./data/shops.json').then(r=>r.json()).then(shops=>{
  const tb=document.getElementById('rows'); tb.innerHTML='';
  shops.forEach((s,i)=>{const url='https://uzum.uz/uz/seller/'+encodeURIComponent(s.slug||'');
   const quote=(s.last_count||0)*cfg.pricePerImage; const tr=document.createElement('tr');
   tr.innerHTML='<td class="rank">'+(i+1)+'</td>'+
    '<td><a class="cell" href="'+esc(url)+'" target="_blank" rel="noopener">'+esc(s.title)+'</a><span class="pill">#'+s.shop_id+'</span></td>'+
    '<td class="num">'+fmt(s.last_count)+'</td><td class="num">'+(s.rating!=null?s.rating+' ★':'—')+'</td>'+
    '<td class="num">'+fmt(s.orders)+'</td><td class="num">'+fmt(quote)+'</td>'+
    '<td><a class="cell" href="./products.html?shop='+s.shop_id+'">View →</a></td>';
   tb.appendChild(tr);});
 });});
</script></body></html>`);

// --- products.html (client-side search + filter + paginate) ---
fs.writeFileSync(path.join(OUT, 'products.html'), `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Uzum — All Products</title><style>${STYLE}</style></head><body>
<div class="head"><h1>All Products</h1>${NAV('products')}</div>
<div class="controls"><input id="q" placeholder="Search product title…" autocomplete="off"/>
<select id="shop"><option value="">All shops</option></select></div>
<div class="count" id="count"></div>
<table><thead><tr><th>Product</th><th>Shop</th><th class="num">Price (so'm)</th></tr></thead>
<tbody id="rows"><tr><td colspan="3">Loading…</td></tr></tbody></table>
<div class="pager"><button id="prev">← Prev</button><span class="count" id="pageinfo"></span><button id="next">Next →</button></div>
<script>${ESC}
const LIMIT=50; let ALL=[],view=[],offset=0,q='',shop=new URLSearchParams(location.search).get('shop')||'';
const $=(id)=>document.getElementById(id);
Promise.all([fetch('./data/products.json').then(r=>r.json()),fetch('./data/shops.json').then(r=>r.json())]).then(([prods,shops])=>{
 ALL=prods;
 for(const s of shops){const o=document.createElement('option');o.value=s.shop_id;o.textContent=s.title+' ('+fmt(s.last_count)+')';if(String(s.shop_id)===String(shop))o.selected=true;$('shop').appendChild(o);}
 apply();
});
function apply(){const ql=q.toLowerCase();
 view=ALL.filter(p=>(!shop||String(p.shop_id)===String(shop))&&(!ql||(p.title||'').toLowerCase().includes(ql)));
 view.sort((a,b)=>(b.price||0)-(a.price||0)); offset=0; render();}
function render(){const tb=$('rows'); const page=view.slice(offset,offset+LIMIT);
 if(!page.length){tb.innerHTML='<tr><td colspan="3">No matches.</td></tr>';}
 else{tb.innerHTML='';for(const p of page){const purl='https://uzum.uz/uz/product/'+encodeURIComponent(p.product_id);
  const surl='https://uzum.uz/uz/seller/'+encodeURIComponent(p.shop_slug||'');const tr=document.createElement('tr');
  tr.innerHTML='<td><a class="cell" style="color:#1f2026" href="'+esc(purl)+'" target="_blank" rel="noopener">'+esc(p.title||'(untitled)')+'</a></td>'+
   '<td><a class="cell" href="'+esc(surl)+'" target="_blank" rel="noopener">'+esc(p.shop_title)+'</a></td>'+
   '<td class="num">'+fmt(p.price)+'</td>'; tb.appendChild(tr);} }
 $('count').textContent=fmt(view.length)+' products'+(shop?' in this shop':' across all shops');
 const from=view.length?offset+1:0,to=Math.min(offset+LIMIT,view.length);
 $('pageinfo').textContent=from+'–'+to+' of '+fmt(view.length);
 $('prev').disabled=offset===0; $('next').disabled=offset+LIMIT>=view.length;}
let t;$('q').oninput=()=>{clearTimeout(t);t=setTimeout(()=>{q=$('q').value.trim();apply();},250);};
$('shop').onchange=()=>{shop=$('shop').value;apply();};
$('prev').onclick=()=>{offset=Math.max(0,offset-LIMIT);render();};
$('next').onclick=()=>{offset+=LIMIT;render();};
</script></body></html>`);

console.log(`Static snapshot → ${OUT}`);
console.log(`  ${shops.length} shops, ${products.length} products, total ${totalProducts.toLocaleString('en-US')}`);
console.log('Deploy: cd web-static && vercel');
