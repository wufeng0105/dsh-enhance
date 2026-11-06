# DSH 版本支持

**适用版本**：DeepSeek Harness 0.2.1-rc.1–0.2.2-rc.1（0.2.2-rc.1 实测，全系源码级核验）。这句与 `README.md` / `README.en.md` 里那两句逐字同源，都由 `package.json` 派生；2026-10-30、2026-10-31 与 2026-11-02 各做过一轮干净安装终验（三轮各有前提，逐条复跑条件见「核验记录」每轮末尾），2026-11-03/04 另有一轮真机桌面会话上的装配层验收，2026-11-06 起新区间以 0.2.2-rc.1 本机冒烟与源码级 diff 收口（见核验记录最新一轮）。

版本支持不是「尽量兼容」的承诺，而是一份有界、可复跑、由一处声明驱动的契约：声明写清我们核过哪些版本，宿主自己执行同一条声明，流程写清新版本来了怎么核，核验结果留档。这篇文档就是契约的全部内容。

## 声明

唯一权威是 `package.json` 的 `engines.dsh`：

```json
"engines": {
  "node": ">=22",
  "dsh": ">=0.2.1-rc.1 <0.2.2-rc.2"
}
```

区间在 semver 上恰好等于 `0.2.1-rc.1` 到 `0.2.2-rc.1`（上界排他，跨一个 minor：`0.2.1-rc.1`–`0.2.1-rc.5` 加 `0.2.2-rc.1`）。`dsh.compatibility` 不是第二份区间，只是这条区间的证据元数据（实测版本、核验依据、日期、文档指针）：

```json
"dsh": {
  "compatibility": {
    "tested": "0.2.2-rc.1",
    "basis": "source-level",
    "verifiedAt": "2026-11-06",
    "doc": "docs/compatibility.md"
  }
}
```

上面片段里的 `verifiedAt`（`2026-11-06`）与 `package.json` 的 `dsh.compatibility.verifiedAt` 逐字一致，**与本文件核验记录的最新一轮一致**——这个片段记的是现值，不是历史样例。

README 里那句适用版本是这份声明的派生文本，`node scripts/check.mjs` 要求两处逐字一致。它同时核对声明形状（区间解析与成员判定在 `shared/compat.mjs`，唯一实现）；探测到本机 DSH 版本不在区间内时判红，提示先跑本文的例行核验再扩区间。

为什么 README 不能是第二权威：散文会被人顺手改，声明不会。两处各写各的，就会「改了声明忘改 README」与「改了 README 忘改声明」各错一次。为什么是区间不是版本数组：宿主读的就是这个字段——理由在「宿主怎么执行这条声明」一节。

**正式版与 rc 的排序陷阱**：上界停在某个 rc 之前时（现在是 `<0.2.2-rc.2`），按 semver 排序 `0.2.2` **大于** `0.2.2-rc.2`——上游一发 0.2.2 正式版，它就落在区间外，插件对用新宿主的用户变成装不上；同理 `0.2.1` 正式版也在区间外。这不是缺陷，是半开区间的应有行为；代价是「上游发正式版」和「上游发 rc」一样，都要先走一轮例行核验再扩区间。另有一个已知取舍：区间含 `0.2.2-rc.1` 时，`0.2.2-alpha` 系（semver 排序在 rc 之前）也一并被包含，`>=A <B` 单一形状表达不了中间挖洞；alpha 上游未发过 tag，接受。

## 宿主怎么执行这条声明

`engines.dsh` 不是写给自家门禁看的自留地，宿主在三个时机读它并做 semver 匹配（无该字段时回退读 `peerDependencies` 里的 `@deepseek-ai/dsh*`）：

| 时机 | 宿主行为 |
|---|---|
| `dsh plugin add` 装前 | preflight 拉取声明，不兼容直接拒装（exit 1，`nothing was installed`） |
| pnpm 装完后 | 校验 `node_modules/<pkg>/package.json`，不兼容回滚重装旧版本（exit 1） |
| profile 启动装载 | 每个插件行过预检，不兼容则该行被禁用、插件根本不被 import |

