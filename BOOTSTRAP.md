# BOOTSTRAP — 零上下文从这里接手

你此刻没有任何关于本仓库的对话上下文。这份文档替你补上最小的一份：它是什么、想动一处会撞上什么、哪些线不能碰、哪些事还挂着。

贯穿四条的是同一句话：**这个仓不靠「写对代码」维持，靠的是每条事实只有一个家——机读的那份叫单一来源，人读的那份叫权威——而那个家被门禁现场核对。** 所以在这里动手，先找家，再改；改完能不能信，看两层校验是不是都兑现。

操作规程在 [CONTRIBUTING.md](CONTRIBUTING.md)。这六篇是一组：本文给**归属与此刻**——每类事实归哪一篇、眼下是什么状态；其余五篇各自独占一件事——怎么改（CONTRIBUTING）、对宿主负责到哪（[docs/compatibility.md](docs/compatibility.md)）、一个东西该叫什么（[docs/terminology.md](docs/terminology.md)）、品牌人设为什么这样设计（[docs/brand-persona.md](docs/brand-persona.md)）、什么时候改了什么（[CHANGELOG.md](CHANGELOG.md)）。**本文不复制它们的话**：每件事只在它那一篇里展开，别处只指向。

## 这是什么仓，装的是什么

`@wufeng0105/dsh-enhance`（GitHub 仓 `wufeng0105/dsh-enhance`），本机在 `Documents\ProgramFilesCode\tools\dsh-enhance`。一个 DeepSeek Harness 的**插件 bundle**：装进 profile 后由宿主加载，靠 `cordis.patch.yml` 里三条插入（`enhance-scope` / `auto-approve` / `enhance-ui`）接上宿主，不碰宿主程序本身。

它做什么、装完什么样，是 [README.md](README.md) 的事；对外定位叫「破甲」，那是**定位层**的说法，只活在入口页——同一功能在设置页与契约里另有名字，命名分层与逐条映射在 [docs/terminology.md](docs/terminology.md)，别在这里另起叫法。

这个仓的文件分四层。**只有产品层会进用户机器**，其余三层都为它服务：

