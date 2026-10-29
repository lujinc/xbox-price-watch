#!/usr/bin/env node
// 抓取 Xbox 商店（默认土耳其区）全量游戏目录与价格，输出精简静态 JSON。
// 无任何第三方依赖，只用 Node 内置 fetch（Node 18+）。
//
// 环境变量：
//   MARKET     市场代码，默认 TR
//   LOCALE     本地化，默认 tr-TR
//   MAX_PAGES  最多抓多少页，默认 300（每页固定 50 条）
//   OUT        输出文件，默认 public/data/games.json

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MARKET = process.env.MARKET || 'TR';
const LOCALE = process.env.LOCALE || 'tr-TR';
const MAX_PAGES = Number(process.env.MAX_PAGES || 300);
const OUT = resolve(process.env.OUT || 'public/data/games.json');
const CONCURRENCY = 10;
const PER_PAGE = 50;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const API = 'https://emerald.xboxservices.com/xboxcomfd/browse';

// MS-CV 是必需的关联向量，缺了直接 400；x-ms-api-version 只认 1.0
function requestHeaders() {
  return {
    'x-ms-api-version': '1.0',
    'MS-CV': Math.random().toString(36).slice(2) + Date.now().toString(36),
    'User-Agent': UA,
    Accept: '*/*',
  };
}

async function fetchPage(pageNumber, attempt = 1) {
  const qs = new URLSearchParams({
    locale: LOCALE,
    market: MARKET,
    mediaType: 'Games',
    query: '',
    orderBy: 'Descending',
    deviceType: 'Console',
    pageNumber: String(pageNumber),
    resultsPerPage: String(PER_PAGE),
  });

  try {
    const res = await fetch(`${API}?${qs}`, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 4) throw new Error(`第 ${pageNumber} 页连续失败：${err.message}`);
    await new Promise((r) => setTimeout(r, 600 * attempt));
    return fetchPage(pageNumber, attempt + 1);
  }
}

function pickImageUrl(images, kind) {
  const raw = images?.[kind]?.url;
  if (!raw) return null;
  // CDN 支持按需缩图，只有 store-images.s-microsoft.com 认这套参数
  const sep = raw.includes('?') ? '&' : '?';
  return `${raw}${sep}w=360&h=540&q=80`;
}

function normalize(product, availability) {
  const price = availability?.price;
  if (!price || typeof price.listPrice !== 'number') return null;

  const platforms = [];
  const on = product.availableOn || [];
  if (on.some((x) => x === 'XboxOne' || x === 'XboxSeriesX')) platforms.push('Xbox');
  if (on.includes('PC')) platforms.push('PC');
  if (on.includes('Handheld')) platforms.push('掌机');

  const discount = Math.round((price.discountPercentage || 0) * 10) / 10;
  const endsRaw = price.endDateUtc || '';
  // endDateUtc 是 M/D/YYYY HH:mm:ss 的美式顺序；9998 表示「无促销截止」
  let ends = null;
  if (discount > 0 && endsRaw && !endsRaw.startsWith('12/30/9998')) {
    const [date, time] = endsRaw.split(' ');
    const [m, d, y] = date.split('/');
    ends = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${time}+00:00`;
  }

  return {
    id: product.productId,
    title: product.title,
    publisher: product.publisherName || '',
    poster: pickImageUrl(product.images, 'poster'),
    platforms,
    rating: product.averageRating ? Number(product.averageRating.toFixed(1)) : null,
    ratingCount: product.ratingCount || 0,
    now: price.listPrice,
    was: price.msrp,
    off: discount,
    cur: price.currency,
    ends,
    url: `https://www.xbox.com/${LOCALE}/games/store/x/${product.productId}`,
  };
}

async function main() {
  const started = Date.now();
  const byId = new Map();
  const priceById = new Map();
  let pageCount = 0;

  for (let base = 1; base <= MAX_PAGES; base += CONCURRENCY) {
    const batch = [];
    for (let p = base; p < base + CONCURRENCY && p <= MAX_PAGES; p += 1) batch.push(p);

    const results = await Promise.all(batch.map((p) => fetchPage(p)));
    let emptyHits = 0;

    for (const data of results) {
      const products = data.productSummaries || [];
      if (products.length === 0) {
        emptyHits += 1;
        continue;
      }
      pageCount += 1;
      for (const p of products) byId.set(p.productId, p);
      for (const a of data.availabilitySummaries || []) {
        if (!priceById.has(a.productId)) priceById.set(a.productId, a);
      }
    }

    process.stderr.write(`\r已抓 ${pageCount} 页 / ${byId.size} 款`);

    // 整批都空 → 目录到底了
    if (emptyHits === batch.length) break;
  }

  const games = [];
  for (const [id, product] of byId) {
    const item = normalize(product, priceById.get(id));
    if (item) games.push(item);
  }

  games.sort((a, b) => b.off - a.off || a.now - b.now);

  const payload = {
    market: MARKET,
    locale: LOCALE,
    currency: games[0]?.cur || null,
    updatedAt: new Date().toISOString(),
    total: games.length,
    onSale: games.filter((g) => g.off > 0).length,
    games,
  };

  // 拆成两个文件：促销名单很小，首屏只加载它；全量目录按需懒加载
  const salePayload = {
    ...payload,
    total: payload.onSale,
    games: games.filter((g) => g.off > 0),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload));
  await writeFile(OUT.replace(/\.json$/, '.sale.json'), JSON.stringify(salePayload));

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stderr.write(
    `\n完成：${games.length} 款（在售 ${payload.onSale} 款），${pageCount} 页，${secs}s\n` +
      `输出：${OUT}\n`
  );
}

main().catch((err) => {
  console.error('\n抓取失败：', err.message);
  process.exit(1);
});
