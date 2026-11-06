# DSH 升级体检手册

本包不声明 `engines.dsh`，宿主对未声明插件走「零要求 → 全放行」，**不存在「本包对哪些宿主版本负责」这一概念，也不存在版本区间**：装前、装后、启动装载都不会因为版本号拒装，市场也不会因为上游发一个 rc 或正式版把插件标 incompatible 隐藏。代价是宿主静默放行——接缝有没有被上游改动，不再由任何声明挡在前面，只能靠 DSH 出新版时跑一次体检自己发现。这份手册就是那次体检的做法。

体检分两层：**源码级体检**（`compat-diff` 看上游 9 个核验包的 tree SHA 与逐文件 diff）与**真机冒烟**（一次性 `DSH_HOME` 里真装一遍，44 条断言）。第一层回答「上游有没有动我们依赖的接缝」，第二层回答「这个包还能不能装上、还能不能跑」。接缝清单与 36 条口径在 [`docs/host-seams.md`](host-seams.md)，本文不复制表，只指向它。

## DSH 出新版时怎么体检

### 1. 先看 9 个核验包的 tree SHA 有没有动

主路径是仓里的工具，`--trees` 模式零网络，blobless 缓存建一次反复用：

```powershell
node tools/compat-diff.mjs --trees <tag1>,<tag2>,... --repo <本地 blobless clone>
```

它对 9 个核验包逐个列各 tag 的 tree SHA，全同打 `ALL-SAME`，否则打印短 SHA 序列——「从哪个 tag 开始变」一眼可读。`<本地 blobless clone>` 是 `git clone --filter=blob:none --no-checkout` 建出来的仓库；没有缓存时工具会打印可操作的建缓存命令后退出 1，不会自动 clone。tag 名格式是 `dsh-v<版本>`（例 `dsh-v0.2.2-rc.1`），别假设新 tag 一定存在，先探一下：

```powershell
gh api "repos/deepseek-ai/deepseek-harness/git/ref/tags/dsh-v0.2.2-rc.2" --jq '.ref'   # 期望 404 说明还没有这个 tag
```

口径先说清：**tag 列表要给全部待比较的 tag，不是首尾两端点**。两端点全同不代表中间没变（本项目就有实测反例：`packages/client/ui-settings-general/src` 在 rc.2→rc.3 之间变过一次）。新 tag 追加进逗号列表，别删旧的，删了就退化成两端点对比。9 个核验包的清单与上游包对应关系指向 [`docs/host-seams.md`](host-seams.md) 的「上游包对应关系」，工具改包清单须与那份文档同步。

### 2. 有变更时读逐文件 diff

`--trees` 报了变更就跑主模式，出逐文件 diff + 预分类：

```powershell
node tools/compat-diff.mjs <oldTag> <newTag> --out <tmp> --repo <本地 blobless clone>
```

输出首行是机器可判的数量行 `changed-files: <n>`，之后每文件一行分类：`SEAM-HIT <组名,...>`（8 组接缝表达式任一命中，**需人读**）或 `SKIM`（零命中，**可略读**）。分组读法：先读 `SEAM-HIT`，`SKIM` 扫一遍抽查即可。**边界句照抄：预分类是分诊不是判决，SKIM 不等于免检**——表达式抓的是机械痕迹，判定标准永远是「我们这侧不改一行代码就会被它弄坏」。埋点、注释、内部重构、纯样式值不算；包的导出名与入口、`ctx.*` 方法签名、`settings.section`/`slots` 契约字段、patch 与装载协议的字段/文件名、`system-prompt` 的 section 顺序常量与文本，才算改到接缝。

接缝关键词的 8 组表达式与「36 条触点」的重数口径都在 [`docs/host-seams.md`](host-seams.md) 的「数法」节，不在本文复制；`node tools/contacts-count.mjs` 现场按那份文档的 a/b/c 口径数，得 36 再与单一来源对账，数出来不是 36 就先怀疑表：漏了新触点，或把两件事并成了一条——改表，别改数。

缓存语义照审计 B1 写实，三层别混：

- **tree 阶段零网络**：blobless clone 里 commit 与 tree 对象全在本地，列变更不回源；
- **blob 首读按需回源（lazy fetch）**：每个文件第一次读会向远端取一次 blob（秒级/文件，需要代理时按本仓规则临时设 `HTTPS_PROXY`）；
- **缓存后离线**：blob 一旦进缓存仓库的 `.git/objects`，同一 diff 重跑零网络。

### 3. 真机冒烟

源码级两层都过了，再跑真机：

```powershell
pwsh -NoProfile -File tools/smoke.ps1
```

它在一次性 `DSH_HOME` 里真装本包、组合出三个入口、验三态与品牌人设遮蔽、写档摘档后再组合，跑完 **44 条断言**（断言条数的单一来源在 `scripts/known-counts.json` 的 `smokeAssertions`，与 `tools/smoke.mjs` 的常量互相咬）。每一步打印 PASS/FAIL，退出码 0 才算过。用独立 `DSH_HOME`，别碰日常使用的 profile；定位与「为什么不进 CI」见 [CONTRIBUTING.md](../CONTRIBUTING.md) 的「发版前必跑：真装冒烟」。

### 4. 结果怎么走

- **体检通过**：正常按 `scripts/release.mjs` 发版，不需要动版本号之外的任何声明——本包没有声明可改。
- **体检发现接缝变了**：修代码（我们自己这一侧的调用）→ 重跑上面的体检与 `node scripts/check.mjs` → 再发版。

没有「改声明、动几处派生文本」这类动作：声明机已拆，接缝清单在 [`docs/host-seams.md`](host-seams.md)，版本行只有「增强 <版本>」。历轮装配层验收的证据链见 git 历史与 [`CHANGELOG.md`](../CHANGELOG.md)。

## 已知边界

- **不拿宿主安装产物做派生。** 版本探测读装机根的元数据，是只读；不解包、不写盘、不生成派生件。图标与派生件永久不做。
- **不建 CI 版本矩阵、不做 semver 求解、不预适配。** 维护模型 = 上游出新版时跑一次体检；接缝变更由冒烟与真机发现，不追求「最优兼容标准」。
