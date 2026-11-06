# 参与开发

这份文档替零上下文接手的人补上最小一份：装的是什么、想动一处会撞上什么、哪些线不能碰、怎么改怎么发。贯穿始终的是同一句话：**这个仓不靠「写对代码」维持，靠的是每条事实只有一个家——机读的那份叫单一来源，人读的那份叫权威——而那个家被门禁现场核对。** 所以动手前先找家，再改；改完能不能信，看两层校验是不是都兑现。

它对外能干什么，见 [README.md](README.md)；升级 DSH 时怎么体检，见 [docs/compatibility.md](docs/compatibility.md)；品牌人设为什么这样设计，见 [docs/brand-persona.md](docs/brand-persona.md)；什么时候改了什么，见 [CHANGELOG.md](CHANGELOG.md)。每件事只在它那一篇里展开，别处只指向——**同一事实只在一处**。

## 这是什么仓，装的是什么

`@wufeng0105/dsh-enhance`（GitHub 仓 `wufeng0105/dsh-enhance`）是一个 DeepSeek Harness 的**插件 bundle**：装进 profile 后由宿主加载，靠 `cordis.patch.yml` 里三条插入（`enhance-scope` / `auto-approve` / `enhance-ui`）接上宿主，不碰宿主程序本身。对外定位叫「破甲」，那是**定位层**的说法，只活在入口页——同一功能在设置页与契约里另有名字，见下面「术语与命名」。

文件分四层，**只有产品层会进用户机器**，其余三层都为它服务：

