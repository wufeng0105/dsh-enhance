# 品牌人设

**一句话**：品牌人设让系统提示的**开场白**在本插件作用域内可控（保留 / 去掉 / 自定义），并可一并隐藏另外两段提到宿主名字的段落。它只改「声明层」，其余段落逐字节保留，存盘即生效、一键退回。

这篇文档是这个功能的契约：解决什么、什么算成、为什么用「按 agent 遮蔽同名段」而不是装配瀑布、代价与边界、DSH 升级后核哪一条。落地步骤在最后一节。

## 1. 它是什么，以及不是什么

DeepSeek Harness 每次请求前现场拼一份系统提示。这份提示以一句产品声明开头：

```text
You are an AI agent powered by DeepSeek Harness.
```

「品牌人设」让这一句在本插件作用域内可控：保留、去掉、或换成你自己的。它同时可以隐藏另外两段提到宿主名字的内容：`harness:source` 的 checkout 说明、`app:web-surface` 的 Web GUI 说明——这两段各有一个 section 和一条 runtime context，一共四处。

**它不是完整白标。** 宿主配置里有官方开关 `includeHarnessIdentity: false`，其说明是「仅当兼容性部署**自己接管完整系统提示词**时」才设。那条路要求接管整份提示，连同十几段工具引导与运行规则。本功能走的是有界的那条：只替换声明层，其余段落一个字节不动。

**它也不保证「模型再也不会说自己是 DSH」。** 训练先验里就有这个名字，去掉声明能大幅压低，不能归零。产品文案不要承诺「彻底去品牌」。

## 2. 要解决什么

一个具体故障：产品换了皮，模型仍张口就说自己是 DSH。

这句话被用在三类场合：直接回答「你是谁」、解释自身能力时带出产品名、用户提到 DSH 时确认自己属于它。对终端用户是品牌泄漏；对上游网关，它有时还是内容指纹。

修法不能是改宿主文件：那会让每次升级失效，也打破本仓「除声明层外，宿主提示词一个字节不动」的承诺。

## 3. 做到什么算成

| # | 验收 | 怎么验 |
|---|---|---|
| 1 | 三态可选：保留 / 去掉 / 自定义 | 设置页切换后，最新一条 `system/message` 的第一句就是所选结果 |
| 2 | 附带开关：同时隐藏宿主说明 | `identity` 为 `remove` 或 `custom`（且自定义文本本身不含该名）时，**system 节点**里 `DeepSeek Harness` 出现 0 次；两条 runtime context 也一并消失（它们不在 system 节点里，单独验） |
| 3 | 随时退回原样 | 选回「保留」后，**最新一条** `system/message` 的文本哈希与未装本插件时一致。历史节点不会被回改，不与历史比 |

自定义文本另有一条验收：文本里含 `{{x}}` 或落单的 `{{` 时，装配不抛错（见第 6 节的 `interpolate: false`）。

## 4. 不做什么

| 不做 | 理由 |
|---|---|
| 改 persona 那句 `You are a coding agent powered by …` | 它由宿主按真实模型名插值（换模型就变），改它等于让模型自述错误型号 |
| 改工具描述里的品牌 | 工具 schema 在 `request/header.tools`，不在 sections 里；动它会同时改 header 与缓存形状 |
| 改宿主界面上的产品名、图标 | 那是打包层资源，本插件不碰 |
| 改写已有会话的历史提示词 | 改写只对新装配生效；日志里的历史是事实 |
| 加第 5 个检查项（v1） | 检查页仍四项。品牌人设的验法只有验收 #1/#2，这条要写明，免得读者以为检查覆盖它 |

## 5. 为什么是「按 agent 遮蔽同名段」

本插件现有能力都挂在宿主接缝上。要把全局注册的 `harness:identity` 换掉，宿主提供了两条路，官方口径是**用够用的最弱机制**：

> From weakest to strongest: `ctx.tools.restrict()` … waterfall listeners can rewrite …
> `system-prompt/assemble` replaces the whole assembly. The stronger the mechanism,
> the more of other plugins' contributions you must preserve.
> —— `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`

同一份文件还写明：**不要**监听 `system-prompt/assemble` 去增删工具或文本。

而「同名段遮蔽」是宿主的一等公民能力，官方三个先例都在用它：

| 先例 | 做法 |
|---|---|
| `@deepseek-ai/dsh-persona` | preset 内用同名 `deployment:persona-prefix` 遮蔽部署人设；挂到全局才会撞名报错 |
| `@deepseek-ai/dsh-subagent` | 在子 agent 的 ctx 里注册同名 `deployment:persona-prefix` |
| 宿主错误串本身 | 重复注册报错时提示「for a per-agent override, register through that agent's `agent.ctx` instead」 |

