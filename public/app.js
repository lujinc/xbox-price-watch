/* ==================================================================
   Xbox 低价区特价 · 前端逻辑（纯静态版）
   支持土耳其（TRY）/ 阿根廷（ARS）两个市场，右上角可切换。
   数据分两层取：
     /data/<region>.deals.json  只有打折的（约 1000 款）→ 首屏秒开
     /data/<region>.all.json    全量目录（约 1 万款）→ 后台静默补全，给热门榜 / 全部 / 搜索用
   筛选 / 排序 / 分页全部本地完成，不依赖任何服务端。
   ================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const BATCH = 48;
const ENDING_SOON_MS = 48 * 3600 * 1000;
const DATA_DIR = './data/';

/* ------------------------------ 市场配置 ------------------------------ */

const REGIONS = {
  tr: {
    key: 'tr',
    label: '土耳其',
    short: 'TR',
    currency: 'TRY',
    unit: 'TL',
    storeLocale: 'tr-TR',
    numLocale: 'tr-TR',
    money: (s) => s + ' TL',
    brandSub: 'Türkiye Store · TRY',
  },
  ar: {
    key: 'ar',
    label: '阿根廷',
    short: 'AR',
    currency: 'ARS',
    unit: 'ARS',
    storeLocale: 'es-AR',
    numLocale: 'es-AR',
    money: (s) => '$ ' + s,
    brandSub: 'Tienda Argentina · ARS',
  },
};

const REGION_KEY = 'xb-region';
const savedRegion = (() => {
  try { return localStorage.getItem(REGION_KEY); } catch { return null; }
})();
// 优先认 URL 里的 ?region=，这样可以把某个区直接收藏成书签
const urlRegion = (() => {
  try {
    return new URLSearchParams(location.search).get('region');
  } catch {
    return null;
  }
})();
const initialRegion = REGIONS[urlRegion]
  ? urlRegion
  : REGIONS[savedRegion]
    ? savedRegion
    : 'tr';

const state = {
  region: initialRegion,
  items: [],        // 已加载的商品：先只有打折的，补全后是全量
  full: false,      // items 是否已经是全量目录
  fullLoading: false,
  fullFailed: false,
  count: 0,         // 在库总数（全量）
  dealCount: 0,
  maxDiscount: 0,
  fx: 0,            // 1 当地货币 → CNY
  updatedAt: 0,
  tab: 'deals',
  q: '',
  minDisc: 0,
  plat: 'all',
  sort: 'hot',
  shown: 0,
  filtered: [],
};

const regionOf = () => REGIONS[state.region] || REGIONS.tr;

/** 当前视图是不是必须要全量目录（热门榜 / 全部游戏 / 搜索都跨全库） */
const needsFull = () => state.tab !== 'deals' || !!state.q;

/* ------------------------------ 工具 ------------------------------ */

const nfCache = new Map();
function nf(locale) {
  let f = nfCache.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    nfCache.set(locale, f);
  }
  return f;
}

/** 按当前市场格式化价格：土耳其 "199,00 TL"，阿根廷 "$ 149.990,00" */
function fmtMoney(v) {
  const r = regionOf();
  return r.money(nf(r.numLocale).format(Number(v) || 0));
}

function fmtCNY(price) {
  const v = (Number(price) || 0) * state.fx;
  if (!v) return '';
  return '≈ ¥' + (v >= 100 ? v.toFixed(0) : v < 10 ? v.toFixed(2) : v.toFixed(1));
}

/** 汇率提示里的小数位：TRY 用 3 位，ARS 太小要 4 位 */
function fxText() {
  const v = state.fx;
  if (!v) return '';
  const digits = v < 0.01 ? 4 : 3;
  return `1 ${regionOf().currency} ≈ ¥${v.toFixed(digits)}`;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim();
}

