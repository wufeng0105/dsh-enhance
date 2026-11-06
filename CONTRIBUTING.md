# 参与开发

这份文档给零上下文接手的人：装的是什么、改一处会撞上什么、哪些线不能碰、怎么改怎么发。

每件事在这组文档里只在一处展开，别处只指向。插件能干什么看 [README.md](README.md)；DSH 出新版怎么体检看 [docs/compatibility.md](docs/compatibility.md)；品牌人设的设计边界看 [docs/brand-persona.md](docs/brand-persona.md)；版本改了什么看 [CHANGELOG.md](CHANGELOG.md)。

## 这是什么仓

`@wufeng0105/dsh-enhance` 是 DeepSeek Harness 的插件 bundle：装进 profile 后由宿主加载，靠 `cordis.patch.yml` 里三条插入（`enhance-scope` / `auto-approve` / `enhance-ui`）接上宿主，不碰宿主程序本身。对外定位叫「破甲」，那是入口页的说法；设置页与契约里另有名字，见「术语与命名」。

文件分四层，只有产品层进用户机器：

| 层 | 在哪 | 谁读 |
|---|---|---|
| 产品层（发货） | `index.js`、`enhance-scope/`、`auto-approve/`、`ui/`、`shared/`、`content-scope.txt`、`cordis.patch.yml` | 宿主 |
| 验证机器（不发货） | `scripts/`、`tools/`、`tests/`、`.github/` | 门禁与 CI |
| 文档（多数不发货） | `README.md`、`README.en.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`LICENSE`、`docs/` | 人；`docs/` 的计数声明同时被门禁比对 |
| 声明数据（两侧都读） | `package.json`、`VERSION`、`code-map.json`、`scripts/known-counts.json`、`scripts/host-fields-allowlist.json` | 门禁现场读，文档里的声明位跟着它走 |

| 路径 | 管什么 |
|---|---|
| `enhance-scope/` | 内容边界注入 + `/enhance/api` 路由 + 本机版本探测 |
| `auto-approve/` | 审批三态（自动同意 / 先问我 / 自动回绝） |
| `ui/` | 设置页：服务端半（`index.js`）与浏览器半（`client.js`） |
| `shared/` | 状态、权限档、会话探针 |
| `scripts/` | 门禁总入口、发版脚本、它的工具件 |
| `tools/` | 结构图、文档门禁、端到端冒烟 |
| `docs/` | 升级体检手册、宿主接缝表、品牌人设契约 |

## 改动时要守的边界

不碰宿主程序；默认设置下，除声明层那几处外，也不碰宿主自带的提示词——声明层的定义见「术语与命名」。可选的「隐藏宿主说明」不是纯品牌改动：它会连着抹掉两段带操作约定的文字与两条 runtime context，代价逐条列在 [docs/brand-persona.md](docs/brand-persona.md) 的对照表里，改文案时别写成「只是换个名字」。

改界面相关的东西要记住一条：浏览器半装不装得上挂在 `ui/package.json` 的两行上，删了设置页整个消失，服务端功能还在。bundle 门钉着这两行；宿主侧的规则与后果在 [docs/host-seams.md](docs/host-seams.md)。

写「Enhanced 权限档」时要记住两条宿主事实：

- **patch 的 `config` 是整块替换，不是深合并。** 在 profile patch 里写 `- id: permission` 加一条 `enhanced`，基础组合包的 `read-only` / `workspace-write` / `danger-full-access` 会全部消失（`dsh --profile <p> --dump-config` 可复现），所以写档时写的是完整档位表：宿主基础三档 + `enhanced`。
- **`enhanced` 是合法的自定义档名。** 保留名只有 `custom` 与 `auto`，本包不配置它们；`approval: ask` 合法——这里的 `approval` 是审批策略 `approval/policy`，与三态的开关档 `approval` 不是一套词表（见「术语与命名」）。未知 kebab-case 档名在菜单里渲染成 Title Case 的纯文字行，patch 里写 `enhanced`、菜单里显示 **Enhanced**，同一个档的两个名字。

设置页版本行只显示「增强 <本包版本>」。`enhance-scope/index.js` 的 `compatSnapshot` 仍按 [docs/host-seams.md](docs/host-seams.md)「版本探测链」那一行的顺序探测本机版本，探测值不上页面、只作诊断，读不到时 `attempts` 说清断在哪一层——别因为页面不展示就把服务端这段删掉。

## 改之前先跑一遍门禁

```powershell
node scripts/check.mjs              # 全部门禁
node scripts/check.mjs --self-test  # 至少 19 个负例，证明每道门禁都真的能红
```

门禁是 version / syntax / tests / graph / docs / readme / bundle；门数不写进文档，以 `node scripts/check.mjs` 的输出为准。CI 在 `windows-latest` 上跑这两条，PR 要让它们都 exit 0。

「全绿」有两种：真的没问题，和门禁已经失效。负例排除后者——每条负例在**负例名册**里登记它守哪道门，删掉一条、或把它改挂到别的门，都会红。

**改动的入口不是读代码，是找家。** 门禁判的是「声明与实际对不对得上」：先找这条事实的单一来源（`package.json` 的 `name` / `version`、`VERSION`、`code-map.json`、`scripts/known-counts.json`、`scripts/host-fields-allowlist.json`），改那一份，再让门禁把散在各文档里的声明位逼成一致。手抄数字那一侧永远是被核的一方，不是权威。哪一种改动牵动哪份声明，按「改动会被谁挡住」查表，别背。

门禁判不了的三类事落在纪律上：秘密（发布身份走 `NPM_TOKEN` 还是 OIDC，取决于仓库有没有 secret）、真机（装不装得上，只有一次性 `DSH_HOME` 的真装冒烟能回答；真机用 `pwsh` 7，不要用 `powershell` 5.1，它的 `-Encoding utf8` 会写 BOM）、外部状态（npm 撤没撤过号、上游修没修）。

环境：Node.js ≥ 22；一个可用的 DeepSeek Harness（无版本限制）。冒烟另需 `pwsh` 与 `dsh` CLI。

## 改动会被谁挡住

分两类：门禁会红的，和没有门禁、靠纪律的。

### 门禁会红的

| 你改了什么 | 门禁 | 要同步什么 |
|---|---|---|
| 加 / 删测试、改 `--self-test` 负例 | tests、docs | [`scripts/known-counts.json`](scripts/known-counts.json) 的 `tests` / `selfTestCases` |
| 改冒烟断言数 | docs | `tools/smoke.mjs` 的 `EXPECTED_ASSERTIONS` 与 `known-counts.json` 的 `smokeAssertions`，两处必须相等 |
| 新增常驻源码文件 | graph | `code-map.json` 登记；新增 `ctx.on(...)` 事件还要登记 `events` |
| 改 `cordis.patch.yml` 的入口 | bundle | 入口 `name` 必须指向真实存在的文件，且前缀等于 `package.json` 的 `name` |
| 删掉包根的 `index.js` 或 `package.json` 的 `main` | bundle | 市场插件装后会判这个包 broken 并当场删除（上游 dsh-market/dsh-market#1091） |
| 改 `package.json` 的 `name` | version、bundle、readme | `cordis.patch.yml` 的入口前缀、两个 README 里 `dsh plugin add` / `remove` 的包名 |
| 改 `VERSION` 或 `package.json` 的 `version` | version | 两处必须逐字相同 |
| 增删 README 的二级标题 | readme | 有目录则须覆盖全部二级标题 |
| 写坏文档里的相对链接或反引号路径 | docs | 两者都必须真实存在 |

新增常驻源码（不含 `scripts/`、`tests/`）必须登记进 `code-map.json`，写 `id` / `layer` / `path` / `owns`；门禁真正比对的是 `id` 与 `path`。

有两类原先挡、后来按维护成本放开了：README 有没有目录（可选）；README 增删章节导致的检查项数变化（不再钉在 `known-counts.json` 上）。

### 靠纪律的

| 事项 | 怎么守 |
|---|---|
| `.zhll/` 永不入库 | 它在 `.gitignore` 里，语法门也跳过它；提交前看一眼改动清单，别 `git add -f` |
| 计数键不许删 | 计数门按现有键逐个比对，键没了那项比对就消失且不会红；只改值、加键，不删键 |
| 发布身份走哪条腿 | 取决于仓库有没有 `NPM_TOKEN` secret，看 `release.yml` 里「选发布身份」那一步的日志 |
| 工作流 action 不钉 SHA | 钉了却没有自动升级会变成「安全补丁永远收不到」；哪天配了 Dependabot 再钉 |
| `main` 禁强推 | 已是仓库设置 |
| npm 账号的 scope 与包名匹配 | 发版脚本的前置检查会替你查 |

`.zhll/` 放本地草稿与审计档案，所以它必须留在本地。

## 哪些线绝对不能碰

越过任何一条，门禁都不会替你喊：

1. **不要 unpublish、不要删 npm 上的版本。** 撤掉的号永久不可再用——`2.0.0` 已经这么烧掉过一次，`release.mjs` 会在写盘前拒绝，别绕。
2. **不要 force-push 或删除 `main`。** 发布出去的版本改不了，历史一旦改写就再也对不上号。
3. **发版只走 `--ship`，不要 `--publish --otp`。** 验证码 30 秒有效、只有人拿得到，Agent 走这条路必卡死。
4. **不要改 `package.json` 的 `name`，也不要把 `private: true` 加回来。** 名字与入口前缀、老用户 profile 依赖键、两个 README 的命令三处绑定；`private: true` 会让 `npm publish` 直接拒绝。
5. **`.zhll/` 永不入库。**
6. **不要删 `scripts/known-counts.json` 的计数键。**
7. **不要绕过门禁，也不要把断言放宽到绿灯。** 删负例、改松断言、把 `selfTestCases` 下限往下压都能变绿，也都让门禁失去意义；这个下限只许增、不许减。

下面三类要人拍板：发布身份与凭据的变更（换 `NPM_TOKEN`、配 trusted publishing）、仓库设置的开关、用户的本机环境。除此之外，改代码、过门禁、发版、对上游提 issue 都不必请示。

## 改测试之前先读这条

`tests/` 里有若干**锁定串**——UI 文案、检查项标题、五个设置组名。它们断言「这一串必须出现在产品文本里」。改产品文案撞到锁定串时连测试一起改，并在 PR 里写清改了什么、为什么；不要为了绿灯放宽断言。

结构测试里还有**切片弱锁**：某些断言只要求「该串出现在某段源码里」，改掉一处同名文本时测试可能仍绿。遇到这种情况按名字核对，别假设绿灯就等于没破坏。

## 术语与命名

这一节是命名的唯一权威：一个东西一个名字；中文界面名与机读标识符 1:1 对应、不许合并。改任何面向人的文案之前先对一遍账本。

命名分三层四套名字，各有分工（三层指产品内的操作 / 契约 / 机读，定位层只活在入口页）。这里的「层」是读者层，与「这是什么仓」的文件四层不是一回事。

| 层 | 用在哪 | 怎么叫 | 谁定 |
| --- | --- | --- | --- |
| 定位层 | 两个 README 的开篇与五条能力 | **破甲**：面向谁、解决什么 | 入口页以一眼读懂为目的，别改成规格书 |
| 操作层 | 设置页五组、四个检查项、`state.json` 字段 | 五个组名 + 四个锁定标题 | 本节 + `CHECK_TITLES` |
| 契约层 | `docs/brand-persona.md`、`docs/compatibility.md`、代码注释 | 「品牌人设」「内容边界文本」「声明层」等精确词 | 本节 |
| 机读层 | 配置值、字段名、档名 | `identity` / `hideHarness` / `text` / `enhanced` | 代码 |

同一个功能在入口页叫「破甲词」、在设置页叫「内容边界」、在状态里叫 `contentScope` / `text`——这不是同物异名，是四个读者层上的四种叫法，强行统一会让任一层变成给另一层的人看的规格书。但**跨层引用必须落到该层的名字**：README 指向设置页用「内容边界」，设置页提到 README 的说法时不要自己编新词。

### 中文界面名 ↔ 机读标识符

两套名字都合法、都要守：中文是给人读的菜单名，标识符是给宿主看的配置值。表锁的是映射本身，不是把两者合并。

| 界面名 | 标识符 | 层 |
| --- | --- | --- |
| 仅可查看 | `read-only` | 宿主档位 |
| 工作区内修改 | `workspace-write` | 宿主档位 |
| 完全权限 | `danger-full-access` | 宿主档位 |
| Enhanced | `enhanced` | 本包添加（表外档名） |

`enhanced` 是表外档名：宿主菜单把它渲染成 Title Case 的纯文字 **Enhanced**，字形表里没有它。patch 里写键名 `enhanced`，菜单里显示 **Enhanced**——同一个档的两层名字，别当两个档。

### 假同物异名：看着像一回事，其实不许合并

- **`suffix` ≠ `personaSuffix`**。前者是 `@deepseek-ai/dsh-persona` 的字段，后者是 `@deepseek-ai/dsh-system-prompt` 的字段——两个插件、两个字段。两者注册同一个段名 `deployment:persona-suffix`、同一个 order `10200`；persona 那一行是 scope-only，挂到全局会与注册表碰撞并直接报错。
- **`custom` / `auto` 是宿主的保留档名**，写进档位表会被宿主直接抛错，不可配置。本包写档时只产基础三档加自己那个 `enhanced`。

### 同名两物：必须加限定词

| 词 | 物一 | 物二 | 消歧写法 |
| --- | --- | --- | --- |
| `ask` | 包内三态键（界面写「先问我」） | 宿主审批策略的取值（`approval: ask`） | 「三态键 `ask`」/「审批策略 `approval: ask`」 |
| `approval` | 开关档：`shared/state.mjs` 的 `{allow, ask, deny}` | 审批策略 `approval/policy`：宿主的 `{ask, never}` | 「开关档 `approval`」/「审批策略 `approval/policy`」 |
| `preset` | 档位（PermissionPreset） | patch 里的一种声明类型（仓内无实指） | 「档位」/「`preset` 声明」 |
| `text` | 内容边界那段文本 | 检查项的机读键 `text` | 「内容边界文本」/「检查项 `text`」 |
| 「检查」 | 门禁：`node scripts/check.mjs` | 设置页第 5 组 | 一律写「门禁」/「设置页的检查项」 |
| 「市场」 | 收录目录 `awesome-dsh-plugin` | 市场插件 `dsh-market/dsh-market` | 「收录目录」/「市场插件」，不单独写「市场」 |

`approval` 最容易踩：同一个模块里就有两套语义。看到这个词先问一句「这是开关档还是审批策略」。最后两行是同一个名字指了两件事，只能拆名，不能选一个留下。

### 核心词「声明层」

**声明层**指系统提示里描述 harness 自身的那些注册项：开场那句自称，以及两段提到它名字的说明（实现目录、界面）——一共 **5 个注册项，落在 3 个名字上**。它不是「提示词的开头」，也不是「所有带品牌的文字」。

| 名字 | 座位 | 注册项 |
| --- | --- | --- |
| `harness:identity` | section | 开场那句自称 |
| `harness:source` | section + runtime context | 实现目录说明（同名两项各算一项） |
| `app:web-surface` | section + runtime context | 界面说明（同名两项各算一项） |

`dsh-enhance` 在默认设置下只在声明层动手，其余段落逐字节保留。**「5 个注册项 / 3 个名字」是本仓唯一口径**；宿主触点的总数与计数口径以 [docs/host-seams.md](docs/host-seams.md) 为权威。其余文档提到「声明层」时引用本节，不复述定义。

### 检查项与设置组名

检查项四个机读键与标题（`CHECK_TITLES`）逐字锁定，改标题要连测试一起改：

| 机读键 | 标题 |
| --- | --- |
| `plugins` | 插件在进程里 |
| `text` | 文字合规 |
| `inject` | 真的进了系统提示 |
| `preset` | Enhanced 档 |

`inject` 这一项的口径随 1.2.0 扩过一次，键与标题仍然不动：它同时验两路——内容边界文本（`sessionContains`），以及品牌人设（`custom` 要在日志里命中 `identity.txt` 的文本；`remove` 要用反向探针 `sessionOmits` 确认**最新一份**含 `system-prompt` 的装配记录里已经没有宿主原句；`keep` 这一路不判）。反向探针只看最新一份：用「最近 N 份都不含」会把切换开关前的旧日志算进来，刚打开遮蔽就永久判红。

设置页五个组名同样以本表为准：**品牌人设**、**内容边界**、**越界审批**、**Enhanced 权限档**、**检查**。README 写这五节时功能名照用这五个；组 3 里那个问句「越界时怎么办」是控件标签，不是组名。设置页那一节本身叫「**增强**」——它既是宿主 `settings.section` 槽位的 label，也是版本行「增强 <本包版本>」开头的那个词，别和五个组名混成一层。

### 「人设」一名三义，必须分写

| 写法 | 指什么 | 机读标识 |
| --- | --- | --- |
| **品牌人设** | 设置页第 1 组；替换系统提示开头那句 `You are an AI agent powered by DeepSeek Harness.` | `identity`（`keep` / `remove` / `custom`）、`hideHarness`、`identityText` |
| **部署人设** | 宿主 `deployment:persona-prefix` / `-suffix` 两段，由 `personaPrefix` / `personaSuffix` 配置与 `@deepseek-ai/dsh-persona` 供给；不是本插件改的东西 | `personaPrefix` / `personaSuffix` |
| **尾巴文字** | 内容边界组里那段用户自写的文本，追加在系统提示末尾 | `text` / `content-scope.txt` |

界面文案里只用「品牌人设」四个字，控件标签不写「人设开关」；内容边界的提示语也不再单独用「人设」。「破甲」不在上述三名之内，它是定位层的对外说法，指内容边界这个能力「用来干什么」——尾巴文字是载体，破甲是用途。

### 声音锚点

短句是常态、长句是例外，不许把短句改成长句；破折号是这个声音的部件，保留；否定式是主力表达（「档位」「只读」「越界」「不猜」四个词保持原样）；量与单位用阿拉伯数字 + 空格 + 单位（`8 KB`），口语量词用中文数字；不写序数词，有序的地方用编号列表，并列的地方用项目符号。

两套语域各有分工：源码注释与测试注释用同侪口吻（第三人称，说「调用方」「这一侧」「人」）；README 与界面文案用对用户口吻（直呼「你」）；README 的「它做什么」首段与五条能力用招揽口吻（短句、直给、只说已实现的能力）。招揽口吻只限入口页开头那一段。

### 一条教训：策略值 ≠ 触发条件

`approval: ask` 或 `never` 描述的是请求被分发时怎么走，不是请求会不会被发出。要断言「什么情况下会发生某件事」，先找触发源，再看配置的取值。审批请求至少有两个触发源——沙箱升级、工具级的 `ask` 决策——只看策略值推结论会推反。

落到本包：设置页那三项面向的是越界（沙箱升级）这条路径。Enhanced 档的沙箱已经全开，这条路径上不产生请求；工具级 `ask` 会不会出现，取决于部署把哪些工具配成需要确认。

## 发版

发版与发 npm 是同一条链，一条命令推上去，剩下的由 CI 做完。

### 发版前必跑：真装冒烟（纪律，门禁替不了）

```powershell
pwsh -NoProfile -File tools/smoke.ps1
```

`--ship` 的门禁全绿只证明静态没坏。这个包吃宿主私有 API，DSH 升级后唯一能证明它还能装、还能跑的东西是真装冒烟：在一次性 `DSH_HOME` 里真装本包、组合出三个入口、验三态与品牌人设遮蔽、写档摘档后再组合，跑完 44 条断言（断言条数的单一来源在 `scripts/known-counts.json` 的 `smokeAssertions`，与 `tools/smoke.mjs` 的常量互相咬）。

它不进 `--ship`、也不进 CI：它要 `pwsh` + 真机 DSH CLI，CI 的 ubuntu runner 给不了。所以它是发版纪律里的硬步骤——每次发版（哪怕 patch）先跑，红了就停下，按 [docs/compatibility.md](docs/compatibility.md) 的「DSH 出新版时怎么体检」查，修完代码再发版。

### 推荐路径：`--ship`

```powershell
node scripts/release.mjs patch --ship
```

它按顺序做完这些，任一步失败就停：

1. 前置检查：工作区干净、在 `main` 上、与 `origin/main` 同步、包名与 `cordis.patch.yml` 的入口前缀一致、目标版本号没有被 npm 撤除过；
2. 把 `VERSION` 与 `package.json` 的 `version` 一起改掉；版本已是目标值时不重写文件；
3. 跑门禁；
4. `npm pack --dry-run` 打出会发出去的文件清单；
5. 提交 `chore: release <版本>`、打标签 `v<版本>`、推分支与标签。

标签推上去后 [`.github/workflows/release.yml`](.github/workflows/release.yml) 接手：核对「标签 == `VERSION`」→ 再跑一遍门禁 → 发到 npm → 用 `CHANGELOG.md` 里 `## [<版本>]` 那一节建 GitHub Release。一次 `--ship` 让版本号、git tag、npm、GitHub Release 四处齐平。

