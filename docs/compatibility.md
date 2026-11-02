# DSH 版本支持

**适用版本**：DeepSeek Harness 0.2.1-rc.1–0.2.1-rc.5（0.2.1-rc.5 实测，全系源码级核验）。这句与 `README.md` / `README.en.md` 里那两句逐字同源，都由 `package.json` 派生；2026-10-30、2026-10-31 与 2026-11-02 各做过一轮干净安装终验（三轮各有前提，逐条复跑条件见「核验记录」每轮末尾）。

版本支持不是「尽量兼容」的承诺，而是一份有界、可复跑、由一处声明驱动的契约：声明写清我们核过哪些版本，宿主自己执行同一条声明，流程写清新版本来了怎么核，核验结果留档。这篇文档就是契约的全部内容。

## 声明

唯一权威是 `package.json` 的 `engines.dsh`：

```json
"engines": {
  "node": ">=22",
  "dsh": ">=0.2.1-rc.1 <0.2.1-rc.6"
}
```

区间在 semver 上恰好等于 `0.2.1-rc.1` 到 `0.2.1-rc.5`（上界排他）。`dsh.compatibility` 不是第二份区间，只是这条区间的证据元数据（实测版本、核验依据、日期、文档指针）：

```json
"dsh": {
  "compatibility": {
    "tested": "0.2.1-rc.5",
    "basis": "source-level",
    "verifiedAt": "2026-11-02",
    "doc": "docs/compatibility.md"
  }
}
```

上面片段里的 `verifiedAt`（`2026-11-02`）与 `package.json` 的 `dsh.compatibility.verifiedAt` 逐字一致，**与本文件核验记录的最新一轮一致**——这个片段记的是现值，不是历史样例。

README 里那句适用版本是这份声明的派生文本，`node scripts/check.mjs` 要求两处逐字一致。它同时核对声明形状（区间解析与成员判定在 `shared/compat.mjs`，唯一实现）；探测到本机 DSH 版本不在区间内时判红，提示先跑本文的例行核验再扩区间。

为什么 README 不能是第二权威：散文会被人顺手改，声明不会。两处各写各的，就会「改了声明忘改 README」与「改了 README 忘改声明」各错一次。为什么是区间不是版本数组：宿主读的就是这个字段——理由在「宿主怎么执行这条声明」一节。

## 宿主怎么执行这条声明

`engines.dsh` 不是写给自家门禁看的自留地，宿主在三个时机读它并做 semver 匹配（无该字段时回退读 `peerDependencies` 里的 `@deepseek-ai/dsh*`）：

| 时机 | 宿主行为 |
|---|---|
| `dsh plugin add` 装前 | preflight 拉取声明，不兼容直接拒装（exit 1，`nothing was installed`） |
| pnpm 装完后 | 校验 `node_modules/<pkg>/package.json`，不兼容回滚重装旧版本（exit 1） |
| profile 启动装载 | 每个插件行过预检，不兼容则该行被禁用、插件根本不被 import |

唯一放行通道是精确版本豁免：profile 里的 `compatibility.json` + `dsh plugin allow-version <pkg@ver> --dsh-version <ver> --accept-risk`。

依据（2026-10-30 取证，可复跑）：上游 `deepseek-ai/deepseek-harness` tag `dsh-v0.2.1-rc.5` 的 `packages/boot/app-boot/src/plugin-compatibility.ts`（`unmetRequirements()` 逐字读 `engines.dsh` 并 `satisfies` 匹配）、`plugin-manager/src/operations.ts`（装前 preflight 与装后回滚）、`app-boot/src/compatibility-preflight.ts`（启动预检）；同路径文件 rc.1 与 rc.5 的 blob SHA 完全一致——门禁 rc.1 就定型，rc.5 未改。本机 rc.3 的 `app.asar` 里打包着同一套逻辑（文本类文件里有 **21 个文件**含 `engines.dsh`，含错误串 `Plugin manifest engines.dsh must be a string`）。官方 e2e（`plugin-compatibility.expected.e2e.ts`）断言了拒装、拒启动、豁免后放行的全流程。

由此两条纪律：

- **声明写错不是小事。** 区间写窄，宿主直接拒装；写宽，宿主放行未验版本。所以扩区间的唯一途径是先过例行核验，两端一起动。
- **声明与门禁同源。** `scripts/check.mjs` 的 version 门禁、设置页版本行、README 适用句，三处都从 `shared/compat.mjs` 读同一条声明，不许任何一处自己再解析一遍。

## 为什么是有界声明

宿主每个 rc 都可能在动我们依赖的接缝，「最优兼容」没有解。所以这里只声明核验过的范围，并给出一个常数流程：新版本发布后跑一遍，通过了就把版本号并进区间。声明是变量，流程是常数。

## 宿主触点

每一条能力都挂在宿主的一个接缝上。例行核验，核的就是这些接缝有没有动。下面这张表按破坏面分组（完整清单由代码反推而来，按表内独立触点项计共 36 条；**36 是本表口径下的条目数，不是 grep 命中数**——从引用点归并成条目的规则见「例行核验」第 1 步；分组只求「宿主变了坏什么」一眼可读）：

