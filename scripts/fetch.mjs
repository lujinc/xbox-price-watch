#!/usr/bin/env node
/**
 * 抓取 Xbox 官方商店目录（土耳其 TR / 阿根廷 AR），产出纯静态数据文件。
 *
 * 零第三方依赖，只用 Node 内置 fetch（Node 18+）。
 *
 * 每个市场输出两个文件：
 *   public/data/<region>.deals.json   只含正在打折的（约 1000 款，首屏用它，快）
 *   public/data/<region>.all.json     全量目录（约 1 万款，热门榜/全部/搜索用，懒加载）
 *
 * 环境变量：
 *   /  MAX_PAGES   每个市场最多翻多少页，默认 320（每页固定 50 条）
 *   /  CONCURRENCY 并发，默认 10
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/* ------------------------------------------------------------------ */
/* 市场配置                                                             */
/* ------------------------------------------------------------------ */

const REGIONS = {
  tr: {
    key: 'tr',
    market: 'TR',
    locale: 'tr-TR',
    currency: 'TRY',
    fxFallback: 0.134, // 1 TRY ≈ ? CNY，汇率接口挂了时的兜底
  },
  ar: {
    key: 'ar',
    market: 'AR',
    locale: 'es-AR',
    currency: 'ARS',
    fxFallback: 0.0043,
  },
};

const MAX_PAGES = Number(process.env.MAX_PAGES || 320);
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);
const ZH_CONCURRENCY = 8;
const PER_PAGE = 50;

const OUT_DIR = resolve('public/data');
const ZH_DICT_FILE = resolve('data/zh-names.json');

const API = 'https://emerald.xboxservices.com/xboxcomfd/browse';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const log = (...a) => console.log('[fetch]', ...a);

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rnd = () => Math.random().toString(36).slice(2, 12);

// MS-CV 是必需的关联向量，缺了直接 400；x-ms-api-version 只认 1.0
function headers(extra = {}) {
  const h = {
    'x-ms-api-version': '1.0',
    'MS-CV': rnd(),
    'User-Agent': UA,
    Accept: '*/*',
    ...extra,
  };
  // 传空串 = 明确不带这个头（displaycatalog 带了就 500）
  for (const k of Object.keys(h)) if (!h[k]) delete h[k];
  return h;
}

async function fetchJson(url, { retries = 3, timeout = 30_000, extraHeaders } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: headers(extraHeaders),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < retries) await sleep(500 * (i + 1));
    }
  }
  throw last;
}

/** "11/05/2026 09:59:59" → epoch ms（商店返回的是 M/D/YYYY 美式顺序） */
function parseStoreDate(s) {
  if (!s) return 0;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return 0;
  const [, mo, d, y, hh, mm, ss] = m;
  return Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
}