推标签是唯一能真正发布的触发条件；手动触发（`workflow_dispatch`）永远是预演，只跑门禁与打包清单，不发布、不建 Release。

发布身份有两条腿，工作流按仓库有没有 `NPM_TOKEN` secret 自动选：

| 仓库里有 `NPM_TOKEN` | 走哪条 |
|---|---|
| 有 | granular access token（勾了 bypass 2FA） |
| 没有 | OIDC 可信发布（`id-token: write`） |

OIDC 是目标态：把可信发布者配好、再把 secret 删掉，工作流自动切换。长期 token 是条死路——npm 已公告勾了「bypass 2FA」的 granular access token 约 2027-01 起连直接发布也不行。配法与迁移理由见 [CHANGELOG.md](CHANGELOG.md) 的发布史与 [`.github/npm-token-expiry.json`](.github/npm-token-expiry.json)。

### 随时核对：`--check`

```powershell
node scripts/release.mjs --check
```

只读，把 `VERSION`、`package.json`、最新 git tag、npm latest、GitHub Release 与发布凭据到期日并排打出来，任何一处对不上就 exit 1。它们谁也不会自动跟着谁变，所以「一致」不是天然成立的。它不在门禁里（门禁必须能离线跑，而这五处要联网），[`.github/workflows/consistency.yml`](.github/workflows/consistency.yml) 每天跑它一次。