| 组 | 触点（代码侧入口） | 宿主变了坏什么 |
|---|---|---|
| cordis 插件 API | 入口形状（`name`/`apply`/`inject`）、`systemPrompt.section()` + `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')`、`ctx.effect`、运行期 `ctx.inject(['webServer'])`、`web.register({kind:'exact'})` 路由、`ctx.on('approval/request')` waterfall、`settings.section` 槽位（`ctx.slots.inject` + `register`）、`ctx.on('agent/created')` + `agent.ctx.inject()` 的 agent 作用域同名段遮蔽（品牌人设） | 注入消失 / 审批接管失效 / 设置页分节挂不上 |
| 浏览器半装载 | `window.__ModuleLoader__.load({id, factory})`、factory 参数 `require('react')`、`dsh.client` 发现规则（`exports["./client"]` + 裸包名行才挂浏览器半） | 设置页整个消失（服务端功能仍在） |
| 宿主视觉 token | 23 个 `--dsw-*`/`--ds-*` 变量、`body[data-ds-dark-theme]` 属性钩子、排版刻度 | 页面不可读 / 深色模式错乱 |
| profile 配置与解析 | `profileContext` 形状（`patchPath`）、`DSH_PROFILE_DIR` + `cordis.patch.yml` 文件名、`profiles/<name>/` 布局、patch 顶层数组 + `config` 整块替换 + `- id: permission` 行、`presets`/`defaultPreset` 契约、档位菜单显示契约（表外档名纯文字行）、宿主侧档位中文名文案、审批策略 `approval/policy` 取 `never` 时前置拒绝 | 写档 409 或写坏用户配置 / 播种错开关档（默认档位的审批策略是 `never` 时，种「自动同意」会被宿主前置拒绝，须种「先问我」） |
| 会话日志探针 | `sessions/<workspace>/<session>/session.v4.jsonl.zstd` 文件名与两层目录、zstd 多帧追加（宿主 Node **≤24.21** 的 `zstdDecompressSync` 只解第一帧，**24.22.1 起解全**；所以探针按魔数逐帧切，不赌版本）、`"system-prompt"` 行标记；另有正反两个探针（`sessionContains` 判「该在的文本在不在」，`sessionOmits` 判「不该在的文本还在不在」——**两者极性不同**：存在性任一命中即证明，缺失性只看**最新一份**含 `"system-prompt"` 装配记录的日志，按 mtime 倒序取第一份，不能扫「最近 N 份都不含」，否则切换设置前的旧日志会把刚生效的遮蔽永久判红） | 「检查」的 inject 项永远红，或品牌人设遮蔽失效却全绿 |
| 版本探测链 | `DSH_VERSION` → `@deepseek-ai/dsh-package-manifest` → 安装作用域核心包 → `app.asar` 头布局 → `LOCALAPPDATA` 安装根 → `dsh-runtimes/<runtime>/runtime.json` | 版本行退化成「读不到本机版本」（其余功能不受影响） |
| home | `DSH_HOME` / `~/.dsh`、`<home>/enhance/` 数据目录 | 自家数据无处落 |
| 装载与冒烟工具链 | bundle patch entry 解析规则（name 相对本包目录）、`dsh` CLI 与安装根、profile `package.json` 装载痕迹 | 装不上 / 例行核验流程断 |

**插件加了新功能就会带来新触点**，所以例行核验的第一步永远是重数这张表。

上游包对应关系（tree-diff 盯这些）：cordis API 家族的接缝分散在 `packages/core/system-prompt/src`、`packages/host/webserver/src`、`packages/interaction/user-approval/src`；settings.section 槽位契约在 `packages/client/ui-settings/src`（`contract/slots.ts`），渲染它的壳是 `packages/client/ui-permission-presets/src` 之外的 `packages/client/ui-settings-general/src`——`ui-settings-models`/`ui-settings-plugins` 是同槽位的兄弟消费方，宿主改它们不破坏我们，不进核验清单；权限预设与显示契约在 `packages/interaction/permission-presets/src` 与 `packages/client/ui-permission-presets/src`；engines 门禁与装载预检在 `packages/boot/app-boot/src` 与 `packages/boot/plugin-manager/src`。其余触点（会话日志格式、asar 头、CSS token、env 量）没有可直接 tree-diff 的上游包位置，靠冒烟与真机核对兜底。

## 例行核验（新 rc 发布后，约 15 分钟）

### 1. 重数触点

从代码 grep 宿主引用重推这张表，不抄旧表。三步，照着走就能得出「是不是还是 36 条」。

**a. 列引用点。** 在我们自己的源码上扫（`enhance-scope/`、`shared/`、`ui/` 都在内），起点表达式：

| 组 | 表达式（正则；`rg` 或 PowerShell `Select-String` 都行） |
|---|---|
| cordis 插件 API | `ctx\.on`、`ctx\.inject`、`ctx\.effect`、`ctx\.slots`、`systemPrompt`、`getSectionOrder`、`web\.register`、`settings\.section`、`agent/created`、`approval/request`、`agent\.ctx\.inject` |
| 浏览器半装载 | `__ModuleLoader__`、`require\(['"]react['"]\)`、`dsh\.client` |
| 宿主视觉 token | `--dsw-`、`--ds-`、`data-ds-dark-theme` |
| profile 与 patch | `profileContext`、`patchPath`、`DSH_PROFILE_DIR`、`cordis\.patch\.yml`、`presets`、`defaultPreset`、`approval/policy` |
| 会话日志探针 | `session\.v4\.jsonl\.zstd`、`system-prompt`、`zstd` |
| 版本探测链 | `DSH_VERSION`、`dsh-package-manifest`、`app\.asar`、`LOCALAPPDATA`、`dsh-runtimes`、`runtime\.json` |
| home | `DSH_HOME`、`\.dsh`、`enhance/` |
| 装载与冒烟工具链 | `dsh\.cmd`、`dsh plugin`、`dump-config`、`smoke\.ps1` |

**b. 归并成条目。** 五条规则，从上往下套：

1. **一个接缝一条**：我们这侧只要改一处调用就都得改的，算一条；
2. **并列项各算一条**：同一行里以「、」分隔的并列项，各算一条；
3. **引用点先归并再计**：同一机制的多个调用点合并成表里那一条——「23 个 `--dsw-*`/`--ds-*` 变量」在代码里是 23 个名字，在表里仍是一条；`ctx.on` 的若干处调用也归并到各自的条目里；
4. **链按环拆**：`→` 连成的链，每一环各算一条——「版本探测链」那一行按 6 环算 6 条，不是 1 条；
5. **新能力就新增条目**：加了新功能带来的新接缝必须新增一条，不许并进旧条目充数。

**c. 对数。** 按 b 数：除「版本探测链」外的其余 7 行按「、」共 30 段，「版本探测链」按 `→` 拆成 6 条，30 + 6 = **36**。grep 命中的是**引用点**（通常上百处），36 是归并后的**条目数**；两个数不相等是正常的，相等反而说明没归并。数出来不是 36 就先怀疑表：漏了新触点，或把两件事并成了一条——改表，别改数。计数门禁把这个数当**人工维护值**（`scripts/known-counts.json` 的 `hostContacts`），它只核各文档之间是否一致、不假装能机算——真正重数还是按 a/b/c 三步走。

### 2. 逐包 tree-diff

逐包比 tree SHA，不要信 GitHub compare API 的文件列表——它的列表上限 300 条，超了会静默截断，用它做触点核验会漏包。

