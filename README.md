# Xbox 价格记录（零成本静态方案）

抓取微软商店公开目录与价格，生成静态 JSON，前端纯静态渲染。
**没有服务器进程、没有端口、不需要备案。**

## 服务到底放在哪

这套东西里没有"服务"，只有三个角色：

| 角色 | 用什么 | 干什么 | 成本 |
|---|---|---|---|
| 代码仓库 | GitHub 仓库 | 存脚本、生成的 JSON、前端页面 | 0 |
| 定时执行 | GitHub Actions | 每天跑一次抓取，把结果 commit 回仓库 | 0（公开仓库无限量，私有仓库 2000 分钟/月） |
| 托管 | GitHub Pages | 监听仓库，自动部署，给一个 `https://<用户名>.github.io/<仓库名>/` | 0 |

访问链路：`浏览器 → GitHub Pages CDN（443，无端口）→ 静态文件`。
中间没有任何你自己的进程在跑，所以既不需要 80 端口，也不触发备案管控。

因为没有自己的域名，这里没有自定义域名这条路——地址就是 `github.io` 的子路径。

## 目录结构

```
scripts/fetch.mjs            抓取 + 生成 JSON（Node 22，零依赖）
data/zh-names.json           中文名对照表（入库，构建时用）
public/index.html            前端结构
public/style.css             前端样式
public/app.js                前端逻辑（原生 JS，无框架）
public/data/<区>.deals.json   仅打折的（约 1000 款）— 首屏只加载它
public/data/<区>.all.json     全量目录（约 1 万款）— 后台补全，给热门榜/全部/搜索用
.github/workflows/update.yml 每日抓取 + 发布到 Pages
```

每个市场两个文件，是刻意分开的：全量目录压缩后仍有 1 MB 左右，
在手机上直接拉会干等好几秒；而「正在打折」只有约 100 KB。
所以首屏先渲染 deals，all 在后台静默补，用户切到热门榜/全部/搜索时通常已经就绪。

`public/data/*.json` 在 `.gitignore` 里：每次构建时现抓现发。
如果把它们提交进仓库，每天几 MB，一年下来会把仓库撑到几百 MB。

## 数据格式

```jsonc
{
  "v": 1,
  "region": "tr",        // 市场键
  "market": "TR",        // 商店 market 参数
  "locale": "tr-TR",
  "currency": "TRY",
  "updatedAt": 1793261358122,  // 抓取时刻（epoch ms）
  "fx": 0.1344,          // 1 当地货币 = ? CNY，构建时取汇率
  "count": 10103,        // 在库总款数（两个文件里都是全量值）
  "dealCount": 967,      // 打折款数
  "maxDiscount": 90,     // 最大折扣幅度
  "zhCount": 1859,       // 有中文名的款数
  "items": [
    {
      "id": "9PK3G146XXVF",
      "title": "Call of Duty®: Modern Warfare® 4 - Kasa Sürümü (Windows)",
      "zh": "《使命召唤®：现代战争® 4》金库版 (Windows)",  // 可能不存在
      "poster": "https://store-images.s-microsoft.com/image/apps...",
      "price": 4399,     // 现价（当地货币，可能带小数）
      "msrp": 4399,      // 原价；无折扣时等于 price
      "discount": 0,     // 折扣百分比整数，0 = 没打折
      "end": 253370592000000,  // 促销截止 epoch ms；12/30/9998 表示无截止
      "platforms": ["PC"],     // "Xbox" / "PC"
      "rank": 0          // 商店排序位次，0 最热，「热门优先」就按它排
    }
  ]
}
```

## 本地跑

```bash
node scripts/fetch.mjs          # 抓 TR + AR 两个区，约 3 分钟
python3 -m http.server 8000 -d public
# 打开 http://localhost:8000
```

调试时想只抓几页：

```bash
MAX_PAGES=10 node scripts/fetch.mjs
```

## 部署（四步，GitHub Pages）

1. **建仓库**：GitHub 新建空仓库（**不要**勾 "Add a README"、".gitignore"、license，
   勾了会和本地首次推送冲突），然后按下面命令推上去。
   免费账号的仓库必须是 **public**，私有仓库用 Pages 要付费。

   ```bash
   cd xbox-price-watch
   git init -b main
   git add .
   git commit -m "init"
   git remote add origin https://github.com/<用户名>/<仓库名>.git
   git push -u origin main
   ```

2. **开写权限**：Settings → Actions → General → Workflow permissions，
   选 **Read and write permissions**。不开的话心跳提交会 403。

3. **开 Pages**：Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。
   ⚠️ 必须选这一项，不能选 "Deploy from a branch"——分支模式只能发布根目录或 `/docs`，
   而我们的产物在 `public/`。

