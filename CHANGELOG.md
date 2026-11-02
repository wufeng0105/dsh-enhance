# 变更记录

本文件自 `1.1.0` 起维护；版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，条目格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.2.0] — 2026-11-02

### 新增

- **品牌人设**（设置页第 1 组）：系统提示开头那句 `You are an AI agent powered by DeepSeek Harness.` 可保留、可去掉、可换成你自己的；顺带能把另外两段提到宿主名字的说明（安装位置、图形界面）连它们的运行时上下文一起隐藏。改的是**模型看到的装配结果**，存盘即生效、不用重启，选回「保留」即逐字节回到宿主原样；
- [`docs/brand-persona.md`](docs/brand-persona.md)：这份契约——解决什么、三条验收、明确不做哪五件事、为什么走「按 agent 遮蔽同名段」而不是装配瀑布、缓存代价、边界、以及 DSH 升级后该核哪一条；
- 自定义身份文本独立成文件 `<DSH_HOME>/enhance/identity.txt`，上限 2 KB（与内容边界的 8 KB 分开）。

### 变更

- `state.json` 从 v3 升到 v4：新增 `identity`（`keep` / `remove` / `custom`）与 `hideHarness`，只加字段、不写迁移支路；旧文件缺这两个键是正常的，不标降级，只有「写了但认不出」才算坏；
- `readState` 新增 `degradedFields`：坏的是哪个字段要能说清——原来只写「审批回落」会把身份坏值说成审批的事；
- 文本读写收敛成唯一实现（`readTextFile` / `writeTextFile`），品牌人设不另起第二套；`readIdentity` / `writeIdentity` 是其薄包装；
- 公开承诺句统一为「**除声明层那一句之外**，宿主提示词一个字节不动」——原来那句「一个字节不动」被本功能打破，README（中英）、`CONTRIBUTING.md` 与 `showcase/prompt-assembly.html` 已同步；
- `docs/terminology.md` 新增「人设一名三义」：品牌人设 / 部署人设 / 尾巴文字必须分写；内容边界提示语里的「写人设」改为「写行为规矩、写内容要求、写补充说明」；
- `docs/compatibility.md` 触点表加一条（`ctx.on('agent/created')` + `agent.ctx.inject()` 的 agent 作用域同名段遮蔽），独立触点项由 35 条重数为 36 条；
- `package.json` 的 `files` 收录 `docs/brand-persona.md`。

### 修复

- **「去掉 → 自定义」在活着的 agent 上不生效**（独立审计 B1，本版发出前修掉）。重装指纹原先只记「有哪些座」，不看座上文本是哪一种实现：`remove` 注册常量空串、`custom` 注册动态读函数，两者座名相同 → 指纹相同 → 不重装，座上留着旧空串。表现是设置页显示「已替换」、预览行也显示自定义文本，而模型实际收到的是**被删掉**的身份句；新起的 agent 正常，所以症状是「有的会话对、有的不对」。修法：身份座一律用动态读函数（`remove` 时 `deriveIdentity` 本就返回空串），两种模式共用同一次注册。补了三条回归——纯函数层「两种模式必须产出同一份计划」、接口层「同一个活 agent 上三步连做」、冒烟 `3.5.7`；
- 设置页的降级原因不再一律说成「审批回落到先问我」，改按 `degradedFields` 逐字段说（身份坏值说成「品牌人设回落到保留」，认不出的字段名照原样抖出来）。

### 验证

- 本地门禁：`node scripts/check.mjs` **7/7**、`--self-test` **17/17**；
- 测试：由 130 项增至 **152** 项；冒烟由 30 条增至 **38** 条断言。新增覆盖三态派生、`identity.txt` 独立上限、遮蔽计划、agent 生命周期端到端、五组顺序、品牌人设界面约束、以及 B1 的三层回归；
- **装配层验收在真机上成立**（契约「做到什么算成」的第 1、3 条，此前一直欠着）：远端机全量重置后装 `0.2.1-rc.5` + 本包，`custom` 态下会话 `system/message` 的第一句是自定义文本、宿主原句在整份会话里 0 命中；切回 `keep` 后第一句逐字回到宿主原句。内容边界在两种状态下都在。详见 `docs/compatibility.md` 的 2026-11-02 记录；
- 过程中被门禁挡下的两处：新增的 `agent/created`/`agent/disposed` 未登记进 `code-map.json` 时 `graph` 门直接判红；预览行初版用了 10px 间距，布局门禁按刻度判红。
- 审计另外指出两处**测试自身的弱锁**，一并修掉：`tests/ui-client.test.mjs` 里「不该出现非 token 字体族」那条正则写成 `\\s`（正则字面量里是「字面反斜杠 + s」），连 `font-family:Arial` 都不匹配、永不红；`cssRules()` 抽到 0 条规则时会让两条排版断言在空集合上静默全绿。前者改为真能红的检测器并加自检，后者改为空集合直接抛。

