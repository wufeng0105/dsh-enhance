# 参与开发

## 改动时要守的边界

装的是什么、文件怎么分层，见 [BOOTSTRAP.md](BOOTSTRAP.md)；它对外能干什么，见 [README.md](README.md)。这里只说改的时候不能越的那条线：**不碰宿主程序**；默认设置下，除声明层那几处外，也不碰宿主自带的提示词——声明层的准确定义只有一处，在 [docs/terminology.md](docs/terminology.md)。

可选的「隐藏宿主说明」不是纯品牌改动：它会连着抹掉两段带操作约定的文字与两条 runtime context，代价逐条列在 [docs/brand-persona.md](docs/brand-persona.md) 的那张对照表里。改文案时别写成「只是换个名字」。

## 哪里放什么

| 路径 | 管什么 |
|---|---|
| `enhance-scope/` | 内容边界注入 + `/enhance/api` 路由 + 本机版本探测 |
| `auto-approve/` | 审批三态（自动同意 / 先问我 / 自动回绝） |
| `ui/` | 设置页：服务端半（`index.js`）与浏览器半（`client.js`） |
| `shared/` | 状态、权限档、兼容声明、会话探针 |
| `scripts/` | 门禁总入口、发版脚本、它的工具件 |
| `tools/` | 结构图、文档门禁、端到端冒烟 |
| `docs/` | 兼容性说明、术语账本、品牌人设契约 |

## 环境

Node.js **≥ 22**；一个可用的 DeepSeek Harness（版本在 `package.json` 的 `engines.dsh` 区间内）。端到端冒烟另需 `pwsh`（PowerShell 7）与 `dsh` CLI。

真装冒烟怎么跑、验什么、为什么进不了门禁，见下面「发版」一节的「发版前必跑：真装冒烟」——它同时是发版的硬步骤，不是改完代码的例行动作。

## 改之前先跑一遍门禁

```powershell
node scripts/check.mjs              # 全部门禁
node scripts/check.mjs --self-test  # 至少 20 个负例，证明每道门禁与每个内嵌 check 组件都真的能红
```

门禁一共这些：version / syntax / tests / graph / docs / readme / bundle——**门数不写进文档**，也不由 `tools/counts-check.mjs` 钉住，以 `node scripts/check.mjs` 的输出为准。CI 在 `windows-latest` 上跑 `node scripts/check.mjs` 与 `node scripts/check.mjs --self-test`（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)），**PR 要让这两条都 exit 0**。

## 改动会被谁挡住

先分清两类：**门禁会红**的，和**没有门禁、靠纪律**的。混在一起说，就分不清哪条真会拦你。

### 门禁会红的

| 你改了什么 | 门禁 | 要同步什么 |
|---|---|---|
| 加 / 删测试、改 `--self-test` 负例 | tests、docs | [`scripts/known-counts.json`](scripts/known-counts.json) 的 `tests` / `selfTestCases` |
| 改冒烟断言数 | docs | `tools/smoke.mjs` 的 `EXPECTED_ASSERTIONS` 与 [`scripts/known-counts.json`](scripts/known-counts.json) 的 `smokeAssertions`，两处必须相等（计数门现场对账） |
| 新增常驻源码文件 | graph | `code-map.json` 登记；新增 `ctx.on(...)` 事件还要登记 `events` |
| 改 `cordis.patch.yml` 的入口 | bundle | 入口 `name` 必须指向真实存在的文件，且前缀等于 `package.json` 的 `name` |
| 删掉包根的 `index.js` 或 `package.json` 的 `main` | bundle | 市场插件装后会判这个包 broken 并当场删除（上游 dsh-market/dsh-market#1091）；下面那段判定就是为它加的 |
| 改 `package.json` 的 `name` | version、bundle、readme | `cordis.patch.yml` 的入口前缀、两个 README 里 `dsh plugin add` / `remove` 的包名 |
| 改 `VERSION` 或 `package.json` 的 `version` | version | 两处必须逐字相同；两个 README 的「适用版本」句由 `engines.dsh` 派生 |
| 增删 README 的二级标题 | readme | 有目录则须覆盖全部二级标题 |
| 写坏文档里的相对链接或反引号路径 | docs | 两者都必须真实存在 |

那张表的第一行（新增常驻源码要登记）有一句必须逐字保留的表述，由 graph 门断言钉住——**常驻源码（不含 `scripts/`、`tests/`）必须登记进 `code-map.json`**。登记时写 `id` / `layer` / `path` / `owns`；真正被门禁比对的是 `id` 与 `path`（`layer` / `owns` 目前只给人读），别随手改；`scripts/` 与 `tests/` 由语法门与测试门自己守着，不进模型比对（改豁免范围要两处一起改）。