function slugify(t) {
  return (
    String(t || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'game'
  );
}

const storeUrl = (it) =>
  `https://www.xbox.com/${regionOf().storeLocale}/games/store/${slugify(it.title)}/${it.id}`;

/**
 * 微软图片 CDN 支持 ?w=&h=&q= 按需缩图（原图 200~700KB，缩到 360 宽约 30KB）
 * 只对官方 CDN 生效，其它域名原样返回。
 */
function artUrl(u, w, h, q = 80) {
  if (!u) return '';
  if (!/store-images\.s-microsoft\.com/.test(u)) return u;
  const sep = u.includes('?') ? '&' : '?';
  return `${u}${sep}w=${w}&h=${h}&q=${q}`;
}

function endText(end) {
  if (!end) return '';
  const left = end - Date.now();
  if (left <= 0) return '已结束';
  const d = Math.floor(left / 86400000);
  const h = Math.floor((left % 86400000) / 3600000);
  if (d >= 1) return `剩 ${d} 天`;
  if (h >= 1) return `剩 ${h} 小时`;
  return '不足 1 小时';
}

const isEndingSoon = (it) => it.end && it.end - Date.now() < ENDING_SOON_MS && it.end > Date.now();

/** 有中文名就优先显示中文，英文/土文原名保留在 tooltip 里 */
const titleOf = (it) => it.zh || it.title;
const CJK = /[\u4e00-\u9fa5]/;

/** 中文名里已经包含了大部分英文原名时，不必再显示英文副标题 */
function showSubtitle(it) {
  if (!it.zh || !CJK.test(it.zh) || CJK.test(it.title)) return false;
  const words = norm(it.title).split(' ').filter(Boolean);
  if (!words.length) return false;
  const nz = norm(it.zh);
  const hit = words.filter((w) => nz.includes(w)).length;
  return hit / words.length < 0.7;
}

/** 常见简称 / 俗称 → 正式名，让 gta、老头环 这类说法也能搜到 */
const ALIASES = {
  gta: ['grand theft auto'],
  cod: ['call of duty'],
  rdr: ['red dead redemption'],
  bf: ['battlefield'],
  tlou: ['the last of us'],
  nba2k: ['nba 2k'],
  mw: ['modern warfare'],
  老头环: ['艾尔登法环'],
  大镖客: ['red dead redemption'],
  黑神话: ['black myth'],
  求生之路: ['left 4 dead'],
};
const altsOf = (tk) => [tk].concat(ALIASES[tk] || []);

/* ------------------------------ 数据加载 ------------------------------ */

const gridEl = $('#grid');
const skelEl = $('#skeletons');
const emptyEl = $('#empty');
const sentinel = $('#sentinel');
const loadmoreWrap = $('#loadmoreWrap');

const EMPTY_HTML = emptyEl.innerHTML;
const loadingHtml = () =>
  '<div class="empty-ico">⏳</div><h3>正在加载目录</h3>' +
  `<p>正在读取${regionOf().label}区全量目录，马上就好。</p>`;

function renderSkeletons(n = 12) {
  skelEl.innerHTML = Array.from({ length: n })
    .map(
      () =>
        '<div class="skel"><div class="skel-art"></div>' +
        '<div class="skel-line"></div><div class="skel-line short"></div></div>'
    )
    .join('');
}
const hideSkeletons = () => { skelEl.innerHTML = ''; };

/** 读一个数据文件：no-cache 让浏览器走 304 协商，既不会拿到隔夜旧数据，也不用重复下载 */
async function readJson(file, bust) {
  const url = `${DATA_DIR}${file}${bust ? `?t=${Date.now()}` : ''}`;
  const res = await fetch(url, { cache: bust ? 'no-store' : 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

let slowTimer = null;

async function loadData({ bust = false } = {}) {
  const region = state.region;
  renderSkeletons();
  gridEl.innerHTML = '';
  loadmoreWrap.hidden = true;
  $('#resultCount').textContent = '';

  clearTimeout(slowTimer);
  slowTimer = setTimeout(() => {
    $('#heroSub').textContent = '正在读取数据，稍等一下…';
  }, 2500);

  try {
    const data = await readJson(`${region}.deals.json`, bust);
    if (state.region !== region) return;   // 读取途中切了市场，丢弃旧结果
    state.items = data.items || [];
    state.full = false;
    state.fullLoading = false;
    state.fullFailed = false;
    applyMeta(data);
    render();
    // 首屏已经能看了，剩下的全量目录在后台补（约 1.4MB，延后一点，别跟封面图抢带宽）
    scheduleFull();
  } catch (e) {
    if (state.region !== region) return;
    hideSkeletons();
    emptyEl.hidden = false;
    emptyEl.innerHTML =
      '<div class="empty-ico">⚠️</div><h3>数据加载失败</h3>' +
      '<p>可能是还没抓到第一批数据，或网络不通。点右上角「刷新」重试。</p>';
    $('#heroSub').textContent = '读取数据失败：' + e.message;
  } finally {
    clearTimeout(slowTimer);
  }
}

/** 全量目录 1.4MB 左右，没必要让「只看打折」的人白下；延后补，省流量/弱网就先不补 */
let fullTimer = null;
function scheduleFull(delay = 1500) {
  clearTimeout(fullTimer);
  const conn = navigator.connection || {};
  if (conn.saveData) return;
  if (/^(slow-)?2g$|^3g$/.test(conn.effectiveType || '')) return;
  fullTimer = setTimeout(loadFull, delay);
}

/** 后台补全全量目录；只补一次，失败也不打扰用户（打折视图不依赖它） */
async function loadFull() {
  if (state.full || state.fullLoading) return;
  const region = state.region;
  state.fullLoading = true;
  state.fullFailed = false;
  try {
    const data = await readJson(`${region}.all.json`);
    if (state.region !== region) return;
    state.items = data.items || [];
    state.full = true;
    applyMeta(data);
    if (needsFull()) render();   // 正在看热门榜/全部/搜索时才有必要重画
  } catch {
    // 首屏的打折列表仍然可用；只有当前视图真的需要全量时才提示失败
    if (state.region === region) {
      state.fullFailed = true;
      if (needsFull()) render();
    }
  } finally {
    if (state.region === region) state.fullLoading = false;
  }
}

function applyMeta(data) {
  // 打折数和最高折扣以 meta 为准（首屏的 deals 文件里已经带了全量统计）
  state.count = data.count || 0;
  state.dealCount = data.dealCount || 0;
  state.maxDiscount = data.maxDiscount || 0;
  state.fx = data.fx || 0;
  state.updatedAt = data.updatedAt || 0;

  $('#statDeals').textContent = state.dealCount.toLocaleString('zh-CN');
  $('#statMax').textContent = state.maxDiscount ? '−' + state.maxDiscount + '%' : '—';
  $('#statCount').textContent = state.count.toLocaleString('zh-CN');
  $('#tabDealsCount').textContent = state.dealCount.toLocaleString('zh-CN');

  const t = state.updatedAt ? new Date(state.updatedAt) : null;
  const ts = t
    ? `${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')} ` +
      `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    : '—';

  $('#heroSub').innerHTML =
    `共 <b>${state.count.toLocaleString('zh-CN')}</b> 款游戏在库 · ` +
    `更新于 ${ts} · ${fxText()}`;
}

/* ------------------------------ 筛选 / 排序 ------------------------------ */

function buildList() {
  let list = state.items;
  let tokens = [];

  if (state.q) {
    tokens = norm(state.q).split(' ').filter(Boolean);
    list = state.items.filter((it) => {
      const n = norm(it.title + ' ' + (it.zh || ''));
      return tokens.every((tk) => altsOf(tk).some((a) => n.includes(a)));
    });
  }

  // 搜索是全局的：正在搜东西时不受「正在打折」标签限制，否则搜不到未打折的游戏
  if (state.tab === 'deals' && !state.q) list = list.filter((x) => x.discount > 0);
  if (state.minDisc > 0) list = list.filter((x) => x.discount >= state.minDisc);
  if (state.plat !== 'all') {
    list = list.filter((x) =>
      state.plat === 'PC' ? x.platforms.includes('PC') : x.platforms.includes('Xbox')
    );
  }

  const s = state.sort;
  const cmp = {
    discount: (a, b) => b.discount - a.discount || b.msrp - b.price - (a.msrp - a.price),
    save: (a, b) => b.msrp - b.price - (a.msrp - a.price),
    priceAsc: (a, b) => a.price - b.price,
    priceDesc: (a, b) => b.price - a.price,
    ending: (a, b) => (a.end || Infinity) - (b.end || Infinity),
    hot: (a, b) => a.rank - b.rank,
  }[s];

  // 搜索时优先「名字越贴近越靠前」，其次才用用户选的排序
  if (state.q) {
    const score = (it) => {
      const n = norm(titleOf(it) + ' ' + it.title);
      let best = 3;
      for (const tk of tokens) {
        const alts = altsOf(tk);
        const primary = alts[0];
        const extras = alts.slice(1);
        // 命中「全名」的排在只是字面包含的（如搜 cod 时 Call of Duty 应排在 CODE VEIN 前面）
        if (extras.some((a) => n.includes(a))) best = Math.min(best, 0.5);
        else if (n === primary) best = Math.min(best, 0);
        else if (n.startsWith(primary)) best = Math.min(best, 1);
        else if (n.includes(primary)) best = Math.min(best, 2);
      }
      return best;
    };
    return list.sort((a, b) => score(a) - score(b) || (cmp ? cmp(a, b) : 0));
  }

  return list.sort(cmp || undefined);
}

/* ------------------------------ 渲染 ------------------------------ */

function createCard(it) {
  const a = document.createElement('a');
  a.className = 'card';
  a.href = storeUrl(it);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = (it.zh && it.zh !== it.title ? `${it.zh}\n${it.title}` : it.title) +
    `\n打开 Xbox ${regionOf().label}区商店`;

  // 封面：先用 40×60 的极小图做模糊底，再把正常图淡入（避免出现字母占位）
  const art = document.createElement('div');
  art.className = 'card-art';

  if (it.poster) {
    art.style.backgroundImage = `url("${artUrl(it.poster, 40, 60, 35)}")`;
    art.style.backgroundSize = 'cover';
    art.style.backgroundPosition = 'center';
  } else {
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.textContent = titleOf(it).trim().charAt(0).toUpperCase();
    art.appendChild(ph);
  }

  if (it.poster) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = titleOf(it);
    img.src = artUrl(it.poster, 360, 540);
    img.srcset = `${artUrl(it.poster, 360, 540)} 1x, ${artUrl(it.poster, 720, 1080)} 2x`;
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    art.appendChild(img);
  }

  if (it.discount > 0) {
    const b = document.createElement('span');
    b.className = 'badge-sale';
    b.textContent = '−' + it.discount + '%';
    art.appendChild(b);
  }

  const platLabel = it.platforms.includes('Xbox')
    ? it.platforms.includes('PC') ? 'XBOX·PC' : 'XBOX'
    : it.platforms.includes('PC') ? 'PC' : '';
  if (platLabel) {
    const p = document.createElement('span');
    p.className = 'badge-plat';
    p.textContent = platLabel;
    art.appendChild(p);
  }

  const go = document.createElement('span');
  go.className = 'card-go';
  go.textContent = '去商店 ↗';
  art.appendChild(go);

  // 信息
  const body = document.createElement('div');
  body.className = 'card-body';

  const h3 = document.createElement('h3');
  h3.className = 'card-title';
  h3.textContent = titleOf(it);
  body.appendChild(h3);

  // 有中文名时，把英文原名作为小字副标题，方便对照版本
  // 但像「《EA SPORTS FC™ 27》标准版」这种中文名里已经含英文原名的，就不再重复显示
  if (showSubtitle(it)) {
    const sub = document.createElement('div');
    sub.className = 'card-sub';
    sub.textContent = it.title;
    body.appendChild(sub);
  }

  const row = document.createElement('div');
  row.className = 'price-row';
  const now = document.createElement('span');
  now.className = 'price-now';
  now.textContent = it.price > 0 ? fmtMoney(it.price) : '免费';
  row.appendChild(now);
  if (it.discount > 0 && it.msrp > it.price) {
    const was = document.createElement('span');
    was.className = 'price-msrp';
    was.textContent = fmtMoney(it.msrp);
    row.appendChild(was);
  }
  body.appendChild(row);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const cny = document.createElement('span');
  cny.className = 'cny';
  cny.textContent = it.price > 0 ? fmtCNY(it.price) : '';
  meta.appendChild(cny);

  const et = endText(it.end);
  if (et && it.discount > 0) {
    const e = document.createElement('span');
    e.className = 'ending' + (isEndingSoon(it) ? ' urgent' : '');
    e.textContent = et;
    meta.appendChild(e);
  }
  body.appendChild(meta);

  a.append(art, body);
  return a;
}

function render() {
  // 热门榜 / 全部游戏 / 搜索都要全量目录，还没补全就先挂个骨架屏，补全后自动重画
  if (needsFull() && !state.full) {
    state.filtered = [];
    gridEl.innerHTML = '';
    loadmoreWrap.hidden = true;
    $('#resultCount').textContent = '';
    emptyEl.hidden = true;

    if (state.fullFailed) {
      hideSkeletons();
      emptyEl.hidden = false;
      emptyEl.innerHTML =
        '<div class="empty-ico">⚠️</div><h3>全量目录没读到</h3>' +
        '<p>点右上角「刷新」重试；只看打折的话切回「正在打折」就行。</p>';
      return;
    }

    renderSkeletons();
    loadFull();
    return;
  }

  state.filtered = buildList();
  state.shown = 0;
  gridEl.innerHTML = '';
  emptyEl.hidden = true;
  hideSkeletons();

  const n = state.filtered.length;
  $('#resultCount').textContent = n
    ? state.q
      ? `找到 ${n.toLocaleString('zh-CN')} 款匹配「${state.q}」${state.tab === 'deals' ? '（含未打折）' : ''}`
      : `共 ${n.toLocaleString('zh-CN')} 款`
    : '';

  if (!n) {
    emptyEl.hidden = false;
    // 还没拉到数据时，别显示「没有匹配的游戏」，容易误以为是搜索坏了
    emptyEl.innerHTML = state.items.length ? EMPTY_HTML : loadingHtml();
    loadmoreWrap.hidden = true;
    return;
  }

  appendMore();
  updateLoadMore();
}

function appendMore() {
  const end = Math.min(state.shown + BATCH, state.filtered.length);
  const frag = document.createDocumentFragment();
  for (let i = state.shown; i < end; i++) frag.appendChild(createCard(state.filtered[i]));
  gridEl.appendChild(frag);
  state.shown = end;
  updateLoadMore();
}

function updateLoadMore() {
  const more = state.shown < state.filtered.length;
  loadmoreWrap.hidden = !more;
  $('#loadmore').textContent = `加载更多（还有 ${(state.filtered.length - state.shown).toLocaleString('zh-CN')} 款）`;
}

/* ------------------------------ 交互 ------------------------------ */

// 标签页
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));

  // 每个视图给一个合适的默认排序：都以「热门优先」开头，避免一屏全是 -90% 的冷门小游戏
  const defSort = 'hot';
  state.sort = defSort;
  $('#sort').value = defSort;

  $('#heroTitle').textContent = heroTitle();

  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

function heroTitle() {
  const r = regionOf();
  const titles = {
    deals: `${r.label}区正在打折`,
    hot: '商店热门排行',
    all: '全部游戏目录',
  };
  return titles[state.tab] || `${r.label}区`;
}

// 折扣 / 平台 chips
$('#chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.disc !== undefined) {
    state.minDisc = Number(btn.dataset.disc);
    $$('#chips button[data-disc]').forEach((b) => b.classList.toggle('active', b === btn));
  } else if (btn.dataset.plat !== undefined) {
    state.plat = btn.dataset.plat;
    $$('#chips button[data-plat]').forEach((b) => b.classList.toggle('active', b === btn));
  }
  render();
});

$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  render();
});

// 搜索
let searchTimer = null;
const qInput = $('#q');

function onQuery(q) {
  state.q = q.trim();
  $('#qClear').hidden = !state.q;
  render();
}

qInput.addEventListener('input', (e) => {
  const v = e.target.value;
  $('#qClear').hidden = !v;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => onQuery(v), 230);
});

qInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    qInput.value = '';
    onQuery('');
    qInput.blur();
  }
});

$('#qClear').addEventListener('click', () => {
  qInput.value = '';
  onQuery('');
  qInput.focus();
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== qInput) {
    e.preventDefault();
    qInput.focus();
    qInput.select();
  }
});

// 刷新：数据每天由 Actions 重建，这里只是绕过浏览器缓存重新读一遍
$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  btn.classList.add('loading');
  btn.disabled = true;
  $('#heroSub').textContent = `正在重新读取${regionOf().label}区数据…`;
  try {
    await loadData({ bust: true });
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
});

/* ------------------------------ 市场切换 ------------------------------ */

/** 一个市场对应一套文案：品牌名、页脚、提示语都要跟着换 */
const FOOT_TEXT = {
  tr: {
    source:
      '<b>数据来源</b>：Xbox 官方商店土耳其区（market=TR，货币 TRY）目录接口，与 xbox.com/tr-TR 同源；人民币价按当日汇率折算，仅供参考。',
    tip:
      '<b>提示</b>：土耳其区属于低价区，结算通常需要土耳其地区支付方式，跨区购买请自行评估账号风险。最终价格以下单页为准。',
  },
  ar: {
    source:
      '<b>数据来源</b>：Xbox 官方商店阿根廷区（market=AR，货币 ARS）目录接口，与 xbox.com/es-AR 同源；人民币价按当日汇率折算，仅供参考。',
    tip:
      '<b>注意</b>：阿根廷区标价可能不含部分税费（如 PAIS 税、所得税预扣等），实际扣款常高于页面显示价；结算同样需要当地支付方式，最终价格以下单页为准。',
  },
};

function syncRegionUI() {
  const r = regionOf();
  document.documentElement.dataset.region = r.key;
  document.title = `Xbox ${r.label}区特价 · ${r.currency} 低价区折扣榜`;
  $('#brandName').textContent = `Xbox ${r.label}区`;
  $('#brandSub').textContent = r.brandSub;
  $('#heroTitle').textContent = heroTitle();
  $$('#regionSwitch button').forEach((b) =>
    b.classList.toggle('active', b.dataset.region === r.key)
  );
  const foot = FOOT_TEXT[r.key] || FOOT_TEXT.tr;
  $('#footSource').innerHTML = foot.source;
  $('#footTip').innerHTML = foot.tip;
}

function setRegion(key) {
  if (!REGIONS[key] || state.region === key) return;
  state.region = key;
  try { localStorage.setItem(REGION_KEY, key); } catch { /* 隐私模式忽略 */ }
  try {
    const u = new URL(location.href);
    u.searchParams.set('region', key);
    history.replaceState(null, '', u);
  } catch { /* ignore */ }
  // 换市场 = 换一整套数据，先把上一区的状态清掉，避免闪出旧价格
  clearTimeout(fullTimer);
  state.items = [];
  state.full = false;
  state.fullLoading = false;
  state.fullFailed = false;
  state.count = 0;
  state.dealCount = 0;
  state.maxDiscount = 0;
  state.fx = 0;
  state.updatedAt = 0;
  state.shown = 0;
  syncRegionUI();
  loadData();
}

$('#regionSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-region]');
  if (!btn) return;
  setRegion(btn.dataset.region);
});

// 加载更多
$('#loadmore').addEventListener('click', appendMore);

if ('IntersectionObserver' in window) {
  new IntersectionObserver(
    (entries) => {
      if (entries.some((x) => x.isIntersecting) && state.shown < state.filtered.length) {
        appendMore();
      }
    },
    { rootMargin: '600px 0px' }
  ).observe(sentinel);
}

/* ------------------------------ 启动 ------------------------------ */

syncRegionUI();
loadData();
