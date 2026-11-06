# 变更记录

本文件自 `1.1.0` 起维护；版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，条目格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

本文件按版本记时间轴：每版改了什么、当时有哪些坑。条目里的门禁数、测试数、区间都是当时的读数，不按现值校验——现行规则以 [CONTRIBUTING.md](CONTRIBUTING.md) 为准，体检做法以 [docs/compatibility.md](docs/compatibility.md) 为准。

## [1.4.0] — 2026-11-06

### 变更（拆解）

- **拆除版本声明机**：删掉 `package.json` 的 `engines.dsh` 与 `dsh.compatibility`、`shared/compat.mjs`、`tests/compat.test.mjs`；`version` 门随之瘦身，不再核区间、README 派生句与本机超范围。本包不声明 `engines.dsh`，宿主对未声明插件走「零要求 → 全放行」——上游再发 rc 或正式版，插件不会被市场标 incompatible 隐藏。设置页版本行简化为「增强 <版本>」；`compatSnapshot` 的本机版本探测保留为体检功能，只是不上页面。
- **体检能力独立**：36 条宿主触点表从 `docs/compatibility.md` 搬进 [`docs/host-seams.md`](docs/host-seams.md)（WP2 验收的权威新家），`contacts-count` 改读新路径；`compat-diff.mjs` 与 `smoke.ps1` 的定位从「为声明服务」改成「DSH 出新版时跑一次体检」。[`docs/compatibility.md`](docs/compatibility.md) 整份改写为《DSH 升级体检手册》：篇首讲清不存在版本区间，保留两个与写入 Enhanced 档相关的宿主事实与版本探测链，新增「DSH 出新版时怎么体检」（`--trees`、主模式、缓存语义三层、冒烟、接缝清单指向 `docs/host-seams.md`）。
- **文档瘦身**：删 `BOOTSTRAP.md` 与术语账本（原 docs/terminology.md），两者仍有效的内容（六份文档归属表、真机冒烟纪律、「同一事实只在一处」、命名分层与术语账本）并入 `CONTRIBUTING.md`；两个 README 删掉「已对 … 核验过 / Verified against …」整句与「约 15 分钟」，依赖句改「无版本限制」；`docs/brand-persona.md` 指向「核验记录」的指针改指 git 历史与 CHANGELOG。

### 验证读数

- `node scripts/check.mjs` 七门 exit 0（含 docs 门死链检查、readme 门结构检查）；`node scripts/check.mjs --self-test` exit 0（19 条负例，`roster=OK`）；`node tools/docs-check.mjs` exit 0；`node tools/contacts-count.mjs` exit 0 且报 **36 条**；真机冒烟 `pwsh -NoProfile -File tools/smoke.ps1` **44 条断言**；账本双校验 exit 0。
- 旧词 0 命中：`适用版本|已验|核验过|扩区间|约 15 分钟` 在 `docs/compatibility.md` / `README.md` / `README.en.md` / `CONTRIBUTING.md` 四份文件里均无命中；`docs/compatibility.md` 无「## 宿主触点 / 例行核验」节。

## [1.3.4] — 2026-11-06

- 把 `engines.dsh` 区间扩到 0.2.2-rc.1（`>=0.2.1-rc.1 <0.2.2-rc.2`），配套走了一轮 38 文件源码级核验与真机冒烟 44/44。**这一版是「有声明」的最后一个版本；1.4.0 已把声明机整体拆除**，这里的区间不再生效。

## [1.3.3] — 2026-11-04

- **npm 包体积减半**：解包 538 KB → 284 KB，文件 38 → 27。删掉的是仓库外可再生的东西——5 张架构图与它们的图源、一页交互式讲解长文、以及一台从未接电的图渲染管线也一并移除。

## [1.3.2] — 2026-11-03

- **bundle 门新增一条判定**：包根必须有 `main` / `exports` / 根 `index.js` 之一且真实存在。删掉这个绕行物会**直接变红**——本仓的门禁看不见市场插件，这条是它唯一的哨兵。

## [1.3.1] — 2026-11-03

- **建 GitHub Release 不幂等**：npm 那步有「版本已存在就跳过」的判断，`gh release create` 没有，所以同一个 tag 重跑会在发布成功之后栽在 `already exists` 上。
- **手动触发（`workflow_dispatch`）能发布**：一次手动跑就能造出「npm 有版本、git 无 tag、GitHub 无 Release」，而 npm 侧不可回退。修法：发布只认 `push` 标签，手动触发一律预演；
- **`.gitignore` 漏了 `node_modules/`、`package-lock.json`、`*.tgz`**：不忽略的话，本地跑一次 `npm install` 或 `npm pack` 就会挡住 `release.mjs` 的「工作区必须干净」，让人误以为仓库脏了；

## [1.3.0] — 2026-11-03

- **老用户要迁移一步**：profile 的依赖键就是包名，改名后旧键会留在 profile 的 `package.json` 里，要按旧名卸掉再装回来。

## [1.2.1] — 2026-11-02

- **品牌人设静默失效现在能发现了**：装不上、或装上了没顶掉时，页面不再照旧显示「已替换」。三处一起改——`state` 快照新增 `identityInstall`（`ok` 是三值：装上 / 明确装不上 / 还没有 agent 可判。
- **干净基线远端机的重装终验已执行**（WP15）：远端测试机先全量重置为干净 `0.2.1-rc.5`，随后真装本包 **1.2.1**——`dsh plugin --profile smoke add` **exit 0**、一次性 home 冒烟 **`pass=38 fail=0 total=38`**、持久装进 `headless` profile 后 `--dump-config` 三入口齐（`enhance-scope` / `auto-approve` / `enhance-ui`）、`cordis.patch.yml` 仍 `[]`；核验前后远端仓库 68 文件的 sha256 清单无差异。**设置页四项只有结构证据**：冒烟只断言 `checks` 的名字与顺序恰为 `["plugins","text","inject","preset"]`，四项各自的 `pass`/`na` 取值当时还没有断言。
- **设置页四项的取值断言（补在后续批次里，2026-11-02）**：一次性 home 冒烟的断言由 **38** 条增至 **44** 条——`plugins` / `text` / `inject` / `preset` 四项不再只断言名字与顺序，各自的取值也钉住了。
- **本轮未复现**：五张图「源 JSON → 成品」的逐字节一致性没有重跑（本机没有 archify），其中两张图是源 JSON 与 SVG 同时手改的。

## [1.2.0] — 2026-11-02`n`n- 新增品牌人设：系统提示开头那句自称可保留 / 去掉 / 换成自定义文本，并可按 agent 作用域遮蔽同名段。

## [1.1.2] — 2026-10-31

- **README 按 standard-readme 重构**：默认页改为中文（`README.md`），英文版退到 `README.en.md`，两版章节一一对应、互链；认知漏斗重排——15 秒能判断的信息全放在第 30 行之前。

## [1.1.1] — 2026-10-31`n`n- 术语账本入仓，手写文本面统一术语与文风。

## [1.1.0] — 2026-10-30`n`n- 首个记录版本：内容边界、越界审批与设置页五组定型。