| 层 | 在哪 | 谁读 |
|---|---|---|
| 产品层（发货） | `index.js`、`enhance-scope/`、`auto-approve/`、`ui/`、`shared/`、`content-scope.txt`、`cordis.patch.yml` | 宿主 |
| 验证机器（不发货） | `scripts/`、`tools/`、`tests/`、`.github/` | 门禁与 CI |
| 文档契约（多数不发货：README、CHANGELOG、LICENSE 与 `docs/` 三份随 npm 包出去，CONTRIBUTING 不发） | `README.md`、`README.en.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`LICENSE`、`docs/` | 人；部分声明位同时被门禁比对（`docs/` 的计数声明） |
| 声明数据（两侧都读） | `package.json`、`VERSION`、`code-map.json`、`scripts/known-counts.json`、`scripts/host-fields-allowlist.json`、`.github/npm-token-expiry.json` | 门禁现场读它，文档里的声明位跟着它走 |

想知道什么，去哪份文件：

| 想知道 | 看 |
|---|---|
| 插件能干什么、怎么装、怎么用 | [README.md](README.md) |
| 怎么改、门禁挡什么、发版链路每一步 | 本文 |
| DSH 出新版怎么体检、宿主接缝有哪些 | [docs/host-seams.md](docs/host-seams.md) 与 [docs/compatibility.md](docs/compatibility.md) |
| 一个东西该叫什么 | 本文「术语与命名」 |
| 「品牌人设」为什么这样设计、它管不到哪 | [docs/brand-persona.md](docs/brand-persona.md) |
| 模块与依赖边、谁 owns 什么 | [code-map.json](code-map.json) |
| 计数、口径、每条怎么被机算 | [scripts/known-counts.json](scripts/known-counts.json) |
| 每个版本改了什么、发布史三条坑 | [CHANGELOG.md](CHANGELOG.md) |

## 改动时要守的边界

改的时候不能越的那条线：**不碰宿主程序**；默认设置下，除声明层那几处外，也不碰宿主自带的提示词——声明层的准确定义见下面「术语与命名」。可选的「隐藏宿主说明」不是纯品牌改动：它会连着抹掉两段带操作约定的文字与两条 runtime context，代价逐条列在 [docs/brand-persona.md](docs/brand-persona.md) 的那张对照表里。改文案时别写成「只是换个名字」。

有一处值得单独记住：改界面相关的东西，浏览器半装不装得上挂在 `ui/package.json` 的两行上——删了，设置页整个消失，服务端功能还在。bundle 门钉着这两行；宿主侧的规则与后果在 [docs/host-seams.md](docs/host-seams.md)。

## 哪里放什么

| 路径 | 管什么 |
|---|---|
| `enhance-scope/` | 内容边界注入 + `/enhance/api` 路由 + 本机版本探测 |
| `auto-approve/` | 审批三态（自动同意 / 先问我 / 自动回绝） |
| `ui/` | 设置页：服务端半（`index.js`）与浏览器半（`client.js`） |
| `shared/` | 状态、权限档、会话探针 |
| `scripts/` | 门禁总入口、发版脚本、它的工具件 |
| `tools/` | 结构图、文档门禁、端到端冒烟 |
| `docs/` | 升级体检手册、宿主接缝表、品牌人设契约 |

## 环境

Node.js **≥ 22**；一个可用的 DeepSeek Harness（**无版本限制**）。端到端冒烟另需 `pwsh`（PowerShell 7）与 `dsh` CLI。

真装冒烟怎么跑、验什么、为什么进不了门禁，见下面「发版」一节的「发版前必跑：真装冒烟」——它同时是发版的硬步骤，不是改完代码的例行动作。

## 改之前先跑一遍门禁

```powershell
node scripts/check.mjs              # 全部门禁
node scripts/check.mjs --self-test  # 至少 19 个负例，证明每道门禁与每个内嵌 check 组件都真的能红
```

门禁一共这些：version / syntax / tests / graph / docs / readme / bundle——**门数不写进文档**，也不由 `tools/counts-check.mjs` 钉住，以 `node scripts/check.mjs` 的输出为准。CI 在 `windows-latest` 上跑 `node scripts/check.mjs` 与 `node scripts/check.mjs --self-test`（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)），**PR 要让这两条都 exit 0**。

负例不是「多跑一遍求安心」。「全绿」有两种：真的没问题，和门禁已经失效。负例排除后者——每条负例在**负例名册**里登记它守哪道门，**删掉一条、或把它改挂到别的门，都会红**。

**改动的入口不是读代码，是找家。** 门禁判的是「声明与实际对不对得上」，不是「代码写得好不好」：先找这条事实的单一来源（`package.json` 的 `name` / `version`、`VERSION`、`code-map.json`、`scripts/known-counts.json`、`scripts/host-fields-allowlist.json`），改那一份，再让门禁把散在各文档里的声明位逼成一致。手抄数字那一侧永远是被核的一方，不是权威。哪一种改动牵动哪份声明，列在下面「改动会被谁挡住」——按你改的东西查表，别背。

门禁判不了的三类事，落在纪律上：**秘密**（发布身份走 `NPM_TOKEN` 还是 OIDC 可信发布，取决于仓库有没有 secret）；**真机**（装不装得上、跑不跑得起来，只有一次性 `DSH_HOME` 的真装冒烟、和从市场插件界面装卸能回答——真机上用 `pwsh` 7，不要用 `powershell` 5.1，5.1 的 `-Encoding utf8` 会写 BOM，宿主读到会崩）；**外部状态**（npm 撤没撤过号、上游修没修、收录目录有没有人采集）。

## 改动会被谁挡住

先分清两类：**门禁会红**的，和**没有门禁、靠纪律**的。混在一起说，就分不清哪条真会拦你。

### 门禁会红的

| 你改了什么 | 门禁 | 要同步什么 |
|---|---|---|
| 加 / 删测试、改 `--self-test` 负例 | tests、docs | [`scripts/known-counts.json`](scripts/known-counts.json) 的 `tests` / `selfTestCases` |
| 改冒烟断言数 | docs | `tools/smoke.mjs` 的 `EXPECTED_ASSERTIONS` 与 [`scripts/known-counts.json`](scripts/known-counts.json) 的 `smokeAssertions`，两处必须相等（计数门现场对账） |
| 新增常驻源码文件 | graph | `code-map.json` 登记；新增 `ctx.on(...)` 事件还要登记 `events` |
| 改 `cordis.patch.yml` 的入口 | bundle | 入口 `name` 必须指向真实存在的文件，且前缀等于 `package.json` 的 `name` |
| 删掉包根的 `index.js` 或 `package.json` 的 `main` | bundle | 市场插件装后会判这个包 broken 并当场删除（上游 dsh-market/dsh-market#1091）；下面那段判定就是为它加的 |
| 改 `package.json` 的 `name` | version、bundle、readme | `cordis.patch.yml` 的入口前缀、两个 README 里 `dsh plugin add` / `remove` 的包名 |
| 改 `VERSION` 或 `package.json` 的 `version` | version | 两处必须逐字相同 |
| 增删 README 的二级标题 | readme | 有目录则须覆盖全部二级标题 |
| 写坏文档里的相对链接或反引号路径 | docs | 两者都必须真实存在 |

那张表的第一行（新增常驻源码要登记）有一句必须逐字保留的表述，由 graph 门断言钉住——**常驻源码（不含 `scripts/`、`tests/`）必须登记进 `code-map.json`**。登记时写 `id` / `layer` / `path` / `owns`；真正被门禁比对的是 `id` 与 `path`（`layer` / `owns` 目前只给人读），别随手改；`scripts/` 与 `tests/` 由语法门与测试门自己守着，不进模型比对（改豁免范围要两处一起改）。

还有两类**不**挡你——它们原先挡，后来按维护成本放开了：README 有没有目录（可选）；README 增删章节导致的检查项数变化（结构检查项数不再钉在 `known-counts.json` 上）。

### 靠纪律的（没有门禁守）

| 事项 | 为什么没有门禁 | 怎么守 |
|---|---|---|
| `.zhll/` 永不入库 | 它在 `.gitignore` 里，[`scripts/code-files.mjs`](scripts/code-files.mjs) 的 `SKIP_DIRS` 也跳过它，所以里面的 `.mjs` 连语法门都不过 | 提交前看一眼改动清单；别对它用 `git add -f`，别为了「统一」把它挪到会被跟踪的位置 |
| 计数键不许删 | 计数门按 `known-counts.json` 里**现有的键**逐个比对，键没了那一项就整个消失，不会红 | 只改值、加键，不删键；删一个键等于静悄悄关掉一项比对 |
| 发布身份走哪条腿 | 取决于仓库有没有 `NPM_TOKEN` secret，门禁读不到 secret | 看 `release.yml` 里「选发布身份」那一步的日志 |
| 工作流 action 不钉 SHA | 钉了却不会有自动升级（除非先配 Dependabot），会变成「安全补丁永远收不到」 | 哪天配了 Dependabot 再钉 |
| `main` 禁强推 | 已经是仓库设置，门禁管不到 | 真要改写历史时先关保护，改完开回来 |
| npm 账号的 scope 与包名匹配 | 要联网查 npm 账号 | 发版脚本的前置检查会替你查（见「发版」） |

`.zhll/` 里放着本地草稿与审计档案（含对自身缺陷的详细描述），这是它必须留在本地的原因。

## 哪些线绝对不能碰

按踩到之后的破坏力排，没有「先问人再放宽」这一档——越过任何一条，门禁都不会替你喊。

1. **不要 unpublish、不要删 npm 上的版本。** 撤掉的号永久不可再用——`2.0.0` 已经这么烧掉过一次，而 `release.mjs` 的 `major` 从 1.3.x 算出来正好是它，脚本会在写盘前拒绝，别绕。发布史三条坑与下一个可用的号，以 [CHANGELOG.md](CHANGELOG.md) 的「已知（发布史，别踩）」为准。
2. **不要 force-push 或删除 `main`。** 分支保护只开了这两条；为什么只开这两条、为什么管理员不豁免，见「仓库设置与已知取舍」。一句话版本：发布出去的版本改不了，历史一旦改写就再也对不上号。
3. **发版只走 `--ship`，不要 `--publish --otp`。** 验证码 30 秒有效、只有人拿得到，Agent 走这条路必卡死。真需要手工发，让在场的人自己敲那一步。
4. **不要改 `package.json` 的 `name`，也不要把 `private: true` 加回来。** 名字与 `cordis.patch.yml` 的入口前缀、老用户 profile 依赖键、两个 README 的命令三处绑定；改错了不一定是报错——宿主可能只打一句 warning，插件就不激活。`private: true` 会让 `npm publish` 直接拒绝，门禁也会红。
5. **`.zhll/` 永不入库。** 见上表；别对它 `git add -f`。
6. **不要删 `scripts/known-counts.json` 的计数键。** 键没了，那项比对跟着消失，门禁不会替你要回来。
7. **不要绕过门禁，也不要把断言放宽到绿灯。** 红灯修到绿，绿灯才可信；删负例、改松断言、把 `selfTestCases` 的下限往下压，都能变绿，也都让门禁失去意义。这个下限的规矩是只许增、不许减。

下面三类不是红线，是权限边界——它们要人拍板：**发布身份与凭据的任何变更**（换 `NPM_TOKEN`、配 trusted publishing）；**仓库设置的开关**（分支保护、workflow 权限）；**用户的本机环境**（日常 profile 里装的插件、`.npmrc`、浏览器、凭据文件）。除这三类之外，改代码、过门禁、发版、对上游提 issue，都不必请示。

## 改测试之前先读这条

`tests/` 里有若干**锁定串**——UI 文案、检查项标题、五个设置组名等。它们断言的是「这一串必须出现在产品文本里」。改产品文案撞到锁定串时，**连测试一起改，并在 PR 里写清改了什么、为什么**；不要为了绿灯放宽断言。

结构测试里还有**切片弱锁**：某些断言只要求「该串出现在某段源码里」，所以改掉一处同名文本时测试可能仍绿。遇到这种情况按名字核对，别假设绿灯就等于没破坏。

## 术语与命名

这一节是命名的**唯一权威**：一个东西一个名字；中文界面名与机读标识符 1:1 对应、不许合并。**改任何面向人的文案之前，先对一遍账本。**

**命名分层：三层四套名字，各有分工，不许互相借用**（三层指产品内的操作 / 契约 / 机读，定位层只活在入口页）。这里的「层」是**读者层**，与上面「这是什么仓」说的「文件分四层」不是一回事，别互相借用。

| 层 | 用在哪 | 怎么叫 | 谁定 |
| --- | --- | --- | --- |
| **定位层** | `README.md` / `README.en.md` 的开篇（`## 它做什么` 首段与五条能力） | **破甲**：它是这个项目「面向谁、解决什么」的对外说法 | 作者原话，入口页以吸引与一眼读懂为目的，别改成规格书 |
| **操作层** | 设置页五组、四个检查项、`state.json` 字段 | 五个组名 + 四个锁定标题（见下两节） | 本节 + `CHECK_TITLES` 锁定串 |
| **契约层** | `docs/brand-persona.md`、`docs/compatibility.md`、代码注释 | 「品牌人设」「内容边界文本」「声明层」等精确词 | 本节 |
| **机读层** | 配置值、字段名、档名 | `identity` / `hideHarness` / `text` / `enhanced` 等 | 代码 |