刚发完版的头几分钟别照提示补发：npm 的 `latest` 还没传播，`--check` 会报不一致并让你「补发一次」——包在标签推送后就已经由 CI 发出去了，再发会撞「这个版本已存在」。判据是 `release` 工作流的日志里有 `npm notice 📦 …@<版本>`；有就只需等（实测约 45 秒到几分钟），重跑 `--check` 会自己变绿。

### 本机手动发（人专用）

```powershell
node scripts/release.mjs patch --publish --otp=<6 位验证码>
```

Agent 不要走这条：验证码由验证器 App 生成、30 秒有效，只有人拿得到。它做的前四步与 `--ship` 相同，只是发完之后不提交、不打标签；脚本显式发到官方源 `registry.npmjs.org`，不吃本机 `.npmrc` 的镜像配置。

发完之后不用管收录目录：`awesome-dsh-plugin` 每夜采集一次 npm，自动更新卡片上的版本号与下载量；描述文字不在自动采集范围内，那部分要改 `data/plugins/wufeng0105__dsh-enhance.yml` 并向上游提 PR。

包名不可随意改：`@wufeng0105/dsh-enhance` 与入口名前缀、老用户的 profile 依赖键三处绑定，发版脚本会拒绝在名字与入口不一致时发布。

## 升级 DSH 时的体检