所以本功能走这条：监听 `agent/created`，在 `agent.ctx` 上注册**同名**段遮蔽全局段。`ctx.systemPrompt.section()` 的 scope 取自调用方上下文，因此在 agent 作用域内注册即落在该 agent 的层上。

要注册的四个名字（按名定位，不按文本匹配——`harness-dev-context` 会给旧会话返回历史措辞，按文本找会漏）：

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

**写盘必须带全四键**：`writeState()` 是整块重建，每个调用点（设置页的 `set`、首装种子）都要带全 `enabled` / `contentScope` / `approval` / `identity` / `hideHarness`，否则用户点一次「总开关」就把品牌人设重置回默认。这条要有一条回归测试：只切 `enabled`，`identity` 不变。

**失败语义**（全部倒向 `keep`，即宿主原样，不静默改身份）：

| 情形 | 结果 |
|---|---|
| `identity` 不是三态之一 | 按 `keep`，标坏 |
| `identity.txt` 缺失 / 读不到 | `custom` 退化为 `keep`，设置页照实说「读不到自定义文本」 |
| `identity.txt` 归一后为空 | 同 `remove`（空文本等于不声明），页面标明 |
| `identity.txt` 超过 2 KB | 拒绝注入，退化为 `keep`，理由写进状态（与内容边界「读路径也拦超限」同一口径） |
| `includeHarnessIdentity: false` 的部署（无全局 `harness:identity`） | `custom` 时补一段；`remove` 无事可做；设置页**看不出**这个部署差异（见「读不到的宿主事实」） |

**`interpolate: false` 是硬要求**：全局 `harness:identity` 注册时没设 `interpolate`，`renderPrompt()` 会对未声明该标志的段做变量插值；用户文本里一个落单的 `{{` 会让整次装配抛错。自定义段必须显式设 `interpolate: false`（与本仓内容边界段的既有做法一致），并有一条测试。

设置页新增一组「品牌人设」，排在内容边界之前（它管提示词开头，内容边界管结尾）：

| 控件 | 复用 | 作用 |
|---|---|---|
| 三档分段按钮 | `Segmented` + `Option` | `identity` 三态 |
| 开关 | `Switch` | `hideHarness` |
| 输入框 + 保存 / 还原 | `TextArea` + `Button` | 自定义文本，仅 `custom` 时出现 |
| 预览行 | 只读文本 | 模型将看到的第一句 |

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
| 无 agent 作用域的装配 | 看到宿主原版开场白（见第 5 节） |
| 只对装了本插件的进程生效 | 另一进程（不同 home / profile）不受影响 |
| 日志显示遮蔽后结果 | 会话日志记装配结果，不记宿主原版；与「只追加」时口径一致 |
| 不动 `request/header` | config 与 tools 不变，不额外触发 header 记录 |
| 设置页看不出「某部署关掉了全局身份段」 | 见下方「读不到的宿主事实」 |

### 读不到的宿主事实

有一件事本插件**做不到**，写清楚免得后来者以为漏了：设置页无法判断「这个部署有没有全局 `harness:identity`」。

- 宿主没有提供「读已注册分段」的 API——`systemPrompt` 只有 `section` / `context` / `getSectionOrder` / `getContextOrder` / `assemble` 这些写入与装配入口，没有枚举。
- 想绕就得调 `assemble()`，那会连带跑一遍装配瀑布（`working-directory` 的 `ensure` 等），代价与副作用都不该由一次设置页查询来付。
- 也可以去解析 profile 各层的 YAML 找 `includeHarnessIdentity`，但配置来自「发行模板 + profile cordis.yml + patch 叠加」多层，本仓没有 YAML 解析器，手搓一层的判断会在别的层上失灵。

所以页面在 `keep` 态一律预览宿主的默认原句。真遇到关掉该开关的部署，预览句与实际不符——这是**已知且已声明**的边界，不是待办的 bug。

## 9. 维护：DSH 升级后核这一条
新 rc 发布后的例行核验多一条触点，也是本功能唯一的宿主依赖：

**按 agent 作用域遮蔽同名段的机制：`ctx.systemPrompt.section()` / `.context()` 的 scope 取自调用方 ctx、`agent/created` 事件、assemble 时「近作用域覆盖全局同名项」。**

已知位置关系：

- `SystemPrompt.section()` 用 `this.layers.effect(this.ctx, …)`，`this.ctx` 跟随调用方上下文（cordis service 转发）；
- `assemble()` 用 `this.layers.merge(scope, …)` 合并，近作用域的同名项胜出；
- `renderPrompt()` 丢弃空文本段，`renderContextSections()` 丢弃空文本 context；
- 先例：`dsh-persona`、`dsh-subagent` 都据此工作。