**为什么允许「破甲」与「内容边界」并存**：同一个东西在入口页叫「破甲词」、在设置页叫「内容边界」、在状态里叫 `contentScope` / `text`——这不是同物异名，是同一功能在四个读者层上的四种叫法。把它们强行统一成一个词，任一层都会变成给另一层的人看的规格书。**但跨层引用时必须落到该层的名字**：README 里指向设置页时用「内容边界」，设置页里提到 README 的说法时不要自己编新词。最容易踩的一条：别把一层的口吻搬进另一层。

### 中文界面名 ↔ 机读标识符

两套名字**都合法、都要守**：中文是给人读的菜单名，标识符是给宿主看的配置值。表锁的是映射本身，**不是**把两者合并成一个名字。

| 界面名 | 标识符 | 层 |
| --- | --- | --- |
| 仅可查看 | `read-only` | 宿主档位 |
| 工作区内修改 | `workspace-write` | 宿主档位 |
| 完全权限 | `danger-full-access` | 宿主档位 |
| Enhanced | `enhanced` | 本包添加（表外档名） |

`enhanced` 是表外档名：宿主菜单把它渲染成 Title Case 的纯文字 **Enhanced**，字形表里没有它。patch 里写的是键名 `enhanced`，菜单里显示 **Enhanced**——同一个档的两层名字，别当两个档。

