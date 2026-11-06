# 宿主接缝（触点表）

> 体检资产。这份文档记录**我们依赖宿主的哪些接缝**、怎么重数、上游哪个包对应哪一组。它不挂在任何版本声明上：声明机已拆（见 [`CHANGELOG.md`](../CHANGELOG.md)），接缝清单照旧维护——DSH 出一个新版，跑一遍例行核验，核的就是这些接缝有没有动。
>
> 整份核验流程（tree-diff、读 diff、改声明、冒烟）仍在 [`docs/compatibility.md`](compatibility.md) 的「例行核验」；本文只承载触点表与它的数法。

## 宿主触点

每一条能力都挂在宿主的一个接缝上。例行核验，核的就是这些接缝有没有动。下面这张表按破坏面分组（完整清单由代码反推而来，按表内独立触点项计共 36 条；**36 是本表口径下的条目数，不是 grep 命中数**——从引用点归并成条目的规则见本文「数法」一节；分组只求「宿主变了坏什么」一眼可读）：

| 组 | 触点（代码侧入口） | 宿主变了坏什么 |
|---|---|---|
| cordis 插件 API | 入口形状（`name`/`apply`/`inject`）、`systemPrompt.section()` + `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')`、`ctx.effect`、运行期 `ctx.inject(['webServer'])`、`web.register({kind:'exact'})` 路由、`ctx.on('approval/request')` waterfall、`settings.section` 槽位（`ctx.slots.inject` + `register`）、`ctx.on('agent/created')` + `agent.ctx.inject()` 的 agent 作用域同名段遮蔽（品牌人设） | 注入消失 / 审批接管失效 / 设置页分节挂不上 |
| 浏览器半装载 | `window.__ModuleLoader__.load({id, factory})`、factory 参数 `require('react')`、`dsh.client` 发现规则（`exports["./client"]` + 裸包名行才挂浏览器半） | 设置页整个消失（服务端功能仍在） |
| 宿主视觉 token | 23 个 `--dsw-*`/`--ds-*` 变量、`body[data-ds-dark-theme]` 属性钩子、排版刻度 | 页面不可读 / 深色模式错乱 |
| profile 配置与解析 | `profileContext` 形状（`patchPath`）、`DSH_PROFILE_DIR` + `cordis.patch.yml` 文件名、`profiles/<name>/` 布局、patch 顶层数组 + `config` 整块替换 + `- id: permission` 行、`presets`/`defaultPreset` 契约、档位菜单显示契约（表外档名纯文字行）、宿主侧档位中文名文案、审批策略 `approval/policy` 取 `never` 时前置拒绝 | 写档 409 或写坏用户配置 / 播种错开关档（默认档位的审批策略是 `never` 时，种「自动同意」会被宿主前置拒绝，须种「先问我」） |
| 会话日志探针 | `sessions/<workspace>/<session>/session.v4.jsonl.zstd` 文件名与两层目录、zstd 多帧追加（宿主 Node **≤24.21** 的 `zstdDecompressSync` 只解第一帧，**24.22.1 起解全**；所以探针按魔数逐帧切，不赌版本）、`"system-prompt"` 行标记；另有正反两个探针（`sessionContains` 判「该在的文本在不在」，`sessionOmits` 判「不该在的文本还在不在」——**两者极性不同**：存在性任一命中即证明，缺失性只看**最新一份**含 `"system-prompt"` 装配记录的日志，按 mtime 倒序取第一份，不能扫「最近 N 份都不含」，否则切换设置前的旧日志会把刚生效的遮蔽永久判红） | 设置页的检查项里 `inject` 那一项永远红，或品牌人设遮蔽失效却全绿 |
| 版本探测链 | `DSH_VERSION` → `@deepseek-ai/dsh-package-manifest` → 安装作用域核心包 → `app.asar` 头布局 → `LOCALAPPDATA` 安装根 → `dsh-runtimes/<runtime>/runtime.json` | 版本行退化成「读不到本机版本」（其余功能不受影响） |
| home | `DSH_HOME` / `~/.dsh`、`<home>/enhance/` 数据目录 | 自家数据无处落 |
| 装载与冒烟工具链 | bundle patch entry 解析规则（name 相对本包目录）、`dsh` CLI 与安装根、profile `package.json` 装载痕迹 | 装不上 / 例行核验流程断 |

