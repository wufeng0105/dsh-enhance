# 参与开发

## 这个仓库是什么

一个 DeepSeek Harness 的**插件 bundle**：在声明层（系统提示里描述 harness 自身的 5 个注册项、3 个名字，定义见 [docs/terminology.md](docs/terminology.md)）换掉系统提示开头那句品牌声明、往末尾追加一段用户自己写的文本，另配越界审批三态、一个可选的自定义权限档、以及一次性的「它到底进没进提示词」检查。它不碰宿主程序；默认设置下，除声明层那几处外，也不碰宿主自带的提示词。

可选的「隐藏宿主说明」不是纯品牌改动：它会连着抹掉两段带操作约定的文字与**两条 runtime context**——`pwd`（不要从 checkout 路径推断工作目录）、「别为了让改动生效另起服务器」、客户端插件改动何时才生效（HMR 要看 `pnpm run dev:web` 在不在跑）。对改 DSH / 写插件的人是实打实的行为退化，改文案时别写成「只是换个名字」。

## 环境

- Node.js **≥ 22**
- 一个可用的 DeepSeek Harness（版本在 `package.json` 的 `engines.dsh` 区间内）
- 端到端冒烟另需 `pwsh`（PowerShell 7）与 `dsh` CLI

## 改之前先跑一遍门禁

```powershell
node scripts/check.mjs              # 七道闸：version / syntax / tests / graph / docs / readme / bundle
node scripts/check.mjs --self-test  # 20 个负例，证明每道闸与每个内嵌 check 组件都真的能红
```

CI 在 `windows-latest` 上跑 `--layer fast`（`.github/workflows/ci.yml`）。**PR 要让这两条都 exit 0。**

## 四条硬约束（踩了必红）

1. **常驻源码（不含 `scripts/`、`tests/`）必须登记进 `code-map.json`。** `graph` 门会列出「源码未登记」的文件。登记时写 `id` / `layer` / `path` / `owns`；前三个是判据，别随手改。`scripts/` 与 `tests/` 由语法门与测试门自己守着，不进模型比对——**这句话与 `tools/graph.mjs` 的 `SKIP_DIRS` 逐字对齐，由 graph 门断言钉住**（改豁免范围要两处一起改）。
2. **`VERSION` 与 `package.json` 的 `version` 必须逐字相同**，且 **`private` 不能是 `true`**、`publishConfig.access` 必须是 `public`。这个包从 2026-11-03 起**同时发布到 npm**（`@wufeng0105/dsh-enhance`）——`private: true` 会让 `npm publish` 直接拒绝，scope 包不加 `access: public` 发出去别人装不了。改名当心：`package.json` 的 `name` 同时是 `cordis.patch.yml` 入口名的前缀，两处必须逐字一致。
3. **README 的「适用版本」句由 `package.json` 派生**，`version` 门逐字校验。要扩区间就改 `engines.dsh` 与 `dsh.compatibility`，README 那句会被门禁逼着你同步。
4. **文档里的相对链接与反引号路径必须真实存在**。`docs` 门查死链、死路径，也查正文里写坏的字面 `\n` / `\t`。

## 改测试之前先读这条

`tests/` 里有若干**锁定串**——UI 文案、检查项标题、五个设置组名等。它们断言的是「这一串必须出现在产品文本里」。改产品文案撞到锁定串时，**连测试一起改，并在 PR 里写清改了什么、为什么**；不要为了绿灯放宽断言。

结构测试里还有**切片弱锁**：某些断言只要求「该串出现在某段源码里」，所以改掉一处同名文本时测试可能仍绿。遇到这种情况按名字核对，别假设绿灯就等于没破坏。

## 术语与文风

[`docs/terminology.md`](docs/terminology.md) 是术语的**唯一权威**：一个东西一个名字；中文界面名与机读标识符 1:1 对应、不许合并；另有几组「看着像同一个东西、其实不能合并」的例外。**改任何面向人的文案之前，先对一遍这张表。**

注意账本里的**四层分工**（定位层 / 操作层 / 契约层 / 机读层）：入口页 `README.md` 的开篇用**定位层**的说法（「破甲」），设置页与契约用**操作层 / 契约层**的词（「内容边界」「品牌人设」…）。这不是同物异名——是同一功能在四个读者层上的四种叫法，**别把入口页的招揽口吻搬进设置页，也别把设置页的规格写法搬进入口页**。跨层指代时落到该层的名字：README 指向设置页要说「内容边界」。

