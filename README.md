# dsh-enhance

**DSH 老说「我不能」，不是它不会，是它开口前先读了一段很保守的系统提示。**

那条系统提示由宿主自己拼：它是谁、能调哪些工具、该用什么语气。没有留给你改的位置。这个工具只在它末尾接上你写的一段文本，别的一个字不动。

写破甲词，它就不那么爱说「我不能」；写人设、写内容边界、写行为规矩，也一样。改完存盘，下一条消息就按新的来，不用重启。

**它是一条纯插件**：安装只往你 profile 的依赖清单里加一行，不碰 DSH 的程序，不碰宿主配置。唯一会写宿主配置的动作是设置页里「写入 Enhanced 档」那个按钮，而那只在你点它的时候发生。

**适用版本**：dsh-enhance `1.1.0` · DeepSeek Harness 0.2.1-rc.1–0.2.1-rc.5（0.2.1-rc.3 实测，全系源码级核验）。这句由 `package.json` 的 `dsh.compatibility` 派生；理由、触点与核验流程见 [docs/compatibility.md](docs/compatibility.md)。

## 安装

一条命令，装完重启 DeepSeek Harness：

```powershell
dsh plugin --profile desktop add github:wufeng0105/dsh-enhance
```

装完，设置页里多出「增强」一节，四组各管一件事：内容边界、越界时怎么办、Enhanced 权限档、检查。

**权限菜单图标**：没有，也不会有。宿主只为内置四个档位名准备了字形，表外的档位名渲染成纯文字行——这是宿主的显示契约，不是这个包缺了什么。

## 内容边界

你写的那段文本在 `<DSH_HOME>/enhance/content-scope.txt`。存盘即生效，下一条消息带上；最多 8 KB（写入时去 BOM、统一换行、去控制字符、去首尾空白）。仓库根目录的 `content-scope.txt` 只是首次加载时抄进去的默认内容，你的文件已经存在就不会被覆盖。

同一件事也可以直接在设置页做：「内容边界」一组里能改、能存、能还原。

三个开关在 `<DSH_HOME>/enhance/state.json`：

| 字段 | 装好时 | 管什么 |
|---|---|---|
| `enabled` | 开 | 关掉 = 全部停下 |
| `contentScope` | 开 | 关掉 = 不接那段文本 |
| `approval` | 看你的默认档位 | 越界时自动同意 / 先问我 / 自动回绝；文件坏了回落到「先问我」 |

`approval` 的初始值不是硬编码：它读你 profile 的默认档位——默认档位是 `approval: never`（沙箱全开、不问人）时种「先问我」，否则种「自动同意」。因为 `never` 的档位下宿主在分发前就拒了，种「自动同意」永远轮不到。

## 越界审批

宿主会在动作超出当前档位时发审批请求。这一段只决定拿到请求之后怎么回：

- **自动同意**：放行这一次（`allowed-once`），不改档位。
- **先问我**：把决定交还宿主的审批界面；你不在，它就停在那儿等。
- **自动回绝**：当场拒（`rejected`），不给你选择。

这三项只对「仅可查看」和「工作区内修改」两个档位起作用。档位是「完全权限」或 Enhanced 时，宿主不会产生需要审批的请求，这三项也就用不上。

## Enhanced 权限档（可选）

宿主内置的 `danger-full-access` 是「沙箱全开 **并且** 审批不问人」。想要「沙箱全开、越界仍问你」，得有一个自定义档；而宿主的档位表只认 profile 配置里定义的名字，所以只能写进你自己的 profile。

怎么用：设置页「增强」→「Enhanced 权限档」→「写入 Enhanced 档」→ 重启。之后左下角档位菜单、`/permission`、设置页的「默认档位」下拉里会多一个纯文字的 **Enhanced**（沙箱全开、审批 `ask`）。

- **写了什么**：当前 profile 的 `cordis.patch.yml` 里 `permission` 行的档位表。patch 的 `config` 是整块替换，所以写的是完整表（宿主基础三档 + enhanced）；只写一条会把另外三档抹掉。
- **没改什么**：不动你的默认档位。原来没有 `defaultPreset` 就仍然没有。
- **写前备份**：写或摘都先存一份 `cordis.patch.yml.bak-enhance-<时间>`。
- **怎么撤**：同一节点「移除 Enhanced 档」，或手工删掉 patch 里 `enhanced:` 那三行。
- **什么时候生效**：重启 DeepSeek Harness。写档是这一页唯一需要重启的动作。

## 检查

