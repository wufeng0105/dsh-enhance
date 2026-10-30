# 第一阶段清理交接报告

这一阶段只做减法：把仓库里已经死掉的部分删干净，不动任何还在执行的东西。判断标准只有一条可达性——从三个根集（根 `cordis.patch.yml` 的 entry、`package.json` 的 `files` 与 `dsh` 字段、测试）出发能不能走到；走不到的删，走得到的一个字不改。这份报告要证明的两件事都在下面：仓库里已经没有不可达的文件、没有零调用的符号；不敢删的每一项都列成了第二阶段的开场库存。

## 判据与纪律

删除只按证据归类，不按审美分支：

- **死物**：文件或符号在全仓库零引用，且不承载任何运行时契约。
- **遗迹**：代码、注释或文档段落描述的是已经删掉的子系统（完整安装路径、图标派生包、派生 bundle、双路径世界观）。
- **空转**：条件永假、只为已不存在的形态服务的分支。
- **孤儿测试**：被测物已不存在。本阶段没有命中。

活物零处置：还在执行、还被引用的临时方案既不转正也不挂账，只登记。删除分四批推进，每批之后 `node --test "tests/*.test.mjs"` 与 `node scripts/check.mjs` 全绿才进下一批；四批都过之后又跑了一轮端到端冒烟。

## 删除清单

每一项都指得回一个具体证据，没有一项是因为「看着旧」。

| 对象 | 类别 | 一句证据 |
| --- | --- | --- |
| `showcase/index.html` 与 `showcase/figures/` 下七个 figure | 死物 | 全仓库零引用；README 只链 `showcase/prompt-assembly.html` |
| `.gitattributes` 里 `*.cmd`、`*.asar` 两条规则 | 死物 | 仓内既没有 `.cmd` 也没有 `.asar` 文件；EOL 主规则与 `*.ps1` 规则仍在使用 |
| `showcase/prompt-assembly.html` 的「装进来只是三行」整节 | 遗迹 | 示例用的是完整安装时代的相对路径，正文讲的是已删除的安装期 patch 手术与卸载归属 |
| 同一文件的「派生件与宿主版本耦合」一条 | 遗迹 | 权限菜单图标的派生件已整体删除 |
| `tools/graph.mjs` 的 `generated` 跳过分支 | 空转 | `code-map.json` 里没有任何 `generated: true` 模块，条件永假 |
| `shared/preset.mjs` 的 `withArrayTail`、`ROW_START` | 死物 | 零引用、零调用 |
| `shared/text-lines.mjs` 的 `removeRowBlock`、`removeInsertRow` | 死物 | 零调用，旧 patch 手术的遗留 |
| `shared/session-probe.mjs` 的 `newestSessionFile` | 死物 | 零调用；注释自认「保留给需要单文件的调用方」，但没有这样的调用方 |
| `scripts/repo-copy.mjs` 的 `trackedFiles`、`walkWithSkipDirs`、`spawnSync` 引入 | 死物 | 零调用；后者甚至引用了未导入的 `join`，是一段不可能跑通的遗留壳 |
| `scripts/repo-copy.mjs` 文档串里「按 `git ls-files` 复制」一段 | 遗迹 | 与现实现（磁盘遍历并跳过本地件）相反 |

合计：15 个文件变更，新增 3 行、删除 2031 行；跟踪文件从 55 个降到 47 个。删除之外没有任何替换文字，唯一一次「改」是把 `.gitattributes` 的换行归一为 LF，让那两行的删除在 diff 里干净。

## 存疑清单

下面每一项都在磁盘上活着，或者删了会丢论证、断编号、制造第四层沉积。这里只登记，不动手。