**口径先说清：「全系」= 区间里每一个 tag，不是首尾两端点。** 两端点全同不代表中间没变——本项目就有实测反例：`packages/client/ui-settings-general/src` 在 rc.2→rc.3 之间变过一次，只比 rc.1 与 rc.5 是看不出来的（见「核验记录」）。所以脚本按 `$tags` 里的**全部 5 个 tag** 各取一次 tree SHA：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'   # 需要时
$repo = 'deepseek-ai/deepseek-harness'
$tags = @('dsh-v0.2.1-rc.1','dsh-v0.2.1-rc.2','dsh-v0.2.1-rc.3','dsh-v0.2.1-rc.4','dsh-v0.2.1-rc.5')
$pkgs = @(
  'packages/core/system-prompt/src',
  'packages/host/webserver/src',
  'packages/interaction/user-approval/src',
  'packages/interaction/permission-presets/src',
  'packages/client/ui-settings/src',
  'packages/client/ui-settings-general/src',
  'packages/client/ui-permission-presets/src',
  'packages/boot/app-boot/src',
  'packages/boot/plugin-manager/src'
)
foreach ($pkg in $pkgs) {
  $shas = @()
  foreach ($tag in $tags) {
    $sha = ("$(gh api "repos/$repo/git/trees/${tag}:${pkg}?recursive=1" --jq '.sha')").Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') { throw "取 tree SHA 失败（$tag $pkg）——查代理/限流/网络后重跑：[$sha]" }
    $shas += $sha
  }
  if (@($shas | Select-Object -Unique).Count -eq 1) {
    "{0}`t{1}`tALL-SAME" -f $pkg, $shas[0]
  } else {
    "{0}`t{1}" -f $pkg, ($shas -join ' ')
  }
}
```

输出每个包一行：`ALL-SAME` 表示这个包在区间内没动过；否则打印 5 个 tag 各自的 SHA，一眼能看出「从哪个 tag 开始变」。脚本对每个 SHA 做 40 位十六进制校验，`gh` 一旦报错（代理抖动 / 限流）就立刻抛并指出是哪个包哪个 tag，不会留一个空格混过去——抛了就重跑。新 rc 发布后把新 tag **追加**进 `$tags`（别删旧的，删了就退化成两端点对比），再把新列补进「核验记录」的 SHA 表。

tag 名格式是 `dsh-v<版本>`（例：`dsh-v0.2.1-rc.5`）。别假设新 tag 一定存在——先探一下（2026-11-02 实测上游**没有** rc.6）：

```powershell
gh api "repos/$repo/git/ref/tags/dsh-v0.2.1-rc.6" --jq '.ref'   # 期望 404 说明还没有这个 tag
```

有变更不要只看数量，要拉 diff 读内容（下一步）：埋点、注释、内部重构不影响接缝，改到 `ctx.slots`、config 形状或装载协议才要处理。

### 3. 有变更时读 diff

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$repo = 'deepseek-ai/deepseek-harness'
$pkg = 'packages/client/ui-settings-general/src/client'
# 1) 同一目录在两个 tag 各列一次文件级 sha，逐路径比——变了的行才是要读的
gh api "repos/$repo/git/trees/dsh-v0.2.1-rc.1:${pkg}?recursive=1" --jq '.tree[] | select(.type=="blob") | "\(.path) \(.sha)"'
gh api "repos/$repo/git/trees/dsh-v0.2.1-rc.3:${pkg}?recursive=1" --jq '.tree[] | select(.type=="blob") | "\(.path) \(.sha)"'
# 2) 取某个 blob 的原文——接口返回的 .content 是 base64，必须解码才看得到源码
$b64 = gh api "repos/$repo/git/blobs/<sha>" --jq '.content'
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($b64 -replace '\s','')))
```

两处细节：`--jq '.content'` 拿到的 base64 字段**带换行**，解码前先 `-replace '\s',''`，否则 `FromBase64String` 直接抛；`<sha>` 用上一步列出来的值（不是 tree SHA，是文件条目的 blob sha）。2026-11-02 实测这套命令：`ui-settings-general/src/client` 在 rc.1 与 rc.3 都是 22 个文件，其中 21 个 blob 相同，只有 `index.ts` 不同（rc.1 是 `561174f90be2d053f7d9a30195a3c2097935d31f`、rc.3 是 `218f5c3cc8f2e34bb6cff9f237704ed6da0ba793`，前者解出来没有 `productAnalytics`、后者有）。GitHub 的 blobs 接口单文件上限 100 MB，读不到先怀疑拿错了 sha。

**什么算「改到接缝」**：一句话——**我们这侧不改一行代码就会被它弄坏**，才算改到接缝。落到字面就是这些：包的导出名与入口、`ctx.*` 方法的签名与调用方式、`settings.section`/`slots` 的契约字段名、`engines.dsh` 的读取逻辑、patch 与装载协议的字段/文件名、`system-prompt` 的 section 顺序常量与文本。埋点、注释、内部重构、纯样式值不算——2026-10-30 那轮就是这个判例：`client/index.ts` 新增了一行 `productAnalytics` 埋点与一行 `import type {}`，`settings.section` 槽位机制一个字没动，所以判「不影响接缝」。

同理，「宿主怎么执行这条声明」里那句「21 个文件含 `engines.dsh`」是同一个读法的另一向：解 asar 头里的条目表（只读、不解包），对文本条目搜 `engines.dsh`——本仓 `enhance-scope/index.js` 的 `readAsarManifestVersion()` 用的就是这套头布局。

### 4. 冒烟

用独立 `DSH_HOME`，别碰日常使用的 profile。仓库自带脚本，一条命令跑完：

```powershell
pwsh -NoProfile -File tools/smoke.ps1
```

它按顺序做这些事，每一步打印 PASS/FAIL，退出码为 0 才算过：

1. 在临时 `DSH_HOME` 里 `dsh plugin --profile smoke add <本仓库路径>`，真机装载；
2. `dsh --profile smoke --dump-config` 确认三个入口进了组合树；
3. 进程内驱动真实插件入口：section 注册与文本、审批三态、`state` / `check` / `preset` 三个 op；
4. 写档，再 `--dump-config`（等价于重启后宿主重新组合）应看到 `enhanced`，其余三档还在；
5. 移除，patch 回到写前字节，`--dump-config` 里 `enhanced` 消失；
6. 删掉这次用的一次性 home。