### 假同物异名：看着像一回事，其实不许合并

- **`suffix` ≠ `personaSuffix`**。前者是 `@deepseek-ai/dsh-persona` 的字段，后者是 `@deepseek-ai/dsh-system-prompt` 的字段——两个插件、两个字段。两者注册**同一个段名** `deployment:persona-suffix`、**同一个 order** `10200`；persona 那一行是 scope-only，挂到全局会与注册表碰撞并直接报错。任何「归一成同一个名字」的改动都是错的。
- **`custom` / `auto` 是宿主的保留档名**，写进档位表会被宿主直接抛错，**不可配置**。它们只用于派生状态与宿主的 Auto 集成；本包写档时只产基础三档加自己那个 `enhanced`。

### 同名两物：必须加限定词

| 词 | 物一 | 物二 | 消歧写法 |
| --- | --- | --- | --- |
| `ask` | 包内三态键（界面写「先问我」） | 宿主审批策略的取值（档位规格里的 `approval: ask`） | 前者写「三态键 `ask`」，后者写「审批策略 `approval: ask`」 |
| `approval` | 开关档：`shared/state.mjs` 的 `{allow, ask, deny}` | 审批策略 `approval/policy`：宿主的 `{ask, never}` | 前者写「开关档 `approval`」，后者写「审批策略 `approval/policy`」 |
| `preset` | 档位（PermissionPreset） | patch 里的一种声明类型（**仓内无实指**，依据在宿主官方文档 publish.md） | 前者写「档位」，后者写「`preset` 声明」 |
| `text` | 内容边界那段文本 | 检查项的机读键 `text` | 前者写「内容边界文本」，后者写「检查项 `text`」 |
| 「检查」 | 门禁：`node scripts/check.mjs` | 设置页第 5 组：把会话日志读回来，证明文本真的进了提示词 | 前者一律写「门禁」，后者一律写「设置页的检查项」 |
| 「市场」 | 收录目录 `awesome-dsh-plugin`（卡片、每夜采集） | 市场插件 `dsh-market/dsh-market`（GUI 里那个市场界面，`hasLoadableEntry` 与 #1091 在它那边） | 前者写「收录目录」，后者写「市场插件」；不单独写「市场」 |

`approval` 最容易踩：同一个模块里就有两套语义（宿主策略的 `never` 与本仓开关档的 `allow` / `ask`）。看到这个词先问一句「这是开关档还是审批策略」。最后两行是**同一个名字指了两件事**，只能拆名，不能选一个留下。

### 核心词「声明层」

**声明层**指系统提示里**描述 harness 自身**的那些注册项：开场那句自称（①），以及两段提到它名字的说明（② 实现目录、④ 界面）——一共 **5 个注册项，落在 3 个名字上**。它不是「提示词的开头」，也不是「所有带品牌的文字」。