唯一放行通道是精确版本豁免：profile 里的 `compatibility.json` + `dsh plugin allow-version <pkg@ver> --dsh-version <ver> --accept-risk`。

依据（2026-10-30 取证，2026-11-06 在 0.2.2-rc.1 复证，可复跑）：上游 `deepseek-ai/deepseek-harness` tag `dsh-v0.2.2-rc.1` 的 `packages/boot/app-boot/src/plugin-compatibility.ts`（`unmetRequirements()` 逐字读 `engines.dsh` 并 `satisfies` 匹配）与 `app-boot/src/compatibility-preflight.ts`（启动预检）自 rc.1 起未改（blob SHA 与 rc.5 完全一致）；`plugin-manager/src/operations.ts`（装前 preflight 与装后回滚）在 0.2.2-rc.1 有变更，但变更内容是 `dsh.bundle.platforms` 平台门禁与输出流处理，`engines.dsh` 的读取与拒装路径未动。本机 0.2.2-rc.1 的 `app.asar` 里打包着同一套逻辑（文本类文件里有 **10 个文件**含 `engines.dsh`）。官方 e2e（`plugin-compatibility.expected.e2e.ts`）断言了拒装、拒启动、豁免后放行的全流程。

由此两条纪律：

- **声明写错不是小事。** 区间写窄，宿主直接拒装；写宽，宿主放行未验版本。所以扩区间的唯一途径是先过例行核验，两端一起动。
- **声明与门禁同源。** `scripts/check.mjs` 的 version 门禁、设置页版本行、README 适用句，三处都从 `shared/compat.mjs` 读同一条声明，不许任何一处自己再解析一遍。

## 为什么是有界声明

宿主每个 rc 都可能在动我们依赖的接缝，「最优兼容」没有解。所以这里只声明核验过的范围，并给出一个常数流程：新版本发布后跑一遍，通过了就把版本号并进区间。声明是变量，流程是常数。

## 例行核验（新 rc 或正式版发布后）

工时不是固定值，按变更规模分档：**rc → rc**（个位数变更文件）约 10–15 分钟；**minor 跳跃**的变更面在第 2 步 tree-diff 跑完即知工作量，第 3 步只精读 `SEAM-HIT` 的文件，工作量与变更文件数成正比。下面按固定顺序走五步。

### 1. 重数触点

触点表已移出本文，独立在 [`docs/host-seams.md`](host-seams.md)（表 + 数法 + 上游包对应关系）；本步的口径与拆条规则以那份文档为准。

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

**c. 对数。** 按 b 数：除「版本探测链」外的其余 7 行按「、」共 30 段，「版本探测链」按 `→` 拆成 6 条，30 + 6 = **36**。grep 命中的是**引用点**（通常上百处），36 是归并后的**条目数**；两个数不相等是正常的，相等反而说明没归并。数出来不是 36 就先怀疑表：漏了新触点，或把两件事并成了一条——改表，别改数。计数门禁把这个数当**可机算值**核（`scripts/known-counts.json` 的 `hostContacts`，`kind` 是 `computed`）：`tools/contacts-count.mjs` 按 [`docs/host-seams.md`](host-seams.md) 的 a/b/c 口径现场数并与单一来源对账，`tools/counts-check.mjs` 再拿它核各文档的声明位。它曾标 `manual`（理由是「口径是散文公式，机算不了」），2026-11-02 证伪后改成机算——真正重数还是按 a/b/c 三步走。

### 2. 逐包 tree-diff

主路径是仓里的工具（零网络，blobless 缓存建一次反复用）：

```powershell
node tools/compat-diff.mjs --trees dsh-v0.2.1-rc.1,dsh-v0.2.1-rc.2,dsh-v0.2.1-rc.3,dsh-v0.2.1-rc.4,dsh-v0.2.1-rc.5,dsh-v0.2.2-rc.1
```