| 层 | 在哪 | 谁读 |
|---|---|---|
| 产品层（发货） | `index.js`、`enhance-scope/`、`auto-approve/`、`ui/`、`shared/`、`content-scope.txt`、`cordis.patch.yml` | 宿主 |
| 验证机器（不发货） | `scripts/`、`tools/`、`tests/`、`.github/` | 门禁与 CI |
| 文档契约（多数不发货：README、CHANGELOG、LICENSE 与 `docs/` 三份随 npm 包出去，CONTRIBUTING 不发） | `README.md`、`README.en.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`LICENSE`、`docs/` | 人；部分声明位同时被门禁比对（README 的适用版本句、`docs/` 的计数声明） |
| 声明数据（两侧都读） | `package.json`、`VERSION`、`code-map.json`、`scripts/known-counts.json`、`scripts/host-fields-allowlist.json`、`.github/npm-token-expiry.json` | 门禁现场读它，文档里的声明位跟着它走 |

现状快照（写就之时；动手前先自己复核）：

- `VERSION` = `1.3.2`，npm latest 与 GitHub Release 都是它；`node scripts/release.mjs --check` 报六处一致（连同发布凭据到期日）。
- 工作区干净，`main` 与 `origin/main` 同步。
- 有一处修好、**尚未发版**的缺陷——挂在「挂着的事，等什么信号」那一节。

想知道什么，去哪份文件：

| 想知道 | 看 |
|---|---|
| 插件能干什么、怎么装、怎么用 | [README.md](README.md) |
| 怎么改、门禁挡什么、发版链路每一步 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 对哪个宿主版本负责、宿主怎么执行区间、新版本来了核什么 | [docs/compatibility.md](docs/compatibility.md) |
| 一个东西该叫什么 | [docs/terminology.md](docs/terminology.md) |
| 「品牌人设」为什么这样设计、它管不到哪 | [docs/brand-persona.md](docs/brand-persona.md) |
| 模块与依赖边、谁 owns 什么 | [code-map.json](code-map.json) |
| 计数、口径、每条怎么被机算 | [scripts/known-counts.json](scripts/known-counts.json) |
| 每个版本改了什么、发布史三条坑 | [CHANGELOG.md](CHANGELOG.md) |

## 想动一处，会撞到什么

上一节说事实分散在声明数据与几份权威里；把它们对上号的机器就是门禁，两层，都要跑、都要 `exit 0`：

```powershell
node scripts/check.mjs              # 门禁：静态、离线、一次跑完
node scripts/check.mjs --self-test  # 负例：逐条把门禁弄红，证明它们真的会红
```

PR 与 CI 都要求这两条 `exit 0`（CI 跑在哪、还跑什么，见 CONTRIBUTING 的「改之前先跑一遍门禁」）。门禁里面有几道，以它自己的输出为准——**门数不是承诺位，文档里不写数字**，加一道门不需要同步任何文档。

负例不是「多跑一遍求安心」。「全绿」有两种：真的没问题，和门禁已经失效。负例排除后者——每条负例在**负例名册**里登记它守哪道门，**删掉一条、或把它改挂到别的门，都会红**。

**改动的入口不是读代码，是找家。** 门禁判的是「声明与实际对不对得上」，不是「代码写得好不好」：先找这条事实的单一来源（`package.json` 的 `engines`、`VERSION`、`code-map.json`、`scripts/known-counts.json`、`scripts/host-fields-allowlist.json`），改那一份，再让门禁把散在各文档里的声明位逼成一致。手抄数字那一侧永远是被核的一方，不是权威。哪一种改动牵动哪份声明，已经列成表，在 CONTRIBUTING 的「改动会被谁挡住」——按你改的东西查表，别背。

有一处值得单独记住：改界面相关的东西，浏览器半装不装得上挂在 `ui/package.json` 的两行上——删了，设置页整个消失，服务端功能还在。bundle 门钉着这两行；宿主侧的规则与后果在 [docs/compatibility.md](docs/compatibility.md) 的「宿主触点」。

门禁判不了的三类事，落在纪律上：

- **秘密**：发布身份走 `NPM_TOKEN` 还是 OIDC 可信发布，取决于仓库有没有 secret，门禁读不到。
- **真机**：装不装得上、跑不跑得起来，只有一次性 `DSH_HOME` 的真装冒烟、和从市场插件界面装卸能回答。真机上用 `pwsh` 7，不要用 `powershell` 5.1——5.1 的 `-Encoding utf8` 会写 BOM，宿主读到会崩。
- **外部状态**：npm 撤没撤过号、上游修没修、收录目录有没有人采集——都在仓库外。

**门禁也有它守不到的地方**：`scripts/known-counts.json` 的计数键被删掉时，那项比对会跟着键一起消失，门禁不会红。这类「没有门禁、只有纪律」的事，逐条列在 CONTRIBUTING 的「靠纪律的」那张表里——那张表就是它们的家。

改完分别跑什么：

- 每次改动：上面那两条命令。
- 发版前：另跑真装冒烟 `pwsh -NoProfile -File tools/smoke.ps1`（一次性 `DSH_HOME`，不碰日常 profile）。它是发版的硬步骤，定位与「为什么不塞进发布脚本」见 CONTRIBUTING 的「发版前必跑：真装冒烟」。
- 发版后、或任何想核的时候：`node scripts/release.mjs --check`。VERSION、`package.json`、最新 git tag、npm latest、GitHub Release 五处，外加发布凭据到期日；联网、只读、不在门禁里（门禁必须能离线跑），`consistency` 工作流每天跑一次。它红了不代表门禁坏了，代表仓外那六样东西分叉了。

  **一条例外，照做会出事**：刚发完版的头几分钟，npm 的 `latest` 还没传播，`--check` 会报 `npm latest` 不一致，并在提示里让你「补发一次」——**别照做**。包在标签推送后就已经由 CI 发出去了，再发会撞「这个版本已存在」。判据是 `release` 工作流的日志里有 `npm notice 📦 …@<版本>`；有就只需等（实测约 45 秒到几分钟），重跑 `--check` 就会自己变绿。

## 哪些线绝对不能碰

上一节说门禁判不了的三类事落在纪律上；这一节是纪律里最硬的几条。按踩到之后的破坏力排，没有「先问人再放宽」这一档——越过任何一条，门禁都不会替你喊：有的会让「事实有家、家被核」这套结构本身失效，有的会让接着的每一步都卡住。

1. **不要 unpublish、不要删 npm 上的版本。** 撤掉的号永久不可再用——`2.0.0` 已经这么烧掉过一次，而 `release.mjs` 的 `major` 从 1.3.x 算出来正好是它，脚本会在写盘前拒绝，别绕。发布史三条坑与下一个可用的号，以 [CHANGELOG.md](CHANGELOG.md) 的「已知（发布史，别踩）」为准，动版本号之前先读那一节。
2. **不要 force-push 或删除 `main`。** 分支保护只开了这两条；为什么只开这两条、为什么管理员不豁免，见 CONTRIBUTING 的「仓库设置与已知取舍」。一句话版本：发布出去的版本改不了，历史一旦改写就再也对不上号。
3. **发版只走 `--ship`，不要 `--publish --otp`。** 验证码 30 秒有效、只有人拿得到，Agent 走这条路必卡死。真需要手工发，让在场的人自己敲那一步。
4. **不要改 `package.json` 的 `name`，也不要把 `private: true` 加回来。** 名字与 `cordis.patch.yml` 的入口前缀、老用户 profile 依赖键、两个 README 的命令三处绑定；改错了不一定是报错——宿主可能只打一句 warning，插件就不激活。`private: true` 会让 `npm publish` 直接拒绝，门禁也会红。
5. **`.zhll/` 永不入库。** 里面是本地草稿与审计档案（含对自身缺陷的详细描述）。它在 `.gitignore` 里、语法门也跳过它，**没有任何门禁守着**，只有提交前看一眼改动清单这一道人防。别对它 `git add -f`，也别为了「统一」把它挪到会被跟踪的位置。
6. **不要删 `scripts/known-counts.json` 的计数键。** 键没了，那项比对跟着消失，门禁不会替你要回来——为什么、怎么守，见 CONTRIBUTING 的「靠纪律的」表。
7. **不要绕过门禁，也不要把断言放宽到绿灯。** 红灯修到绿，绿灯才可信；删负例、改松断言、把 `selfTestCases` 的下限往下压，都能变绿，也都让门禁失去意义。这个下限的规矩是只许增、不许减。

下面三类不是红线，是权限边界——它们要人拍板：

- **发布身份与凭据的任何变更**：换 `NPM_TOKEN`、配 trusted publishing。凭据属于账号，Agent 不持有，也不该自作主张。
- **仓库设置的开关**：分支保护、workflow 权限。既定取舍与理由在 CONTRIBUTING 的「仓库设置与已知取舍」，偏离它要人拍板。
- **用户的本机环境**：日常 profile 里装的插件、`.npmrc`、浏览器、凭据文件。那些不在「只管源码」的范围里，动之前先问。

除这三类之外，改代码、过门禁、发版、对上游提 issue，都不必请示。

## 挂着的事，等什么信号

红线管的是不该做的事，这一类是现在还不能做的事。挂着的判断标准不是「有人想过」，是「有明确信号，信号没到之前动手是浪费或有害」。好几个信号就是门禁自己变红——门禁红不是打扰，是「该动手了」的通知。

| 事项 | 现在的状态 | 信号到了做什么 |
|---|---|---|
| 包根 `index.js` 绕行 | 在。它不承载功能，只满足市场插件的装后校验（上游 dsh-market/dsh-market#1091 把「载体自身的子路径」当成了别的包目录） | 上游修复合入 **npm `latest`** 后三处一起拆——删根 `index.js`、删 `package.json` 的 `main`、删 `check.mjs` 里 `gateBundle` 那段判定，`code-map.json` 的登记跟着改；完整理由与「只拆一处会红」见 CONTRIBUTING 的「仓库设置与已知取舍」 |
| 已修好、未发版的 `sessionOmits` 假红 | 代码已修（1.3.2 之后的提交），npm 上的 1.3.2 仍带着它：切过品牌人设的遮蔽之后，「设置页的检查项」会误报 | 下一次发版：先跑真装冒烟，再走 `--ship`。发出去之前，1.3.2 的用户点那一项就是会看到误报 |
| `NPM_TOKEN` 到期 | 记在 [.github/npm-token-expiry.json](.github/npm-token-expiry.json)（2027-02-01） | 剩 30 天内 `--check` 判红，`consistency` 工作流每天替你看着；换法就在那个文件里。这条门禁看不见：token 过期时五处版本号仍一片对齐，只有 npm 那一步 401 |
| DSH 出新 rc，或发 0.2.1 正式版 | 真机只在 rc.5 上验过；区间现值以 `package.json` 的 `engines.dsh` 为准（验过哪些版本见 compatibility 的「声明」） | `version` 门会红——正式版按 semver 大于 rc 上界，这不是误报，是硬闸的应有行为。按 [docs/compatibility.md](docs/compatibility.md) 的例行核验跑一遍，过了再两端一起扩区间 |
| 真会话上的装配层验收 | 桌面会话上已验通（rc.5）：内容边界确实进了系统提示，品牌人设遮蔽确实生效。headless 真会话仍被凭据余额挡住（`QUOTA: Insufficient Balance`），rc.1–rc.4 没有真机证据 | 等一次有余额的会话，补 headless 那一半；结论与复跑条件记在 [docs/compatibility.md](docs/compatibility.md) 的「核验记录」 |
| 收录目录上的卡片 | 版本、下载量、宿主要求由每夜采集自动追平 | 只有**描述文字**不自动：要改就向上游 `data/plugins/wufeng0105__dsh-enhance.yml` 提 PR，条目里不许手写 `npm:`。仓库侧不用管 |
| 市场插件那条报错文案 | 上游 #1091 里记了，单独一条处理，未修 | 上游的事，我们这侧修不了——文案在对方包里。别在本仓为它打补丁 |

一句话收尾：先认家，再动手；改完让两层校验都 `exit 0`；门禁管不到的，红线与信号已经写在上面——绿了就做，没绿就修，别拿绿去替纪律。