驱动插件入口这一步在进程内跑，不用 `dsh headless`，原因在凭据：真会话要模型凭据，而凭据在用户的 `<DSH_HOME>/.credentials.yaml` 里，为冒烟去复制用户凭据不可接受。所以「注入是否真的进提示词」用捕获 `systemPrompt.section()` 的 `text()` 返回值来验——宿主拿到的就是同一个返回值，这条路径与真会话同源。

手动做也是这几步：

```powershell
$cli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = Join-Path $env:TEMP 'dsh-smoke-home'
& $cli plugin --profile smoke add <本仓库路径>
& $cli --profile smoke --dump-config
```

真机上看一眼：装好启动、发一条消息、在设置页点「开始检查」，四项都应是 ✓ 或 –；再点「写入 Enhanced 档」并重启，左下角档位菜单、`/permission`、设置页的「默认档位」下拉三处都应出现纯文字的 **Enhanced**；点「移除 Enhanced 档」并重启，三处消失。

### 5. 改声明

核验全过之后，**一处声明 + 四处派生文本**一起动。下面是「模拟上游发了 0.2.1-rc.6」时按本仓现状要改的**全部**位置（2026-11-02 逐步走了一遍；行号会随本文增删漂移，按内容定位）：

| # | 文件 | 改什么 | 门禁会不会逼你改 |
|---|---|---|---|
| 1 | `package.json` | `engines.dsh` 的**上界**：`<0.2.1-rc.6` → `<0.2.1-rc.7`。**上界是排他的**，所以要把 rc.6 并进区间，字面必须指向**下一个**版本；写成 `<=0.2.1-rc.6` 不是本仓写法（`shared/compat.mjs` 只解析 `>=`/`<` 这种半开区间）。同时 `dsh.compatibility.tested` → `0.2.1-rc.6`、`verifiedAt` → 本轮日期 | **会**（version 门核区间可解析、`tested` 落在区间内、`verifiedAt` 形状） |
| 2 | `README.md` | 适用版本句（由声明派生，逐字一致） | **会**（version 门只读 `README.md`） |
| 3 | `README.en.md` | 同一句的第二语言副本（照同一格式派生） | **不会**——version 门不覆盖英文 README，**最容易漏** |
| 4 | `docs/compatibility.md`（本文） | 七处 + 新增一轮记录：①篇首适用版本句与「哪几轮做过终验」；②「声明」节的 `engines.dsh` JSON 片段；③紧随其后的 semver / 上界排他说明；④`dsh.compatibility` 元数据里的 `tested` 与 `verifiedAt`；⑤「宿主怎么执行这条声明」依据段里的 tag 名；⑥「例行核验」第 2 步的 `$tags` 与第 3 步例子里的 tag；⑦「核验记录」的 SHA 表加一列，并**新增一轮**（不覆盖旧轮） | **不会**（version 门对本文只查存在；counts 门只核计数） |
| 5 | `CHANGELOG.md` | 新增一条版本条目，写明「兼容区间扩到 rc.6」与本轮「验证」做了什么；即使不发新版插件也记一条 | 不会（docs 门只查字面转义 / 死链 / 死路径，不核版本号） |
| 6 | 触点表的计数副本 | 只有**触点集合本身变了**才动：计数门禁的单一来源 `scripts/known-counts.json` 里的 `hostContacts`（先改它，门禁会逼着文档一起改）、`docs/figures/sources/compat-verify.workflow.json` 与成品 SVG 里的「36 条」、`docs/brand-persona.md` 里的引用。区间扩张本身不动它们 | 会（counts 门核「36 条触点」的声明位） |

改完跑 `node scripts/check.mjs`：version 门会把 `README.md` 那句与声明逐字核对；但 `README.en.md`、`CHANGELOG.md` 里的版本句**version 门不查**，本文自己的版本行它也不查——docs / counts 两道门只管机械残渣与计数，不管版本号。所以上表要照着走，不能等门禁提醒。

## 核验记录

每改一次声明区间前后各核一轮，都记在这儿——**都留着、不覆盖**，因为两轮暴露的问题不一样。每轮的结构相同：结论表 → 逐文件读法 → 那一轮确认的边界与未验项 → **逐条复跑条件表**（每条记录都写清本机可不可复跑、不可复跑时缺什么）。

### 2026-10-30（范围 rc.1–rc.5）

| 包 | rc.1 tree SHA | rc.2 | rc.3 | rc.4 | rc.5 | 结论 |
|---|---|---|---|---|---|---|
| `packages/core/system-prompt/src` | `004ba79f1155e70d6106d57d18bde92408da3c97` | 同左 | 同左 | 同左 | 同左 | 全同 |
| `packages/host/webserver/src` | `2a70b7add8775b3fe47724e34706317485298e6d` | 同左 | 同左 | 同左 | 同左 | 全同 |
| `packages/interaction/user-approval/src` | `2c3c6bcdcd5b1e7a57e09459dd71be2e8adf05fa` | 同左 | 同左 | 同左 | 同左 | 全同 |
| `packages/interaction/permission-presets/src` | `9c84caa30dbc0ab32d530217c10be26479c58f19` | 同左 | 同左 | 同左 | 同左 | 全同 |
| `packages/client/ui-settings/src` | `6bcf51fa271b5763ac4adf713a6a32087ab6bb73` | 同左 | 同左 | 同左 | 同左 | 全同 |
| `packages/client/ui-settings-general/src` | `e0ad312f5ae2b026c986ef908fda668016d6dd64` | 同左 | `22c42682ba5fb15014c86caaabfeb4bb4c86bb58` | 同左 | 同左 | rc.1≡rc.2；rc.3 起变，rc.3≡rc.4≡rc.5 |
| `packages/client/ui-permission-presets/src` | `71cf0cb4204e166c8dec3434681a9a52a0221966` | 同左 | 同左 | 同左 | 同左 | 全同 |
| `packages/boot/app-boot/src` | `14016c958ce4f6006933056a4863c5bebb348daf` | 同左 | 同左 | 同左 | 同左 | 全同 |
| `packages/boot/plugin-manager/src` | `90ef58695a4ebc4a076c4688b36529124fdfcf11` | 同左 | 同左 | 同左 | 同左 | 全同（rc.1–rc.5 五个 tag 同一个 tree SHA） |