它对 9 个核验包逐个列各 tag 的 tree SHA，全同打 `ALL-SAME`，否则打印短 SHA 序列——「从哪个 tag 开始变」一眼可读。tree 对象全在本地（blobless clone 里 commit 与 tree 不回源），这一步**全程零网络**；这是它相对下面 gh api 脚本的真正优势。新 rc 发布后把新 tag **追加**进逗号列表（别删旧的，删了就退化成两端点对比）。首次没有缓存时工具会打印可操作的建缓存命令（`git clone --filter=blob:none --no-checkout`，约 1–2 分钟一次性）后退出 1；也可以 `--repo` 直接指向已有的本地 clone。

**口径先说清：「全系」= 区间里每一个 tag，不是首尾两端点。** 两端点全同不代表中间没变——本项目就有实测反例：`packages/client/ui-settings-general/src` 在 rc.2→rc.3 之间变过一次，只比 rc.1 与 rc.5 是看不出来的（见「核验记录」）。所以 tag 列表要给**全部 6 个 tag**，工具才逐包逐 tag 各取一次 tree SHA。

9 个核验包的清单（工具内置同款，`packages/core/system-prompt/src`、`packages/host/webserver/src`、`packages/interaction/user-approval/src`、`packages/interaction/permission-presets/src`、`packages/client/ui-settings/src`、`packages/client/ui-settings-general/src`、`packages/client/ui-permission-presets/src`、`packages/boot/app-boot/src`、`packages/boot/plugin-manager/src`）；工具改包清单须与本文同步（它头注释声明了这一点）。

**无克隆后备**（没有本地 clone、也不想建缓存，或只想临时抽查一两个包）用 gh api 手工脚本，逐包比 tree SHA，不要信 GitHub compare API 的文件列表——它的列表上限 300 条，超了会静默截断，用它做触点核验会漏包。脚本按**全部 tag** 各取一次 tree SHA：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'   # 需要时
$repo = 'deepseek-ai/deepseek-harness'
$tags = @('dsh-v0.2.1-rc.1','dsh-v0.2.1-rc.2','dsh-v0.2.1-rc.3','dsh-v0.2.1-rc.4','dsh-v0.2.1-rc.5','dsh-v0.2.2-rc.1')
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

输出每个包一行：`ALL-SAME` 表示这个包在区间内没动过；否则打印各 tag 的短 SHA，一眼能看出「从哪个 tag 开始变」。脚本对每个 SHA 做 40 位十六进制校验，`gh` 一旦报错（代理抖动 / 限流）就立刻抛并指出是哪个包哪个 tag，不会留一个空格混过去——抛了就重跑。新 rc 发布后把新 tag **追加**进 `$tags`（别删旧的，删了就退化成两端点对比），再把新列补进「核验记录」的 SHA 表。

tag 名格式是 `dsh-v<版本>`（例：`dsh-v0.2.2-rc.1`）。别假设新 tag 一定存在——先探一下：

```powershell
gh api "repos/$repo/git/ref/tags/dsh-v0.2.2-rc.2" --jq '.ref'   # 期望 404 说明还没有这个 tag
```

有变更不要只看数量，要拉 diff 读内容（下一步）：埋点、注释、内部重构不影响接缝，改到 `ctx.slots`、config 形状或装载协议才要处理。

### 3. 有变更时读 diff

主路径还是那条工具，这次用主模式——它列两 tag 间的文件级变更，逐文件做统一 diff（`--out` 落盘），并按第 1a 步表格的 8 组接缝关键词表达式预分类：

```powershell
node tools/compat-diff.mjs dsh-v0.2.1-rc.5 dsh-v0.2.2-rc.1 --out <目录>
```

输出首行是机器可判的数量行 `changed-files: <n>`，之后每文件一行分类：`SEAM-HIT <组名,...>`（任一表达式命中，**需人读**）或 `SKIM`（零命中，**可略读**）。分组读法：先读 `SEAM-HIT`，`SKIM` 扫一遍抽查即可。**预分类是分诊不是判决，SKIM 不等于免检**——表达式抓的是机械痕迹，判定标准永远是「我们这侧不改一行代码就会被它弄坏」（判据见下）。