还有两类**不**挡你——它们原先挡，后来按维护成本放开了：README 有没有目录（可选）；README 增删章节导致的检查项数变化（结构检查项数不再钉在 `known-counts.json` 上）。

### 靠纪律的（没有门禁守）

| 事项 | 为什么没有门禁 | 怎么守 |
|---|---|---|
| `.zhll/` 永不入库 | 它在 `.gitignore` 里，[`scripts/code-files.mjs`](scripts/code-files.mjs) 的 `SKIP_DIRS` 也跳过它，所以里面的 `.mjs` 连语法门都不过 | 提交前看一眼改动清单；别对它用 `git add -f`，别为了「统一」把它挪到会被跟踪的位置 |
| 计数键不许删 | 计数门按 `known-counts.json` 里**现有的键**逐个比对，键没了那一项就整个消失，不会红 | 只改值、加键，不删键；删一个键等于静悄悄关掉一项比对 |
| 发布身份走哪条腿 | 取决于仓库有没有 `NPM_TOKEN` secret，门禁读不到 secret | 看 `release.yml` 里「选发布身份」那一步的日志 |
| 工作流 action 不钉 SHA | 钉了却不会有自动升级（除非先配 Dependabot），会变成「安全补丁永远收不到」 | 哪天配了 Dependabot 再钉 |
| `main` 禁强推 | 已经是仓库设置，门禁管不到 | 真要改写历史时先关保护，改完开回来 |
| npm 账号的 scope 与包名匹配 | 要联网查 npm 账号 | 发版脚本的前置检查会替你查（见「发版」） |

`.zhll/` 里放着本地草稿与审计档案（含对自身缺陷的详细描述），这是它必须留在本地的原因。

## 改测试之前先读这条

`tests/` 里有若干**锁定串**——UI 文案、检查项标题、五个设置组名等。它们断言的是「这一串必须出现在产品文本里」。改产品文案撞到锁定串时，**连测试一起改，并在 PR 里写清改了什么、为什么**；不要为了绿灯放宽断言。

结构测试里还有**切片弱锁**：某些断言只要求「该串出现在某段源码里」，所以改掉一处同名文本时测试可能仍绿。遇到这种情况按名字核对，别假设绿灯就等于没破坏。

## 术语与文风

[docs/terminology.md](docs/terminology.md) 是命名的**唯一权威**：一个东西一个名字；中文界面名与机读标识符 1:1 对应、不许合并；同名两物的消歧写法与「看着像同一个东西、其实不能合并」的例外也都在那张表里。**改任何面向人的文案之前，先对一遍账本。**

最容易踩的一条单独提醒：同一功能在入口页、设置页、契约、机读四处各有各的名字（入口页叫「破甲」，设置页叫「内容边界」…），**别把一层的口吻搬进另一层**。这四套名字怎么分、跨层指代该落到哪个名字，见账本的「命名分层」一节——那是「命名」的分层，与 BOOTSTRAP 说的「文件分层」不是一回事，别互相借用。

## 发版

发版与发 npm 是同一条链。一条命令推上去，剩下的由 CI 做完。

### 发版前必跑：真装冒烟（纪律，门禁替不了）

```powershell
pwsh -NoProfile -File tools/smoke.ps1
```

`--ship` 的门禁全绿只证明「静态没坏」。这个包吃宿主私有 API，**DSH 升级后唯一能证明它还能装、还能跑的东西是真装冒烟**：在一个一次性 `DSH_HOME` 里真装本包、组合出三个入口、验三态与品牌人设遮蔽、写档摘档后再组合，跑完 44 条断言（断言条数的单一来源在 [`scripts/known-counts.json`](scripts/known-counts.json) 的 `smokeAssertions`，与 `tools/smoke.mjs` 的常量互相咬）。

它**不进** `--ship`、也不进 CI，这是有意的：它要 `pwsh` + 真机 DSH CLI，CI 的 ubuntu runner 给不了；塞进发布脚本只会让紧急热修在没有装 DSH 的机器上发不出去，而「这次发布要不要信静态门禁」的判断本来就该由人做。所以它是**发版纪律里的硬步骤**：每次发版（哪怕 patch）先跑，红了就停下，按 [`docs/compatibility.md`](docs/compatibility.md) 的「例行核验」查，核验过了再动 `engines.dsh` 区间。

### 推荐路径：`--ship`