## 目录

| 路径 | 管什么 |
|---|---|
| `enhance-scope/` | 内容边界注入 + `/enhance/api` 路由 + 本机版本探测 |
| `auto-approve/` | 审批三态（自动同意 / 先问我 / 自动回绝） |
| `ui/` | 设置页：服务端半（`index.js`）与浏览器半（`client.js`） |
| `shared/` | 状态、权限档、兼容声明、会话探针 |
| `scripts/` | 门禁总入口与它的工具件 |
| `tools/` | 结构图、文档门禁、端到端冒烟 |
| `docs/` | 兼容性说明、术语账本 |
| `showcase/` | 给用户看的原理讲解页 |

## 兼容性

`engines.dsh` 声明了核验过的宿主版本区间，宿主自己在**安装**与**启动**时都会执行它。要把新版本并进区间，先按 [`docs/compatibility.md`](docs/compatibility.md) 的例行核验跑一遍（约 15 分钟）。

## 发布（发版与发 npm 是同一条流水线）

有两条路。**推荐走标签那条**——它不用长期 token，也不会在 2027 年 1 月被 npm 掐掉。

### 路一：一条命令，`--ship`（推荐）

```powershell
node scripts/release.mjs patch --ship
```

它做的是一整条链，任一步失败就停：

1. 前置检查：工作区干净、在 `main` 上、与 `origin/main` 同步、包名与 `cordis.patch.yml` 的入口前缀一致、npm 账号的 scope 对得上包名；
2. 把 `VERSION` 与 `package.json` 的 `version` 一起改掉（两者必须逐字相同，`version` 门会核）；版本已是目标值时不重写文件；
3. 跑 `node scripts/check.mjs` 全七道闸；
4. `npm pack --dry-run` 打出会发出去的文件清单；
5. 提交 `chore: release <版本>`、打标签 `v<版本>`、推分支与标签。

标签推上去后 [`.github/workflows/release.yml`](.github/workflows/release.yml) 接手：核对「标签 == `VERSION`」→ 再跑一遍门禁 → 发到 npm → 用 `CHANGELOG.md` 里 `## [<版本>]` 那一节建 **GitHub Release**。

所以一次 `--ship` 就让**版本号、git tag、npm、GitHub Release** 四处齐平，不用你分别去记。

**发布身份当前是 `NPM_TOKEN`**（仓库 secret 里的 granular access token）；OIDC 可信发布是目标态，配好后删掉 secret 即自动切换——见下面那张表。

**手动触发（`workflow_dispatch`）永远是预演**：只跑门禁与 `npm pack --dry-run`，不发布、不建 Release。要真发布只有一条路——推 `v*` 标签。这是有意的：一次手动触发就能造出「npm 有版本、git 无 tag、GitHub 无 Release」，而 npm 侧不可回退。

**发布身份有两条腿，工作流会自动选**：

| 仓库里有 `NPM_TOKEN` secret | 走哪条 |
|---|---|
| 有 | 用这个 granular access token（勾了 bypass 2FA） |
| 没有 | OIDC 可信发布（`id-token: write`） |

所以**没配好 trusted publishing 也能发**：建一个 bypass-2FA token 存进仓库的 `NPM_TOKEN` secret 即可。等哪天配好可信发布者，把 secret 删掉，工作流就自动切到 OIDC，`release.yml` 一个字都不用改。

**配可信发布者（长期方案）**：npm 上包的 Settings → Trusted Publisher → GitHub Actions，仓库填 `wufeng0105/dsh-enhance`、工作流文件名填 `release.yml`，勾上 publish 与 manage dist-tags。

⚠️ **这一步当前卡着**：npm 把「改包设置」归为敏感操作，要求账号已配 **2FA**；网页端只提供**安全密钥**（WebAuthn）这一种方式，需要 Windows Hello PIN、手机通行证或 USB 安全钥匙。账号现有的 TOTP（`auth-and-writes`）足够发版，但不够改包设置。在解决之前，用上面那条 `NPM_TOKEN` 的路。

为什么长期要迁到 OIDC：npm 在 2026-07 的公告里写明，勾了「bypass 2FA」的 granular access token 从 2026-08 起不能做账号与包管理动作，**约 2027-01 起连直接发布也不行**，发布会收缩成「暂存 + 人工用 2FA 批准」。长期 token 是条死路。

