# dsh-enhance

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的本地增强件：把「内容边界注入」「审批三态开关」「设置页」做成可开关、可验证、可退出的三件事。

它不修改宿主源码，只通过 profile patch 里的几行接进去。当前版本 **1.0.0**，在 DeepSeek Harness `0.2.1-rc.3` 上验证过。

## 它解决什么

**提示词里的边界应该可编辑、可审计。** 想让模型"动文件前先读"，不该去改代码或重启宿主；应该是一段能随时改、改完下一条消息就生效的文本。

**审批应该可预期。** 「这次工具调用放不放行」应该有明确的三种答案（放行 / 问人 / 拒绝），而不是散落在各处的默认值；状态读坏了要回落到「问人」，不能静默放行。

**改动应该可退出。** 装了什么、改了哪几行、怎么还回去，都要有账可查；默认卸载要能逐字节还原，不把用户的配置留在半路。

## 能力

| 能力 | 做什么 | 开关 |
|---|---|---|
| 内容边界注入 | 把 `content-scope.txt` 里的文本接在系统提示末段（section id `enhance:content-scope`），每条消息都带 | `state.json` 的 `contentScope`；总开关 `enabled` |
| 审批三态 | 拦到 `approval/request` 之后：`allow` 回 `allowed-once`、`ask` 交还宿主审批界面、`deny` 回 `rejected` | `state.json` 的 `approval` |
| 设置页 | 五节：结论 / 审批 / 内容边界 / 检查 / 卸载；改开关、改文本、检查注入、发起卸载 | 宿主设置页里的 enhance 一节 |

三个能力都还提供：

- **检查注入**：读会话日志的 system 事件原文，证明那段文本真的进了系统提示，而不是「插件挂上了」。
- **权限菜单图标**：desktop 档的权限菜单多一个 `enhanced` 字形（沙箱全开 + 审批仍问人）。

**明确不做**：改文件前先读（先读后写）不在这里——它由宿主自带的 `fs-observation-policy` 管，装/卸都不读不写那一行。

## 怎么工作

- 宿主启动时读 `profiles/<profile>/cordis.patch.yml`。安装只做**行级追加**：一个 `insert` 块（三个插件入口）加上 desktop 的权限替换行；已有行一个字节不动。
- 插件与共享层落在 `<home>/enhance/`；`<home>/enhance/state.json` 与 `<home>/enhance/content-scope.txt` 是开关与文本的唯一真相，插件每次装配重读。
- 设置页由 `ui/` 提供，通过 `POST /enhance/api` 读写这两个文件；接口按「回环 socket + 回环 Host + Origin 严格同源」判定。
- 每次安装会把「写了什么」记进 `<home>/enhance/install-manifest.json`；卸载按这份清单认领，认不出归属的行保持原样并告警。

想按图理解这些流程：clone 之后用浏览器打开 [`showcase/index.html`](showcase/index.html)——12 张图按顺序讲完架构、时序、注入条件、审批、装退、门禁与失败边界。

## 安装

要求：Node.js ≥22；DeepSeek Harness 已经装好（本工具不下载宿主的安装包）。

```powershell
node install.mjs --home <DSH_HOME> --dry-run   # 先看要写什么
node install.mjs --home <DSH_HOME>             # 真装：有变化才备份 patch
node doctor.mjs  --home <DSH_HOME>             # 全 PASS 再重启 DeepSeek Harness
```

- 默认只装 `desktop`。`headless` / `web` 用 `--profiles` 显式指定，且这些 profile 必须已经有 `cordis.patch.yml`；`--all` 装当前 home 已存在的全部 profile。
- **一个可装的 profile 都没有时，安装在任何写盘之前拒绝**（退出码 1），不会留下「插件在、但没有任何 profile 引用」的绿色空操作。
- 装完只打印 `请重启 DeepSeek Harness 使改动生效`，不自动重启。

不想敲命令：仓库根的 `enhance-install.cmd`（双击走中文菜单）与 `enhance-uninstall.cmd` 做同一件事，带 `-Yes` 是非交互模式，带 `-DryRun` 只预览。

## 使用

改 `<DSH_HOME>/enhance/state.json` 或 `<DSH_HOME>/enhance/content-scope.txt`，存盘即可：下一条消息就按新值来，不用重启。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 三件事一起停手 |
| `contentScope` | `true` | 是否允许注入内容边界 |
| `approval` | `ask` | `allow` / `ask` / `deny`；状态缺失、损坏或值不认识时回落到 `ask`（问人，不静默放行） |

文本规则：去 BOM、CRLF 与 CR 折成 LF、去控制字符、trim；上限 8 KB，**写入与读取两侧都生效**——设置页写入超限返回 413 `ETOOLARGE`；直接编辑文件写成超限不会注入，`doctor --home` 会判红。

`enhanced` 档位固定是「沙箱全开 + 审批仍问人」（`sandbox: danger-full-access` + `approval: ask`）；被改窄时 `doctor --home` 判红。

## 卸载

```powershell
node uninstall.mjs --home <DSH_HOME> --dry-run   # 先看计划
node uninstall.mjs --home <DSH_HOME>             # 默认：归档，然后删 enhance/，保留所有 .bak-*
node uninstall.mjs --home <DSH_HOME> --thorough  # 彻底清理：不归档，连本工具造的备份一起删
```