表里的「同左」= 与前一列同一个 SHA（不是「没测」）。取这张表的命令就是「例行核验」第 2 步那条 5 tag 脚本，输出逐行对得上：`ALL-SAME` 的行对应本表的「全同」，`ui-settings-general/src` 那行打印 5 个 SHA，只有第 3、4、5 个相同。2026-11-02 逐 tag 重取复对，9 行全部一致；其中 `plugin-manager/src` 那一行原先只写「（blob 级对照）」、没有值也没有命令，本轮补上 tree SHA `90ef58695a4e…`（完整值见上表）与上面的命令。

逐文件比对 `ui-settings-general/src`：只有 `client/index.ts` 变了，diff 是新增 `productAnalytics.track('code_work_view_toggle', …)` 埋点与一行 `import type {}`，**`settings.section` 的槽位机制未动**。复跑就是「例行核验」第 3 步那两条命令：该目录在 rc.1 与 rc.3 各 22 个文件，21 个 blob 全同、只有 `index.ts` 不同（`src/` 层面是 25 个文件里 24 同、同样只有它变——`src/client` 之外还有 3 个文件，全同）。

rc.5 上还做了一轮**干净环境终验**（2026-10-30，远端机重置后）：静默重装 `0.2.1-rc.5` → 按现行装法 `dsh plugin add` 装最终包（`engines.dsh` 区间在装载 preflight 下直接通过，exit 0）→ `--dump-config` 三个入口齐全、profile patch 保持 `[]` → 隔离 home 冒烟 30 条断言全过 → GUI 侧 `/enhance/api` 注入命中真实会话系统提示、写档/重启/组合/摘除闭环 → 真启动一次只报余额不足（`QUOTA`），没有插件相关报错。**复跑条件**：装包、`--dump-config`、冒烟三步本机可复跑（「例行核验」第 4 步）；「GUI 注入命中真实会话」这一环**不可复跑**——要一台能起桌面 GUI 的机器和一次**有余额的会话**才能复跑，两样今天都没有（余额 0，见 10-31 那轮 `QUOTA`）。

同一轮里确认的版本行已知边界：asar 清单读取在 CLI 进程（headless / 探针）稳定返回 `0.2.1-rc.5`，但在 GUI 的插件进程里，整条探测链都退化为「读不到本机版本」——页面照实显示、不判红，注入、审批、写档不受影响；这就是「读不到就照实写」的实测样例。**复跑条件**：这一段**不可复跑**——需要一台能起桌面 GUI 的机器，并把本包装进 `desktop` profile 才能复跑（本机 `desktop` profile 里装的是 `dsh-enhance-1.1.2.tgz`、`state.json` 仍是 v3，等于没装这一轮的代码）；CLI 那一半只用 `--version` 与 `--dump-config` 就能复跑。

**本轮逐条复跑条件**：

| 记录条目 | 复跑条件 | 缺什么 |
|---|---|---|
| rc.1–rc.5 的 9 行 tree SHA 表 | **本机可复跑**：「例行核验」第 2 步的 5 tag 脚本，约两分钟 | 无 |
| `plugin-manager/src` 那一行 | **本机可复跑**：同一条命令，值见上表 | 无（原先没写 SHA 值，属「结论在、证据缺」） |
| 「只有 `client/index.ts` 变了」 | **本机可复跑**：「例行核验」第 3 步的列 sha + base64 解码 | 无 |
| rc.5 干净环境终验（装包 / `--dump-config` / 冒烟 / GUI 注入命中真实会话） | 前三步**本机可复跑**；「GUI 注入命中真实会话」**不可复跑** | 需要一台能起桌面 GUI 的机器 + 一次**有余额的会话**，才能复跑那一环 |
| GUI 插件进程里探测链退化为「读不到本机版本」 | **不可复跑** | 需要一台能起桌面 GUI 的机器，且把本包装进 `desktop` profile（本机装的是 1.1.2、`state.json` 仍 v3），才能复跑 |

### 2026-10-31（重置重装后，rc.5）

把远端测试机**全量重置**（杀进程 → 删 `.dsh` / `%APPDATA%\@deepseek-ai` / 安装根 / 卸载项 → 静默装 `0.2.1-rc.5`，43 s），随后实测。**复跑条件**：**不可复跑**——需要一台可整机重置的测试机与连接方式（那台机是 Windows Server 2022 / pwsh 7.6.9 / node v24.22.1，从开发机经 SSH 别名连入；别名与私钥不在仓内，原始输出在本地账本、不随包发布），本机是日常机、不能当重置对象，详见本轮末尾的复跑条件表：

- **tree SHA 表逐条复对**：按五个 tag 重取（脚本见「例行核验」第 2 步），上面那张 9 行的表全部一致；`ui-settings-general/src/client/` 内除 `index.ts` 外**其余 21 个文件 blob 全同**，与「只有 `client/index.ts` 变了」吻合。
- **洁净环境装本包**：`dsh plugin --profile headless add <仓库>` → exit 0，profile 的 `dsh.profile.bundles` 追加本包，`--dump-config` 组合出 `enhance-scope` / `auto-approve` / `enhance-ui` 三个入口。说明 `engines.dsh` 预检与 bundle patch 在全新 rc.5 上都通过。
- **一次性 home 冒烟 30 条断言全过**：三态映射（`allow→allowed-once`、`ask→unavailable` 且交还下游、`deny→rejected`）、写档写完整四档、**不写 `defaultPreset`**、摘档逐字节回到写前、`<home>/enhance/` 自动补齐。
- **patch 摘成空文件确实会失败**（三种写法都试了：0 字节 / 仅换行 / 仅注释）：宿主 `exit=1`，报 `dsh: overlay <profile>/cordis.patch.yml must be a top-level YAML array of loader patch entries`（`dsh-app-boot/lib/index.js:4000`）。所以往 patch 里写东西必须写成顶层数组，别留空文件。2026-11-02 本机用下面这段一次性 home 命令重跑，三种写法同样都是 `exit 1`、错误串逐字一致；写回 `[]` 则 `--dump-config` 回到 `exit 0`（360 行配置输出）。
- **组合树里 `- id: permission` 的 `config.presets` 是三档全表、不含 `defaultPreset`**：默认档由组合的 sandbox 与 approval 推导，不是写出来的（组合默认 `workspace-write` + `ask`）。
- **仍未验的一项**：真会话。本机 `DEEPSEEK_API_KEY` 余额 0，`dsh --profile headless "…"` 直接 `QUOTA: Insufficient Balance`（exit 1）；「Enhanced 档下是否真会产生 `approval/request`」要一次有余额的会话才能定，这里**只记录、不下结论**。

