# 品牌人设

**目标**：**在不接管整份系统提示词的前提下，让模型不再把 DeepSeek Harness 当作自己的身份说出来。**

要动的是 harness 自身自指的 **3 个名字（共 5 个注册项）**：开场那句自称（①），以及两段提到它名字的说明（② 实现目录、④ 界面）。「声明层」的准确定义见 `docs/terminology.md`。这一段话是后面所有取舍的准绳——方案、开关、代价都拿它量。

**做法**：在 agent 作用域内按名遮蔽这 3 个名字；只改声明层，其余段落逐字节保留，存盘即生效、一键退回。

这篇文档是这个功能的契约：解决什么、什么算成、为什么用「按 agent 遮蔽同名段」而不是装配瀑布、代价与边界、DSH 升级后核哪一条。落地步骤在最后一节。

## 1. 它是什么，以及不是什么

DeepSeek Harness 每次请求前现场拼一份系统提示。这份提示以一句产品声明开头：

```text
You are an AI agent powered by DeepSeek Harness.
```

「品牌人设」让这一句在本插件作用域内可控：保留、去掉、或换成你自己的。它同时可以隐藏另外两段提到宿主名字的内容：`harness:source` 的 checkout 说明、`app:web-surface` 的 Web GUI 说明——这两段各自有一个 section 和一条 runtime context，合起来 4 个注册项；加上 ① 那一项，全功能一共 **5 个注册项、落在 3 个名字上**。

**它不是完整白标，而且「去品牌」的可达范围是有边的。** 下面是模型与用户实际能看到品牌的地方，以及本功能管不管——这句话原来只写「不是完整白标」，太含糊：

| 位置 | 载体 | 本功能 |
|---|---|---|
| system 节点 · 自称句 | `harness:identity` section | **管**（三态） |
| system 节点 · 部署人设（**含真实模型名**） | `deployment:persona-prefix`，宿主配置项 `personaPrefix`，默认 `You are a coding agent powered by the {{model}} model.`（`{{model}}` 插值成实际模型，如 `deepseek-flash`） | **不管**——它是**部署方**的旋钮，宿主用 `personaPrefix` 明确留给了部署方（`dsh-base` 设空串，web / headless / acp / sdk-app 各设各的，`dsh-sdk-minimal` 读环境变量）。插件去遮它会把 `{{model}}` 冻住，换模型后模型自述错型号 |
| system 节点 · 实现目录说明 | `harness:source` section | **管**（开关） |
| system 节点 · 界面说明 | `app:web-surface` section | **管**（开关） |
| user 快照 · 两条 runtime context | 安装路径 / GUI URL | **管**（开关，成对） |
| `DSH` 缩写 | `dsh-sandbox-policy` 的 runtime context（`Current DSH file policy: …`） | **不管** |
| 界面侧栏品牌、`productTitle` | 宿主客户端槽位与硬编码 | **不管**（本轮范围外，见「不做什么」） |
| 工具 schema 里的 `DSH` | `dsh-tool-cordis` 等 | **不管** |

**这张表就是「白标能到哪一步」的答案**：本插件只覆盖 harness 的自指。**只去掉 ① 不等于白标**——下一句仍是 `You are a coding agent powered by the deepseek-flash model.`（真机会话日志实测），那一句归部署方配 `personaPrefix`。

宿主配置里的官方开关 `includeHarnessIdentity: false` 是另一条路：宿主 README 对它的措辞是「仅当兼容性部署**自己拥有完整系统提示词**时才设为 false」（`Set false only when a compatibility deployment owns the complete system prompt`）。机制上它**只省略那一句固定开场白**，所以关掉之后那一段就没人补——用它等于把整份提示词的责任接过来。本功能走的是有界的那条。

**它也不保证「模型再也不会说自己是 DSH」。** 训练先验里就有这个名字，去掉声明能大幅压低，不能归零。产品文案不要承诺「彻底去品牌」。

## 2. 要解决什么

一个具体故障：产品换了皮，模型仍张口就说自己是 DSH。

这句话被用在三类场合：直接回答「你是谁」、解释自身能力时带出产品名、用户提到 DSH 时确认自己属于它。对终端用户是品牌泄漏。

修法不能是改宿主文件：那会让每次升级失效，也打破本仓「除声明层外，宿主提示词一个字节不动」的承诺。

### 2.1 「去品牌」和「过网关」是两件事，别并成一件