| 对象 | 为什么存疑 | 建议第二阶段怎么处置 |
| --- | --- | --- |
| `tests/bundle.test.mjs` 里「防止两条安装路径的种子漂移」 | 双路径世界观的词，但它位于 docstring 的编号列表里，删掉会打断编号 | 重述成 bundle 单路径口径：种子只有一处来源 |
| 「bundle 安装没有 installer 参与」这句话（`auto-approve/index.js`、`enhance-scope/index.js`、`shared/seed.mjs`、`code-map.json` 各一处） | 仍在解释首装为什么要在 `apply()` 里补种子，删掉会丢论证 | 换成「没有安装器阶段」的直述，或删掉括号保留主语 |
| `docs/compatibility.md` 的「不碰宿主 `app.asar`」与同文「只读 asar 清单」 | 1.1.0 的版本行新增了只读 asar，边界句没跟上，活文档自相矛盾 | 合并成一条边界：只读元数据，不解包、不派生 |
| `showcase/prompt-assembly.html` 用「第 181–192 行」回指 `enhance-scope/index.js` 的注册 | 行号早已漂移，`apply` 目前在 422 行附近，按号回指必然指错 | 改成按符号名回指（`apply` 里的 `ctx.systemPrompt.section`） |
| `code-map.json` 里 `core.text-lines` 的描述含「删块」 | 删块函数本阶段已删除，描述失准 | 同步成「换行安全与切分」 |
| `.github/workflows/ci.yml` 不在三个根集里 | 但它就是 CI 闸门本身，删掉等于停掉自动检查 | 保留；若改闸门口径需同步该文件 |
| `enhance-scope` 的 `onMissing` 选项 | 未文档化，没有任何配置方使用，只有默认路径跑到过 | 决定去留：写进 README，或连同分支一起删 |
| 只导出、无外部调用者的符号：`readHostVersion`、`compatSnapshot`、`presetRecordPath`、`seedApprovalForHome`、`recentSessionFiles`、`decompressFrames` | 都是活代码，导出多余 | 收成模块内私有 |
| 「asar」一词仍有命中 | 全部是活代码与活文档：版本行只读 asar 头、对应测试、宿主内部行为的引用；与提示词里「asar 图标派生」不是同一件事 | 无需处置，登记在此以免第二阶段误删 |

## 存量基线

清理后是 47 个跟踪文件（不含这份报告；连它自己在内是 48 个）：根 10、`tests` 8、`shared` 7、`docs` 6、`tools` 4、`scripts` 3、`ui` 3、两个插件目录各 2、`.github` 1、`showcase` 1。`showcase` 剩下的那一页就是 README 链接的提示词装配讲解。

插件入口仍是三条，来自根 `cordis.patch.yml` 的 insert 块：

- `enhance-scope` → `dsh-enhance/enhance-scope/index.js`
- `auto-approve` → `dsh-enhance/auto-approve/index.js`
- `enhance-ui` → `./ui/index.js`

闸门在清理后全绿：

- `node --test "tests/*.test.mjs"` → 112 passed / 0 failed（8 个文件）
- `node scripts/check.mjs` → 6 passed / 0 failed（version、syntax 24 文件、tests、graph、docs、bundle）
- `pwsh -NoProfile -File tools/smoke.ps1` → 30 passed / 0 failed（隔离 home 真装 bundle、组合树、三态、写档与摘档后宿主重新组合）

验收对照：

- 残留词检索（完整安装、`enhance-permissions`、`patch-rows`、`install.mjs`、`uninstall.mjs`、`build-client`）：零命中。
- 可达性重跑：不可达文件为零。剩余零引用文件只有 `.gitattributes`、`.github/workflows/ci.yml` 与 `tests/*`——配置、CI 闸门、二等根，都在定义之内。
- 与提示词转述不符、以磁盘为准的事实：
  - 「asar」不是残留词，磁盘上它已是活代码（版本行只读 asar 头），见存疑清单最后一条。
  - `showcase` 并非整目录死亡：`prompt-assembly.html` 由 README 引用，存活；其余八件不可达。
  - 提示词作者的快照里没有版本行与 asar 只读读取；这一项是本轮更早的会话加进来的，清理时必须把它当活物。

复跑方法：

```
node --test "tests/*.test.mjs"
node scripts/check.mjs
pwsh -NoProfile -File tools/smoke.ps1
```
