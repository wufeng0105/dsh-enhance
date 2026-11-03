# 变更记录

本文件自 `1.1.0` 起维护；版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，条目格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

本文件记的是**时间轴**：每个版本改了什么、那一版当时的验证读数。条目里的数字（门禁几道、测试几项、断言几条、适用区间）都是**当时**的读数，不按现值校验——现行规则以 [CONTRIBUTING.md](CONTRIBUTING.md) 为准，接手现状以 [BOOTSTRAP.md](BOOTSTRAP.md) 为准，核验结论以 [docs/compatibility.md](docs/compatibility.md) 为准；计数的现值只住在 `scripts/known-counts.json` 一处。门数现在不是承诺位（口径见 CONTRIBUTING 的「改之前先跑一遍门禁」），早期条目里提到的单一来源条目也有增删（门数、README 检查项都已移出），同样以那份 JSON 的现值为准。

## [1.3.3] — 2026-11-04

### 修复

- **设置页的「检查」会误报「遮蔽没有生效」。** 真机上同一个会话日志里会先后出现多条系统提示装配记录——每改一次设置、下一条请求就重算一次，新记录追加在同一个 `session.v4.jsonl.zstd` 里。而「宿主原句有没有被顶掉」这一项此前是**在整份日志里数命中**，于是改动之前那条旧记录会一直把它拉红，而最新一条装配其实是对的。现在只认**最后一条**装配记录。触发条件：最新会话文件里存在任意一条来自「插件生效之前」或「设置改动之前」的装配——典型情形是装完/重启后继续用旧对话。

### 变更（用户可见）

- **npm 包体积减半**：解包 538 KB → 284 KB，文件 38 → 27。删掉的是仓库外可再生的东西——5 张架构图与它们的图源、一页交互式讲解长文、以及一台从未接电的图渲染管线（它要写入的产物目录在 git 全历史里都不存在，`--emit` 也没有任何调用方）。图改由外部工具在仓外生成，不再进仓库维护。
- **README 不再内嵌那 5 张架构图**（图源已移出仓库）。文字说明与链接不受影响。

### 内部

- 门禁新增**负例名册**：负例的「必须存在」有了登记，删掉一条、或把它改挂到别的门，都会红——此前只要不跌破地板，负例可以被一条条删掉而没人发现。
- `bundle` 门新增**浏览器半发现契约**：`ui/package.json` 里那两行是设置页出现的唯一开关，删了设置页整个消失而服务端功能还在，宿主侧看不见（真机上实测过：删掉之后宿主不再下发该客户端）。
- `field-check` 的扫描范围补上 `auto-approve/` 与包根 `index.js`，此前的「未文档化宿主字段」禁令对这两处是瞎的。
- `counts-check` 新增 `--report`：一条命令列出某个计数的全部声明位，改计数不必再靠反复跑门禁逐条发现。
- 面向 agent 的六份文档做了一次整体归位：同一事实只在一处展开，其余位置改为指向。

## [1.3.2] — 2026-11-03

### 修复

- **从市场插件（`dsh-market/dsh-market`）的界面安装会被判「没有可安装的内容」并当场删掉。** 现象是：pnpm 真的装上了（`+ @wufeng0105/dsh-enhance 1.3.1`，`exit 0`），紧接着装后校验把这个包删除，界面报「插件需要构建授权（allowBuilds，默认拦截）或未附带构建产物」。**该包不需要构建、也不缺产物**——零依赖、无构建脚本、产物就是源码；`dsh plugin add` 从同一条 npm 源装 `exit 0`，三个入口齐全，宿主多次正常启动。那条文案是市场插件 `routes.js` 里 `notAPlugin` 的兜底分支（上游源码自己记过同类误判，#258），与构建无关。
- 根因在**市场插件那一侧**：`hasLoadableEntry`（`lib/profile.js`）只认「包根有 `main`/`exports`/根 `index.js`」或「某个 patch 目标是**独立的包目录**」。纯 patch 载体按构造没有前者；而本包的三个入口全是**载体自身的子路径**，被整串当成目录名去找 `<target>/package.json`，9 个探测点全部落空 ⇒ 判 broken ⇒ 删除。已提上游：**dsh-market/dsh-market#1091**（与该仓库 #203 / #906 / #792 同一家族，但那三次修的都是「目标指向别人」，这次是「指向载体自己」）。