blob 首读按需回源（git promisor lazy fetch）：每个文件第一次读会向远端取一次 blob（秒级/文件，需要代理时按本仓规则临时设 `HTTPS_PROXY`）；blob 一旦进了缓存仓库的 `.git/objects`，同一 diff 重跑**零网络**——「tree 阶段零网络、blob 首读按需回源、缓存后离线」三层，缓存建好后日常这一步基本不出网。重跑失败时工具会提示这一点，补缺失的 blob 而已，已缓存的不再回源。

**无克隆后备**（gh api 手工做单文件排查）：

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

两处细节：`--jq '.content'` 拿到的 base64 字段**带换行**，解码前先 `-replace '\s',''`，否则 `FromBase64String` 直接抛；`<sha>` 用上一步列出来的值（不是 tree SHA，是文件条目的 blob sha）。2026-11-02 实测这套命令：`ui-settings-general/src/client` 在 rc.1 与 rc.3 都是 22 个文件，其中 21 个 blob 相同，只有 `index.ts` 不同（rc.1 是 `561174f90be2d053f7d9a30195a3c2097935d31f`、rc.3 是 `218f5c3cc8f2e34bb6cff9f237704ed6da0ba793`，前者解出来没有 `productAnalytics`、后者有）。GitHub 的 blobs 接口单文件上限 100 MB，读不到先怀疑拿错了 sha。2026-11-06 的 0.2.2-rc.1 轮起，这套流程由 `tools/compat-diff.mjs` 固化：38 文件基线回放、预分类与人工轮判定一致（见「核验记录」）。

**什么算「改到接缝」**：一句话——**我们这侧不改一行代码就会被它弄坏**，才算改到接缝。落到字面就是这些：包的导出名与入口、`ctx.*` 方法的签名与调用方式、`settings.section`/`slots` 的契约字段名、`engines.dsh` 的读取逻辑、patch 与装载协议的字段/文件名、`system-prompt` 的 section 顺序常量与文本。埋点、注释、内部重构、纯样式值不算——2026-10-30 那轮就是这个判例：`client/index.ts` 新增了一行 `productAnalytics` 埋点与一行 `import type {}`，`settings.section` 槽位机制一个字没动，所以判「不影响接缝」。

同理，「宿主怎么执行这条声明」里那句「10 个文件含 `engines.dsh`」（0.2.2-rc.1 本机 asar 实测；rc.3 那阵是 21 个，数字随宿主打包内容变，不是契约值）是同一个读法的另一向：解 asar 头里的条目表（只读、不解包），对文本条目搜 `engines.dsh`——本仓 `enhance-scope/index.js` 的 `readAsarManifestVersion()` 用的就是这套头布局。

### 4. 改声明

源码级三步（第 1–3 步）全过之后、冒烟（第 5 步）之前，**一处声明 + 四处派生文本**一起动。顺序为什么是这样：冒烟要真装进本机 DSH，装前 preflight 按 `engines.dsh` 区间拒装——声明未扩就冒烟，FAIL 全落在装载组（2026-11-06 实录 39/44，5 个 FAIL 全由旧区间造成），流程自己制造假失败。扩声明的证据门槛在第 1–3 步，不在冒烟。

下面是「模拟上游发了 0.2.2-rc.2」时按本仓现状要改的**全部**位置（2026-11-06 扩到 0.2.2-rc.1 时逐步走了一遍；行号会随本文增删漂移，按内容定位）：

