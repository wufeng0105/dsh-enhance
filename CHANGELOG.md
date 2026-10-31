# 变更记录

本文件自 `1.1.0` 起维护；版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，条目格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