### 新增

- 包根 **`index.js`** 与 `package.json` 的 `main`。它**不承载任何功能**，宿主从不加载它（bundle 只加载 patch 行所指的模块）——存在的唯一理由是满足市场插件那道装后校验。实测：加上它之后 `--dump-config` 仍然只有那三个入口，冒烟 **44/44** 照过。
- **bundle 门新增一条判定**：包根必须有 `main` / `exports` / 根 `index.js` 之一且真实存在。删掉这个绕行物会**直接变红**——本仓的门禁看不见市场插件，这条是它唯一的哨兵。
- `code-map.json` 登记 `packaging.root-entry`；CONTRIBUTING 在「改动会被谁挡住」表里加一行，并在「仓库设置与已知取舍」里写清**拆除条件**（上游修好 #1091 后，删根 `index.js`、删 `main`、删那段判定，三处一起）。

### 验证

- 本地门禁七道全过、`--self-test` 20/20；真机冒烟 **44/44**（一次性 `DSH_HOME`，装的是带根入口的本仓库）；
- 用市场插件自己的函数复算：`entryArtifactExists` 与 `hasLoadableEntry` 现在都返回 **true**（1.73.1 与 1.73.9 两版同）；
- `npm pack --dry-run`：`index.js` 已进包（`main` 指向的文件 npm 始终收录），39 个文件。

## [1.3.1] — 2026-11-03

一轮独立只读审计（无上下文、不参与开发）在 1.3.0 发布之后跑出来，报了三个阻塞级问题，全被复现。本版就是那批修复。**这一版是 CI 第一次真正发布出去的版本**——1.3.0 是本机 `npm publish` 发的，CI 那两次绿只是「发现版本已存在就跳过」。

### 修复

- **发版工具一跑就崩。** `scripts/release.mjs` 把 `const npmUser` 缩进进了 `if (publish && !ship)` 块，却在块外的汇总打印里引用它——任何非 `--check` 模式一启动就 `ReferenceError`。语法完全合法，所以语法门（只解析不执行）与 `--check`（提前 exit）都看不见，七道门一直全绿而「一条命令发版」是空的。修法：声明提到块外；
- **README 中英的卸载命令还是被废弃的旧包名** `dsh-enhance`，与同一文件里的安装命令自相矛盾——照着装能装上，照着卸卸不掉，而去掉 scope 的那个名字在 npm 上是别人的包。修法：改成 `@wufeng0105/dsh-enhance`，并补一句旧包名的迁移说明；
- **建 GitHub Release 不幂等**：npm 那步有「版本已存在就跳过」的判断，`gh release create` 没有，所以同一个 tag 重跑会在发布成功之后栽在 `already exists` 上。修法：先 `gh release view` 探一下；
- **手动触发（`workflow_dispatch`）能发布**：一次手动跑就能造出「npm 有版本、git 无 tag、GitHub 无 Release」，而 npm 侧不可回退。修法：发布只认 `push` 标签，手动触发一律预演；
- **`README.en.md` 把门禁名单里的 `graph` 写成了 `structure`**，与实际门名不符；
- **`.gitignore` 漏了 `node_modules/`、`package-lock.json`、`*.tgz`**：不忽略的话，本地跑一次 `npm install` 或 `npm pack` 就会挡住 `release.mjs` 的「工作区必须干净」，让人误以为仓库脏了；
- **发布出去的 tarball 不含 `docs/figures`、`showcase`、`CHANGELOG`**，而 README 用相对路径引用了 5 张图与 1 个长文页——GitHub 上能解析，npm 包页面上六处全是死链。修法：加进 `files`（文件数 25 → 38，解包 264 KB → 538 KB）。

### 新增

- `release.mjs` 的 `--dry` 冒烟模式，并挂进 **syntax 门**（不加第八道门）。这是唯一能自动发现「脚本根本跑不起来」的机制——以前没有，所以上面那个 `ReferenceError` 能带着进 `v1.3.0` 的源码；
- `release.mjs` 在写盘前先查 packument 的 `time` 与 `versions`：命中「曾发布又被撤除」的版本号就拒绝并提示跳号。`2.0.0` 正是这种号（见 1.3.0 的「已知」），而 `major` 从 `1.3.0` 算出来正好是它。