本包不声明 `engines.dsh`，宿主对未声明插件走「零要求 → 全放行」，没有版本区间需要维护。上游出新 rc 或正式版时按 [docs/compatibility.md](docs/compatibility.md) 跑一次体检；接缝清单与 36 条口径在 [docs/host-seams.md](docs/host-seams.md)。

## 仓库设置与已知取舍

判断前提是日常操作由 Agent 执行，所以逐条看的是「这条对自动化的净效果」。

`main` 的分支保护只开了两条：禁强推、禁删除分支，且 `enforce_admins: true`。npm 上的发布版改不了——一个已经发出去的标签指向提交 A，如果有人 force-push 把 A 从 `main` 抹掉，npm 上还挂着那个版本，而仓库里再也说不出它对应哪次提交。这是唯一一类会造成不可逆错位的历史改写，值得用仓库设置兜住；管理员能绕过等于没开。

有意没开的几条：要求 PR 才能合入（`--ship` 直接推 `main`，开了会把发版链挡死）、要求 CI 绿才能合入（同上，且 `ci` 是 push 之后才跑）、发布 job 挂带 reviewer 的 environment（Agent 无法批准 GitHub environment，开了每次发版都卡死在只有人能做的一步）。发布不需要人工闸门，因为闸门已经在前面：`--ship` 的前置检查、门禁、CI 里的逐字核对。