`docs/compatibility.md` 的改法：在「cordis 插件 API」那一行的接缝清单里加 `ctx.on('agent/created')` 与「agent 作用域同名段遮蔽」，并按该节自己的计数口径把「共 35 条」重数成 36（该节的 30 + 探测链 5 = 35 公式要同步）。`packages/core/system-prompt/src` 已在 tree-diff 清单里，不新增目录；`packages/interaction/agent`（若存在）视核验结果决定是否加入。

任一条不成立 → 本功能失效，其余功能不受影响。降级路径：设置页开关仍在但预览与实况不符，在 `compatibility.md` 记一轮。

## 10. 落地清单

一次性清单，做完逐项勾。

**代码**

- `shared/state.mjs`：`STATE_VERSION` 3→4；新增 `identity` / `hideHarness` 与 `IDENTITY_LIMIT`；文本读写复用现有 `readText` / `writeText` 口径（加路径与上限参数），不另起第二套实现
- `shared/seed.mjs`：首装写盘带全 v4 键
- `enhance-scope/index.js`：`ctx.on('agent/created')` + `agent/disposed`；按名遮蔽四处；`set` op 白名单加 `identity` / `hideHarness` / `identityText`；`state` 快照加三字段与预览句；`writeState` 所有调用点带全键
- `ui/client.js`：新增「品牌人设」组（三档 + 开关 + 输入框 + 预览），`errorLine` 加 `identity` 段，页面自身「四组」文案与注释同步改
- `code-map.json`：`events` 加 `agent/created`、`agent/disposed`（owner `plugin.scope`）；新增「agent 作用域遮蔽」接缝边；`state.fields` 补齐（含今天已缺的 `enabled`）；`plugin.ui-client` 的 `owns` 文案

**文档**

- `docs/terminology.md`：组名「品牌人设」；机读标识符 `identity` / `hideHarness` / `identityText`；三分「人设」——品牌人设（`harness:identity` 开场白）／部署人设（`deployment:persona-prefix`）／内容边界文本；内容边界提示里的「写人设」改为「写行为规矩、写内容要求、写补充说明」
- `docs/compatibility.md`：按第 9 节改两处 + 下一轮核验记录
- `README.md` / `README.en.md`：功能一句、设置页说明、退回方法；「四组」改「五组」；承诺句统一为「除声明层外，宿主提示词一个字节不动」
- `CONTRIBUTING.md`：同上承诺句
- `showcase/prompt-assembly.html`：「它只做加法」那两处补上品牌人设这一例外
- `package.json`：`files` 加 `docs/brand-persona.md`（契约要随包发布）

**门禁与测试**

- `tests/state.test.mjs`：`STATE_VERSION` 断言、精确 key 列表、只切 `enabled` 不动 `identity` 的回归
- `tests/ui-client.test.mjs`：四组顺序与切片（改五组）、`errorLine` 段列表加 `identity`、`ids.size` 改 5、「写人设」锁定串改「写行为规矩、写内容要求、写补充说明」、新增组的文案锁
- `tests/enhance-scope-api.test.mjs`：`fakeCtx` 补 `on('agent/created')` 捕获；新 op 白名单与校验；`interpolate: false` 断言；只切 `enabled` 后 `identity` / `hideHarness` 不变的回归（`writeState` 整块重建的坑）
- 新增纯函数测试：三态 × 隐藏 的组合、按名遮蔽、空文本、`{{` 不炸、超限退化
- `tools/smoke.mjs`：加七条端到端断言（捕获 `agent/created`，喂假 agent ctx，断言 `keep` 不注册、`remove` 注册同名段且 `interpolate:false`、隐藏时 section 与 context 成对遮蔽）
- `node scripts/check.mjs` 与 `--self-test` 都要 exit 0

## 11. 落地状态（2026-11-02）

- **已核验**：`node scripts/check.mjs` 7/7（145 项测试 / 9 个文件）；`--self-test` 17/17；
  `tools/smoke.ps1` 37/37（真装 bundle + 真组合树 + 七条品牌人设断言）；
  **真宿主首启**落盘的 `state.json` 确为 v4 五键（`gates/wp4-live-seed.log`）。
- **尚未核验**：第 3 节验收 1 与 3 的**装配层**结论（最新一条 `system/message` 的第一句）。
  本机隔离 `DSH_HOME` 没有模型凭据，`dsh headless` 在会话建立前就停下，拿不到会话日志。
  在有凭据的环境里，装上本包、切成「自定义」发一条消息，再读那条 `system/message` 即可补上——
  这是本功能唯一还欠的一次核验。
