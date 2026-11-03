# BOOTSTRAP — 新会话从这里开始

> 你（Agent）此刻没有任何关于本仓库的对话上下文。本文把接手维护所需的状态从会话记忆搬进仓库。
> **先读 CONTRIBUTING.md**——那是操作规程的权威，本文只做入口、红线与挂起项，不复制步骤。

## 这个仓库是什么

**当前状态快照**（写就之时；动手前先现查）：版本 1.3.2 已发布，`node scripts/release.mjs --check` 报六处一致，工作区干净。

`wufeng0105/dsh-enhance`（本机路径 `Documents\ProgramFilesCode\tools\dsh-enhance`），npm 包 `@wufeng0105/dsh-enhance`。一个 DeepSeek Harness 的插件 bundle：换掉系统提示开头的品牌声明句、在末尾追加用户自定义文本，配越界审批三态、可选权限档与检查项。定位层的说法是「破甲」（见 README 开篇）；面向改动者的术语与四层分工见 [docs/terminology.md](docs/terminology.md)。

**发布史里有三个不会自动纠正的坑**，动版本号之前先读：

- `2.0.0` 已被 npm 永久烧毁（曾发布后整包撤除），**下一个 major 是 2.1.0，不是 2.0.0**。发版脚本会拦，别绕。
- npm 上有个 `0.0.0-stage` 占位版本，是 npm 暂存流程的副产物，无害、别删。
- `1.2.0` / `1.2.1` 只有提交、没有 tag 与 Release，历史事实，别回补。

## 环境事实（命令的前提，省一步就打错地方）

- 网络代理 `127.0.0.1:7897`。`gh` 与 npm 官方源都要走它：临时 `$env:HTTPS_PROXY='http://127.0.0.1:7897'`，**别写进全局环境变量**（git 已配好，不用管）。
- 本机 `~/.npmrc` 的 registry 指向 `registry.npmmirror.com`——**只读镜像，发不上去**。凡查官方源、发 npm，命令必须显式带 `--registry https://registry.npmjs.org/`。
- `dsh` CLI 不在 PATH：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。
- `gh` 已登录（`wufeng0105`）。npm 登录用浏览器授权（`npm login --registry https://registry.npmjs.org/`），token 类凭据不落本机 `.npmrc`。
- 对话与文档一律简体中文。

## 红线（七条，按踩到后的破坏力排序）

1. **不要 unpublish 或删除 npm 包。** 烧掉一个永久不可重用的版本号，还会连带删掉市场侧的配置（历史上那包「2.0.0 → 整包撤除 → 重发 1.3.0」就是这一刀）。
2. **不要 force-push `main`。** 分支保护开着（禁强推、禁删分支）；npm 上的发布版与提交的对应关系一旦被改写，仓库里再也说不出它对应哪次提交。
3. **发版只走 `--ship`，不要 `--publish --otp`。** 验证码由验证器 App 生成、30 秒有效，只有人拿得到——Agent 走这条路必卡死。CI 用仓库 secret `NPM_TOKEN` 发布。
4. **不要改 `package.json` 的 `name`。** 它与 `cordis.patch.yml` 入口前缀、老用户 profile 依赖键、两个 README 的命令三处绑定。
5. **不要把 `private: true` 加回 `package.json`。** `npm publish` 直接拒绝，version 门也会红。
6. **`.zhll/` 永不入库**（本地草稿与审计档案）。它没有门禁守着——只有提交前看一眼改动清单这一道人防。
7. **不要绕过门禁，也不要放宽断言求绿。** 门禁全绿不等于没问题——历史上有过发版脚本带着 ReferenceError 而门禁全绿，那之后才有了 syntax 门里的 `release.mjs --dry` 冒烟。红灯修到绿，绿灯才可信。

## 例行公事（改完代码之后的完整动作）

改动收敛后：

```powershell
node scripts/check.mjs              # 门禁（七道）
node scripts/check.mjs --self-test  # 负例，证明每道门真的能红
```

发版与发 npm 是同一条链，**唯一入口**：

```powershell
node scripts/release.mjs patch --ship
```

发完核对：

```powershell
node scripts/release.mjs --check
```

发版后的传播节奏：CI 约半分钟跑完，npm registry 的 `latest` 要再等 5–10 分钟才可读——**别把延迟当失败**。

