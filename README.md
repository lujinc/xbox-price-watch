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
public/index.html            前端（原生 JS，无框架）
public/data/games.json       全量目录（运行产物，不入库）
public/data/games.sale.json  仅促销（运行产物，不入库）— 首屏只加载这个
.github/workflows/update.yml 每日抓取 + 发布到 Pages
```

`public/data/*.json` 在 `.gitignore` 里：每次构建时现抓现发。
如果把它们提交进仓库，每天一个 4.6MB 的文件，一年下来会把仓库撑到几百 MB。

## 本地跑

```bash
node scripts/fetch.mjs          # 全量抓取，约 70 秒
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

抓哪个区完全由环境变量决定：

```bash
MARKET=AR LOCALE=es-AR node scripts/fetch.mjs   # 阿根廷
MARKET=BR LOCALE=pt-BR node scripts/fetch.mjs   # 巴西
MARKET=US LOCALE=en-US node scripts/fetch.mjs   # 美国
```

`price.currency` 会跟着变，前端不会写死 TRY。

**做真正的多区比价**是下一步：先抓一个区拿到 productId 列表，
再对这些 id 用 `displaycatalog.mp.microsoft.com/v7.0/products?bigIds=...`
逐区回查价格（一次最多 100 个 id）。注意那个接口**不能**带 `MS-CV` 请求头，会 500。

## 几个已经踩过的坑

- `resultsPerPage` 最大就是 50，写更大无效；`skipItems`、`sort`、`query` 参数全部被忽略。
- 判断是否打折用 `discountPercentage > 0`，不要用 `msrp != listPrice`。
- `endDateUtc` 是 `M/D/YYYY HH:mm:ss` 美式顺序；非促销时是 `12/30/9998`。
- 封面图必须加 `?w=360&h=540&q=80` 缩图（223 KB → 34 KB），
  且**只对 `store-images.s-microsoft.com` 有效**，URL 不能截断。
- 抓取并发别超过 12，容易被限流。

## 边界

- 只读取公开目录数据，不做任何交易、不加联盟返利链接、不挂广告。
- 封面图直接引用微软 CDN，不在本地转存，避免版权问题。
- 价格仅供个人参考，购买请走官方商店。