早先的讨论把它们混成过一句「去掉品牌就顺带解决了指纹」。**这是错的**，写清楚，免得下游按错的前提做承诺。

上游网关的内容过滤有一份实测规则表（来源是相邻项目 `_xdpool-local-layer/dsh-xdpool` 的 `src/upstream.ts`，配 `tests/system-fingerprint.test.ts` 与三次 400/11128 的时间线）：

| 规则 | 验证过的最小修法 | 与品牌的关系 |
|---|---|---|
| `powered by DeepSeek Harness` | → `running on DeepSeek Harness` | **保留品牌名** |
| `DeepSeek Harness Web GUI` | → `DeepSeek Harness web interface` | **保留品牌名** |
| `Relative paths resolve from the workspace root` | → `Relative paths are resolved against the workspace root` | **与品牌无关** |

三条读出来的结论：

1. 网关要的是**那串字换掉**，不是品牌消失——前两条的最小修法都留着 `DeepSeek Harness`。
2. 第三条由 `@deepseek-ai/dsh-file-reference` 供给、由 `dsh-file-reference-local` 注册进 section `context:file-reference`（order 900，仅当 `read` 工具在）。**它与品牌毫无关系，所以无论怎么去品牌，都过不了网关。**
3. 网关只扫 `system` 与 `assistant` 两个角色的消息；runtime context 是 user 角色的快照，**不在扫描范围内**。所以「两条 context 必须成对处理」是为了**去品牌**，不是为了过指纹。

**本功能解决「模型自称」，不解决「过网关」。** 过网关是那条独立规则的事，本仓不是责任方，也不替它做承诺。

（网关判定来自上面那份实测记录，本仓无法复现——这里写的是「依据在哪」，不是「本仓已验证」。）

## 3. 做到什么算成

| # | 验收 | 怎么验 |
|---|---|---|
| 1 | 三态可选：保留 / 去掉 / 自定义 | 设置页切换后，最新一条 `system/message` 的第一句就是所选结果 |
| 2 | 附带开关：同时隐藏宿主说明 | **先打开 `hideHarness=true`**，且 `identity` 为 `remove` 或 `custom`（自定义文本本身不含该名）时，**system 节点**里 `DeepSeek Harness` 出现 0 次。这个前置条件不能省：`harness:source` 段文本自身就含该名，而它只在 `hideHarness=true` 时才被遮蔽——开关关着时该计数必然非 0。两条 runtime context 也一并消失（它们既不在 system 节点里，也在同一个开关下成对处理，单独验） |
| 3 | 随时退回原样 | 选回「保留」后，**最新一条** `system/message` 的**第一句逐字回到宿主原句**。注意这条比的是**同一配置下的基线**：默认 `contentScope=true` 会在尾部追加一段，所以整条文本的哈希与「未装本插件时」必然不同——要比哈希，基线必须取自**同样开着 `contentScope`** 的未装态（或先关掉 `contentScope` 再比）。历史节点不会被回改，不与历史比 |

自定义文本另有一条验收：文本里含 `{{x}}` 或落单的 `{{` 时，装配不抛错（见「它长什么样」的 `interpolate: false`）。

## 4. 不做什么

| 不做 | 理由 |
|---|---|
| 改 persona 那句 `You are a coding agent powered by …` | 它由宿主按真实模型名插值（换模型就变），改它等于让模型自述错误型号 |
| 改工具描述里的品牌 | 工具 schema 在 `request/header.tools`，不在 sections 里；动它会同时改 header 与缓存形状 |
| 改宿主界面上的产品名、图标 | **本轮范围外**。宿主把侧栏品牌做成了 single slot，官方填充包的 README 明写「使用其他品牌的部署应提供替代品牌包」——宿主**期待**它被替换，所以这不是「打包层资源」（本仓已有浏览器半，技术上够得着）。写成范围外，不是写成做不到 |
| 改写已有会话的历史提示词 | 改写只对新装配生效；日志里的历史是事实 |
| 加第 5 个检查项（v1） | 检查页**仍是四项**，键与标题都不增删。但品牌人设**已合进 `inject` 那一项**验，不再是「只有验收 #1/#2」：`custom` 要命中 `identity.txt` 的文本、`remove` 不得再出现宿主原句、`keep` 这一路不判（记 `applies: false`，不是失败）。另有一条**可发现性**出口：装没装上由状态快照的 `identityInstall` 与设置页那一行如实说明 |

