// Mac Radar — scanner lancé par GitHub Actions toutes les 20 minutes.
// Lit plusieurs sources, garde les MacBook Pro Pro/Max ≥ 24 Go ≤ budget (neuf ou reconditionné Apple),
// met à jour docs/deals.json et envoie une notification Web Push pour chaque nouvelle offre dans le budget.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEALS_FILE = path.join(ROOT, "docs", "deals.json");
const SUBS_FILE = path.join(ROOT, "data", "subscriptions.json");
const SEEN_FILE = path.join(ROOT, "data", "seen.json");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const BUDGET = CONFIG.budget;          // 2600
const WATCH_MAX = CONFIG.watchMax;     // 3000 : affichées dans « À surveiller »
const MIN_RAM = CONFIG.minRam;         // 24
const APP_URL = CONFIG.appUrl;
const NOW = new Date();
const TEST_PUSH = process.env.TEST_PUSH === "true";
const DEBUG = process.env.DEBUG === "true";

const DBG = {};
function dbg(k, v) { if (DEBUG) { (DBG[k] = DBG[k] || []).push(v); } }
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        "Accept": opts.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

// ---------- Décodage / parsing de texte ----------
function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&euro;/g, "€").replace(/&amp;/g, "&");
}
function stripTags(s) { return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }

const RAM_VALUES = new Set([16, 18, 24, 32, 36, 48, 64, 96, 128]);
const REFURB_RE = /reconditionn|occasion|renewed|refurb|seconde main|grade\s*[abc]\b|comme neuf|back\s*market|okamac|certideal|recommerce|ex-?d[ée]mo|d[ée]stockage d'occasion/i;
const MIN_RAM_BY_CHIP = { "M3 Pro": 18, "M3 Max": 36, "M4 Pro": 24, "M4 Max": 36, "M5 Pro": 24, "M5 Max": 36 };

function parsePrices(text) {
  const out = [];
  const re = /(\d{1,2}(?:[   .]?\d{3}))(?:[,.](\d{2}))?\s?(?:€|euros?\b|EUR\b)/gi;
  let m;
  while ((m = re.exec(text))) {
    const v = parseFloat(m[1].replace(/[   .]/g, "") + (m[2] ? "." + m[2] : ""));
    if (v >= 700 && v <= 9000) out.push(v);
  }
  const re2 = /€\s?(\d{1,2}(?:[   .,]?\d{3}))/g;
  while ((m = re2.exec(text))) {
    const v = parseFloat(m[1].replace(/[   .,]/g, ""));
    if (v >= 700 && v <= 9000) out.push(v);
  }
  return out;
}