设置页的「检查」翻最新一份会话日志，把系统提示读回来，证明那段文本确实在末尾。四项：插件在进程里、文字合规、真的进了系统提示、Enhanced 档状态明确。只读，不改任何东西。

多工作区并行时，它可能读到别的工作区的日志——这是唯一的口径偏移。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-enhance
```

然后重启。市场卸载只摘插件本身：`<DSH_HOME>/enhance/` 里你写的文本、开关、`.bak` 备份都会保留；你点按钮写进 profile 的档位行也不会被删，Enhanced 仍留在档位菜单里。想彻底干净，先在设置页点「移除 Enhanced 档」，再卸载；数据目录想清就自己删。

## 它到底改了什么

DSH 的程序和自带系统提示一个字节都不动。装和用加起来只碰三处：

| 改的地方 | 具体做了什么 |
|---|---|
| profile 的 `package.json` 与 `dsh.profile.bundles` | 记一笔这个包；`cordis.patch.yml` 由宿主在组合时叠加本包的 bundle patch |
| `<DSH_HOME>/enhance/` | 放这个工具的数据：`state.json`（开关）与 `content-scope.txt`（内容边界）。只在文件不存在时创建，已有就不覆盖 |
| profile 的 `cordis.patch.yml` | 只有你点「写入 Enhanced 档」时才被改：写前备份，写完整档位表；点「移除」把我们写的那三行摘掉 |

它不会清空你配置里的 `personaSuffix` 或 `suffix`：内容边界只追加在那段之后，两者并存。

## 升级之后

升级 DSH 是零操作：这个包不碰宿主配置、不派生任何产物；唯一读宿主安装目录的地方是设置页顶部那行版本号，而且只读元数据，不解包、不写、不改。

那行版本号长这样：`增强 1.1.0 · DSH 0.2.1-rc.5 · 已验 0.2.1-rc.1–0.2.1-rc.5`。超出已验范围时变黄，只提示、不拦控件；读不到本机版本就照实写「读不到」，不猜。探测顺序与 rc.5 上的实测结果见 [docs/compatibility.md](docs/compatibility.md)。

要做的只是「声明还算不算数」：新 rc 发布后跑一遍例行核验（约 15 分钟），过了就把版本号加进 `package.json` 的 `dsh.compatibility`，README 那句由门禁盯着一起改。

如果本机 DSH 超出声明范围，`node scripts/check.mjs` 会直接告诉你：

```
FAIL  version  本机 DSH <版本> 不在声明范围 [0.2.1-rc.1…0.2.1-rc.5]：
      先按 docs/compatibility.md 的例行核验跑一遍（约 15 分钟），
      核验过了再把该版本加进 package.json 的 dsh.compatibility.versions
```

## 让 AI 帮你装

不想自己动手：把下面整段发给任意 AI（Claude / Codex / 你自己的 DSH 会话都行），它会照做。

```text
帮我在这台机器上安装 dsh-enhance —— 一个 DeepSeek Harness 的本地插件。

要求：
1. 先确认本机已装 DeepSeek Harness，并找到它的 dsh 命令
   （桌面版通常在 resources\runtime\cli\bin\dsh.cmd）。
2. 跑：dsh plugin --profile desktop add github:wufeng0105/dsh-enhance
   如果它报错，把原始输出贴给我，不要自己换别的装法、不要改 DSH 的源码或配置。
3. 装完只告诉我「请重启 DeepSeek Harness」。不要自动重启。
4. 如果找不到 dsh 命令，先告诉我，不要猜路径。
```

## 图

![运行期架构：纯插件身份，装的时候只动 profile 的依赖清单](docs/images/01-runtime-architecture.png)

*运行期架构：一条纯插件。装的时候只改你这份 profile 的依赖清单；宿主配置只在你点「写入 Enhanced 档」时才被碰。*

![一条消息的一生](docs/images/02-message-lifecycle.png)

*一条消息的一生：内容边界怎么进到系统提示里，以及怎么用会话日志证明它真的进去了。*

![四道门：为什么这次没有注入](docs/images/04-injection-gates.png)

*四道门：总开关、内容边界开关、文本非空、文本不超过 8 KB——哪道没通过、原因是什么。*

![审批三态](docs/images/05-approval-three-states.png)

*越界审批三态：自动同意 / 先问我 / 自动回绝分别是什么结果，以及开关文件坏了为什么回落到「先问我」。*

还有一页把 DSH 的系统提示怎么一层层拼起来、dsh-enhance 接在哪一档讲清楚：`showcase/prompt-assembly.html`（下载后用浏览器打开）。

## 许可

[MIT](LICENSE)