## 5. 为什么是「按 agent 遮蔽同名段」

本插件现有能力都挂在宿主接缝上。要把全局注册的 `harness:identity` 换掉，先看宿主给的是什么形状的机制谱。官方口径是一句**强度谱**（不是「两条路」），完整原文如下——**注意它排的是「介入装配管线的强度」，`ctx.tools.guard()` 这一级不能省**：

> **Extension points are shared; use the weakest mechanism that suffices.** From weakest to strongest: `ctx.tools.restrict()` can only remove tools; `ctx.tools.guard()` can only deny; waterfall listeners can rewrite and depend on registration order; `system-prompt/assemble` replaces the whole assembly. The stronger the mechanism, the more of other plugins' contributions you must preserve.
> —— `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`

**这张谱上没有「同名段遮蔽」这一项。** 遮蔽不在这根轴上——谱排的是「介入装配管线的强度」，遮蔽是**作用域维度**（近作用域同名项覆盖外层同名项），两者不同轴。所以本功能不是「在谱上挑了最弱的一级」，而是**选了谱之外的另一种机制**；「用最弱机制」这条官方原则对它只构成方向性约束（别去碰瀑布），不构成排序依据。

同一份文件还写明了**禁止**的范围，条件完整保留：**不要**监听 `system-prompt/assemble` 去增删工具或文本（`Do not listen to system-prompt/assemble to add or remove tools or text.`）——禁止的是「增删 tools/text」这一用法，不是所有用量。本功能不是瀑布监听器，落在允许侧；同一份文件另外推荐「用 `ctx.systemPrompt.section()` 加提示词文本」与「在 `agent/created` 里往 `agent.ctx` 注册 per-agent 行为」，正是本功能的做法。

「同名段遮蔽」是宿主**明确支持**的能力，但**它的出处不是 practices.md**（那份文件全文没有 shadow/override 字样）。出处是宿主自己的 README 与 JSDoc：

- `@deepseek-ai/dsh-system-prompt/README.md`：「Agent-scoped contributions override same-named global defaults without affecting other agents.」；「registering through `agent.ctx` affects that agent alone and shadows a same-named global.」；「creator plugins may register agent-scoped shadows」
- 同包 `lib/index.js` 的 JSDoc：「A scoped section shadows a global section with the same name」
- `@deepseek-ai/dsh-scope/README.md`：「`merge()` materializes insertion-ordered named shadows along the scope chain」

宿主自己的**两个**使用实例（不是三个——第三项是报错串，见下）：

| 先例 | 做法 |
|---|---|
| `@deepseek-ai/dsh-persona` | preset 内用同名 `deployment:persona-prefix` 遮蔽部署人设；挂到全局才会撞名报错。其 JSDoc 自己写明「Mounted inside an agent preset it shadows the deployment persona for that one session, **exactly like the per-child persona `dsh-subagent` installs**」 |
| `@deepseek-ai/dsh-subagent` | 在子 agent 的 `childCtx` 里注册同名 `deployment:persona-prefix` |

**第三项不是先例，是诊断信息**：在全局层重复注册同名项时，宿主会报
`prompt section "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`。它证明宿主**预期**你这么干，但不构成使用实例。

所以本功能走这条：监听 `agent/created`，在 `agent.ctx` 上注册**同名**段遮蔽全局段。`ctx.systemPrompt.section()` 的 scope 取自调用方上下文，因此在 agent 作用域内注册即落在该 agent 的层上。

**一处需要说清的边界**：`harness:identity`（本功能要遮的那道名）在宿主里**没有先例**——宿主自己的两处遮蔽都用 `deployment:persona-prefix`。所以这道名靠的是上面那条**通则**（README：「creator plugins may register agent-scoped shadows」），不是靠某个包先遮过它。


要注册的是 **5 个注册项，落在 3 个名字上**（按名定位，不按文本匹配——`harness-dev-context` 会给旧会话返回历史措辞，按文本找会漏）。① 是一个名字一项；②④ 各自 section 与 context 同名，所以各两项：

| 名字 | 类型 | 遮蔽后 |
|---|---|---|
| `harness:identity` | section | `keep` 不注册；`remove` 注册空文本（渲染丢弃）；`custom` 注册自定义文本 |
| `harness:source` | section | `hideHarness` 时注册空文本 |
| `harness:source` | context | `hideHarness` 时注册空文本 |
| `app:web-surface` | section | `hideHarness` 时注册空文本 |
| `app:web-surface` | context | `hideHarness` 时注册空文本 |

