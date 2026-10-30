# DSH 版本支持

**适用版本**：DeepSeek Harness `0.2.1-rc.1`–`0.2.1-rc.5`（`0.2.1-rc.3` 实测，全系源码级核验）。

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
    "tested": "0.2.1-rc.3",
    "basis": "source-level",
    "verifiedAt": "2026-10-30",
    "doc": "docs/compatibility.md"
  }
}
```

README 里那句适用版本是这份声明的派生文本，`node scripts/check.mjs` 要求两处逐字一致；它同时核对声明形状（区间解析与成员判定在 `shared/compat.mjs`，唯一实现），并在探测到本机 DSH 版本不在区间内时判红，提示先跑本文的例行核验再扩区间。

为什么 README 不能是第二权威：散文会被人顺手改，声明不会。两处各写各的，就会「改了声明忘改 README」与「改了 README 忘改声明」各错一次。为什么是区间不是版本数组：宿主读的就是这个字段——见下一节。

## 宿主怎么执行这条声明

`engines.dsh` 不是写给自家门禁看的自留地，宿主在三个时机读它并做 semver 匹配（无该字段时回退读 `peerDependencies` 里的 `@deepseek-ai/dsh*`）：

| 时机 | 宿主行为 |
|---|---|
| `dsh plugin add` 装前 | preflight 拉取声明，不兼容直接拒装（exit 1，`nothing was installed`） |
| pnpm 装完后 | 校验 `node_modules/<pkg>/package.json`，不兼容回滚重装旧版本（exit 1） |
| profile 启动装载 | 每个插件行过预检，不兼容则该行被禁用、插件根本不被 import |

唯一放行通道是精确版本豁免：profile 里的 `compatibility.json` + `dsh plugin allow-version <pkg@ver> --dsh-version <ver> --accept-risk`。

依据（2026-10-30 取证，可复跑）：上游 `deepseek-ai/deepseek-harness` tag `dsh-v0.2.1-rc.5` 的 `packages/boot/app-boot/src/plugin-compatibility.ts`（`unmetRequirements()` 逐字读 `engines.dsh` 并 `satisfies` 匹配）、`plugin-manager/src/operations.ts`（装前 preflight 与装后回滚）、`app-boot/src/compatibility-preflight.ts`（启动预检）；同路径文件 rc.1 与 rc.5 的 blob SHA 完全一致——门禁 rc.1 就定型，rc.5 未改。本机 rc.3 的 `app.asar` 里打包着同一套逻辑（`engines.dsh` 73 处命中，含错误串 `Plugin manifest engines.dsh must be a string`）。官方 e2e（`plugin-compatibility.expected.e2e.ts`）断言了拒装、拒启动、豁免后放行的全流程。

由此两条纪律：

- **声明写错不是小事。** 区间写窄，宿主直接拒装；写宽，宿主放行未验版本。所以扩区间的唯一途径是先过例行核验，两端一起动。
- **声明与门禁同源。** `scripts/check.mjs` 的 version 门禁、设置页版本行、README 适用句，三处都从 `shared/compat.mjs` 读同一条声明，不许两处各自维护。

## 为什么是有界声明

宿主每个 rc 都可能在动我们依赖的接缝，「最优兼容」没有解。所以这里只声明核验过的范围，并给出一个常数流程：新版本发布后跑一遍，通过了就把版本号并进区间。声明是变量，流程是常数。

## 宿主触点

每一条能力都挂在宿主的一个接缝上。例行核验，核的就是这些接缝有没有动。下面这张表按破坏面分组（完整清单由代码反推而来，35 条；分组只求「宿主变了坏什么」一眼可读）：

| 组 | 触点（代码侧入口） | 宿主变了坏什么 |
|---|---|---|
| cordis 插件 API | 入口形状（`name`/`apply`/`inject`）、`systemPrompt.section()` + `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')`、`ctx.effect`、运行期 `ctx.inject(['webServer'])`、`web.register({kind:'exact'})` 路由、`ctx.on('approval/request')` waterfall、`settings.section` 槽位（`ctx.slots.inject` + `register`） | 注入消失 / 审批接管失效 / 设置页分节挂不上 |
| 浏览器半装载 | `window.__ModuleLoader__.load({id, factory})`、factory 参数 `require('react')`、`dsh.client` 发现规则（`exports["./client"]` + 裸包名行才挂浏览器半） | 设置页整个消失（服务端功能仍在） |
| 宿主视觉 token | 23 个 `--dsw-*`/`--ds-*` 变量、`body[data-ds-dark-theme]` 属性钩子、排版刻度 | 页面不可读 / 深色模式错乱 |
| profile 配置与解析 | `profileContext` 形状（`patchPath`）、`DSH_PROFILE_DIR` + `cordis.patch.yml` 文件名、`profiles/<name>/` 布局、patch 顶层数组 + `config` 整块替换 + `- id: permission` 行、`presets`/`defaultPreset` 契约、档位菜单显示契约（表外档名纯文字行）、宿主中文档名文案、`never` 策略前置拒绝 | 写档 409 或写坏用户配置 / 播种错档（never 机器上种 `allow` 会被宿主前置拒绝，须种 `ask`） |
| 会话日志探针 | `sessions/<workspace>/<session>/session.v4.jsonl.zstd` 文件名与两层目录、zstd 多帧追加（宿主 Node 只解第一帧，须按魔数逐帧解）、`"system-prompt"` 行标记 | 「检查」的 inject 项永远红 |
| 版本探测链 | `DSH_VERSION` → `@deepseek-ai/dsh-package-manifest` → 安装作用域核心包 → `app.asar` 头布局 → `LOCALAPPDATA` 安装根 → `dsh-runtimes/<runtime>/runtime.json` | 版本行退化成「读不到本机版本」（其余功能不受影响） |
| home | `DSH_HOME` / `~/.dsh`、`<home>/enhance/` 数据目录 | 自家数据无处落 |
| 装载与冒烟工具链 | bundle patch entry 解析规则（name 相对本包目录）、`dsh` CLI 与安装根、profile `package.json` 装载痕迹 | 装不上 / 例行核验流程断 |

