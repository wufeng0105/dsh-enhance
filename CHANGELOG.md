# 变更记录

本文件自 `1.1.0` 起维护；版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，条目格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