**为什么 context 必须整条遮蔽而非清文本**：`refreshContext()` 在请求准入前会遍历已接纳 assembly 的 contexts，按名字找回 provider 重新求值。若只是清掉文本而没有同名 provider，原 provider 会把文本恢复。注册同名 provider 返回空串，才稳定为空。

**生命周期**：`agent/created` 里注册，把 disposer 按 agent 记在插件自己的 effect 里；`agent/disposed` 与插件卸载两边都能拆。这是 practices.md 明写的模式（「A registration on another context has two owners」）。

**代价**：每个 agent 一次注册，比瀑布多一段生命周期代码。换来的是官方认可的最弱机制、不需要替其他插件保留 assembly 结构、也不会因为瀑布监听器抛错拖垮整次装配。

**不受管的情形**：不经过 agent 作用域的装配（例如某些由部署直接发起的会话标题请求）看到的仍是宿主原版开场白。这是选择弱机制的自然结果，写在此处备查。

## 6. 它长什么样

数据分两处，沿用本仓纪律：开关进 `state.json`，文本进单独文件。

```text
<DSH_HOME>/enhance/state.json     → identity: keep|remove|custom, hideHarness: true|false
<DSH_HOME>/enhance/identity.txt   → 自定义文本（上限 2 KB，独立于内容边界的 8 KB）
```

`state.json` 从 v3 升到 v4：只加字段，不改旧字段，不写迁移支路。旧文件缺字段时取默认（`keep` + `hideHarness: false`）。

**写盘必须带全五键**：`writeState()` 是整块重建，每个调用点（设置页的 `set`、首装种子）都要带全 `enabled` / `contentScope` / `approval` / `identity` / `hideHarness`，否则用户点一次「总开关」就把品牌人设重置回默认。这条要有一条回归测试：只切 `enabled`，`identity` 不变。

**失败语义**（全部倒向 `keep`，即宿主原样，不静默改身份）：

| 情形 | 结果 |
|---|---|
| `identity` 不是三态之一 | 按 `keep`，标坏 |
| `identity.txt` 缺失 / 读不到 | `custom` 退化为 `keep`，设置页照实说「读不到自定义文本」 |
| `identity.txt` 归一后为空 | 同 `remove`（空文本等于不声明），页面标明 |
| `identity.txt` 超过 2 KB | 拒绝注入，退化为 `keep`，理由写进状态（与内容边界「读路径也拦超限」同一口径） |
| `includeHarnessIdentity: false` 的部署（无全局 `harness:identity`） | `custom` 时补一段；`remove` 无事可做；**装没装上现在看得见**——`identityInstall` 与设置页那一行会如实说「已接上 / 未生效」；但 `keep` 态**仍不进判据**，页面照旧无法判断这个部署有没有那段全局身份段（见「读不到的宿主事实」） |

**`interpolate: false` 是硬要求**：全局 `harness:identity` 注册时没设 `interpolate`，`renderPrompt()` 会对未声明该标志的段做变量插值；用户文本里一个落单的 `{{` 会让整次装配抛错。自定义段必须显式设 `interpolate: false`（与本仓内容边界段的既有做法一致），并有一条测试。

设置页新增一组「品牌人设」，排在内容边界之前（它管提示词开头，内容边界管结尾）：

| 控件 | 复用 | 作用 |
|---|---|---|
| 三档分段按钮 | `Segmented` + `Option` | `identity` 三态 |
| 开关「隐藏宿主说明」 | `Switch` | `hideHarness`。标签固定为动作名，**不许随状态翻转**：开关绑的是「隐藏」，若关着时写「显示宿主说明」，用户会读成「宿主说明不显示了」，与事实相反 |
| 输入框 + 保存 / 还原 | `TextArea` + `Button` | 自定义文本，仅 `custom` 时出现 |
| 预览行 | 只读文本 | 模型将看到的第一句 |