| # | 文件 | 改什么 | 门禁会不会逼你改 |
|---|---|---|---|
| 1 | `package.json` | `engines.dsh` 的**上界**：`<0.2.2-rc.2` → `<0.2.2-rc.3`。**上界是排他的**，所以要把 rc.2 并进区间，字面必须指向**下一个**版本；写成 `<=0.2.2-rc.2` 不是本仓写法（`shared/compat.mjs` 只解析 `>=`/`<` 这种半开区间）。同时 `dsh.compatibility.tested` → `0.2.2-rc.2`、`verifiedAt` → 本轮日期 | **会**（version 门核区间可解析、`tested` 落在区间内、`verifiedAt` 形状） |
| 2 | `README.md` | 适用版本句（由声明派生，逐字一致） | **会**（version 门核 `README.md` 与 `README.en.md` 两处的适用版本句） |
| 3 | `README.en.md` | 同一句的第二语言副本（照同一格式派生） | **会**——version 门核两份；「漏英文那份会红」的可红性只由 `--self-test` 的 `compat readme en red` 证明，别的地方只许指向它、不许复述 |
| 4 | `docs/compatibility.md`（本文） | 七处 + 新增一轮记录：①篇首适用版本句与「哪几轮做过终验」；②「声明」节的 `engines.dsh` JSON 片段；③紧随其后的 semver / 上界排他说明；④`dsh.compatibility` 元数据里的 `tested` 与 `verifiedAt`；⑤「宿主怎么执行这条声明」依据段里的 tag 名；⑥「例行核验」第 2 步的 tag 列表（`--trees` 与后备脚本 `$tags`）与第 3 步例子里的 tag；⑦「核验记录」的 SHA 表加一列，并**新增一轮**（不覆盖旧轮） | **不会**（version 门对本文只查存在；counts 门只核计数） |
| 5 | `CHANGELOG.md` | 新增一条版本条目，写明「兼容区间扩到 rc.2」与本轮「验证」做了什么；即使不发新版插件也记一条 | 不会（docs 门只查字面转义 / 死链 / 死路径，不核版本号） |
| 6 | 触点表的计数副本 | 只有**触点集合本身变了**才动：计数门禁的单一来源 `scripts/known-counts.json` 里的 `hostContacts`（先改它，门禁会逼着文档一起改）、`docs/brand-persona.md` 里的引用。区间扩张本身不动它们 | 会（counts 门核「36 条触点」的声明位） |

改完跑 `node scripts/check.mjs`：version 门会把 `README.md` 与 `README.en.md` 两句都与声明逐字核对；但 `CHANGELOG.md` 里的版本句**version 门不查**，本文自己的版本行它也不查——docs / counts 两道门只管机械残渣与计数，不管版本号。所以上表要照着走，不能等门禁提醒。

### 5. 冒烟

改完声明再冒烟：它在新区间下全链路真装一遍收口——装前 preflight 应放行（本机版本已落进声明区间），装不上先回头查第 4 步的声明有没有真扩。用独立 `DSH_HOME`，别碰日常使用的 profile。仓库自带脚本，一条命令跑完（它同时是**发版前的硬步骤**：定位、断言口径与「为什么不进 CI」在 [CONTRIBUTING.md](../CONTRIBUTING.md) 的「发版前必跑：真装冒烟」，这里只把当例行核验用）：

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

## 核验记录

每改一次声明区间前后各核一轮。**细节不在这里复述**：每一轮当时的完整叙述都在 git 历史里（`git log -p docs/compatibility.md`），本表只留三样——核了什么、结论是什么、想复跑要什么条件。这样记录不随版本数无限膨胀，而结论与复跑条件一条不少。

### 2026-10-30 – 2026-11-04（历轮汇总）

**源码级区间（2026-10-30）**：9 个包的 5 个 tag 逐个比 tree SHA。取法即「例行核验」第 2 步那条脚本（现为无克隆后备，工具主路径见该步）；「同左」= 与 rc.1 同一个 SHA（不是「没测」）。

| 包 | tree SHA | 结论 |
|---|---|---|
| `packages/core/system-prompt/src` | `004ba79f1155e70d6106d57d18bde92408da3c97` | rc.1–rc.5 全同 |
| `packages/host/webserver/src` | `2a70b7add8775b3fe47724e34706317485298e6d` | 全同 |
| `packages/interaction/user-approval/src` | `2c3c6bcdcd5b1e7a57e09459dd71be2e8adf05fa` | 全同 |
| `packages/interaction/permission-presets/src` | `9c84caa30dbc0ab32d530217c10be26479c58f19` | 全同 |
| `packages/client/ui-settings/src` | `6bcf51fa271b5763ac4adf713a6a32087ab6bb73` | 全同 |
| `packages/client/ui-settings-general/src` | rc.1/rc.2 `e0ad312f5ae2b026c986ef908fda668016d6dd64`；rc.3–rc.5 `22c42682ba5fb15014c86caaabfeb4bb4c86bb58` | 唯一变更：`client/index.ts`（新增埋点 + 一行 `import type {}`），`settings.section` 槽位未动；该目录 22 文件里 21 个 blob 全同 |
| `packages/client/ui-permission-presets/src` | `71cf0cb4204e166c8dec3434681a9a52a0221966` | 全同 |
| `packages/boot/app-boot/src` | `14016c958ce4f6006933056a4863c5bebb348daf` | 全同 |
| `packages/boot/plugin-manager/src` | `90ef58695a4ebc4a076c4688b36529124fdfcf11` | 全同 |