| 名字 | 座位 | 注册项 |
| --- | --- | --- |
| `harness:identity` | section | ① 开场那句自称 |
| `harness:source` | section + runtime context | ② 实现目录说明（同名两项各算一项） |
| `app:web-surface` | section + runtime context | ④ 界面说明（同名两项各算一项） |

`dsh-enhance` 在**默认设置下**只在声明层动手，其余段落逐字节保留。**「5 个注册项 / 3 个名字」是本仓唯一口径**；宿主触点的总数与计数口径以 [`docs/host-seams.md`](docs/host-seams.md) 为权威，别在这里另立公式。其余文档提到「声明层」时引用本节，不复述定义。

### 检查项与设置组名

检查项四个机读键与标题（`CHECK_TITLES`）**逐字锁定**，改标题要连测试一起改——**这四个名字以本表为准**：

| 机读键 | 标题 |
| --- | --- |
| `plugins` | 插件在进程里 |
| `text` | 文字合规 |
| `inject` | 真的进了系统提示 |
| `preset` | Enhanced 档 |

产品侧的汇总句用的就是这四个名字。第四项在散文里可以多写「状态明确」（「Enhanced 档状态明确」）——那是附加成分，不必补进 `CHECK_TITLES`，也不必为了「一致」把它删掉。

`inject` 这一项的**口径**（不是标题）随 1.2.0 扩过一次，**键与标题仍然不动**：它同时验两路——内容边界文本（`sessionContains`），以及品牌人设（`custom` 要在日志里命中 `identity.txt` 的文本；`remove` 要用反向探针 `sessionOmits` 确认**最新一份**含 `system-prompt` 的装配记录里已经没有宿主原句；`keep` 这一路不判）。反向探针只看最新一份日志：用「最近 N 份都不含」会把切换开关前的旧日志算进来，刚打开遮蔽就永久判红。

设置页**五个组名**同样**以本表为准**：**品牌人设**、**内容边界**、**越界审批**、**Enhanced 权限档**、**检查**。界面文案用这五个名字；`README.md` 是入口页，写这五节时**功能名照用这五个**（开篇定位可以按定位层写成「破甲」，但落到这五节时用组名——读者在设置页里要找的是这五个词）。组 3 里那个问句「越界时怎么办」是**控件标签**，不是组名，别为了「统一」去改它。

设置页那一节本身叫「**增强**」——它既是宿主 `settings.section` 槽位的 label，也是版本行「增强 <本包版本>」开头的那个词。别把它和五个组名混成一层。

### 「人设」一名三义，必须分写

「人设」这个词在本仓指三件不同的事，正文里**不许只写「人设」**：

| 写法 | 指什么 | 机读标识 |
| --- | --- | --- |
| **品牌人设** | 设置页第 1 组；替换系统提示开头那句 `You are an AI agent powered by DeepSeek Harness.` | `identity`（`keep` / `remove` / `custom`）、`hideHarness`、`identityText` |
| **部署人设** | 宿主 `deployment:persona-prefix` / `-suffix` 两段，由 `personaPrefix` / `personaSuffix` 配置与 `@deepseek-ai/dsh-persona` 供给；**不是本插件改的东西** | `personaPrefix` / `personaSuffix` |
| **尾巴文字** | 内容边界组里那段用户自写的文本，追加在系统提示末尾 | `text` / `content-scope.txt` |

「品牌人设」这个名字容易被读成宿主 persona——所以界面文案里只用「品牌人设」四个字，控件标签不写「人设开关」；内容边界的提示语也已把「写人设」改成实际那句「写行为规矩、写内容要求、写补充说明都行；它只是追加在末尾，不改 DSH 自己的系统提示。」（`ui/client.js` 的 `enh-hint` 是锁定串，以界面实际文案为准）。两处都不再单独用「人设」。

**「破甲」不在上述三名之内**，它是**定位层的对外说法**，指的是内容边界这个能力「用来干什么」（写让模型照做的语句）。它与「尾巴文字」的关系：尾巴文字是**载体**（那个 8 KB 文件里的文本），破甲是**用途**。所以：界面与契约里**仍然只用「内容边界」「尾巴文字」**，不写「破甲」；`README.md` 的开篇与五条能力里**可以**写「破甲」；需要跨层指代时，README 指向设置页就说「内容边界」，不要写成「破甲那一组」。

### 声音锚点

守的是**方向**，不是某一组统计数字——数字每次改写都会漂，当判据就会自相矛盾。方向是：短句是常态、长句是例外，**不许把短句改成长句**。破折号是这个声音的部件，保留；否定式是主力表达（「档位」「只读」「越界」「不猜」四个词保持原样）；量与单位用阿拉伯数字 + 空格 + 单位（`8 KB`、`10 份`），口语量词用中文数字；不写序数词，有序的地方用编号列表，并列的地方用项目符号。