要动宿主相关的东西，先读 [docs/compatibility.md](docs/compatibility.md)：`engines.dsh` 是硬闸，DSH 出新版本（rc 或正式版）都要先跑那边的例行核验再扩区间。

## 核对纪律（这个仓库最看重的东西）

- **不信任何脚本自己的结论。** `--check` 过了，还要独立核：直连 registry（绕代理、破缓存）、`git ls-remote` 查远端标签、`git show <tag>:VERSION` 查标签指向的提交里写的是哪个版本。历史上 tag 与 VERSION 错位这类问题，`--check` 自己看不见。
- **门禁全绿 ≠ 没问题。** 曾经有发版脚本带着 ReferenceError 门禁全绿——所以 syntax 门里加了 `release.mjs --dry` 冒烟。新代码若同样「只解析不执行」就能过门，要想一想该给它配什么哨兵。
- **每个对外声明要有证据与出处。** 核验结果写进 [docs/compatibility.md](docs/compatibility.md) 的核验记录表，一节一格式：做了什么、结果、复跑条件。
- **改完跑冒烟**：`tools/smoke.ps1`（一次性 `DSH_HOME`，不碰日常 profile）。

## 挂着的事（Agent 要盯的信号）

| 事项 | 触发信号 | 该做什么 |
|---|---|---|
| 包根 `index.js` 绕行的拆除 | 上游修复合入 **npm `latest`** 渠道 | 三处一起拆：删 `index.js`、删 `package.json` 的 `main`、删 `gateBundle` 里那段判定。只拆一处 bundle 门会红 |
| `NPM_TOKEN` 到期（2027-02-01） | `--check` 剩 30 天判红（`consistency` 工作流每天自动跑） | 按 [.github/npm-token-expiry.json](.github/npm-token-expiry.json) 里的步骤换 |
| DSH 出 0.2.1 正式版或新 rc | `version` 门会红（semver 陷阱：正式版大于 rc 上界） | 按 docs/compatibility.md 例行核验，过了再扩区间 |
| 市场详情页 README 落后于仓库 | awesome-dsh-plugin 每夜采集自动追平 | 不用管；只有**卡片描述文字**要改上游 `data/plugins/wufeng0105__dsh-enhance.yml` 提 PR |

## 对上游（两个外部仓库）

**awesome-dsh-plugin**（收录目录）：本插件的市场卡片描述在它的 `data/plugins/wufeng0105__dsh-enhance.yml`，改动走 PR、由其维护者（`fkysly`）合并。npm 关联字段（版本、下载量）由每夜采集自动填，**条目里不许手写 `npm:`**。关联前提是包的 `repository` 指回 GitHub——已满足。

**dsh-market/dsh-market**（市场插件本体，MIT、活跃）：装后校验 `hasLoadableEntry` 误判「载体自身子路径」的问题已提 **#1091**，维护者确认判定链并已修复进 nightly（提交 `e5107cb`）。提新 issue 用它的 `bug_report.yml` 模板，参考 #906 的体例：给 `file:line`、用市场自己的函数复算、附最小复现。

## 没闭环的（诚实清单）

- **真机会话上的装配层验收**：模型凭据余额为 0，一直阻塞（`QUOTA: Insufficient Balance`）。有的只是门禁、冒烟与合成日志。
- **根 `index.js` 绕行仍在**：上游已修但未进 npm `latest` 渠道，拆除要等它发布并观察。
- **市场报错文案**（把入口判定失败说成「需要构建授权」）：维护者在 #1091 里记了，单独一条处理，未修。

## 边界（哪些先问人）

维护动作——改代码、过门禁、发版、对上游提 issue——不必请示。要问人的只有三类：

- **发布身份与凭据**的任何变更（换 `NPM_TOKEN`、配 trusted publishing）——凭据属于账号，Agent 不持有也不该自作主张；
- **仓库设置**（分支保护、workflow 权限）的开关——先例与理由都写在 CONTRIBUTING 的「仓库设置与已知取舍」，偏离既定取舍要人拍板；
- **动用户的本机环境**（日常 profile 里装的插件、`.npmrc`、浏览器）——那些不在「只管源码」的范围内。

## 一句话收尾

权威在 CONTRIBUTING 与 docs/；证据在 docs/compatibility.md 的核验记录；红线在上文七条；除此之外，改完跑门禁，发版跑 `--ship`。