/* ------------------------------------------------------------------ */
/* 中文名对照表（商店只给约 18% 商品中文名，其余靠这份人工表补）            */
/* ------------------------------------------------------------------ */

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[®™©]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** 去掉 "(Windows)" "(Xbox One & Xbox Series X|S)" 这类平台尾巴 */
function stripPlatform(t) {
  return String(t || '')
    .replace(/\([^()]*?(?:windows|series|\bpc\b|xbox)[^()]*?\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let DICT = { titles: {}, parts: {}, numerals: {}, series: {}, keys: [] };

async function loadDict() {
  try {
    const j = JSON.parse(await readFile(ZH_DICT_FILE, 'utf8'));
    DICT = {
      titles: j.titles || {},
      parts: j.parts || {},
      numerals: j.numerals || {},
      series: j.series || {},
      keys: Object.keys(j.series || {}).sort((a, b) => b.length - a.length),
    };
    log(`中文对照表：${Object.keys(DICT.titles).length} 条整名 / ${DICT.keys.length} 个系列`);
  } catch (e) {
    log(`中文对照表没读到（${e.message}），只用商店自带的中文名`);
  }
}

/**
 * 用对照表推中文名：
 *   1. titles 整串精确命中
 *   2. series 最长前缀命中，剩下的按 parts（版本/副标题）和 numerals 逐段拼
 *   3. 只要有一段翻不出来就整体放弃 —— 宁可显示英文，也不要「Dying Light 精华版」这种半中半英
 */
function dictZhTitle(rawTitle) {
  if (!DICT.keys.length) return '';
  const key = normKey(stripPlatform(rawTitle));
  if (!key) return '';

  if (DICT.titles[key]) return DICT.titles[key];

  let best = '';
  for (const k of DICT.keys) {
    if (key === k) return DICT.series[k];
    if (key.startsWith(k + ' ') && k.length > best.length) best = k;
  }
  if (!best) return '';

  const rest = key.slice(best.length + 1).trim();
  if (!rest) return DICT.series[best];

  const words = rest.split(' ');
  const segs = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (let n = Math.min(3, words.length - i); n >= 1; n--) {
      const frag = words.slice(i, i + n).join(' ');
      if (Object.prototype.hasOwnProperty.call(DICT.parts, frag)) {
        if (DICT.parts[frag]) segs.push({ kind: 'part', text: DICT.parts[frag] });
        i += n;
        matched = true;
        break;
      }
      if (n === 1 && (DICT.numerals[frag] || /^\d+$/.test(frag))) {
        segs.push({ kind: 'num', text: DICT.numerals[frag] || frag });
        i += 1;
        matched = true;
        break;
      }
    }
    if (!matched) return '';
  }

  let out = DICT.series[best];
  let firstPart = true;
  for (const s of segs) {
    if (s.kind === 'num') {
      out += ' ' + s.text;
    } else {
      out += (firstPart ? '：' : ' ') + s.text;
      firstPart = false;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 目录抓取                                                             */
/* ------------------------------------------------------------------ */

function browseUrl(region, page) {
  const qs = new URLSearchParams({
    locale: region.locale,
    market: region.market,
    mediaType: 'Games',
    query: '',
    orderBy: 'Descending',
    deviceType: 'Console',
    pageNumber: String(page),
    resultsPerPage: String(PER_PAGE),
  });
  return `${API}?${qs}`;
}

function normalize(product, price, rank) {
  const p = price || {};
  const msrp = Number(p.msrp) || 0;
  const now = Number(p.listPrice) || 0;
  if (now <= 0) return null; // 免费 / 未定价，跳过
  const discount = Math.min(Math.round(Number(p.discountPercentage) || 0), 99);

  const img = product.images || {};
  const poster =
    img.poster?.url || img.boxArt?.url || img.featuredPromotionalSquareArt?.url || '';

  // 商店返回 XboxOne / XboxSeriesX / PC / Handheld，统一成 Xbox / PC 两个维度
  const on = Array.isArray(product.availableOn) ? product.availableOn : [];
  const platforms = [];
  if (on.some((x) => /^xbox/i.test(String(x)))) platforms.push('Xbox');
  if (on.some((x) => String(x) === 'PC' || String(x) === 'Handheld')) platforms.push('PC');

  return {
    id: product.productId,
    title: String(product.title || '').trim(),
    poster,
    price: now,
    msrp: msrp > 0 ? msrp : now,
    discount,
    end: parseStoreDate(p.endDateUtc),
    platforms,
    rank,
  };
}

async function crawlRegion(region) {
  const t0 = Date.now();
  const byId = new Map(); // id → { product, price, rank }

  for (let base = 1; base <= MAX_PAGES; base += CONCURRENCY) {
    const pages = [];
    for (let p = base; p < base + CONCURRENCY && p <= MAX_PAGES; p++) pages.push(p);

    const results = await Promise.all(pages.map((p) => fetchJson(browseUrl(region, p))));
    let empty = 0;

    // 响应里不带 pageNumber，名次只能用「请求的页号」算
    results.forEach((data, idx) => {
      const page = pages[idx];
      const products = data.productSummaries || [];
      if (!products.length) {
        empty++;
        return;
      }
      const prices = new Map();
      for (const a of data.availabilitySummaries || []) prices.set(a.productId, a.price);

      products.forEach((prod, i) => {
        const id = prod.productId;
        // 同一款可能出现在多页，保留最靠前的名次
        const rank = (page - 1) * PER_PAGE + i;
        const prev = byId.get(id);
        if (!prev || rank < prev.rank) byId.set(id, { product: prod, price: prices.get(id), rank });
      });
    });

    process.stderr.write(`\r  [${region.key}] 已抓 ${Math.min(base + CONCURRENCY - 1, MAX_PAGES)} 页 / ${byId.size} 款`);

    // 整批都空 → 目录到底了
    if (empty === pages.length) break;
  }

  process.stderr.write('\n');

  const items = [];
  for (const { product, price, rank } of byId.values()) {
    const it = normalize(product, price, rank);
    if (it) items.push(it);
  }
  items.sort((a, b) => a.rank - b.rank);

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(`[${region.key}] ${items.length} 款在库，${items.filter((x) => x.discount > 0).length} 款打折，${secs}s`);
  return items;
}

/* ------------------------------------------------------------------ */
/* 中文标题（按 productId 回查）                                          */
/* ------------------------------------------------------------------ */

/**
 * 商店目录接口虽然能给中文标题，但中文目录的排序和土区完全不同（实测只重合 4%），
 * 所以只有「按 id 回查」这条路能保证一款不落地拿到中文名。
 *
 * 注意：displaycatalog 只要把 MS-CV 当「请求头」发就返回 500，只能放查询参数里。
 */
async function fetchZhTitles(ids) {
  const BATCH = 100;
  const chunks = [];
  for (let i = 0; i < ids.length; i += BATCH) chunks.push(ids.slice(i, i + BATCH));

  const out = new Map();
  let cursor = 0;
  let done = 0;
  let failed = 0;

  async function worker() {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      const url =
        'https://displaycatalog.mp.microsoft.com/v7.0/products' +
        `?bigIds=${chunk.join(',')}&market=TR&languages=zh-cn` +
        `&fieldsTemplate=Browse&MS-CV=${rnd()}`;
      try {
        const j = await fetchJson(url, {
          timeout: 45_000,
          extraHeaders: { 'x-ms-api-version': '', 'MS-CV': '' },
        });
        for (const p of j.Products || []) {
          const t = p.LocalizedProperties?.[0]?.ProductTitle;
          if (p.ProductId && t) out.set(p.ProductId, String(t).trim());
        }
      } catch {
        failed++;
      }
      done++;
      if (done % 10 === 0) process.stderr.write(`\r  中文标题 ${done}/${chunks.length}`);
    }
  }

  await Promise.all(Array.from({ length: ZH_CONCURRENCY }, worker));
  process.stderr.write('\n');
  if (failed) log(`中文标题有 ${failed}/${chunks.length} 批失败（这些会显示原名）`);
  return out;
}

/* ------------------------------------------------------------------ */
/* 汇率                                                                 */
/* ------------------------------------------------------------------ */

async function getFx(region) {
  for (let i = 0; i < 2; i++) {
    try {
      const j = await fetchJson(`https://open.er-api.com/v6/latest/${region.currency}`, {
        retries: 1,
        timeout: 10_000,
      });
      const rate = Number(j?.rates?.CNY);
      if (rate > 0) return rate;
    } catch {
      /* 换失败重试一次，再不行用兜底 */
    }
  }
  log(`[${region.key}] 汇率接口失败，用兜底值 ${region.fxFallback}`);
  return region.fxFallback;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const started = Date.now();
  await loadDict();

  const keys = Object.keys(REGIONS);
  const result = {};

  for (const key of keys) {
    const region = REGIONS[key];
    log(`=== ${region.market} (${region.locale}) ===`);
    result[key] = await crawlRegion(region);
  }

  // 两个市场的 id 合成一次中文名回查，省一半请求
  const allIds = new Set();
  for (const key of keys) for (const it of result[key]) allIds.add(it.id);
  log(`中文名回查：${allIds.size} 个 id`);
  const zhMap = await fetchZhTitles([...allIds]);

  const updatedAt = Date.now();

  for (const key of keys) {
    const region = REGIONS[key];
    const items = result[key];

    let zhStore = 0;
    let zhDict = 0;
    for (const it of items) {
      const shopZh = zhMap.get(it.id);
      // 商店给了「中文名」但和原名一样，说明这款没做中文本地化 → 交给对照表再试一次
      if (shopZh && shopZh !== it.title) {
        it.zh = shopZh;
        zhStore++;
      } else {
        const d = dictZhTitle(it.title);
        if (d) {
          it.zh = d;
          zhDict++;
        }
      }
    }

    const fx = await getFx(region);
    const deals = items.filter((x) => x.discount > 0);
    const maxDiscount = deals.reduce((m, x) => Math.max(m, x.discount), 0);

    const meta = {
      v: 1,
      region: region.key,
      market: region.market,
      locale: region.locale,
      currency: region.currency,
      updatedAt,
      fx,
      count: items.length,
      dealCount: deals.length,
      maxDiscount,
      zhCount: zhStore + zhDict,
    };

    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(
      resolve(OUT_DIR, `${region.key}.deals.json`),
      JSON.stringify({ ...meta, items: deals })
    );
    await writeFile(
      resolve(OUT_DIR, `${region.key}.all.json`),
      JSON.stringify({ ...meta, items })
    );

    log(
      `[${region.key}] 输出完成：在库 ${items.length}，打折 ${deals.length}，最高 -${maxDiscount}%，` +
        `中文名 ${zhStore + zhDict}（商店 ${zhStore} + 对照表 ${zhDict}），1 ${region.currency} ≈ ¥${fx}`
    );
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`全部完成，耗时 ${secs}s`);
}

main().catch((err) => {
  console.error('\n抓取失败：', err);
  process.exit(1);
});