```powershell
node scripts/release.mjs patch --ship
```

它按顺序做完这些，任一步失败就停：

1. 前置检查：工作区干净、在 `main` 上、与 `origin/main` 同步、包名与 `cordis.patch.yml` 的入口前缀一致、目标版本号没有被 npm 撤除过（撤除过的号永远不能再用，见 `CHANGELOG.md` 的「已知」）；
2. 把 `VERSION` 与 `package.json` 的 `version` 一起改掉；版本已是目标值时不重写文件；
3. 跑门禁；
4. `npm pack --dry-run` 打出会发出去的文件清单；
5. 提交 `chore: release <版本>`、打标签 `v<版本>`、推分支与标签。

标签推上去后 [`.github/workflows/release.yml`](.github/workflows/release.yml) 接手：核对「标签 == `VERSION`」→ 再跑一遍门禁 → 发到 npm → 用 `CHANGELOG.md` 里 `## [<版本>]` 那一节建 **GitHub Release**。所以一次 `--ship` 就让**版本号、git tag、npm、GitHub Release** 四处齐平。

推标签是**唯一**能真正发布的触发条件。手动触发（`workflow_dispatch`）永远是预演——只跑门禁与打包清单，不发布、不建 Release。这是有意的：一次手动触发就能造出「npm 有版本、git 无 tag、GitHub 无 Release」，而 npm 侧不可回退。

发布身份有两条腿，工作流按仓库有没有 `NPM_TOKEN` secret 自动选：

| 仓库里有 `NPM_TOKEN` | 走哪条 |
|---|---|
| 有 | granular access token（勾了 bypass 2FA） |
| 没有 | OIDC 可信发布（`id-token: write`） |

OIDC 是目标态：把可信发布者配好、再把 secret 删掉，工作流自动切换，`release.yml` 一个字都不用改。配法是 npm 上包的 Settings → Trusted Publisher → GitHub Actions，仓库填 `wufeng0105/dsh-enhance`、工作流文件名填 `release.yml`，勾上 publish 与 manage dist-tags。

这一步行不行，取决于账号有没有**安全密钥**：npm 把「改包设置」归为敏感操作，而网页端只提供安全密钥（WebAuthn）这一种方式——Windows Hello PIN、手机通行证或 USB 安全钥匙都算。TOTP 够发版，不够改包设置。

要迁到 OIDC 的原因不是偏好：npm 在 2026-07 的公告里写明，勾了「bypass 2FA」的 granular access token 从 2026-08 起不能做账号与包管理动作，**约 2027-01 起连直接发布也不行**，发布会收缩成「暂存 + 人工用 2FA 批准」。长期 token 是条死路。

### 随时核对：`--check`

```powershell
node scripts/release.mjs --check
```

只读，不改任何文件，把几处各自独立写入的版本号并排打出来：`VERSION`、`package.json`、最新 git tag、npm latest、GitHub Release，外加发布凭据的到期日。任何一处对不上就 exit 1，并告诉你补哪一条命令。

它们谁也不会自动跟着谁变——忘了打标签、CI 挂了没建 Release、token 快到期，都会让它们分叉。所以「一致」不是天然成立的，这个开关就是那条余检查。它不在门禁里（门禁必须能离线跑，而这五处要联网），适合发版前或定时任务里用；[`.github/workflows/consistency.yml`](.github/workflows/consistency.yml) 每天跑它一次。

发布凭据的到期日记在 [`.github/npm-token-expiry.json`](.github/npm-token-expiry.json)：剩 30 天内 `--check` 判红。这类问题版本号核对**看不见**——token 过期后 npm 那步会 401，而五处版本号仍然一片对齐。

### 本机手动发（人专用）

```powershell
node scripts/release.mjs patch --publish --otp=<6 位验证码>
```

**Agent 不要走这条**：验证码由验证器 App 生成、30 秒有效，只有人拿得到，Agent 用它会卡死。真需要手工发时让人来操作。

它做的前四步与 `--ship` 相同，只是发完之后不提交、不打标签，脚本会把该跑的 git 命令打出来。它显式发到官方源 `registry.npmjs.org`。本机 `.npmrc` 若指向镜像（本机是 `npmmirror`），那是只读的、发不上去——所以脚本不吃全局配置。

**发完之后不用管收录目录**：`awesome-dsh-plugin` 每夜采集一次 npm，自动更新卡片上的版本号、30 天下载量、能力标签，以及「宿主要求」那一格（它读的是 npm 清单里的 `engines.dsh`）。描述文字不在自动采集范围内，那部分要改 `data/plugins/wufeng0105__dsh-enhance.yml` 并向上游提 PR。

