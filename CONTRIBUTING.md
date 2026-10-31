# 参与开发

## 这个仓库是什么

一个 DeepSeek Harness 的**插件 bundle**：往宿主系统提示的末尾追加一段用户自己写的文本，另配越界审批三态、一个可选的自定义权限档、以及一次性的「它到底进没进提示词」检查。它不碰宿主程序，也不碰宿主自带的提示词。

## 环境

- Node.js **≥ 22**
- 一个可用的 DeepSeek Harness（版本在 `package.json` 的 `engines.dsh` 区间内）
- 端到端冒烟另需 `pwsh`（PowerShell 7）与 `dsh` CLI

## 改之前先跑一遍门禁

```powershell
node scripts/check.mjs              # 六道闸：version / syntax / tests / graph / docs / bundle
node scripts/check.mjs --self-test  # 15 个负例，证明每道闸都真的能红
```

CI 在 `windows-latest` 上跑 `--layer fast`（`.github/workflows/ci.yml`）。**PR 要让这两条都 exit 0。**

## 四条硬约束（踩了必红）

1. **新源码文件必须登记进 `code-map.json`。** `graph` 门会列出「源码未登记」的文件。登记时写 `id` / `layer` / `path` / `owns`；前三个是判据，别随手改。
2. **`VERSION` 与 `package.json` 的 `version` 必须逐字相同**，且 `private` 必须是 `true`——这不是 npm 包，是 profile bundle。
3. **README 的「适用版本」句由 `package.json` 派生**，`version` 门逐字校验。要扩区间就改 `engines.dsh` 与 `dsh.compatibility`，README 那句会被门禁逼着你同步。
4. **文档里的相对链接与反引号路径必须真实存在**。`docs` 门查死链、死路径，也查正文里写坏的字面 `\n` / `\t`。

## 改测试之前先读这条

`tests/` 里有若干**锁定串**——UI 文案、检查项标题、四个设置组名等。它们断言的是「这一串必须出现在产品文本里」。改产品文案撞到锁定串时，**连测试一起改，并在 PR 里写清改了什么、为什么**；不要为了绿灯放宽断言。

结构测试里还有**切片弱锁**：某些断言只要求「该串出现在某段源码里」，所以改掉一处同名文本时测试可能仍绿。遇到这种情况按名字核对，别假设绿灯就等于没破坏。

## 术语与文风

[`docs/terminology.md`](docs/terminology.md) 是术语的**唯一权威**：一个东西一个名字；中文界面名与机读标识符 1:1 对应、不许合并；另有几组「看着像同一个东西、其实不能合并」的例外。**改任何面向人的文案之前，先对一遍这张表。**

## 目录

| 路径 | 管什么 |
|---|---|
| `enhance-scope/` | 内容边界注入 + `/enhance/api` 路由 + 本机版本探测 |
| `auto-approve/` | 审批三态（自动同意 / 先问我 / 自动回绝） |
| `ui/` | 设置页：服务端半（`index.js`）与浏览器半（`client.js`） |
| `shared/` | 状态、权限档、兼容声明、会话探针 |
| `scripts/` | 门禁总入口与它的工具件 |
| `tools/` | 结构图、文档门禁、端到端冒烟 |
| `docs/` | 兼容性说明、术语账本 |
| `showcase/` | 给用户看的原理讲解页 |

## 兼容性

`engines.dsh` 声明了核验过的宿主版本区间，宿主自己在**安装**与**启动**时都会执行它。要把新版本并进区间，先按 [`docs/compatibility.md`](docs/compatibility.md) 的例行核验跑一遍（约 15 分钟）。

## 提交与 PR

- 一个逻辑改动一个提交，信息写清「改了什么、为什么」
- PR 里贴 `check.mjs` 与 `--self-test` 的输出
- 不要提交 `.zhll/`、`.tmp/`、`.codegraph/`（已在 `.gitignore` 里）