**插件加了新功能就会带来新触点**，所以例行核验的第一步永远是重数这张表（从代码 grep 宿主引用重推，不抄本文）。

上游包对应关系（tree-diff 盯这些）：cordis API 家族的接缝分散在 `packages/core/system-prompt/src`、`packages/host/webserver/src`、`packages/interaction/user-approval/src`；settings.section 槽位契约在 `packages/client/ui-settings/src`（`contract/slots.ts`），渲染它的壳是 `packages/client/ui-permission-presets/src` 之外的 `packages/client/ui-settings-general/src`——`ui-settings-models`/`ui-settings-plugins` 是同槽位的兄弟消费方，宿主改它们不破坏我们，不进核验清单；权限预设与显示契约在 `packages/interaction/permission-presets/src` 与 `packages/client/ui-permission-presets/src`；engines 门禁与装载预检在 `packages/boot/app-boot/src` 与 `packages/boot/plugin-manager/src`。其余触点（会话日志格式、asar 头、CSS token、env 量）没有可直接 tree-diff 的上游包位置，靠冒烟与真机核对兜底。

## 例行核验（新 rc 发布后，约 15 分钟）

### 1. 重数触点

从代码 grep 宿主引用重推上表（变量步骤）：插件加了新功能会带来新触点，抄旧表会漏。

### 2. 逐包 tree-diff

逐包比 tree SHA，不要信 GitHub compare API 的文件列表——它的列表上限 300 条，超了会静默截断，用它做触点核验会漏包。

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'   # 需要时
$repo = 'deepseek-ai/deepseek-harness'
foreach ($pkg in @(
  'packages/core/system-prompt/src',
  'packages/host/webserver/src',
  'packages/interaction/user-approval/src',
  'packages/interaction/permission-presets/src',
  'packages/client/ui-settings/src',
  'packages/client/ui-settings-general/src',
  'packages/client/ui-permission-presets/src',
  'packages/boot/app-boot/src',
  'packages/boot/plugin-manager/src'
)) {
  foreach ($tag in @('dsh-v0.2.1-rc.1', 'dsh-v0.2.1-rc.5')) {
    $sha = gh api "repos/$repo/git/trees/${tag}:${pkg}?recursive=1" --jq '.sha'
    "$tag $pkg $sha"
  }
}
```

首尾 tag 的 SHA 全同，这个触点没动。有变更不要只看数量，要拉 diff 读内容：埋点、注释、内部重构不影响接缝，改到 `ctx.slots`、config 形状或装载协议才要处理。

### 3. 有变更时读 diff

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$repo = 'deepseek-ai/deepseek-harness'
# 列文件级 sha
gh api "repos/$repo/git/trees/dsh-v0.2.1-rc.1:packages/client/ui-settings/src?recursive=1" --jq '.tree[] | "\(.path) \(.sha)"'
# 取某个 blob 的原文（base64）
gh api "repos/$repo/git/blobs/<sha>" --jq '.content'
```

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

第 3 步是进程内而不是 `dsh headless`，原因在凭据：真会话要模型凭据，而凭据在用户的 `<DSH_HOME>/.credentials.yaml` 里，为冒烟去复制用户凭据不可接受。所以「注入是否真的进提示词」用捕获 `systemPrompt.section()` 的 `text()` 返回值来验——宿主拿到的就是同一个返回值，这条路径与真会话同源。

手动做也是这几步：

```powershell
$cli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = Join-Path $env:TEMP 'dsh-smoke-home'
& $cli plugin --profile smoke add <本仓库路径>
& $cli --profile smoke --dump-config
```

真机上看一眼：装好启动、发一条消息、在设置页点「开始检查」，四项都应是 ✓ 或 –；再点「写入 Enhanced 档」并重启，档位菜单、`/permission`、设置页默认档下拉三处都应出现纯文字的 **Enhanced**；点「移除 Enhanced 档」并重启，三处消失。

### 5. 改声明

