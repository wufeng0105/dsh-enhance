# dsh-enhance

给 DeepSeek Harness 的本地破甲插件。

核心只有一件事：把 `<DSH_HOME>/enhance/content-scope.txt` 里的一段纯文本，追加到系统提示的最后一个槽位（官方 `DEPLOYMENT_PERSONA_SUFFIX` 档，section `enhance:content-scope`），每条消息都带。换成破甲提示词，模型的行为就跟着变——效果取决于你写的文本和目标模型，本工具不内置提示词库。

**兼容**：dsh-enhance `1.0.0` · DeepSeek Harness `0.2.1-rc.3`（验证基线）· Node.js ≥ 22 · 不需要 `npm install`。升级 DSH 后先跑 `node doctor.mjs --home <DSH_HOME>`；权限菜单图标那份派生件要按新版本重新生成（`node enhance-permissions/build-client.mjs --asar "<DSH_ROOT>\resources\app.asar"`），否则图标可能对不上新宿主。

## 它到底改了什么

宿主本体不碰：不修改 `app.asar` / 宿主源码，宿主内置的系统提示、工具说明、基础人格段都不动。会动的是 profile 配置和 `<DSH_HOME>/enhance/`：

| 位置 | 安装时做什么 |
|---|---|
| `<DSH_HOME>/enhance/` | 落 4 个插件 + 共享模块 + `uninstall.mjs`；`state.json` / `content-scope.txt` 缺失才种，已存在不覆盖 |
| `profiles/<profile>/cordis.patch.yml` | 追加 3 行 insert：`enhance-scope`、`auto-approve`、`enhance-ui` |
| 同上 · desktop 档 | 把官方 `ui-permission` 行停用（`disabled: true`），插入本工具的权限菜单副本 `enhance-permissions` |
| 同上 · 权限预设 | 补一个 `enhanced` 档（`sandbox: danger-full-access` + `approval: ask`）；原来没有默认档时，把默认档设成 `enhanced` |
| 同上 · 人格后缀 | 如果写了内联 `personaSuffix`（部署人格后缀）或预设 `suffix`，会清成 `''`——内容边界要占那个槽位 |
| 备份 | 每次改前留 `cordis.patch.yml.bak-enhance-<时间戳>`；默认卸载按备份/清单还原，干净路径逐字节一致 |

这些改动 `--dry-run` 会逐条打印出来，装之前可以先看。

## 安装

```powershell
git clone https://github.com/wufeng0105/dsh-enhance.git
cd dsh-enhance

node install.mjs --home <DSH_HOME> --dry-run   # 1. 先看每个 profile 会改哪几行
node install.mjs --home <DSH_HOME>             # 2. 真装：有变化才备份 patch
node doctor.mjs  --home <DSH_HOME>             # 3. 全 PASS 后重启 DeepSeek Harness
```

- `<DSH_HOME>` 是 DSH 的 home，常见是 `%USERPROFILE%\.dsh`。
- 默认只装 `desktop`；`headless` / `web` 用 `--profiles` 指定（这些 profile 必须已经有 `cordis.patch.yml`）；`--all` 装当前 home 已存在的全部 profile。
- 装完只提示「请重启 DeepSeek Harness」，不会自动重启。
- 不想敲命令：双击仓库根的 `enhance-install.cmd`（中文菜单；`-Yes` 非交互，`-DryRun` 只预览）。
- 重启后在 DSH 设置页的 enhance 一节点一次「开始检查」，确认注入真的生效。

## 使用

改 `<DSH_HOME>/enhance/content-scope.txt`：一段纯文本，存盘即生效，下一条消息就带；上限 8 KB（去 BOM、CRLF 折成 LF、去控制字符、trim）。仓库根的 `content-scope.txt` 只是首次安装时种入的默认文本，目标文件已存在就不覆盖。

开关在 `<DSH_HOME>/enhance/state.json`：

| 键 | 首装种子 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 全部停手 |
| `contentScope` | `true` | 是否注入内容边界 |
| `approval` | `allow` | `allow` 自动放行 / `ask` 问人 / `deny` 拒绝。宿主默认档位是 `approval: never` 时种 `ask`；运行时状态缺失或损坏，一律回落到 `ask` |

**首装审批种子是 `allow`**：装完默认自动放行工具审批、不再弹窗。不想这样，就在设置页把它改成 `ask`（每次都问）或 `deny`（直接拒）。

也可以在 DSH 设置页的 enhance 一节里操作：改文本、改开关、检查注入（读会话日志，确认那段文本真的进了系统提示）、发起卸载。

## 卸载

```powershell
node uninstall.mjs --home <DSH_HOME> --dry-run   # 先看计划
node uninstall.mjs --home <DSH_HOME>             # 默认：归档后删 enhance/，保留所有 .bak-*
node uninstall.mjs --home <DSH_HOME> --thorough  # 彻底清理：不归档，连本工具造的备份一起删
```

默认卸载把 profile patch 还原到安装前，干净路径逐字节一致。不想敲命令：双击 `enhance-uninstall.cmd`，选 `1` 保留备份 / `2` 彻底清理。

## 让 AI 帮你装

不想自己敲命令：把下面整段发给任意 AI（Claude / Codex / 你自己的 DSH 会话都行），它会照做。

```text
帮我在这台机器上安装 dsh-enhance —— 一个 DeepSeek Harness 的本地破甲插件。
仓库：https://github.com/wufeng0105/dsh-enhance

要求：
1. 先确认 Node.js ≥ 22，并且本机已经装好 DeepSeek Harness。
2. clone 仓库，先跑 `node install.mjs --home <DSH_HOME> --dry-run`，把输出原样贴给我。
3. 我确认后再跑 `node install.mjs --home <DSH_HOME>`。
4. 然后跑 `node doctor.mjs --home <DSH_HOME>`，把每一行输出原样贴给我。
5. 全 PASS 后停手，只告诉我「请重启 DeepSeek Harness」；不要自动重启、不要改 DSH 源码、不要动别的插件和配置。

如果我不知道 <DSH_HOME> 是哪，先把 DSH home 找出来告诉我，不要猜。
```

## 图

![运行期架构：enhance 只通过 patch 行接入宿主](docs/images/01-runtime-architecture.png)

*运行期架构：enhance 只通过 patch 行接入宿主，不改宿主源码。*

![一条消息的一生](docs/images/02-message-lifecycle.png)

*一条消息的一生：内容边界怎么进系统提示，以及怎么用会话日志证明它真的进去了。*

![四道门：为什么这次没有注入](docs/images/04-injection-gates.png)

*四道门：总开关、内容边界开关、文本非空、文本不超过 8 KB——哪道没通过、原因是什么。*

![审批三态](docs/images/05-approval-three-states.png)

*审批三态：allow / ask / deny 分别回什么，以及状态坏了为什么回落到 ask。*

## 许可

[MIT](LICENSE)