### 随时核对：`--check`

```powershell
node scripts/release.mjs --check
```

只读，不改任何文件，把五处版本号并排打出来：`VERSION` / `package.json` / 最新 git tag / npm latest / GitHub Release。任何一处对不上就 exit 1，并告诉你补哪一条命令。

这五处是**各自独立写入**的，谁也不会自动跟着谁变——忘了打标签、CI 挂了没建 Release，都会让它们分叉。所以「一致」不是天然成立的，这个开关就是那条余检查。它不进七道门（那七道要能离线跑），适合发版前或定时任务里用。

### 路二：本机手动发（需要验证码）

```powershell
node scripts/release.mjs patch --publish
```

它按顺序做四件事，任一步失败就停：

1. 检查工作区干净、在 `main` 上、且与 `origin/main` 同步（避免发一个仓库里没有的版本）；
2. 把 `VERSION` 与 `package.json` 的 `version` 一起改掉（两者必须逐字相同，`version` 门会核）；版本已经是目标值时**不重写文件**；
3. 跑 `node scripts/check.mjs` 全七道闸；
4. `npm pack --dry-run` 打出这次会发出去的文件清单，让你先看一眼。

加 `--publish` 才真的发。它用 `--access public` 发到**官方源** `registry.npmjs.org`（本机 `.npmrc` 里配的是 `npmmirror` 镜像，只读，发不上去——脚本显式指定 registry，不吃全局配置）。

**这条路要过 2FA**：npm 对发布强制二次验证，直接跑会拿到 `E403 … Two-factor authentication … required`。两条出路——要么给命令补 `--otp=<6 位验证码>`，要么先在 npmjs.com 建一个勾了「Bypass two-factor authentication」的 granular token 并用它发（注意这条 2027-01 起不能发布）。

**三条都要守的**：`npm whoami --registry https://registry.npmjs.org/` 要能返回 `wufeng0105`；包名的 scope 必须等于当前 npm 账号；`VERSION` 与 `package.json` 的 `version` 必须逐字相同。

**发完之后不用管市场**：awesome-dsh-plugin 每夜采集一次 npm，自动更新卡片上的版本号、30 天下载量、能力标签，以及「宿主要求」那一格（它读的是 npm 清单里的 `engines.dsh`）。描述文字不在自动采集范围内，那部分要改 `data/plugins/wufeng0105__dsh-enhance.yml` 并向上游提 PR。

**包名不可随意改**：`@wufeng0105/dsh-enhance` 与 `cordis.patch.yml` 的入口名前缀、老用户的 profile 依赖键三处绑定。真要改名，`scripts/release.mjs` 会拒绝在名字与入口不一致时发布。

## 提交与 PR

- 一个逻辑改动一个提交，信息写清「改了什么、为什么」
- PR 里贴 `check.mjs` 与 `--self-test` 的输出
- 不要提交 `.zhll/`、`.tmp/`、`.codegraph/`（已在 `.gitignore` 里）

## 推之前：会挡住你的只有这几类

远端有新提交时 `git push` 会被拒（非快进），先 `git pull --rebase origin main`，整合完**重跑一遍门禁**再推——rebase 改了基线，门禁读的数可能跟着变。

以下四类改动会让门禁变红，都是**有意的**，按表同步即可：

| 你改了什么 | 要同步的地方 |
|---|---|
| 加 / 删测试、改 `--self-test` 负例、新增门禁 | `scripts/known-counts.json` 的对应计数（`tests` / `selfTestCases` / `gates`） |
| 改冒烟断言数 | `scripts/known-counts.json` 的 `smokeAssertions`（人工维护值） |
| 新增常驻源码文件（不含 `scripts/`、`tests/`） | `code-map.json` 登记；新增 `ctx.on(...)` 事件还要登记 `events` |
| 改 `cordis.patch.yml` 的入口 | 入口 `name` 必须指向真实存在的文件（`bundle` 门） |

两类**不会**再挡你（已按维护成本放开）：README 有没有目录（ToC 现在是可选的，**有则须覆盖全部二级标题**）；README 增删章节导致的检查项数变化（结构检查项数不再钉在 `known-counts.json` 上）。

本机 DSH 升级到 `engines.dsh` 区间之外时，`version` 门会红——那是提醒你按例行核验扩区间，不是误报；CI 不装 DSH，所以只有本机会看到。