**历轮汇总**

| 轮次 | 核了什么 | 结论 | 复跑条件 |
|---|---|---|---|
| 10-30 · 源码级区间 | 上面那张表 | 8 个包全同、1 个包在 rc.2→rc.3 变且只动埋点 → 「全系源码级核验」成立 | **本机可复跑**（例行核验第 2、3 步，gh api 后备命令） |
| 10-30 · rc.5 干净环境终验 | 远端重置后真装 → `--dump-config` 三入口、patch 仍 `[]` → 隔离 home 冒烟 → GUI 侧 `/enhance/api` 命中真实会话 | 装包、组合、冒烟通过；GUI 注入命中（当时有可用会话） | 前三步**可复跑**；GUI 那一环**不可复跑**（要桌面 GUI + 一次有余额的会话） |
| 10-31 · 远端全量重置后重装 | 杀进程 → 删 `.dsh`／安装根／卸载项 → 静默重装 rc.5 → 复对 SHA → 装包 → 冒烟 | SHA 9/9 一致；装包 exit 0；冒烟当时全过；空 patch 三种写法必败；组合树 `presets` 三档全表、不含 `defaultPreset` | 重置本身**不可复跑**（需可整机重置的测试机）；空 patch 探针**可复跑**（下面那段命令） |
| 11-02 · 36 条触点那一轮（1.2.0） | 宿主侧 asar 逐条核对新触点；远端真机端到端（双 profile 装包、设置页五组） | 契约假设全部成立；装配层验收在真机会话日志上成立（`custom` 第一句为自定义文本、宿主原句 0 命中；切回 `keep` 逐字回原句） | asar 核对**可复跑**（基准见下）；远端那轮**不可复跑**（桌面 GUI + 有余额的会话） |
| 11-02 · 1.2.1 收口轮 | 干净基线远端真装 1.2.1（**1.2.0 那轮的包装不含本轮新增的 `identityInstall` 与 `inject` 两路探针**） | 装包 exit 0；三入口齐；patch 仍 `[]`；远端 68 文件 sha256 前后无差异；冒烟当轮 38 条（现值以 `scripts/known-counts.json` 的 `smokeAssertions` 为准） | 装包**不可复跑**（需那台测试机）；冒烟**可复跑** |
| 11-03 · 市场安装路径（1.3.2） | 远端服务器上从**市场插件**（`dsh-market/dsh-market`）的界面安装与卸载本包（`@wufeng0105/dsh-enhance`） | **能装能卸**。此前 1.3.1 会「装上后立刻被装后校验判 broken 并删除」——根因在插件那一侧（`hasLoadableEntry` 把载体自身子路径的 patch 目标当独立包目录探测，上游 #1091），本仓以包根 `index.js` 绕行，bundle 门守着它不被删 | 需一台**能连市场插件**的远端机器；`--check` 证明不了这一环 |
| 11-03/04 · 真机桌面会话（rc.5） | 桌面端会话日志里的装配结果：内容边界文本有没有逐字进系统提示；品牌人设遮蔽有没有真的顶掉宿主自称句 | **两条都成立**：装配记录末尾逐字含内容边界那句；遮蔽后首句是部署人设句，宿主自称句在整份日志里 0 命中 | **不可复跑**（要桌面 GUI + 一次能跑通的会话）；同一轮的 headless 真会话仍被余额挡住，见下一行 |
| headless 真会话 · `hideHarness` | `dsh headless` 上的装配结果；`hideHarness` 在桌面 / web profile 上的效果 | **仍未验**：headless 一跑就 `QUOTA: Insufficient Balance`（余额 0）；`hideHarness` 那两段在桌面 / web 上也还没有基线——`headless` 组合里本来就没有 `webApp`，那两段注册不到 | **不可复跑**，缺**一次有余额的会话**（+ `custom`/`keep` 两份日志对照） |