- 默认方式把 `state.json` / `content-scope.txt` / `install-manifest.json` 归档到 `<home>/enhance-archive-<时间戳>/`，再把 profile patch 还原到安装前（干净路径逐字节一致）。
- `--thorough` 不可逆，设置页要二次确认；别人写的 `.bak-*` 一个不碰。
- 想只回滚一个 profile 的 patch：`uninstall.mjs --home <home> --to <备份> --profiles <单个 profile>`；它只回滚 patch，保留 `<home>/enhance/`。
- 从归档恢复：`install.mjs --home <home> --restore <归档目录> [--replace]`（只取 state 与文本，不恢复旧清单）。

不想敲命令：`enhance-uninstall.cmd` 双击后选 `1` 保留备份 / `2` 彻底清理。

## 升级 DeepSeek Harness 之后

1. 派生件与宿主版本耦合，先判代际：

   ```powershell
   node enhance-permissions/build-client.mjs --check --asar "<DSH_ROOT>\resources\app.asar"
   ```

   退出码 0 = 同代且补丁仍落得下；非 0 = 在新 asar 上重新派生（去掉 `--check`）后再装。

2. 落盘侧核对，然后重启：

   ```powershell
   node doctor.mjs --home <DSH_HOME>
   ```

3. 打开设置页点一次「开始检查」，确认新会话的系统提示末段带内容边界、审批三档行为正确。

## 仓库结构

```text
enhance-scope/        内容边界注入插件（systemPrompt.section + /enhance/api）
auto-approve/         审批三态插件（approval/request）
enhance-permissions/  权限菜单图标插件 + client.js 派生物 + build-client.mjs
ui/                   设置页（宿主 web 里渲染）
shared/               state / text-lines / session-probe / patch-rows / tool-version
install.mjs           幂等安装：拷文件、种文本与状态、写三行 insert、记清单
uninstall.mjs         行级卸载 / --to 单档回滚 / --thorough 彻底清理
doctor.mjs            落盘预检（13 项）
scripts/              门禁入口 check.mjs、使用者脚本逻辑、code-files、install-hooks
tools/                graph.mjs（代码 → 图）与 docs-check.mjs（文档门禁）
tests/                193 条 node:test
showcase/             12 张图的单文件展示页（index.html）与各图源文件
VERSION               版本唯一来源（package.json 的 version 与它由门禁守住一致）
```

## 质量与门禁

```powershell
node scripts/check.mjs --layer full   # 七道 fast 门禁 + 两道 full 门禁
node scripts/check.mjs --self-test    # 26 条负例：每条都必须红
node --test "tests/*.test.mjs"        # 193 条测试
```

七道 fast 门禁：`version`（版本三处一致）、`syntax`（37 个源文件）、`tests`、`doctor`、`graph`（模块 / import 边 / 接缝登记）、`docs`（死链与死路径）、`lifecycle`（install → doctor → uninstall → 还原成 `[]`）。full 层多 `graph-strict`（逐字节比图）与 `build-client`（派生件与给定 asar 同代），没有外部产物时记 `SKIP`，不算 PASS。

负例不造坏产物，而是**把守卫改回旧写法**，看守卫它的测试红不红——红了才说明守卫在吃劲。

## 兼容性

- DeepSeek Harness `0.2.1-rc.3`（验证基线）；派生件与宿主版本耦合，升级后按上一节重判。
- Node.js ≥22（会话日志解压要 zstd 支持）。
- 两个薄壳脚本面向 Windows PowerShell 7；核心（`install.mjs` / `uninstall.mjs` / `doctor.mjs` / 门禁）是纯 Node，路径处理跨平台。
- 不需要 `npm install`：仓库没有运行时依赖。

## 已知限制

- `approval: never` 的档位：宿主在分发前就拒掉审批请求，本层的 `allow` 轮不到；要生效请用 `approval: ask` 的档位（例如 `enhanced`）。
- patch 只做行级追加，不解析整份 YAML：结构坏要靠人看，`doctor` 能抓「行不在 / 半装 / 未接线」，抓不了「行在但结构坏」。
- 无 Origin 的请求（curl / CLI / Electron 主进程）直接放行；接口没有额外 token。
- 会话探针读的是最新一份会话文件：多工作区并行时可能读错对象。
- `desktop` 档由 Electron 应用独占，CLI 的 `--dump-config` 不适用；用 `doctor --home` 的 `patch:<profile>` 行核对。
- `doctor` 只验派生件带没带来源戳；「是不是同一代」要靠 `build-client --check --asar`。

## 开发

```powershell
git clone https://github.com/wufeng0105/dsh-enhance.git
cd dsh-enhance
node scripts/check.mjs                 # fast 层
node scripts/check.mjs --self-test     # 门禁自身能红
node --test "tests/*.test.mjs"
```

改图或改展示页：`showcase/figures/` 是每张图的源，`showcase/index.html` 是把它们拼成的单文件页面。

## 版本与许可

- 当前版本 `1.0.0`。版本只有一个来源：根 `VERSION`；`package.json` 的 `version`、安装写进清单的 `toolVersion` 由 `version` 门禁守住一致。
- 以 [MIT 许可证](LICENSE) 发布，许可证全文见根目录 `LICENSE`。