核对当前生效的设置：`gh api repos/wufeng0105/dsh-enhance/branches/main/protection`。

**包根那个 `index.js` 是一处绕行，带拆除条件。** 它不承载功能，宿主从不加载它——存在的唯一理由是市场插件装完包后会跑一次 `hasLoadableEntry`，它要求包根有 `main` / `exports` / 根 `index.js` 三者之一，而纯 patch 载体按构造就没有，于是被判「没有可安装的内容」并当场删掉（上游 dsh-market/dsh-market#1091）。它**有门禁守着**（bundle 门那条「包根缺可加载入口」），删了会红。上游修好 #1091 之后，拆掉它要三处一起：删根 `index.js`、删 `package.json` 的 `main`、删 bundle 门里那段判定。

另外一处已知取舍：工作流里的 `actions/checkout@v4`、`actions/setup-node@v4` 有意不钉 SHA。发布 job 带 `contents: write` + `id-token: write`，按供应链习惯本该钉 commit SHA；这里没钉，理由是单人仓库加只有这两个官方 action，钉了却没有自动升级，会变成「安全补丁永远收不到」的另一种风险。

## 挂着的事，等什么信号

| 事项 | 现在的状态 | 信号到了做什么 |
|---|---|---|
| 包根 `index.js` 绕行 | 在，只满足市场插件的装后校验（上游 #1091） | 上游修复合入 npm `latest` 后三处一起拆：删根 `index.js`、删 `package.json` 的 `main`、删 `check.mjs` 里 `gateBundle` 那段判定，`code-map.json` 的登记跟着改 |
| `NPM_TOKEN` 到期 | 记在 [.github/npm-token-expiry.json](.github/npm-token-expiry.json)（2027-02-01） | 剩 30 天内 `--check` 判红，`consistency` 工作流每天替你看着；这条门禁看不见：token 过期时五处版本号仍一片对齐，只有 npm 那一步 401 |
| 真会话上的装配层验收 | 桌面会话上的装配结果成立（rc.5）：内容边界进了系统提示，品牌人设遮蔽生效。headless 真会话仍被凭据余额挡住（`QUOTA: Insufficient Balance`） | 等一次有余额的会话，补 headless 那一半；证据链见 git 历史与 [CHANGELOG.md](CHANGELOG.md) |
| 收录目录上的卡片 | 版本、下载量由每夜采集自动追平 | 只有描述文字不自动：向上游 `data/plugins/wufeng0105__dsh-enhance.yml` 提 PR，条目里不许手写 `npm:` |
| 市场插件那条报错文案 | 上游 #1091 里记了，未修 | 上游的事，我们这侧修不了——文案在对方包里 |

## 提交与 PR

一个逻辑改动一个提交，信息写清「改了什么、为什么」；PR 里贴 `check.mjs` 与 `--self-test` 的输出。`.zhll/`、`.tmp/`、`.codegraph/` 都不要提交，它们已在 `.gitignore` 里。

远端有新提交时 `git push` 会被拒（非快进），先 `git pull --rebase origin main`，整合完重跑一遍门禁再推——rebase 改了基线，门禁读的数可能跟着变。