**按「它是什么，以及不是什么」的目标，这个开关是「可选加固」，不是达成目标的必要条件**——「模型不自称」由三态那一个控件就达成了；开关的作用是进一步减少品牌暴露。所以它保持**一个开关、两档**：两类角色正好各自对应一档（改 DSH / 写插件的人关掉、两段都留；白标终端用户打开、两段都去）。**不拆成两个**——② 与 ④ 在这里性质相同（都是减少品牌暴露），拆开只会逼用户做一个他无从判断的选择。将来若「只隐藏安装路径、保留界面说明」变成独立需求，那属于**环境值脱敏**，是另一个功能。

**`hideHarness` 隐藏的不是「一句品牌名」，而是两整段带操作约定的文字。** 这一点必须在下游说清楚，否则用户会以为是纯品牌改动：

| 被隐藏的名字 | 座位 | 丢的是什么 |
|---|---|---|
| `harness:source` | section（order 10000） | 「实现 checkout 与当前工作目录是两个值、可能不同；**不要从 checkout 路径推断工作目录**；用 `pwd`；这个 checkout 只用来查看或扩展 DSH 本身」 |
| `harness:source` | context（order 200） | 安装目录的绝对路径（`Current DeepSeek Harness implementation checkout: "…"`） |
| `app:web-surface` | section（order 10100） | 「这个页面 / 这个 GUI 指的就是它」的指代消解，加上**「别为了让改动生效另起服务器」**与「客户端插件改动何时才生效（HMR 要看 `pnpm run dev:web` 在不在跑）」 |
| `app:web-surface` | context（order 210） | Web GUI 的 URL |

所以对**改 DSH / 写插件**的人，打开这个开关是实打实的行为退化；对终端用户才近乎无成本。设置页那句提示语就是照这个写的。

**还有一条容易误解的**：隐藏 ≠ 隔离。路径与 URL 模型照样读得到（`pwd`、文件系统、网络），隐藏只是「不告诉它」，不是安全边界——省的是噪声与暴露面。

预览行由服务端派生：`remove` 态显示「已去掉，下一段接上」，不伪造一句话；`custom` 显示自定义文本；`keep` 显示宿主原文。

API 沿用 `set` op，白名单加三键：`identity`、`hideHarness`、`identityText`（内容边界的 `text` 已被占用）。落盘顺序沿用「先验文本再写状态」。

## 7. 缓存代价

DSH 自己的口径是：

> 前缀复用要求在同一提供方与模型路由下，此前消息和声明保持**逐字节一致**。
> 任何变更都可能从第一个变化的 token 起使复用失效；**不保证提供方共享缓存或实际命中率**。
> —— `dsh-agent-loop/README.zh.md`、`dsh-system-prompt/README.zh.md`

据此本功能只说三件事：

- 每次切换三态或保存新文本，等于换一条前缀，下一条请求冷启动一次；
- 之后只要渲染结果不变，就**不再有额外失效点**（这是机制层面的，不是命中率承诺）；
- 去掉段落让系统提示变短，每条请求少付那几百 token。

本机样本（2026-11-02，本工作区两个会话）：稳定态命中 94–99%，切换模型那一轮掉到 87%、下一轮回到 99%；另一会话全程 96.6%，中途几个工作步掉到 76–86%。**这些是采样数字，不是保证**——DSH 明确不承诺命中率。

## 8. 边界

| 边界 | 表现 |
|---|---|
| 某 preset 声明 `complete: true` | 装配会用那一段覆盖整份提示词，本遮蔽失效。宿主既定行为，不兼容 |
| 无 agent 作用域的装配 | 看到宿主原版开场白（见「为什么是「按 agent 遮蔽同名段」」） |
| 只对装了本插件的进程生效 | 另一进程（不同 home / profile）不受影响 |
| 日志显示遮蔽后结果 | 会话日志记装配结果，不记宿主原版；与「只追加」时口径一致 |
| 不动 `request/header` | config 与 tools 不变，不额外触发 header 记录 |
| `keep` 态看不出「某部署关掉了全局身份段」 | 装没装上现在看得见（`identityInstall` 与设置页那一行），但**这个部署有没有那段全局身份段**仍读不到；见下方「读得到的宿主事实」 |
| 打破宿主「已接纳段落逐字不变」的投影语义 | 身份三态非 `keep` 或 `hideHarness` 打开时，老会话恢复拿到的是当下的遮蔽结果，与它已记录的那一版提示词不同；宿主会写一条新的 prompt 版本。见下方「一条被打破的宿主语义」 |

### 读得到的宿主事实，以及一个要明写的决策