两套语域，各有分工，不许互相借用：源码注释与测试注释用**同侪口吻**（第三人称：说「调用方」「这一侧」「人」）；`README.md` 与界面文案用**对用户口吻**（直呼「你」）；`README.md` / `README.en.md` 的 `## 它做什么` 首段与五条能力用**招揽口吻**（短句、直给、先说「能帮你干什么」再说机制，不得写未实现的能力、不得承诺效果）。招揽口吻只限入口页开头那一段——把它扩散到设置页或契约里，就是把定位层的话塞进了操作层。

### 一条教训：策略值 ≠ 触发条件

`approval: ask` 或 `never` 描述的是**请求被分发时怎么走**，不是**请求会不会被发出**。要断言「什么情况下会发生某件事」，先找**触发源**（谁调用、在什么条件下调用），再看配置的取值。审批请求至少有两个触发源——沙箱升级、工具级的 `ask` 决策——只看策略值推结论，会推反。

落到本包那句话上：设置页那三项面向的是**越界（沙箱升级）**这条路径。Enhanced 档的沙箱已经全开、没有比它更宽的档可升，所以这条路径上不产生请求；工具级 `ask` 会不会出现，取决于部署把哪些工具配成需要确认。两句不矛盾，但都别把对方的口径算进来。

## 发版

发版与发 npm 是同一条链。一条命令推上去，剩下的由 CI 做完。

### 发版前必跑：真装冒烟（纪律，门禁替不了）

```powershell
pwsh -NoProfile -File tools/smoke.ps1
```

`--ship` 的门禁全绿只证明「静态没坏」。这个包吃宿主私有 API，**DSH 升级后唯一能证明它还能装、还能跑的东西是真装冒烟**：在一个一次性 `DSH_HOME` 里真装本包、组合出三个入口、验三态与品牌人设遮蔽、写档摘档后再组合，跑完 44 条断言（断言条数的单一来源在 [`scripts/known-counts.json`](scripts/known-counts.json) 的 `smokeAssertions`，与 `tools/smoke.mjs` 的常量互相咬）。

它**不进** `--ship`、也不进 CI，这是有意的：它要 `pwsh` + 真机 DSH CLI，CI 的 ubuntu runner 给不了；塞进发布脚本只会让紧急热修在没有装 DSH 的机器上发不出去，而「这次发布要不要信静态门禁」的判断本来就该由人做。所以它是**发版纪律里的硬步骤**：每次发版（哪怕 patch）先跑，红了就停下，按 [docs/compatibility.md](docs/compatibility.md) 的「DSH 出新版时怎么体检」查，修完代码再发版。

### 推荐路径：`--ship`

```powershell
node scripts/release.mjs patch --ship
```

它按顺序做完这些，任一步失败就停：

1. 前置检查：工作区干净、在 `main` 上、与 `origin/main` 同步、包名与 `cordis.patch.yml` 的入口前缀一致、目标版本号没有被 npm 撤除过（撤除过的号永远不能再用，见 `CHANGELOG.md` 的「已知」）；
2. 把 `VERSION` 与 `package.json` 的 `version` 一起改掉；版本已是目标值时不重写文件；
3. 跑门禁；
4. `npm pack --dry-run` 打出会发出去的文件清单；
5. 提交 `chore: release <版本>`、打标签 `v<版本>`、推分支与标签。

标签推上去后 [`.github/workflows/release.yml`](.github/workflows/release.yml) 接手：核对「标签 == `VERSION`」→ 再跑一遍门禁 → 发到 npm → 用 `CHANGELOG.md` 里 `## [<版本>]` 那一节建 **GitHub Release**。所以一次 `--ship` 就让**版本号、git tag、npm、GitHub Release** 四处齐平。

推标签是**唯一**能真正发布的触发条件。手动触发（`workflow_dispatch`）永远是预演——只跑门禁与打包清单，不发布、不建 Release。这是有意的：一次手动触发就能造出「npm 有版本、git 无 tag、GitHub 无 Release」，而 npm 侧不可回退。

发布身份有两条腿，工作流按仓库有没有 `NPM_TOKEN` secret 自动选：

| 仓库里有 `NPM_TOKEN` | 走哪条 |
|---|---|
| 有 | granular access token（勾了 bypass 2FA） |
| 没有 | OIDC 可信发布（`id-token: write`） |

OIDC 是目标态：把可信发布者配好、再把 secret 删掉，工作流自动切换，`release.yml` 一个字都不用改。配法是 npm 上包的 Settings → Trusted Publisher → GitHub Actions，仓库填 `wufeng0105/dsh-enhance`、工作流文件名填 `release.yml`，勾上 publish 与 manage dist-tags。