空 patch 的复跑命令（本机 2026-11-02 实测；用一次性 `DSH_HOME`，不碰日常 profile）：

```powershell
$cli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = Join-Path $env:TEMP 'dsh-empty-patch-probe'
& $cli plugin --profile t list                      # 先初始化 profile；跳过这步会报「profile 不存在」
$patch = Join-Path $env:DSH_HOME 'profiles\t\cordis.patch.yml'
Set-Content -LiteralPath $patch -Value '' -NoNewline # 0 字节；再试 "`n" 与 "# comment`n"
& $cli --profile t --dump-config                    # 期望 exit 1：overlay … must be a top-level YAML array
Set-Content -LiteralPath $patch -Value "[]`n" -NoNewline
& $cli --profile t --dump-config                    # 对照：exit 0
Remove-Item -LiteralPath $env:DSH_HOME -Recurse -Force
```

**本轮逐条复跑条件**：

| 记录条目 | 复跑条件 | 缺什么 |
|---|---|---|
| 把远端测试机全量重置（见本节开头） | **不可复跑** | 需要一台**可整机重置**的 Windows 测试机与连接方式（规格见本节开头；连接别名不在仓内），本机是日常机，不能当重置对象 |
| tree SHA 表逐条复对 + `client/` 21 文件 blob 全同 | **本机可复跑**：「例行核验」第 2、3 步 | 无 |
| 洁净环境 `dsh plugin --profile headless add <仓库>`（exit 0） | **本机可复跑**：`tools/smoke.ps1` 第 1 步走同一条装载路径 | 无 |
| 一次性 home 冒烟（当时 30 条断言，现 **38** 条） | **本机可复跑**：`pwsh -NoProfile -File tools/smoke.ps1` | 无 |
| 空 patch 三种写法必失败 | **本机可复跑**：上面那段命令；2026-11-02 本机实测三种都 `exit 1`，写回 `[]` 则 `exit 0` | 无 |
| 组合树 `config.presets` 三档全表、不含 `defaultPreset` | **本机可复跑**：`dsh --profile <p> --dump-config`（冒烟 4.5/4.6 覆盖） | 无 |
| 真会话仍未验（`QUOTA`，只记录不下结论） | **不可复跑** | 需要一次**有余额的会话**才能复跑；`QUOTA` 是凭据余额状态，不是插件行为 |

两段记录的差异来自**会话可用性**，不是产品行为变了：10-30 那次机器上有可用会话，才看得到「注入命中真实会话系统提示」；10-31 这次重置后无可用会话，`inject` 项因此为红。别把两段混着读成「行为回退了」。补一句口径：`inject` 仍是**一项**（键与标题都不动），但它现在同时探**内容边界**与**品牌人设**两路——这两路探针是 **1.2.1 才进工作树**的，10-31 那轮还没有它们（那轮的 `inject` 只探内容边界）。有装配日志却两路都不命中才是真红；没有日志时按「还没有证据」如实说，不冒充失败。

### 2026-11-02（1.2.0 品牌人设；36 条触点那一轮）

触点表加了一条（`ctx.on('agent/created')` + `agent.ctx.inject()` 的 agent 作用域同名段遮蔽），独立触点项由 35 条重数为 36 条。这一轮核的就是这条新触点，做法与结论：

- **宿主侧逐条核对（本机 `0.2.1-rc.5` 的 `app.asar` 只读）**：`@deepseek-ai/dsh-system-prompt` 里 `HARNESS_IDENTITY` 座位与 `"You are an AI agent powered by DeepSeek Harness."` 原文、`@deepseek-ai/dsh-harness-dev-context` 里 `harness:source` / `app:web-surface` 两个名字同时用于 section 与 context、`@deepseek-ai/dsh-agent` 的 `agent/created` 载荷为 `{ agent, source, signal }` 且 `agent.ctx` 是可注入的 agent 作用域上下文、`@deepseek-ai/dsh-file-reference-local` 就是 `agent.ctx.inject(['systemPrompt'], …)` 的现成先例——全部与契约「为什么是「按 agent 遮蔽同名段」」的假设一致。**复跑条件**：本机可复跑（只读解 asar 头，读法见「例行核验」第 3 步末尾；「21 个文件含 `engines.dsh`」按同一读法复算）。但**基准不是原封发行件**：本机 `app.asar` 与同目录 `app.asar.bak-2026-10-31T09-42-57-481Z` 等长（182766714 B）而内容差一个条目——`dsh-sandbox-windows-acl` 的 `types-*.js` 一行等长替换（改动者不是本插件）。它与这一轮核对的四个包无关，所以结论不变；要拿干净基准，先用安装器重装一次再核。
- **真机端到端（远端机全量重置后）**：静默重装 `0.2.1-rc.5` → `dsh plugin --profile headless add` 与 `--profile desktop add`（均 exit 0）→ `--dump-config` 组合出三个入口；`headless` 首启种下 `state.json` **v4 五键**；设置页后端 `/enhance/api` 的 `state` 快照在桌面端 GUI 上返回 `version=4 / identityLimit=2048`；`check` 四项全绿——按**这一轮的探针口径**读：那一轮的 `inject` 只探**内容边界**一路，还没有品牌人设那一路（**1.2.1 起 `inject` 另加品牌人设一路**，该轮口径与实测见下面「2026-11-02（1.2.1 收口轮）」）；桌面端 GUI 的「增强」一节实际渲染出五组（用户截图确认）。**复跑条件**：**不可复跑**——需要那台可整机重置的远端测试机、桌面 GUI 与一次**有余额的会话**，三样缺一样都复不了；本机 `desktop` profile 装的是 1.1.2，连「装的是本轮代码」这个前提都不成立。
- **装配层验收（契约「做到什么算成」的第 1、3 条）在真机会话日志上成立**——这是 10-31 那次欠下的那项，这次补上了。做法是**手工**的：把 `identity` 设成 `custom`、写 `identity.txt`、`hideHarness=true`，跑一次 `dsh --profile headless headless "…"`，再解压会话日志看 `system/message` 的文本：
  - `custom` 态：system 节点第一句是 `You are Aria, a private assistant.`，宿主原句 `You are an AI agent powered by DeepSeek Harness.` **在整份会话里 0 命中**；
  - 切回 `keep` 态：第一句**逐字回到**宿主原句，自定义文本 0 命中。
  两条都只改声明层——内容边界那句在两种状态下都在。这条路径**不依赖任何 1.2.1 才进工作树的能力**（它是改设置 + 跑一次 headless + 解压日志，那几件新探针一件都没用上），所以它是这一轮的记录，不下移到别轮。**复跑条件**：**不可复跑**——要改完 `identity` 后**新起一次真会话**，而那需要一次**有余额的会话**（本机余额 0，`dsh --profile headless headless "…"` 直接 `QUOTA` exit 1）；还要 `custom` 与 `keep` 两次会话日志作对照，才能复跑。**这条限制的是「今天能不能重跑一遍」，不是「那一轮验没验过」**——当时读的那两份会话日志的读数就记在上面这两行。
- **仍然没验的**：`hideHarness` 在**桌面/web** profile 上的效果。`harness-dev-context` 的 `inject` 含 `webApp`，`headless` 组合里没有它，所以那两段在 `headless` 上本来就注册不到（基线里也是 0 命中），无从对比。这一项留给一次桌面端真会话。**复跑条件**：**不可复跑**——需要一次**桌面端真会话**才复得了；本机没有桌面会话可跑。
- **顺带纠正一处旧记录**：`dsh --version` **不会**重建 `.dsh`（10-31 那次记反了）。真正重建的是一次 profile 引导：`dsh headless "…"` 即便因 `QUOTA` 退出码 1，`~/.dsh` 也已生成。本次实测确认（2026-11-02 本机复核：临时 `DSH_HOME` 下 `dsh --version` 后目录仍不存在；`dsh plugin --profile t list` 之后 `profiles/t/` 就出现了）。**复跑条件**：**本机可复跑**，命令即这两步。

**本轮逐条复跑条件**：

| 记录条目 | 复跑条件 | 缺什么 |
|---|---|---|
| 宿主侧 asar 逐条核对（`0.2.1-rc.5` 只读） | **本机可复跑**：只读解 asar 头 + 上面那四个包的条目对照 | 步骤上不缺；但**基准不是原封发行件**（本机差一个 `dsh-sandbox-windows-acl` 条目），要干净基准得先重装 |
| 真机端到端（远端重置 + 双 profile 装包 + 设置页五组 + `check` 四项全绿） | **不可复跑** | 需要一台可整机重置的远端测试机（规格与连接方式见 10-31 那轮开头）、桌面 GUI、一次**有余额的会话**；本机 `desktop` profile 装的是 1.1.2 |
| 装配层验收：`custom` 态第一句是自定义文本、宿主原句 0 命中 / 切回 `keep` 逐字回原句 | **不可复跑** | 需要改完 `identity` 后**新起真会话** + `custom`/`keep` 两份会话日志作对照，而真会话要**有一次有余额的会话** |
| `hideHarness` 在桌面 / web profile 上的效果 | **不可复跑** | 需要一次**桌面端真会话**；本机没有桌面会话可跑 |
| 「`dsh --version` 不重建 `.dsh`」这处纠正 | **本机可复跑**：临时 `DSH_HOME` 下 `dsh --version` 后目录不存在，再跑一次带 `--profile` 的命令就出现 | 无 |

### 2026-11-02（1.2.1 收口轮；干净基线远端机真装 1.2.1）

这一节记的是 **1.2.1** 的能力归属与它在真机上的读数。上面 1.2.0 那一轮装进去的包**不含**下面这些能力，所以它们不写在那轮里。

**先勘时段归属。** `identityInstall`（`state` 快照的上报字段，由 `describeIdentityInstall` 派生）、`inject` 的「内容边界 + 品牌人设」两路（由 `identityShadowProof` 判定）、反向探针 `sessionOmits` 都是 **1.2.1 才进工作树**的（本轮改动之前，这四个名字在上一版代码里各 0 命中）。原先挂在 1.2.0 那轮的两处说法（`state` 快照带 `identityInstall`、`inject` 两路与 `sessionOmits`）因此从那轮叙述里移出，改按下面的实测重写。**这次移出只覆盖上面这两个字段，不覆盖那一轮的装配层验收**：那轮的装配层验收走的是**手工路径**（设 `identity=custom`、写 `identity.txt`、跑 headless、解压会话日志看 `system/message`），不碰上面任何一件新探针，所以它**不属时段错位**——它已按原记录恢复在上一节；那轮的「`check` 四项全绿」在当时的口径（`inject` 只探内容边界）下也成立，同样保留。

- **能力进树（1.2.1）**：`state` 快照新增 `identityInstall`——`ok` 是三值：`true` 装上、`false` 明确装不上、`null` 还没有 agent 可判，不把「还没有证据」报成失败；`inject` 从只探内容边界扩成「**内容边界 + 品牌人设**」两路（`custom` 要命中 `identity.txt` 的文本、`remove` 不得再出现宿主原句、`keep` 这一路不判）；缺失性走反向探针 `sessionOmits`，只看**最新一份**含 `"system-prompt"` 装配记录的日志（按 mtime 倒序取第一份，不让切换设置前的旧日志把检查永久判红）。
- **干净基线远端机真装 1.2.1（本轮实测）**：远端测试机已全量重置为干净 `0.2.1-rc.5`（重置过程见 10-31 那轮开头）。本轮真装 **1.2.1**：`dsh plugin --profile smoke add <仓库>` → **exit 0**（输出 `+ dsh-enhance 1.2.1`）；一次性 home 冒烟 **`pass=38 fail=0 total=38`**（进程内驱动真实插件入口，含 `3.5.7` 在同一个活 agent 上「去掉 → 自定义」真的换上自定义文本）；持久装进 `headless` profile 后 `--dump-config` 三个入口齐——`enhance-scope` / `auto-approve` / `enhance-ui` 各命中一次；`profiles/headless/cordis.patch.yml` 仍是 `[]`（本包不替用户改 patch）；核验前后两次算的远端仓库 **68 文件** sha256 清单无差异、**820967 B** 不变（本包没动被核对的源码）。
- **设置页四项：取值断言后来补上了，真机证据仍缺**：本轮（WP15）当轮，冒烟 `3.4` 只断到 `op=check` 返回的 `checks` **名字与顺序**恰为 `["plugins","text","inject","preset"]`，四项各自的 `pass`/`na` 取值没有断言。**这一批之后补上了**：`3.4.1`–`3.4.4` 分别断言四项取值（`inject` 在没有会话日志时**如实为 `false`** 并点明「没有会话日志」，不是静默绿、也不当成遮蔽失效），`3.4.5`/`3.4.6` 用**合成**会话日志覆盖 `inject` 的两路绿路；冒烟因此从 38 增至 **44**，并在同一台远端复跑 `pass=44 fail=0 total=44`。上面 `38` 那个读数保持原样——那是当轮的实测。**合成日志不替代真机会话证据**，也没有浏览器 / DOM 证据：这只装了 `headless` profile，组合树里没有 web 服务宿主，设置页的 HTTP 端点在这台机上起不来。
- **真机会话仍是阻塞**：`dsh --profile headless headless "hi"` 跑一次即 **`QUOTA: Insufficient Balance`**（exit 1），**未重试、未动凭据**。所以**本轮想再跑一次真会话、补一份 1.2.1 装配结果的读数**这件事没有做成：这一轮**没有新增**任何真机会话读数，只记录、不下结论——这不改变 1.2.0 那轮已成立的那对读数（见上一节），也不拿它当「当时没验成」的凭据。**复跑条件**：**不可复跑**——需要**一次有余额的会话**才能复跑（`QUOTA` 是凭据余额状态，不是插件行为），且要 `custom` 与 `keep` 两次会话日志作对照。

**本轮逐条复跑条件**：

| 记录条目 | 复跑条件 | 缺什么 |
|---|---|---|
| 远端重置为干净 `0.2.1-rc.5` 后真装 1.2.1（`plugin --profile smoke add` exit 0） | **不可复跑** | 需要一台可整机重置的测试机与连接方式（规格见 10-31 那轮开头），本机是日常机、不能当重置对象 |
| 冒烟 `pass=38 fail=0 total=38`（含 `3.5.7` 的活 agent 换文） | **本机可复跑**：`pwsh -NoProfile -File tools/smoke.ps1`（**现值 44 条**，见上；38 是当轮读数） | 无 |
| `--dump-config` 三入口齐 + `cordis.patch.yml` 仍 `[]` | **本机可复跑**：冒烟 `0.3`/`0.4` 与 `3.3` 覆盖 | 无 |
| 远端仓库 68 文件 sha256 清单前后无差异 | **不可复跑** | 需要那台测试机（清单是对远端仓库逐文件算 `Get-FileHash`） |
| 真会话 `QUOTA`（只记录、不下结论） | **不可复跑** | 需要**一次有余额的会话** |

## 两个与「写入 Enhanced 档」按钮直接相关的宿主事实

**patch 的 `config` 是整块替换，不是深合并。** 在 profile patch 里写 `- id: permission` 加一条 `enhanced`，基础组合包的 `read-only` / `workspace-write` / `danger-full-access` 会全部消失（`dsh --profile <p> --dump-config` 可复现）。所以设置页写档时写的是完整档位表：宿主基础三档 + `enhanced`。界面名与标识符的逐条对照见 `docs/terminology.md`——两套都合法，别合并成一个名字。

**`enhanced` 是合法的自定义档名。** 保留名只有 `custom` 与 `auto`，本包不配置它们；`approval: ask` 合法——这里的 `approval` 指宿主的**审批策略** `approval/policy`，与本包那三态的**开关档** `approval` 不是一套词表（消歧见 `docs/terminology.md`）。未知 kebab-case 档名在档位菜单里渲染成 Title Case 的纯文字行，字形表里没有它——这不是缺陷，是宿主的显示契约。本包这个档就落在其中：patch 里写 `enhanced`，菜单里显示纯文字的 **Enhanced**，同一个档的两个名字。

## 设置页那行版本号怎么读本机版本

设置页顶部显示 `增强 <本包版本> · DSH <本机版本> · 已验 <范围>`。本包版本与范围读自 `package.json` 的 `version` 与 `engines.dsh`（经 `shared/compat.mjs` 派生）；本机版本按下面的顺序探测，读不到就写「读不到本机版本」，不猜：

1. `DSH_VERSION` 环境变量（显式覆盖，脚本与测试用）；
2. 宿主的 `@deepseek-ai/dsh-package-manifest` → `getDshRuntimeVersion()`；
3. 安装作用域里的核心包（`@deepseek-ai/dsh-base` 等，版本号与产品同号）；
4. 桌面版装机根的 `app.asar` 清单（只读头里的 `package.json` 条目，不解包、不写盘、不派生任何产物）；
5. `<home>/dsh-runtimes/<runtime>/runtime.json` 的 `desktopVersion`。

rc.5 上的实测：`@deepseek-ai/dsh-package-manifest` 与安装作用域核心包在 profile 插件里分别报 `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`；`dsh-runtimes` 的目录在没跑过带工具的会话时不出现；只有 `app.asar` 清单稳定可用。这条只读路径是 1.1.0 唯一新增的宿主耦合；宿主哪天改掉 asar 头布局，它会自动退化成「读不到本机版本」，不影响注入、审批与写档。

## 已知边界

- **不拿宿主安装产物做派生。** 版本行读装机根的元数据，是只读；不解包、不写盘、不生成派生件。图标与派生件永久不做。
- **不覆盖 `0.2.2-alpha` / `master`。** master 自 2026-10-28 起有一次 context-menu 槽位重构，动过 `ui-permission-presets`；转型后我们对它只剩显示契约依赖，不是补丁。风险降级，但不是零。
- **不建 CI 版本矩阵、不做 semver 求解、不预适配。** 「最优兼容标准」无解，不追求：维护模型 = 常数流程（本篇）+ 一条随版本更新的声明（`engines.dsh`）。