4. **跑一次**：Actions → `update-and-deploy` → Run workflow。
   第一次会在 CI 里现抓一遍（约 70 秒），所以**不需要本地先跑 fetch**。

跑完访问 `https://<用户名>.github.io/<仓库名>/`。

仓库里没有数据文件是正常的——数据在每次构建时生成，直接进 Pages，不回写仓库。
仓库里每天只会多一个几十字节的 `.ci/last-run.txt`，用来防止 GitHub 因 60 天无推送停用定时任务。

### 地址格式

| 仓库名 | 访问地址 |
|---|---|
| 任意名（如 `xbox-price-watch`） | `https://<用户名>.github.io/xbox-price-watch/` |
| 恰好叫 `<用户名>.github.io` | `https://<用户名>.github.io/` |

注意第一种是**子路径**部署，末尾必须有斜杠。前端用的是相对路径 `./data/...`，
在子路径下解析为 `/xbox-price-watch/data/...`，不用改任何代码。

### 国内访问实测（2026-10，上海电信，单点样本）

| 平台 | 首字节 | 备注 |
|---|---|---|
| 国内 OSS + CDN | 0.09–0.31s | 需备案 |
| `*.netlify.app` | 0.37–0.69s | 免费额度仅 300 credits/月，撑不住每日部署 |
| `*.github.io` | 0.24–1.38s | 能通，波动大 |
| Cloudflare 自定义域名 | 0.87–1.89s | 需自己有域名 |
| `*.pages.dev` | 三次全失败 | 国内打不开 |
| `*.vercel.app` | 三次全失败 | 国内打不开 |

部署完请用你自己的网络再测一次，平台 IP 会变、不同运营商结果不同。

## 换区域 / 加区域

区域配置集中在 `scripts/fetch.mjs` 顶部的 `REGIONS`：

```js
const REGIONS = {
  tr: { key:'tr', market:'TR', locale:'tr-TR', currency:'TRY', fxFallback:0.134 },
  ar: { key:'ar', market:'AR', locale:'es-AR', currency:'ARS', fxFallback:0.0043 },
};
```

加一个区 = 加一行，同时在前端 `public/app.js` 的 `REGIONS` 里加一条文案配置
（label / 货币符号 / 品牌副标题 / 页脚说明），并在 `public/index.html` 的 `#regionSwitch` 里加个按钮。
每个区会多出两个数据文件，抓取时间也相应变长。

想临时只抓一个区，把另一个从 `REGIONS` 里注释掉即可（CI 里别注释，页面会缺数据）。

## 中文名怎么来的

商店目录接口给的 `title` 是当地语言的（土区是土耳其语），中文名走两条路：

1. **按 productId 回查**：`displaycatalog.mp.microsoft.com/v7.0/products?bigIds=...&languages=zh-cn`，
   一次最多 100 个 id。约 18% 的游戏有官方中文名。
2. **人工对照表** `data/zh-names.json`：`titles` 整名精确命中，`series` 最长前缀 + `parts`/`numerals` 逐段拼接。
   任何一段翻不出来就整体放弃——宁可显示英文，也不要出现「Dying Light 精华版」这种半中半英。

两个市场的 productId 取并集，只回查一次，省一半请求。

## 几个已经踩过的坑

- `resultsPerPage` 最大就是 50，写更大无效；`skipItems`、`sort`、`query` 参数全部被忽略。
- 判断是否打折用 `discountPercentage > 0`，不要用 `msrp != listPrice`。
- `endDateUtc` 是 `M/D/YYYY HH:mm:ss` 美式顺序；非促销时是 `12/30/9998`。
- 封面图必须加 `?w=360&h=540&q=80` 缩图（223 KB → 34 KB），
  且**只对 `store-images.s-microsoft.com` 有效**，URL 不能截断。
- 抓取并发别超过 12，容易被限流。
- `browse` 的响应里**不带** `pageNumber`，名次只能用「请求的页号」算，
  否则每页的 rank 都是 0–49，热门榜会乱。
- `displaycatalog` 接口把 `MS-CV` 当**请求头**发就 500，只能放查询参数里；
  `browse` 接口反过来，缺 `MS-CV` 请求头直接 400。
- 全量目录 1 万款、3 MB JSON，gzip 后仍有 1 MB 左右——因为标题和图片 URL 几乎不重复，
  压缩率很低。所以别指望「压一压就能一把梭」，要拆文件。

## 边界

- 只读取公开目录数据，不做任何交易、不加联盟返利链接、不挂广告。
- 封面图直接引用微软 CDN，不在本地转存，避免版权问题。
- 价格仅供个人参考，购买请走官方商店。