这里原先写着「宿主没有提供读取已注册分段的 API」，并据此推出「所以我们只能自己写整段替换文案」。**前半句不准确，后半句因此不成立**——等于用一件不存在的事实，替自己省掉了一个选项。

- `SystemPrompt` 的**原型方法**确实只有写入与装配入口：`section` / `context` / `getSectionOrder` / `getContextOrder` / `suppressRuntimeContext` / `tools` / `variable` / `refreshContext` / `assemble`，**没有枚举方法**。
- 但服务实例上有**公有字段 `layers`**（`@deepseek-ai/dsh-system-prompt/lib/index.js` 的类字段，非 `#` 私有），而 `ScopedLayers` / `NamedEntries` 由 `@deepseek-ai/dsh-scope` 导出。实测能枚举出全局已注册的段及其 `order` / `text` / `interpolate`：

  ```text
  harness:identity | order: -1000 | text: "You are an AI agent powered by DeepSeek Harness."
  ```

- `layers` **不是文档化 API**（宿主 README 只声明「没有给终端用户编辑提示词的 API」）。所以用不用它是一个**要明写下来的决策**，而不是一句「没有入口」就能排除的事。基于它和其他两条路的对比见下一节「被评估过、现被挂起的路线」。

仍然读不到的是**宿主配置**：想知道某个部署有没有关掉 `includeHarnessIdentity`，只能去解析 profile 各层的 YAML，而配置来自「发行模板 + profile cordis.yml + patch 叠加」多层，本仓没有 YAML 解析器，手搓一层的判断会在别的层上失灵。

所以页面在 `keep` 态一律预览宿主的默认原句。真遇到关掉该开关的部署，预览句与实际不符——这是**已知且已声明**的边界，不是待办的 bug。

### 被评估过、现被挂起的路线（②④）

②④ 那两段说明有三种处理法，用的是**同一套机制**（按 agent 遮蔽同名段），差别只在「覆盖成什么」。现在跑的是第一种；后两种**不是被否决，是挂起**——各有必须先付的代价，而「模型不自称」这个目标已经达成，所以不急着换。

| 路线 | 做法 | 挂起的原因 |
|---|---|---|
| 整段删（＝现状 `hideHarness`） | 同名注册空串，②④ 一起变空 | 已实现，无遗留决策。代价是那两段带操作约定的文字一起消失（见「它长什么样」那节的四行对照表） |
| C · 自己写文案 | 我们提供无品牌的**等价文案**，同名覆盖 | 选它等于**我们拥有这段文案**：每次 rc 升级要对账「我们的稿子与宿主新措辞差了什么」，而仓里没有给「我们拥有的提示词文案」留核验位；改写稿还要处理技术标识（`dsh web`、`window.__DSH_BOOT__`、`apps/web`、`DSH itself`、`pwd`），品牌词表边界一含糊就出现「半去品牌」 |
| H′ · 运行时改写 | 读宿主当前注册项 → 逐词替换品牌 → 同名覆盖，并把函数式 provider 一起转发 | 依赖**未文档化的 `layers` 字段**（见上）：rc 一改名或封装就静默失效，所以落地必须带 feature-detect、命中率自检、触点登记三件套。好处是三条路里唯一一条**不打破**宿主投影语义、也不用对账整段文案的 |

三条路都过不了上游网关——网关要的是「那串字换掉」，不是品牌消失；那是「「去品牌」和「过网关」是两件事」那条独立规则的事，别拿本功能替它做承诺。

### 一条被打破的宿主语义：`hideHarness` 与 admitted-legacy

② 的 section 文本不是常量，是函数：`text: (context) => admitted(context).source ?? HARNESS_SOURCE_PROMPT`。宿主专门为它注册了 `harnessDevLegacyPrompt` 投影，注释原话是「A Session whose admitted prompt holds the paragraphs that embedded those values keeps them verbatim, so **resuming it never rewrites its logged prompt**」。

**现状已经打破了这条语义**：按名注册同名项后，老会话恢复时拿到的是**本插件当下的遮蔽结果**，与它当初记录的那一版提示词不同，宿主会为此写一条新的 prompt 版本。整段删（现状）与 C 都打破它；只有 H′ 转发函数式 provider 才能保住。

**为什么暂不改**：这是「按名遮蔽」这条路本身的性质——同名项在装配时近端胜出——不是可以局部修掉的 bug；换 H′ 要引入未文档化字段依赖，代价更大。触发条件明写在上面那条边界行里：身份三态非 `keep`，或 `hideHarness` 打开。