核验全过之后：`package.json` 的 `engines.dsh` 区间两端一起动（新版本并进范围），`dsh.compatibility.tested` / `verifiedAt` 更新为本次实测值；README 的适用版本句由声明派生，必须逐字一致。改完跑 `node scripts/check.mjs`，它会把这两处连同 `VERSION` 一起核对。

## 本次结果（2026-10-30，范围 rc.1–rc.5）

| 包 | 结论 | rc.1 tree SHA | rc.5 tree SHA |
|---|---|---|---|
| `packages/core/system-prompt/src` | 全同 | `004ba79f1155e70d6106d57d18bde92408da3c97` | 同左 |
| `packages/host/webserver/src` | 全同 | `2a70b7add8775b3fe47724e34706317485298e6d` | 同左 |
| `packages/interaction/user-approval/src` | 全同 | `2c3c6bcdcd5b1e7a57e09459dd71be2e8adf05fa` | 同左 |
| `packages/interaction/permission-presets/src` | 全同 | `9c84caa30dbc0ab32d530217c10be26479c58f19` | 同左 |
| `packages/client/ui-settings/src` | 全同 | `6bcf51fa271b5763ac4adf713a6a32087ab6bb73` | 同左 |
| `packages/client/ui-settings-general/src` | rc.1≡rc.2；rc.3 起变，rc.3≡rc.4≡rc.5 | `e0ad312f5ae2b026c986ef908fda668016d6dd64` | `22c42682ba5fb15014c86caaabfeb4bb4c86bb58` |
| `packages/client/ui-permission-presets/src` | 全同 | `71cf0cb4204e166c8dec3434681a9a52a0221966` | 同左 |
| `packages/boot/app-boot/src` | 全同 | `14016c958ce4f6006933056a4863c5bebb348daf` | 同左 |
| `packages/boot/plugin-manager/src` | 全同 | （blob 级对照，见 `docs/verification/2026-10-30-touchpoints.txt`） | 同左 |

逐文件比对 `ui-settings-general/src`：只有 `client/index.ts` 变了，diff 是新增 `productAnalytics.track('code_work_view_toggle', …)` 埋点与一行 `import type {}`，**`settings.section` 的槽位机制未动**。原始输出见 `docs/verification/2026-10-30-touchpoints.txt`。

rc.5 上还补了一次运行期实测：干净安装 `0.2.1-rc.5`，装包后 `--dump-config` 三个入口齐全，隔离 home 冒烟 30 条断言全过，真启动一次只报余额不足（`QUOTA`），没有插件相关报错。

## 两个与「写入 Enhanced 档」按钮直接相关的宿主事实

**patch 的 `config` 是整块替换，不是深合并。** 在 profile patch 里写 `- id: permission` 加一条 `enhanced`，基础组合包的 `read-only` / `workspace-write` / `danger-full-access` 会全部消失（`dsh --profile <p> --dump-config` 可复现）。所以设置页写档时写的是完整档位表：宿主基础三档 + enhanced。

**`enhanced` 是合法的自定义档名。** 保留名只有 `custom` 与 `auto`；`approval: ask` 合法；未知 kebab-case 档名在档位菜单里渲染成 Title Case 的纯文字行，字形表里没有它——这不是缺陷，是宿主的显示契约。

## 设置页那行版本号怎么读本机版本

设置页顶部显示 `增强 <本包版本> · DSH <本机版本> · 已验 <范围>`。本包版本与范围读自 `package.json` 的 `version` 与 `engines.dsh`（经 `shared/compat.mjs` 派生）；本机版本按下面的顺序探测，读不到就写「读不到本机版本」，不猜：

1. `DSH_VERSION` 环境变量（显式覆盖，脚本与测试用）；
2. 宿主的 `@deepseek-ai/dsh-package-manifest` → `getDshRuntimeVersion()`；
3. 安装作用域里的核心包（`@deepseek-ai/dsh-base` 等，版本号与产品同号）；
4. 桌面版装机根的 `app.asar` 清单（只读头里的 `package.json` 条目，不解包、不写盘、不派生任何产物）；
5. `<home>/dsh-runtimes/<runtime>/runtime.json` 的 `desktopVersion`。

rc.5 上的实测：第 2、3 条在 profile 插件里分别报 `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`，第 5 条的目录在没跑过带工具的会话时不出现，只有第 4 条稳定可用。这条只读路径是 1.1.0 唯一新增的宿主耦合；宿主哪天改掉 asar 头布局，它会自动退化成「读不到本机版本」，不影响注入、审批与写档。

## 已知边界

- **不拿宿主安装产物做派生。** 版本行读装机根的元数据，是只读；不解包、不写盘、不生成派生件。图标与派生件永久不做。
- **不覆盖 `0.2.2-alpha` / `master`。** master 自 2026-10-28 起有一次 context-menu 槽位重构，动过 `ui-permission-presets`；转型后我们对它只剩显示契约依赖，不是补丁。风险降级，但不是零。
- **不建 CI 版本矩阵、不做 semver 求解、不预适配。** 「最优兼容标准」无解，不追求：维护模型 = 常数流程（本篇）+ 一条随版本更新的声明（`engines.dsh`）。