### 2026-11-06（区间扩到 0.2.2-rc.1，1.3.4）

**源码级区间（9 包 × 6 tag）**：rc.1–rc.5 各包 SHA 与上表一致；`dsh-v0.2.2-rc.1` 上 9 个包全部有变更：

| 包 | 0.2.2-rc.1 tree SHA | 判定 |
|---|---|---|
| `packages/core/system-prompt/src` | `d7e1f19b76f0311ef7cd1e4c205082582104cb29` | waterfall 参数拆分（`PromptAssembly`→`PromptPresentation`，去 `tools`）；本仓不监听该事件；`section()`/`getSectionOrder`/顺序常量未动 → 不动接缝 |
| `packages/host/webserver/src` | `a7209956c08dde54a321d698a1052f0a2c7fba19` | 新增资源路由与 `readResource`；`register({kind:'exact', handler})` 原形保留 → 不动接缝 |
| `packages/interaction/user-approval/src` | `7ead3d1870a2b42116c4f489b06eda239f37413b` | `approval/request` 契约未动；政策存储改 projection 内部实现；`ask` 档提示句换措辞（本仓未引用旧句）→ 不动接缝 |
| `packages/interaction/permission-presets/src` | `d6fe7f3b77e30c1a5f0e91c9763963780f97dcda` | `session/created`→`agent/created`（与本仓同款）；档位与 policy 契约未动 → 不动接缝 |
| `packages/client/ui-settings/src` | `434f2a307d3a73d2af32d7d1ca52c81c3fd4dbf3` | 新增可选 `settings.section.icon` 槽；`settings.section` 契约未动 → 不动接缝 |
| `packages/client/ui-settings-general/src` | `ab7f6dbbe056f99e4d61115b64ef4f66e5cfd6dd` | 响应式布局、8 语言、导航图标改槽位化；`client/index.ts` 的 `apply`/`inject` 形状未动 → 不动接缝 |
| `packages/client/ui-permission-presets/src` | `84668cb3951cba97956d28d3847ab7ec702d0732` | 多语言与样式；显示契约未动 → 不动接缝 |
| `packages/boot/app-boot/src` | `6a2f8058f08fb5c008dd428b6d35d44bb2980298` | 新增 `dsh.bundle.platforms` 平台门禁（未声明该字段时全平台放行，本仓不声明）；official-bundles 外迁；`plugin-compatibility.ts` 与 `compatibility-preflight.ts` blob SHA 与 rc.5 一致 → 不动接缝 |
| `packages/boot/plugin-manager/src` | `a1e5a0702bc85016abd717b93b25deb874e6e933` | 版本列表/更新流/详情页/操作事件等增量功能；装后校验 `engines.dsh` 路径未动 → 不动接缝 |

38 个变更文件逐对拉 blob 读 diff，全部判定「不改到接缝」；本机 0.2.2-rc.1 的 asar 实扫 10 个文本文件含 `engines.dsh`，门禁逻辑在位。

**本机冒烟（0.2.2-rc.1）**：改动前先跑一遍作基线——装前 preflight 按旧区间拒装（预期，拒的就是声明本身）；进程内驱动真实插件入口 39/44 全过（section 注册与顺序、审批三态、路由、快照、检查四项、写档/移除全链路），5 个 FAIL 全部是「装进 profile」组、由旧区间唯一造成。声明扩到 `<0.2.2-rc.2` 后重跑冒烟 **44/44 全过**（一次性 `DSH_HOME`，CLI 即 0.2.2-rc.1 自带）。