### 「用 AGENTS.md 补偿」：评估过，不采用

曾经评估过的一条路：系统提示不动，转而用 `AGENTS.md` 补偿，让模型从工作区指令里得知自己属于别的产品。**不采用**，理由：

- `AGENTS.md` 由 `@deepseek-ai/dsh-agent-instructions` 以 **user message** 送达（`source.kind === 'agent-instructions'`），**不在系统提示层**。system 节点里的自称句照旧，模型仍会把系统里的声明当作身份。
- 它自己写明**不覆盖** system / developer / 直接用户指令；让一条低优先级的消息去盖系统提示，方向就是反的。
- 它按「工作区根 + 两个全局根」候选、有 64 KiB 预算、超了保近丢远并明示截断；对子 agent 一样有效，但作用域与预算都不是本功能能承诺的。

**结论**：本功能的战场是系统提示的声明层；`AGENTS.md` 不在这条链上。别再把它当替代方案重新提出来。

## 9. 维护：DSH 升级后核这一条
新 rc 发布后的例行核验多一条触点，也是本功能唯一的宿主依赖：

**按 agent 作用域遮蔽同名段的机制：`ctx.systemPrompt.section()` / `.context()` 的 scope 取自调用方 ctx、`agent/created` 事件、assemble 时「近作用域覆盖全局同名项」。**

已知位置关系：

- `SystemPrompt.section()` 用 `this.layers.effect(this.ctx, …)`，`this.ctx` 跟随调用方上下文（cordis service 转发）；
- `assemble()` 用 `this.layers.merge(scope, …)` 合并，近作用域的同名项胜出；
- `renderPrompt()` 丢弃空文本段，`renderContextSections()` 丢弃空文本 context；
- 先例：`dsh-persona`、`dsh-subagent` 都据此工作。

`docs/host-seams.md` 的改法：在「cordis 插件 API」那一行的接缝清单里加 `ctx.on('agent/created')` 与「agent 作用域同名段遮蔽」，并按那一节自己的计数口径把独立触点项总数重数一遍——**总数、公式与拆条规则都以那一节为准，别在这里另立**。`packages/core/system-prompt/src` 已在 tree-diff 清单里，不新增目录；`packages/interaction/agent`（若存在）视核验结果决定是否加入。

任一条不成立 → 本功能失效，其余功能不受影响。降级路径不再只有「人工记账」一条：

- **装没装上**：状态快照里的 `identityInstall`（机读）与设置页品牌人设组那一行说明（人读）会如实说「已生效 / 已接上 / 未生效」，例如「未生效：本版宿主没有可注入的 agent 上下文（agent.ctx.inject 不可用）」；「还没有 agent 可判」是三态的 `null`，不压成「失败」。
- **遮蔽是否真的生效**：由设置页的检查项里 `inject` 那一项的第二路证伪——`custom` 要在会话日志里命自定义文本、`remove` 要用反向探针确认最新一份装配记录里已经没有宿主原句；`keep` 不判。
- **仍要人工记的**：装配层验收在桌面会话上已验通（结论与复跑条件在 [`docs/compatibility.md`](compatibility.md) 的「核验记录」）；还剩 `hideHarness` 在桌面 / web profile 上的效果未核，见下面「仍未核验」。

## 10. 落地状态与剩余边界

这个功能已经落地。**状态不在这份契约里复述**——它随每次发版变化，写在这里就一定会变成假话：

- 逐版本改了什么、验证读数是多少 → [`CHANGELOG.md`](../CHANGELOG.md)
- 宿主接缝、历轮核验的结论与「想复跑要什么条件」 → [`docs/compatibility.md`](compatibility.md)

契约只需要记住两条**不会随发版消失**的边界：

- **仍未核验**：`hideHarness` 在**桌面 / web** profile 上的效果。`harness-dev-context` 的 `inject` 含 `webApp`，`headless` 组合里没有它，那两段本来就注册不到，没有基线可比。补它的条件见 [`docs/compatibility.md`](compatibility.md) 的「核验记录」。
- **装配层验收**：做法与结论记在 [`docs/compatibility.md`](compatibility.md) 的「核验记录」——桌面会话上已验通（内容边界进提示、遮蔽生效），headless 那一半要**一次有余额的会话**才能复跑。