**插件加了新功能就会带来新触点**，所以例行核验的第一步永远是重数这张表。

## 数法（重数触点）

从代码 grep 宿主引用重推这张表，不抄旧表。三步，照着走就能得出「是不是还是 36 条」。

### a. 列引用点

在我们自己的源码上扫（`enhance-scope/`、`shared/`、`ui/` 都在内），起点表达式：

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

### b. 归并成条目

五条规则，从上往下套：

1. **一个接缝一条**：我们这侧只要改一处调用就都得改的，算一条；
2. **并列项各算一条**：同一行里以「、」分隔的并列项，各算一条；
3. **引用点先归并再计**：同一机制的多个调用点合并成表里那一条——「23 个 `--dsw-*`/`--ds-*` 变量」在代码里是 23 个名字，在表里仍是一条；`ctx.on` 的若干处调用也归并到各自的条目里；
4. **链按环拆**：`→` 连成的链，每一环各算一条——「版本探测链」那一行按 6 环算 6 条，不是 1 条；
5. **新能力就新增条目**：加了新功能带来的新接缝必须新增一条，不许并进旧条目充数。

### c. 对数

按 b 数：除「版本探测链」外的其余 7 行按「、」共 30 段，「版本探测链」按 `→` 拆成 6 条，30 + 6 = **36**。grep 命中的是**引用点**（通常上百处），36 是归并后的**条目数**；两个数不相等是正常的，相等反而说明没归并。数出来不是 36 就先怀疑表：漏了新触点，或把两件事并成了一条——改表，别改数。计数门禁把这个数当**可机算值**核（`scripts/known-counts.json` 的 `hostContacts`，`kind` 是 `computed`）：`tools/contacts-count.mjs` 按本节 a/b/c 的口径现场数并与单一来源对账，`tools/counts-check.mjs` 再拿它核各文档的声明位。它曾标 `manual`（理由是「口径是散文公式，机算不了」），2026-11-02 证伪后改成机算——真正重数还是按 a/b/c 三步走。

## 上游包对应关系

上游包对应关系（tree-diff 盯这些）：cordis API 家族的接缝分散在 `packages/core/system-prompt/src`、`packages/host/webserver/src`、`packages/interaction/user-approval/src`；settings.section 槽位契约在 `packages/client/ui-settings/src`（`contract/slots.ts`），渲染它的壳是 `packages/client/ui-permission-presets/src` 之外的 `packages/client/ui-settings-general/src`——`ui-settings-models`/`ui-settings-plugins` 是同槽位的兄弟消费方，宿主改它们不破坏我们，不进核验清单；权限预设与显示契约在 `packages/interaction/permission-presets/src` 与 `packages/client/ui-permission-presets/src`；engines 门禁与装载预检在 `packages/boot/app-boot/src` 与 `packages/boot/plugin-manager/src`。其余触点（会话日志格式、asar 头、CSS token、env 量）没有可直接 tree-diff 的上游包位置，靠冒烟与真机核对兜底。

## 36 这个数的机器来源

**单一来源**是 `scripts/known-counts.json` 的 `counts.hostContacts`：`value` 为 36，`kind` 为 `computed`（精确值，文档里写的数必须与它相等）。

三处一起把「36」钉住，谁都不许自证：

1. **现场数**：`node tools/contacts-count.mjs` 读本文件的「## 宿主触点」节，按「数法」a/b/c 的口径数分组表第二列（其余行按「、」分段、`版本探测链` 按 `→` 拆），得 36 再与单一来源对账；表读不出来、节找不到、数与来源不等，一律判红（exit 1），不许静默通过。
2. **文档声明位**：`tools/counts-check.mjs` 把本文当作「36 条」的必需声明位（`docs/host-seams.md` 的「共 NN 条」），同时扫 `docs/**` 与 README 里所有触点计数声明，任何一处与单一来源不等都判红。
3. **门禁串联**：`scripts/check.mjs` 的 docs 门同时跑上面两个工具，任一个非零退出，docs 门红。红态本身由 `--self-test` 的 `counts-check red` 负例钉住（把本文上面那句声明里的数改小 1，docs 门必须变红）。

改口径的代价写在明处：触点集合真变了，先改 `scripts/known-counts.json`，再让门禁逼着文档一起改；**只改数不改表、或只改表不改数，都过不了门**。