| 轮次 | 核了什么 | 结论 | 复跑条件 |
|---|---|---|---|
| 11-06 · 0.2.2-rc.1 收口轮（1.3.4） | 触点重数 36；9 包 × 6 tag tree-diff + 38 文件逐对读 diff；asar 门禁在位；一次性 home 冒烟 44/44；**真机桌面会话装配层验收**（1.3.4 装进日常 desktop profile，重启后设置页「检查」**全部通过**——会话日志回读证实内容边界进了系统提示、品牌人设遮蔽按所选档生效） | 新区间「全系源码级核验」成立；装配层验收在 0.2.2-rc.1 真机上成立（rc.5 那轮之外的第二台真机证据）；本机 pnpm 11 的 24h 供应链冷却期（`minimumReleaseAge` 默认 1440 分钟）曾让市场暂不显示 1.3.4，用 profile 的 `minimumReleaseAgeExclude` 名单现成机制放行 | tree-diff 与读 diff **本机可复跑**（例行核验第 2、3 步，现工具主路径）；冒烟**可复跑**（`tools/smoke.ps1`）；桌面装配层验收**不可复跑**（要桌面 GUI + 一次能跑通的会话） |
| 11-06 · 工具化轮（P1/P2 落地后回放） | 流程工具化本身的一轮复核：触点重数仍 **36**（`node tools/contacts-count.mjs` 现场数，与单一来源对账 exit 0）；第 2 步 `node tools/compat-diff.mjs --trees`（6 tag）替代 54 次 gh api，9 包 SHA 表与上表归档值逐位一致；第 3 步主模式回放 rc.5→0.2.2-rc.1，`changed-files: 38`、SEAM-HIT/SKIM 预分类与人工轮「38 文件全部不改到接缝」的判定一致；缓存语义实证：tree 阶段零网络、blob 首读按需回源（lazy fetch）、缓存后死代理重跑 exit 0（离线） | 工具口径与人工轮同源，「例行核验」第 2/3 步自此以工具为主路径（gh api 降为无克隆后备）；流程顺序重排为 4 改声明 → 5 冒烟（先扩声明再真装，冒烟不再死于装前 preflight 的旧区间拒装） | **本机可复跑**（判据：contacts-count 报 36、`--trees` 与主模式回放 exit 0、`--self-test` exit 0；`node scripts/check.mjs` 七门全绿）；复核指针 `.zhll/exec-WP1.md` / `.zhll/exec-WP2.md` 与 `.zhll/gates/wp1-*.log` / `.zhll/gates/wp2-*.log` |

**三条容易忘的边界**

- **本机 asar 不是原封发行件**：与同目录 `app.asar.bak-2026-10-31T09-42-57-481Z` 等长而内容差一个条目（`dsh-sandbox-windows-acl` 的 `types-*.js` 一行等长替换，改动者不是本插件）。它与核过的四个包无关，结论不变；要干净基准先重装。
- **GUI 侧版本读取退化**：CLI 进程读得到本机版本，GUI 插件进程读不到，页面照实写「读不到本机版本」、不判红。
- **设置页四项**：名字与顺序、四项取值都有断言（冒烟 `3.4.1`–`3.4.6`）；但**没有 GUI / 浏览器证据**——只装了 `headless`，组合树里没有 web 服务宿主。

空 patch 的复跑命令（一次性 `DSH_HOME`，不碰日常 profile）：

```powershell
$cli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = Join-Path $env:TEMP 'dsh-empty-patch-probe'
& $cli plugin --profile t list                        # 先初始化 profile
$patch = Join-Path $env:DSH_HOME 'profiles\t\cordis.patch.yml'
Set-Content -LiteralPath $patch -Value '' -NoNewline   # 再试 "`n" 与 "# comment`n"
& $cli --profile t --dump-config                      # 期望 exit 1：overlay … must be a top-level YAML array
Set-Content -LiteralPath $patch -Value "[]`n" -NoNewline
& $cli --profile t --dump-config                      # 对照：exit 0
Remove-Item -LiteralPath $env:DSH_HOME -Recurse -Force
```

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