// Extrait les specs d'un titre libre (« MacBook Pro 14" M5 Pro 24 Go / 1 To à 2 599 € au lieu de 2 899 € »)
function parseSpecs(text) {
  const t = " " + text.replace(/ | /g, " ") + " ";
  if (!/mac\s*book\s*pro/i.test(t)) return null;
  if (/mac\s*book\s*(air|neo)\b/i.test(t) && !/mac\s*book\s*pro/i.test(t.replace(/mac\s*book\s*(air|neo)/ig, ""))) return null;
  const chipM = t.match(/\bM\s?([345])\s*(Pro|Max)\b/i);
  if (!chipM) return null;
  const gen = "M" + chipM[1];
  const tier = chipM[2][0].toUpperCase() + chipM[2].slice(1).toLowerCase();
  const chip = `${gen} ${tier}`;
  let ram = null;
  const gbRe = /(\d{2,4})\s?(?:go|gb)\b/gi; let g;
  while ((g = gbRe.exec(t))) { const v = +g[1]; if (RAM_VALUES.has(v)) { ram = v; break; } }
  let ramInferred = false;
  if (ram == null) { ram = MIN_RAM_BY_CHIP[chip] || null; ramInferred = true; }
  let storage = null;
  const to = t.match(/\b(\d)\s?(?:to|tb)\b/i);
  if (to) storage = `${to[1]} To`;
  else { const go = t.match(/\b(256|512)\s?(?:go|gb)\b/i); if (go) storage = `${go[1]} Go`; }
  let size = null;
  const sz = t.match(/\b(14|16)(?:[.,][12])?\s?(?:"|″|''|”|pouces|po\b|inch|-inch|\s?inch)/i) || t.match(/\b(14|16)[.,][12]\b/);
  if (sz) size = +sz[1];
  const cg = t.match(/CPU\s*(?:de\s*)?(\d{1,2})\s*c[\wœ]*\s*(?:[\/,\-]|et)?\s*GPU\s*(?:de\s*)?(\d{1,2})/i)
    || t.match(/(\d{1,2})\s*c[\wœ]*\s*CPU\s*(?:[\/,\-]|et)?\s*(\d{1,2})\s*c[\wœ]*\s*GPU/i)
    || t.match(/\b(1[0-9])\s?\/\s?(1[0-9]|[2-4][0-9])\s*(?:c\b|cœurs|coeurs|cores)/i);
  const prices = parsePrices(t);
  const price = prices.length ? Math.min(...prices) : null;
  const oldPrice = prices.length > 1 ? Math.max(...prices) : null;
  return { chip, gen, tier, ram, ramInferred, storage, size, cpuGpu: cg ? `${cg[1]}/${cg[2]}` : null, price, oldPrice: oldPrice && oldPrice > price ? oldPrice : null };
}

function keyboardNote(url, text) {
  if (/amazon\.(it|de|es|nl|com\.be)|qwerty|qwertz/i.test(url + " " + text)) return "Clavier QWERTY ou QWERTZ (vendu hors de France).";
  return null;
}

// ---------- Sources ----------
const sources = {};
async function runSource(name, fn) {
  try {
    const items = await fn();
    sources[name] = { ok: true, count: items.length };
    return items;
  } catch (e) {
    sources[name] = { ok: false, count: 0, error: String(e.message || e).slice(0, 120) };
    console.log(`[${name}] erreur : ${e.message || e}`);
    return [];
  }
}

// 1) Apple Reconditionné France (JSON embarqué dans la page)
async function appleRefurb() {
  const items = []; const seenUrl = new Set(); let fetched = 0;
  for (const url of ["https://www.apple.com/fr/shop/refurbished/mac/macbook-pro", "https://www.apple.com/fr/shop/browse/home/specialdeals/mac/macbook_pro"]) {
    let html; try { html = await get(url); fetched++; } catch (e) { dbg("apple", { url, error: e.message }); continue; }
    for (const it of appleParse(html, url)) { if (!seenUrl.has(it.url + it.price)) { seenUrl.add(it.url + it.price); items.push(it); } }
  }
  if (!fetched) throw new Error("page Apple injoignable");
  return items;
}
function appleParse(html, url) {
  const items = [];
  const m = html.match(/REFURB_GRID_BOOTSTRAP\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (m) {
    const data = JSON.parse(m[1]);
    for (const tile of data.tiles || []) {
      const title = decodeEntities(tile.title || "");
      dbg("appleTiles", `${title} | ${JSON.stringify(tile.price && tile.price.currentPrice)} | ${JSON.stringify(tile.filters && tile.filters.dimensions)}`.slice(0, 400));
      if (!/macbook\s*pro/i.test(title)) continue;
      const dims = (tile.filters && tile.filters.dimensions) || {};
      const raw = tile.price && tile.price.currentPrice && (tile.price.currentPrice.raw_amount || tile.price.currentPrice.amount);
      const price = raw ? parseFloat(String(raw).replace(/[^\d.,]/g, "").replace(/\s/g, "").replace(",", ".")) : null;
      const prev = tile.price && tile.price.previousPrice && (tile.price.previousPrice.raw_amount || tile.price.previousPrice.previousPrice);
      const specs = parseSpecs(title) || {};
      if (!specs.chip) continue;
      const ramDim = String(dims.tsMemorySize || "").match(/(\d+)/);
      const capDim = String(dims.dimensionCapacity || "").match(/(\d+)\s*(gb|tb)/i);
      const sizeDim = String(dims.dimensionScreensize || "").match(/(\d+)/);
      items.push({
        ...specs,
        ram: ramDim ? +ramDim[1] : specs.ram,
        ramInferred: ramDim ? false : specs.ramInferred,
        storage: capDim ? (capDim[2].toLowerCase() === "tb" ? `${capDim[1]} To` : `${capDim[1]} Go`) : specs.storage,
        size: sizeDim ? +sizeDim[1] : specs.size,
        price, oldPrice: prev ? parseFloat(String(prev).replace(",", ".")) : null,
        title, merchant: "Apple Reconditionné", condition: "reco-apple",
        url: tile.productDetailsUrl ? new URL(tile.productDetailsUrl, "https://www.apple.com").href.split("?")[0] : url,
        sourceUrl: url, source: "Apple Reconditionné", confirmed: true,
      });
    }
  } else {
    // Secours : titres + prix bruts
    dbg("apple", { url, note: "pas de REFURB_GRID_BOOTSTRAP", len: html.length, sample: html.slice(0, 300) });
    const re = /MacBook Pro[^<]{0,60}reconditionné avec puce Apple (M[345] (?:Pro|Max))[^<]*<[\s\S]{0,600}?(\d[\d\s ]*,\d{2})\s?€/g;
    let x;
    while ((x = re.exec(html))) {
      const specs = parseSpecs(x[0].replace(/<[^>]+>/g, " ")) || {};
      if (!specs.chip) continue;
      items.push({ ...specs, merchant: "Apple Reconditionné", condition: "reco-apple", url, sourceUrl: url, source: "Apple Reconditionné", confirmed: true, title: stripTags(x[0]).slice(0, 160) });
    }
  }
  return items;
}

// 2) Dealabs : pages de recherche (données JSON « data-vue3 » de chaque deal), avec repli RSS
function dealabsThreadsFromHtml(html) {
  const out = [];
  const re = /data-vue[23]=(?:"([^"]+)"|'([^']+)')/g; let m;
  while ((m = re.exec(html))) {
    let obj; try { obj = JSON.parse(decodeEntities(m[1] || m[2])); } catch { continue; }
    const th = obj && obj.props && obj.props.thread;
    if (!th || !th.title) continue;
    out.push(th);
  }
  return out;
}
async function dealabs() {
  const queries = ["macbook pro m5 pro", "macbook pro m4 pro", "macbook pro m5 max", "macbook pro m4 max", "macbook pro m3 pro", "macbook pro m3 max"];
  const items = []; let fetched = 0;
  for (const q of queries) {
    const url = `https://www.dealabs.com/search?q=${encodeURIComponent(q)}&sortBy=new`;
    let html;
    try { html = await get(url); fetched++; } catch (e) { console.log(`[Dealabs] ${q} : ${e.message}`); continue; }
    const threads = dealabsThreadsFromHtml(html);
    dbg("dealabs", { q, len: html.length, vue: (html.match(/data-vue[23]=/g) || []).length, threads: threads.length, titles: threads.slice(0, 5).map((t) => t.title), around: html.slice(Math.max(0, html.indexOf("MacBook") - 200), html.indexOf("MacBook") + 300) });
    if (DEBUG) console.log(`[Dealabs] ${q} : ${threads.length} deals lus`);
    for (const th of threads) {
      const published = th.publishedAt ? new Date(th.publishedAt * 1000) : null;
      if (published && NOW - published > 10 * 86400e3) continue;
      const merchant = (th.merchant && (th.merchant.merchantName || th.merchant.name)) || th.merchantName || null;
      const title = decodeEntities(th.title);
      const specs = parseSpecs(`${title} ${th.price ? th.price + " €" : ""} ${th.nextBestPrice ? th.nextBestPrice + " €" : ""}`);
      if (!specs) continue;
      if (th.price) specs.price = +th.price;
      if (th.nextBestPrice && +th.nextBestPrice > specs.price) specs.oldPrice = +th.nextBestPrice;
      const link = th.shareableLink || (th.threadId ? `https://www.dealabs.com/bons-plans/${th.titleSlug || "deal"}-${th.threadId}` : url);
      items.push({
        ...specs, title, merchant: merchant || "Dealabs", condition: "neuf",
        url: link, sourceUrl: link, source: "Dealabs",
        expired: !!(th.isExpired || th.status === "expired"),
        temperature: th.temperature != null ? Math.round(th.temperature) : null,
        refurbFlag: REFURB_RE.test(title),
        publishedAt: published ? published.toISOString() : null,
      });
    }
  }
  if (!items.length) {
    // Repli : flux RSS des nouveaux deals
    for (const feed of ["https://www.dealabs.com/rss/nouveaux", "https://www.dealabs.com/rss/hot"]) {
      try {
        const xml = await get(feed, { accept: "application/rss+xml,application/xml,text/xml" });
        for (const it of rssItems(xml)) {
          const specs = parseSpecs(it.title + " " + it.description);
          if (!specs) continue;
          items.push({ ...specs, title: it.title, merchant: "Dealabs", condition: "neuf", url: it.link, sourceUrl: it.link, source: "Dealabs (RSS)", refurbFlag: REFURB_RE.test(it.title + " " + it.description), publishedAt: it.date });
        }
        fetched++;
      } catch (e) { console.log(`[Dealabs RSS] ${e.message}`); }
    }
  }
  if (!fetched) throw new Error("Dealabs a bloqué toutes les requêtes");
  return items;
}

function rssItems(xml) {
  const items = [];
  const re = /<item[\s>]([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const pick = (tag) => { const x = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)); return x ? stripTags(x[1]) : ""; };
    const date = pick("pubDate");
    items.push({ title: pick("title"), link: decodeEntities(pick("link")), description: pick("description"), source: pick("source"), date: date ? new Date(date).toISOString() : null });
  }
  return items;
}

// 3) Agrégateurs d'actus (Google Actualités + Bing Actualités) : iPhon.fr, MacG, Consomac, Frandroid, Les Numériques, Journal du Geek…
async function newsFeeds() {
  const qs = [
    '"MacBook Pro" "M5 Pro" prix', '"MacBook Pro" "M4 Pro" promo', '"MacBook Pro" "M5 Max" promo',
    '"MacBook Pro" "M4 Max" promo', '"MacBook Pro" bon plan', '"MacBook Pro" Black Friday',
  ];
  const items = []; let fetched = 0;
  for (const q of qs) {
    const feeds = [
      `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:2d")}&hl=fr&gl=FR&ceid=FR:fr`,
      `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=fr-FR&cc=FR`,
    ];
    for (const f of feeds) {
      let xml; try { xml = await get(f, { accept: "application/rss+xml,application/xml,text/xml" }); fetched++; } catch (e) { console.log(`[Actus] ${e.message}`); continue; }
      const rssList = rssItems(xml);
      dbg("news", { feed: f.slice(0, 90), len: xml.length, items: rssList.length, titles: rssList.slice(0, 4).map((i) => i.title) });
      for (const it of rssList) {
        if (it.date && NOW - new Date(it.date) > 2 * 86400e3) continue;
        const text = `${it.title} ${it.description}`;
        const specs = parseSpecs(text);
        if (!specs || !specs.price) continue;
        const outlet = it.source || (it.title.match(/ - ([^-]+)$/) || [])[1] || "Actualités";
        const merchant = (text.match(/\b(?:chez|sur)\s+(Amazon|Fnac|Darty|Boulanger|LDLC|Cdiscount|Carrefour|Leclerc|Rakuten|Apple|Materiel\.net|Auchan|Joybuy|Electro D[ée]p[ôo]t)/i) || [])[1] || null;
        items.push({ ...specs, title: it.title, merchant: merchant || outlet, condition: "neuf", url: it.link, sourceUrl: it.link, source: outlet.trim(), refurbFlag: REFURB_RE.test(text), publishedAt: it.date, fromNews: true });
      }
    }
  }
  if (!fetched) throw new Error("flux d'actualités injoignables");
  return items;
}

// 4) Revendeurs en direct (beaucoup bloquent les robots : chaque échec est simplement noté)
async function retailers() {
  const items = [];
  const searches = [
    { name: "LDLC", url: "https://www.ldlc.com/recherche/macbook%20pro%20m5%20pro/", split: /class="pdt-item/ },
    { name: "LDLC", url: "https://www.ldlc.com/recherche/macbook%20pro%20m4%20pro/", split: /class="pdt-item/ },
    { name: "Materiel.net", url: "https://www.materiel.net/recherche/macbook%20pro%20m5%20pro/", split: /class="c-products-list__item/ },
    { name: "Boulanger", url: "https://www.boulanger.com/resultats?tr=macbook+pro+m5+pro", split: /class="product-list__item|data-product-id=/ },
    { name: "Fnac", url: "https://www.fnac.com/SearchResult/ResultList.aspx?Search=macbook+pro+m5+pro", split: /class="Article-item|data-prid=/ },
    { name: "Darty", url: "https://www.darty.com/nav/recherche?text=macbook+pro+m5+pro", split: /class="product_detail|data-sku=/ },
    { name: "Amazon", url: "https://www.amazon.fr/s?k=macbook+pro+m5+pro&i=computers", split: /data-component-type="s-search-result"/ },
  ];
  let okCount = 0;
  for (const s of searches) {
    let html;
    try { html = await get(s.url); okCount++; } catch (e) { console.log(`[${s.name}] ${e.message}`); continue; }
    // Texte visible de la page, découpé à chaque nom de produit « MacBook Pro »
    const text = stripTags(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " "));
    const starts = []; const nameRe = /(?:Apple\s+)?Mac\s?Book\s+Pro\b/gi; let nm;
    while ((nm = nameRe.exec(text))) starts.push(nm.index);
    const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]{0,200}MacBook Pro[^<]{0,200})<\/a>/gi)].map((x) => ({ href: x[1], name: stripTags(x[2]) }));
    const segs = [];
    for (let i = 0; i < starts.length; i++) {
      const seg = text.slice(starts[i], Math.min(starts[i] + 700, starts[i + 1] ?? text.length));
      if (seg.length < 25) continue;
      segs.push(seg);
    }
    dbg("retailers", { name: s.name, len: html.length, segments: segs.length, samples: segs.filter((x) => /€/.test(x)).slice(0, 4).map((x) => x.slice(0, 260)) });
    const seenSeg = new Set();
    for (const seg of segs) {
      if (REFURB_RE.test(seg) || /vendu (?:et expédié )?par (?!amazon|fnac|darty|boulanger|ldlc|materiel)/i.test(seg)) continue;
      const specs = parseSpecs(seg);
      if (!specs || !specs.price || specs.price < 1500) continue;
      const name = seg.split(/\s(?=\d[\d\s]*[,.]?\d*\s?€)/)[0].slice(0, 160);
      const k = specs.chip + specs.ram + specs.storage + specs.price;
      if (seenSeg.has(k)) continue; seenSeg.add(k);
      const lk = links.find((l) => name.toLowerCase().includes(l.name.toLowerCase().slice(0, 40)) || l.name.toLowerCase().includes(name.toLowerCase().slice(0, 40)));
      const link = lk ? new URL(decodeEntities(lk.href), s.url).href.split("#")[0] : s.url;
      items.push({ ...specs, title: name, merchant: s.name, condition: "neuf", url: link, sourceUrl: s.url, source: s.name, fromRetailer: true });
    }
  }
  if (!okCount) throw new Error("tous les revendeurs ont bloqué la requête");
  return items;
}

// ---------- Programme principal ----------
function dealKey(d) {
  return [d.gen + (d.tier || ""), d.size || "x", d.ram || "x", (d.storage || "x").replace(/\s/g, ""), Math.round(d.price || 0)].join("-").toLowerCase();
}
function slug(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24); }

async function main() {
  const prev = readJson(DEALS_FILE, { deals: [] });
  const seen = readJson(SEEN_FILE, { keys: {} });
  const subs = readJson(SUBS_FILE, []);

  const found = [
    ...(await runSource("Apple Reconditionné", appleRefurb)),
    ...(await runSource("Dealabs", dealabs)),
    ...(await runSource("Actus (Google/Bing)", newsFeeds)),
    ...(await runSource("Revendeurs", retailers)),
  ];

  // Filtrage strict des critères
  const valid = [];
  for (const d of found) {
    if (!d.chip || !d.price) continue;
    if (d.condition !== "reco-apple" && (d.refurbFlag || REFURB_RE.test(d.title || ""))) continue;
    if (d.chip === "M3 Pro" && d.ramInferred) continue;           // M3 Pro de base = 18 Go
    if (d.ram == null || d.ram < MIN_RAM) continue;
    if (d.price > WATCH_MAX) continue;
    valid.push(d);
  }

  // Fusion avec l'historique
  const byId = new Map((prev.deals || []).map((d) => [d.id, d]));
  const seenThisRun = new Set();
  const fresh = [];
  for (const d of valid) {
    const id = `${slug(d.merchant)}-${dealKey(d)}`;
    if (seenThisRun.has(id)) continue;
    seenThisRun.add(id);
    const old = byId.get(id);
    const note = [keyboardNote(d.url || "", d.title || ""), d.ramInferred ? `RAM non précisée : ${d.ram} Go minimum sur cette puce, à confirmer.` : null, d.fromNews ? `Relayé par ${d.source}.` : null]
      .filter(Boolean).join(" ") || null;
    const rec = {
      id, chip: d.chip, gen: d.gen, tier: d.tier, cpuGpu: d.cpuGpu || (old && old.cpuGpu) || null,
      size: d.size || (old && old.size) || null, ram: d.ram, storage: d.storage || (old && old.storage) || null,
      price: d.price, oldPrice: d.oldPrice || (old && old.oldPrice) || null,
      merchant: d.merchant, condition: d.condition,
      status: d.expired ? "expired" : (d.confirmed ? "active" : "to_verify"),
      url: d.url, sourceUrl: d.sourceUrl, source: d.source, title: d.title || null,
      temperature: d.temperature ?? null, note,
      foundAt: (old && old.foundAt) || NOW.toISOString(), checkedAt: NOW.toISOString(), lastSeen: NOW.toISOString(),
    };
    byId.set(id, rec);
    const inBudget = rec.status !== "expired" && rec.price <= BUDGET && rec.ram >= MIN_RAM;
    const k = dealKey(rec);
    if (inBudget && !seen.keys[k]) { fresh.push(rec); }
    if (inBudget) seen.keys[k] = NOW.toISOString();
  }

  // Expiration : reconditionné Apple absent de la page = vendu ; autres sources non revues depuis 48 h
  const appleOk = sources["Apple Reconditionné"] && sources["Apple Reconditionné"].ok;
  for (const d of byId.values()) {
    if (seenThisRun.has(d.id) || d.status === "expired") continue;
    const age = NOW - new Date(d.lastSeen || d.checkedAt || 0);
    if ((d.condition === "reco-apple" && appleOk) || age > 48 * 3600e3) { d.status = "expired"; d.checkedAt = NOW.toISOString(); }
  }
  // On garde 14 jours d'historique
  const deals = [...byId.values()].filter((d) => NOW - new Date(d.lastSeen || d.checkedAt || 0) < 14 * 86400e3);
  for (const k of Object.keys(seen.keys)) if (NOW - new Date(seen.keys[k]) > 30 * 86400e3) delete seen.keys[k];

  const inBudgetCount = deals.filter((d) => d.status !== "expired" && d.price <= BUDGET).length;
  writeJson(DEALS_FILE, {
    lastScan: NOW.toISOString(),
    summary: `${inBudgetCount} offre${inBudgetCount > 1 ? "s" : ""} dans le budget`,
    budget: BUDGET, minRam: MIN_RAM, sources, deals,
  });
  writeJson(SEEN_FILE, seen);
  if (DEBUG) writeJson(path.join(ROOT, "data", "debug.json"), DBG);
  console.log(`Scan terminé : ${found.length} trouvées, ${valid.length} valides, ${fresh.length} nouvelles dans le budget.`);
  console.log(JSON.stringify(sources));

  // Notifications
  const messages = fresh.slice(0, 5).map((d) => ({
    title: `🔥 ${d.chip} ${d.size ? d.size + "″ " : ""}à ${Math.round(d.price).toLocaleString("fr-FR")} €`,
    body: `MacBook Pro ${d.ram} Go${d.storage ? " / " + d.storage : ""} chez ${d.merchant}${d.condition === "reco-apple" ? " (reconditionné Apple)" : ""}${d.oldPrice ? ` au lieu de ${Math.round(d.oldPrice).toLocaleString("fr-FR")} €` : ""}`,
    url: d.url || APP_URL, tag: d.id,
  }));
  if (fresh.length > 5) messages.push({ title: `+${fresh.length - 5} autres offres`, body: "Ouvre Mac Radar pour tout voir.", url: APP_URL, tag: "more" });
  if (TEST_PUSH) messages.unshift({ title: "Mac Radar est connecté ✅", body: `Test réussi. ${inBudgetCount} offre(s) dans ton budget en ce moment.`, url: APP_URL, tag: "test" });
  await sendPushes(subs, messages);
}

async function sendPushes(subs, messages) {
  if (!messages.length || !subs.length) { if (messages.length) console.log("Aucun téléphone abonné : notifications non envoyées."); return; }
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) { console.log("VAPID_PRIVATE_KEY absent : notifications non envoyées."); return; }
  webpush.setVapidDetails(CONFIG.vapidSubject, CONFIG.vapidPublicKey, priv);
  const alive = [];
  for (const s of subs) {
    let gone = false;
    for (const msg of messages) {
      try { await webpush.sendNotification(s, JSON.stringify(msg), { TTL: 3600, urgency: "high" }); }
      catch (e) { console.log(`Push échoué (${e.statusCode || ""}) : ${e.body || e.message}`); if (e.statusCode === 404 || e.statusCode === 410) { gone = true; break; } }
    }
    if (!gone) alive.push(s);
  }
  if (alive.length !== subs.length) writeJson(SUBS_FILE, alive);
  console.log(`Notifications envoyées à ${alive.length} appareil(s) : ${messages.length} message(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