## [1.1.2] — 2026-10-31

### 新增

- [`docs/figures/`](docs/figures/)：五张架构图（宿主接缝、注入路径、保存往返、例行核验、Enhanced 档生命周期），README 里按叙事顺序嵌入；SVG 是自包含的，GitHub 直接渲染；
- [`docs/figures/sources/`](docs/figures/sources/)：图的源 JSON 与复现步骤——源 → 交互式 HTML → 独立 SVG，两步都能跑；
- `scripts/extract-figure-svg.mjs`：从 Archify 的交互式 HTML 抽出可独立渲染的 SVG（补 `xmlns`、内联类规则与 CSS 变量、CDATA 包裹）；
- `scripts/check-readme.mjs`：README 门禁，114 项结构检查（章节顺序、站内链接、图存在、ToC 覆盖、代码块语言、许可证在最后、两个语言版本互链）。

### 变更

- **README 按 standard-readme 重构**：默认页改为中文（`README.md`），英文版退到 `README.en.md`，两版章节一一对应、互链；认知漏斗重排——15 秒能判断的信息全在第 30 行之前，兼容区间、接缝清单、档位手术下沉到后半段与 `docs/`；
- 门禁从六道变七道，新增 `readme` 一道；`--self-test` 负例从 15 条增到 17 条（新增「README 里的图路径失效」与「源码型守卫」各一）；
- `CONTRIBUTING.md` 与两份 README 里「六道闸」的表述同步为七道。

### 验证

- 本地门禁：`node scripts/check.mjs` **7/7**、`--self-test` **17/17**；
- 图的端到端复现：源 JSON → 交互式 HTML → SVG，五张与仓库成品**逐字节一致**；
- GitHub 实际渲染：以真实页面截图确认五张图、表格、代码块、徽章、目录均正常。

## [1.1.1] — 2026-10-31

### 新增

- [`docs/terminology.md`](docs/terminology.md)：术语账本——界面名与机读标识符的 1:1 映射、同名两物的消歧写法、假同物异名的豁免、以及声音锚点。

### 变更

- 仓库内**手写文本面**（代码注释、设置页文案、`docs/compatibility.md`）统一到同一套术语与文风；
- 设置页第 2 组的组标题与错误行标签统一为「越界审批」，与术语账本里的四个组名一致（见 [`docs/terminology.md`](docs/terminology.md)；该组内的控件标签保持问句写法）；
- 审批结果的措辞改为「宿主四个 outcome 里我们主动产出的三个」，不再说「一一对应」；
- `docs/compatibility.md`：「73 处」改为可复算的「21 个文件」；「六层探测」改为「整条探测链」；新增「2026-10-31 复核」一节（重置重装、tree SHA 复对、空 patch 报错、`defaultPreset` 不存在）。

### 修复

- 界面与注释里那个「直接放行」在宿主中并不存在，已移除；
- `scripts/code-files.mjs` 的 `SKIP_DIRS` 补 `.dsh`：走盘兜底时不再把本地 DSH 数据目录下的 `.mjs` 算进语法门禁；
- `scripts/check.mjs` 的 `--self-test` 负例改为**锚定 `SKIP_DIRS` 内容**替换：以后增减该集合的条目不会再让这条负例静默失效；
- `code-map.json` 里过期的组名；
- 测试失败消息里的章节编号（`04` → `03`，与产品侧注释编号一致）。

### 验证

- 远端测试机**全量重置重装 `0.2.1-rc.5`** 后：`dsh plugin add` exit 0、`--dump-config` 组合出三个入口、一次性 home 冒烟 **30/30 断言全过**；
- 本地门禁：`node scripts/check.mjs` **6/6**、`--self-test` **15/15**。

## [1.1.0]

首个公开版本。