这一步行不行，取决于账号有没有**安全密钥**：npm 把「改包设置」归为敏感操作，而网页端只提供安全密钥（WebAuthn）这一种方式——Windows Hello PIN、手机通行证或 USB 安全钥匙都算。TOTP 够发版，不够改包设置。

要迁到 OIDC 的原因不是偏好：npm 在 2026-07 的公告里写明，勾了「bypass 2FA」的 granular access token 从 2026-08 起不能做账号与包管理动作，**约 2027-01 起连直接发布也不行**，发布会收缩成「暂存 + 人工用 2FA 批准」。长期 token 是条死路。

### 随时核对：`--check`

```powershell
node scripts/release.mjs --check
```

只读，不改任何文件，把几处各自独立写入的版本号并排打出来：`VERSION`、`package.json`、最新 git tag、npm latest、GitHub Release，外加发布凭据的到期日。任何一处对不上就 exit 1，并告诉你补哪一条命令。

它们谁也不会自动跟着谁变——忘了打标签、CI 挂了没建 Release、token 快到期，都会让它们分叉。所以「一致」不是天然成立的，这个开关就是那条余检查。它不在门禁里（门禁必须能离线跑，而这五处要联网），适合发版前或定时任务里用；[`.github/workflows/consistency.yml`](.github/workflows/consistency.yml) 每天跑它一次。

发布凭据的到期日记在 [`.github/npm-token-expiry.json`](.github/npm-token-expiry.json)：剩 30 天内 `--check` 判红。这类问题版本号核对**看不见**——token 过期后 npm 那步会 401，而五处版本号仍然一片对齐。

**刚发完版的头几分钟别照提示补发**：npm 的 `latest` 还没传播，`--check` 会报不一致并让你「补发一次」——包在标签推送后就已经由 CI 发出去了，再发会撞「这个版本已存在」。判据是 `release` 工作流的日志里有 `npm notice 📦 …@<版本>`；有就只需等（实测约 45 秒到几分钟），重跑 `--check` 就会自己变绿。

### 本机手动发（人专用）

```powershell
node scripts/release.mjs patch --publish --otp=<6 位验证码>
```

**Agent 不要走这条**：验证码由验证器 App 生成、30 秒有效，只有人拿得到，Agent 用它会卡死。真需要手工发时让人来操作。

它做的前四步与 `--ship` 相同，只是发完之后不提交、不打标签，脚本会把该跑的 git 命令打出来。它显式发到官方源 `registry.npmjs.org`。本机 `.npmrc` 若指向镜像（本机是 `npmmirror`），那是只读的、发不上去——所以脚本不吃全局配置。

**发完之后不用管收录目录**：`awesome-dsh-plugin` 每夜采集一次 npm，自动更新卡片上的版本号、30 天下载量、能力标签。描述文字不在自动采集范围内，那部分要改 `data/plugins/wufeng0105__dsh-enhance.yml` 并向上游提 PR。

**包名不可随意改**：`@wufeng0105/dsh-enhance` 与 `cordis.patch.yml` 的入口名前缀、老用户的 profile 依赖键三处绑定，两个 README 的命令也跟着它。发版脚本会拒绝在名字与入口不一致时发布。

## 升级 DSH 时的兼容处置

本包不声明 `engines.dsh`，宿主对未声明插件走「零要求 → 全放行」，**没有版本区间需要维护，也没有「本机 DSH 升级到区间之外」这回事**。上游出新 rc 或正式版时，不需要改任何声明或派生文本，只需按 [docs/compatibility.md](docs/compatibility.md) 的「DSH 出新版时怎么体检」跑一次：tree SHA 对比 → 有变更读逐文件 diff → 真机冒烟。体检通过就正常按 `scripts/release.mjs` 发版；发现接缝变了就修代码，再发版。接缝清单与 36 条口径在 [`docs/host-seams.md`](docs/host-seams.md)。

## 仓库设置与已知取舍

判断前提是**日常操作由 Agent 执行**，所以逐条看的是「这条对自动化的净效果」。

`main` 的分支保护只开了两条：禁强推、禁删除分支，且 `enforce_admins: true`。为什么只开这两条——npm 上的发布版改不了。一个已经发出去的标签指向提交 A，如果有人 force-push 把 A 从 `main` 抹掉，npm 上还挂着那个版本，而仓库里再也说不出它对应哪次提交，用户没法核对「我装的这版是不是仓库里那个」。这是唯一一类会造成**不可逆错位**的历史改写，值得用仓库设置兜住。`enforce_admins: true` 是有意的：管理员能绕过等于没开。

有意**没开**的几条：

| 没开的规则 | 为什么 |
|---|---|
| 要求 PR 才能合入 | `--ship` 是直接推 `main` 的，开了会把发版链整个挡死 |
| 要求 CI 绿才能合入 | 同上，且 `main` 上的 `ci` 是 push 之后才跑，形成鸡生蛋 |
| 发布 job 挂带 reviewer 的 environment | **Agent 无法批准 GitHub environment**，那需要在网页上点。开了这条，每次发版都会卡死在一个只有人能做的一步上 |