**包名不可随意改**：`@wufeng0105/dsh-enhance` 与 `cordis.patch.yml` 的入口名前缀、老用户的 profile 依赖键三处绑定，两个 README 的命令也跟着它。发版脚本会拒绝在名字与入口不一致时发布。

## 兼容性

`engines.dsh` 声明了核验过的宿主版本区间，宿主在**安装**与**启动**时都会执行它。区间为什么是半开的、正式版与 rc 在 semver 上差在哪、宿主具体在哪三个时机读它，都在 [docs/compatibility.md](docs/compatibility.md) 的「声明」一节。这里只留动作：**扩区间前，先按那边的例行核验跑一遍（约 15 分钟）**，两端一起动。

本机 DSH 升级到区间之外时 `version` 门会红——那是提醒你按例行核验扩区间，不是误报；CI 不装 DSH，所以只有本机会看到。宿主发正式版和发 rc 一样，都要触发这一轮核验，别等到有人装不上才发现。

## 仓库设置与已知取舍

判断前提是**日常操作由 Agent 执行**，所以逐条看的是「这条对自动化的净效果」。

`main` 的分支保护只开了两条：禁强推、禁删除分支，且 `enforce_admins: true`。为什么只开这两条——npm 上的发布版改不了。一个已经发出去的标签指向提交 A，如果有人 force-push 把 A 从 `main` 抹掉，npm 上还挂着那个版本，而仓库里再也说不出它对应哪次提交，用户没法核对「我装的这版是不是仓库里那个」。这是唯一一类会造成**不可逆错位**的历史改写，值得用仓库设置兜住。`enforce_admins: true` 是有意的：管理员能绕过等于没开。

有意**没开**的几条：

| 没开的规则 | 为什么 |
|---|---|
| 要求 PR 才能合入 | `--ship` 是直接推 `main` 的，开了会把发版链整个挡死 |
| 要求 CI 绿才能合入 | 同上，且 `main` 上的 `ci` 是 push 之后才跑，形成鸡生蛋 |
| 发布 job 挂带 reviewer 的 environment | **Agent 无法批准 GitHub environment**，那需要在网页上点。开了这条，每次发版都会卡死在一个只有人能做的一步上 |

发布这一步不需要人工闸门，因为闸门已经在前面了：`--ship` 的前置检查、门禁、CI 里的「标签 == `VERSION`」逐字核对。再加一个只能人点的按钮，收益是零，代价是自动化全废。

核对当前生效的设置：`gh api repos/wufeng0105/dsh-enhance/branches/main/protection`。要临时放宽（比如真需要改写 `main` 的历史），用 `gh api -X DELETE repos/wufeng0105/dsh-enhance/branches/main/protection` 关掉，改完再按同一份配置开回来。

**包根那个 `index.js` 是一处绕行，而且带拆除条件。** 它不承载任何功能，宿主从不加载它——存在的唯一理由是市场插件装完包后会跑一次 `hasLoadableEntry`，它要求包根有 `main` / `exports` / 根 `index.js` 三者之一，而纯 patch 载体按构造就没有，于是被判「没有可安装的内容」并当场删掉。上游那 4 行判据把「载体自己的子路径」当成了「另一个包目录」，已提 dsh-market/dsh-market#1091。

它**有门禁守着**（bundle 门那条「包根缺可加载入口」），所以删了会红，不会静默坏掉。**上游修好 #1091 之后，拆掉它要三处一起**：删根 `index.js`、删 `package.json` 的 `main`、删 bundle 门里那段判定。

另外一处已知取舍：工作流里的 `actions/checkout@v4`、`actions/setup-node@v4` 是**有意不钉 SHA** 的。发布 job 带 `contents: write` + `id-token: write`，按供应链习惯本该钉 commit SHA；这里没钉，理由是单人仓库加只有这两个官方 action，钉了却没有自动升级，会变成「安全补丁永远收不到」的另一种风险。这是被接受的取舍，不是疏忽。

## 提交与 PR

一个逻辑改动一个提交，信息写清「改了什么、为什么」；PR 里贴 `check.mjs` 与 `--self-test` 的输出。`.zhll/`、`.tmp/`、`.codegraph/` 都不要提交，它们已在 `.gitignore` 里。

远端有新提交时 `git push` 会被拒（非快进），先 `git pull --rebase origin main`，整合完**重跑一遍门禁**再推——rebase 改了基线，门禁读的数可能跟着变。