### 验证

- 本地门禁 `node scripts/check.mjs` 七道全过（syntax 门现在会额外跑 `release.mjs --dry`）、`--self-test` 全过；
- 本版由 `node scripts/release.mjs patch --ship` 推标签触发 CI 发布，用来验收「推标签 → CI 发 npm → 自动建 Release」这条链——此前它从未真正发成功过。

## [1.3.0] — 2026-11-03

### 变更（破坏性）

- **包名改为 `@wufeng0105/dsh-enhance`。** 无 scope 的 `dsh-enhance` 在 npm 上已被他人占用（现有 0.3.4，另一个作者），拿不回来。这个包从本版起**同时发布到 npm**，所以名字只能落在自己的 scope 下；
- **推翻「这不是 npm 包」这条旧决策。** `CONTRIBUTING.md` 原先明写「`private` 必须是 `true`——这不是 npm 包，是 profile bundle」，`version` 门也把这条钉成了断言。现在反过来：`private` 不能是 `true`，`publishConfig.access` 必须是 `public`，两条都由 `version` 门判红；
- `cordis.patch.yml` 的两个入口名跟着换前缀（`dsh-enhance/…` → `@wufeng0105/dsh-enhance/…`）。这是**改了宿主接缝**：入口名以包名为锚，不改则装完两个入口解析不到、插件等于没装上；
- **老用户要迁移一步**：profile 的依赖键就是包名，改名后旧键会留在 `profiles/<name>/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里。升级路径是先 `dsh plugin remove dsh-enhance`，再 `dsh plugin add @wufeng0105/dsh-enhance`。

### 新增

- [`scripts/release.mjs`](scripts/release.mjs)：发版一条命令。它把几处隐式依赖收进脚本——工作区干净、在 `main` 上、与远端同步、包名与入口前缀一致、npm 身份与 scope 匹配；改版本后跑全七道闸，`npm pack --dry-run` 先给出会发出去的文件清单，确认后加 `--publish` 才真发。**刻意不自动 commit / tag / push**：版本号被 force-push 覆盖会让 npm 与仓库永久对不上；发布失败时它把版本退回原值；
- `CONTRIBUTING.md` 增「发布」一节：发版命令、必须的登录态、以及为什么脚本显式指定 `registry.npmjs.org`（本机 `.npmrc` 指向 `npmmirror` 只读镜像，直接发布走的是错的源）。

### 修复

- `tools/smoke.mjs` 的包名不再写死，改为从 `package.json` 读——否则每次改名都会让冒烟假红。

### 验证

- 本地门禁：`node scripts/check.mjs` 七道全过；`--self-test` 全过（`orphan bundle entry red` 那条负例的替换锚点已跟着入口名更新，否则它会因为「回退替换没命中」而静默失效）；
- 首次发布后核对：`npm view @wufeng0105/dsh-enhance version` 与仓库 `VERSION` 一致。

### 已知（发布史，别踩）

- **`2.0.0` 这个版本号永久作废。** 本版最初发布为 `2.0.0`，随后整包从 npm 撤除、重新发布为 `1.3.0`。npm 的 packument 里 `time` 仍记着 `2.0.0` 曾发布，按规则被撤除的版本号不可重用——所以**下一个可用的号是 `2.0.1`**（它不是一次 major 升位，只是 2.x 里最小的可用号；`major` 从 1.3.x 算出来仍是 `2.0.0`，脚本会在写盘前拒绝）。
- **npm 上留着一个 `0.0.0-stage` 占位版本**（`description: Temporary package placeholder for staged publishing`，无 license / 无 repository）。它是 npm 暂存发布流程的副产物，不在 `dist-tags` 里，`latest` 不受影响，正常安装不会碰到它。
- **`1.2.0` 与 `1.2.1` 只有提交、没有 tag 与 Release。** 那两个版本存在于入库 npm 之前（对应提交 `4aec0a4`、`13292fb`），所以按本 CHANGELOG 找不到对应的标签——这是历史事实，不回补。

## [1.2.1] — 2026-11-02

### 新增

- 门禁补齐独立审计指出的三处「零门禁」，**仍是七道门、不加第八道**，新判据都并进现有门里：`tools/host-check.mjs`（宿主原文基准核对——`harness:identity` 仍是 section 座位、开场那句逐字命中宿主原文、`harness:source` / `app:web-surface` 各自 section + context 成对）并进 **version** 门；`tools/counts-check.mjs`（文档计数一致性）并进 **docs** 门；`tools/field-check.mjs`（生产目录里未登记的 `layers` 入口）挂进 **graph** 门。极性一律「坏输入判红、扫不到也判红」，只有「本机没有 asar」才如实跳过；
- `scripts/known-counts.json`：七个已发布计数（测试 / 负例 / 门数 / README 检查项 / 冒烟断言 / 设置组数 / 宿主触点）的单一来源；其中冒烟断言与触点数显式标 `manual`——算不出来就承认，不假装能机算；
- `tools/asar-read.mjs`：只读解 `app.asar` 头的读取器，供上面那道宿主核对用（不解包、不写盘）。

### 变更

- [`docs/terminology.md`](docs/terminology.md) 给出「声明层」的定义：它指系统提示里描述 harness 自身的注册项，一共 **5 个注册项落在 3 个名字上**；README 中英据此各给一张同名清单（`harness:identity` / `harness:source` / `app:web-surface`），并写明默认设置下这三处一个都不动；
- README 中英把 `hideHarness` 的代价挪到能被看见的地方：一并隐去的除品牌外，还有两条 runtime context 与两段带操作约定的文字；
- 契约数词统一为「**5 个注册项 / 3 个名字**」（原来散写成 3 / 4 / 4 / 5），两条验收判据改写成对得上 `inject` 两路探针的写法；
- [`docs/brand-persona.md`](docs/brand-persona.md) 回仓三条被否决或挂起的决策：C 与 H′ 两条路线的对比及被挂起的原因、`hideHarness` 已打破宿主 admitted-legacy 投影语义这个已知缺陷、以及「用 AGENTS.md 补偿」被否决的理由；
- [`docs/compatibility.md`](docs/compatibility.md) 给每条核验记录补上**复跑条件**（本机可复跑 / 不可复跑 / 缺什么），并把例行核验第 5 步要改的位置补全（含 `README.en.md` 与文档自身）。

### 修复

- **品牌人设静默失效现在能发现了**：装不上、或装上了没顶掉时，页面不再照旧显示「已替换」。三处一起改——`state` 快照新增 `identityInstall`（`ok` 是三值：装上 / 明确装不上 / 还没有 agent 可判，不把「还没有证据」报成失败）；`inject` 从只探内容边界扩成「**内容边界 + 品牌人设**」两路，缺失性走新加的反向探针 `sessionOmits`（两路的三态判定口径见 [`docs/brand-persona.md`](docs/brand-persona.md) 与 [`docs/compatibility.md`](docs/compatibility.md)）；
- 设置页的降级原因不再一律说成「审批回落到先问我」：改按 `degradedFields` 逐字段说，身份坏值就说「品牌人设回落到保留」。

### 验证

- 本地门禁：`node scripts/check.mjs` **7/7**、`--self-test` **17/17**、`node --test` **161** 项（1.2.0 是 152 项，本轮 +9 全在品牌人设探针）；一次性 `DSH_HOME` 真装本包（日志里 `+ dsh-enhance 1.2.1`）后冒烟 `smoke.ps1` **38/38**；
- 新判据的三证（红灯 / 绿证 / 空转检查）留在 `gates/wp12-gates.log`：宿主核对在真 asar 上命中，假 asar 与路径不存在都 `exit 1`，没有 asar 只打印跳过；把门数改成 8 时计数门 `exit 1`；
- **干净基线远端机的重装终验已执行**（WP15）：远端测试机先全量重置为干净 `0.2.1-rc.5`，随后真装本包 **1.2.1**——`dsh plugin --profile smoke add` **exit 0**、一次性 home 冒烟 **`pass=38 fail=0 total=38`**、持久装进 `headless` profile 后 `--dump-config` 三入口齐（`enhance-scope` / `auto-approve` / `enhance-ui`）、`cordis.patch.yml` 仍 `[]`；核验前后远端仓库 68 文件的 sha256 清单无差异。**设置页四项只有结构证据**：冒烟只断言 `checks` 的名字与顺序恰为 `["plugins","text","inject","preset"]`，四项各自的 `pass`/`na` 取值没有断言，也没有 GUI 证据（该机只装 `headless` profile，组合里没有 web 服务宿主）；
- **设置页四项的取值断言（补在后续批次里，2026-11-02）**：一次性 home 冒烟的断言由 **38** 条增至 **44** 条——`plugins` / `text` / `inject` / `preset` 四项不再只断言名字与顺序，各自的 `pass` / `na` 取值都钉住了（`inject` 分两态：没有会话日志时**如实红**、detail 点明「没有会话日志」；用合成会话日志命中时绿。品牌人设第二路 `identity=custom` 另用一份合成日志走一遍绿）。合成日志只证明探针判定链路通，**不**替代真机会话证据——真会话那一条仍阻塞在余额上。上面 38/38 与「四项只有结构证据」是 WP15 当时的读数，保持不变；
- **本轮未复现**：五张图「源 JSON → 成品」的逐字节一致性没有重跑（本机没有 archify），其中 `02-prompt-injection` 与 `04-compat-verify` 是源 JSON 与 SVG 同时手改、`02` 的遮罩宽度按字宽估算；`1.1.2` 那条是那一轮自己的记录，不是本轮的复现凭证；
- **本轮仍阻塞**：真机会话上的装配层验收复跑——远端真会话跑一次即 `QUOTA: Insufficient Balance`（exit 1，未重试），模型凭据余额为 0，本轮只有单测、门禁与合成日志，没有真机会话日志；要复跑缺**一次有余额的会话**。`hideHarness` 在桌面 / web profile 上的效果同样未验。

## [1.2.0] — 2026-11-02

### 新增

- **品牌人设**（设置页第 1 组）：系统提示开头那句 `You are an AI agent powered by DeepSeek Harness.` 可保留、可去掉、可换成你自己的；顺带能把另外两段提到宿主名字的说明（安装位置、图形界面）连它们的运行时上下文一起隐藏。改的是**模型看到的装配结果**，存盘即生效、不用重启，选回「保留」即逐字节回到宿主原样；
- [`docs/brand-persona.md`](docs/brand-persona.md)：这份契约——解决什么、三条验收、明确不做哪五件事、为什么走「按 agent 遮蔽同名段」而不是装配瀑布、缓存代价、边界、以及 DSH 升级后该核哪一条；
- 自定义身份文本独立成文件 `<DSH_HOME>/enhance/identity.txt`，上限 2 KB（与内容边界的 8 KB 分开）。

### 变更

- `state.json` 从 v3 升到 v4：新增 `identity`（`keep` / `remove` / `custom`）与 `hideHarness`，只加字段、不写迁移支路；旧文件缺这两个键是正常的，不标降级，只有「写了但认不出」才算坏；
- `readState` 新增 `degradedFields`：坏的是哪个字段要能说清——原来只写「审批回落」会把身份坏值说成审批的事；
- 文本读写收敛成唯一实现（`readTextFile` / `writeTextFile`），品牌人设不另起第二套；`readIdentity` / `writeIdentity` 是其薄包装；
- 公开承诺句统一为「**除声明层那一句之外**，宿主提示词一个字节不动」——原来那句「一个字节不动」被本功能打破，README（中英）与 `CONTRIBUTING.md` 已同步；
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

- 「docs/figures/」：五张架构图（宿主接缝、注入路径、保存往返、例行核验、Enhanced 档生命周期），README 里按叙事顺序嵌入；SVG 是自包含的，GitHub 直接渲染；
- 「docs/figures/sources/」：图的源 JSON 与复现步骤——源 → 交互式 HTML → 独立 SVG，两步都能跑；
- `scripts/extract-figure-svg.mjs`：从 Archify 的交互式 HTML 抽出可独立渲染的 SVG（补 `xmlns`、内联类规则与 CSS 变量、CDATA 包裹）；
- `scripts/check-readme.mjs`：README 门禁，114 项结构检查（章节顺序、站内链接、图存在、ToC 覆盖、代码块语言、许可证在最后、两个语言版本互链）。

> 上面三条与图相关的路径**现已不存在**：图与图源、`scripts/extract-figure-svg.mjs` 都已从仓库删除，架构图改由 Archify 在仓外生成，不再进仓维护。

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