发布这一步不需要人工闸门，因为闸门已经在前面了：`--ship` 的前置检查、门禁、CI 里的「标签 == `VERSION`」逐字核对。再加一个只能人点的按钮，收益是零，代价是自动化全废。

核对当前生效的设置：`gh api repos/wufeng0105/dsh-enhance/branches/main/protection`。要临时放宽（比如真需要改写 `main` 的历史），用 `gh api -X DELETE repos/wufeng0105/dsh-enhance/branches/main/protection` 关掉，改完再按同一份配置开回来。

**包根那个 `index.js` 是一处绕行，而且带拆除条件。** 它不承载任何功能，宿主从不加载它——存在的唯一理由是市场插件装完包后会跑一次 `hasLoadableEntry`，它要求包根有 `main` / `exports` / 根 `index.js` 三者之一，而纯 patch 载体按构造就没有，于是被判「没有可安装的内容」并当场删掉。上游那 4 行判据把「载体自己的子路径」当成了「另一个包目录」，已提 dsh-market/dsh-market#1091。

它**有门禁守着**（bundle 门那条「包根缺可加载入口」），所以删了会红，不会静默坏掉。**上游修好 #1091 之后，拆掉它要三处一起**：删根 `index.js`、删 `package.json` 的 `main`、删 bundle 门里那段判定。

另外一处已知取舍：工作流里的 `actions/checkout@v4`、`actions/setup-node@v4` 是**有意不钉 SHA** 的。发布 job 带 `contents: write` + `id-token: write`，按供应链习惯本该钉 commit SHA；这里没钉，理由是单人仓库加只有这两个官方 action，钉了却没有自动升级，会变成「安全补丁永远收不到」的另一种风险。这是被接受的取舍，不是疏忽。

## 挂着的事，等什么信号

挂着的判断标准不是「有人想过」，是「有明确信号，信号没到之前动手是浪费或有害」。

| 事项 | 现在的状态 | 信号到了做什么 |
|---|---|---|
| 包根 `index.js` 绕行 | 在。它不承载功能，只满足市场插件的装后校验（上游 dsh-market/dsh-market#1091 把「载体自身的子路径」当成了别的包目录） | 上游修复合入 **npm `latest`** 后三处一起拆——删根 `index.js`、删 `package.json` 的 `main`、删 `check.mjs` 里 `gateBundle` 那段判定，`code-map.json` 的登记跟着改；完整理由见上面「仓库设置与已知取舍」 |
| 已修好、未发版的 `sessionOmits` 假红 | 代码已修（1.3.2 之后的提交），npm 上的 1.3.2 仍带着它：切过品牌人设的遮蔽之后，「设置页的检查项」会误报 | 下一次发版：先跑真装冒烟，再走 `--ship`。发出去之前，1.3.2 的用户点那一项就是会看到误报 |
| `NPM_TOKEN` 到期 | 记在 [.github/npm-token-expiry.json](.github/npm-token-expiry.json)（2027-02-01） | 剩 30 天内 `--check` 判红，`consistency` 工作流每天替你看着；换法就在那个文件里。这条门禁看不见：token 过期时五处版本号仍一片对齐，只有 npm 那一步 401 |
| 真会话上的装配层验收 | 桌面会话上的装配结果成立（rc.5）：内容边界确实进了系统提示，品牌人设遮蔽确实生效。headless 真会话仍被凭据余额挡住（`QUOTA: Insufficient Balance`） | 等一次有余额的会话，补 headless 那一半；证据链见 git 历史与 [`CHANGELOG.md`](CHANGELOG.md) |
| 收录目录上的卡片 | 版本、下载量由每夜采集自动追平 | 只有**描述文字**不自动：要改就向上游 `data/plugins/wufeng0105__dsh-enhance.yml` 提 PR，条目里不许手写 `npm:`。仓库侧不用管 |
| 市场插件那条报错文案 | 上游 #1091 里记了，单独一条处理，未修 | 上游的事，我们这侧修不了——文案在对方包里。别在本仓为它打补丁 |

一句话收尾：先认家，再动手；改完让两层校验都 `exit 0`；门禁管不到的，红线与信号已经写在上面——绿了就做，没绿就修，别拿绿去替纪律。

## 提交与 PR

一个逻辑改动一个提交，信息写清「改了什么、为什么」；PR 里贴 `check.mjs` 与 `--self-test` 的输出。`.zhll/`、`.tmp/`、`.codegraph/` 都不要提交，它们已在 `.gitignore` 里。

远端有新提交时 `git push` 会被拒（非快进），先 `git pull --rebase origin main`，整合完**重跑一遍门禁**再推——rebase 改了基线，门禁读的数可能跟着变。
