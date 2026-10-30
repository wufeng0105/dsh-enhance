# dsh-enhance

**DSH 老说「我不能」，不是它不会，是它开口前先读了一段很保守的提示词。**

DSH 每次回答前，都会先读一段很长的系统提示词：它是谁、能调哪些工具、该用什么语气。这段内容由 DSH 自己拼，没留给你改的地方。

这个工具不碰那段内容，只在它的最后接上你写的一段纯文本。写破甲词，它就不那么爱说「我不能」；写人设、写内容规矩，也一样。以后你只改一个 txt，别的不用管。

改完存盘，下一条消息就按新的来，不用重启。工具自己不带任何提示词，你写什么，模型就读什么；DSH 的程序和自带提示词，一个字不改。

它是一条**纯插件**：装的时候只改动你自己那份 profile 的依赖清单，**不碰 DSH 的程序、不碰宿主配置**。唯一会写宿主配置的动作是「Enhanced 权限档」那个按钮，而那只在你点它的时候发生。

**适用版本**：dsh-enhance `1.1.0` · DeepSeek Harness 0.2.1-rc.1–0.2.1-rc.5（0.2.1-rc.3 实测，全系源码级核验）。这句是 `package.json` 里 `dsh.compatibility` 的派生文本；核验方法、触点清单与「超出范围怎么办」见 [docs/compatibility.md](docs/compatibility.md)。

## 安装

一条命令，装完重启 DeepSeek Harness：

```powershell
dsh plugin --profile desktop add github:wufeng0105/dsh-enhance
```

装的是三样东西：内容边界注入、审批三态、设置页「增强」一节。

**权限菜单图标**：没有，也不会有。宿主给内置四个档位名准备了图标，表外的档位名只渲染文字行 —— 这是宿主的显示契约，不是这个包缺了什么。

## 使用

改 `<DSH_HOME>/enhance/content-scope.txt` 里那段话：存盘就生效，下一条消息就带上；最多 8 KB（会自动去 BOM、统一换行、去控制字符、去首尾空白）。仓库根目录的那个 `content-scope.txt` 只是首次加载时抄进去的默认内容，你的文件已经存在就不会被覆盖。

开关在 `<DSH_HOME>/enhance/state.json`：

| 开关 | 装好时 | 管什么 |
|---|---|---|
| `enabled` | 开 | 关掉 = 全部停下 |
| `contentScope` | 开 | 关掉 = 不注入那段话 |
| `approval` | 看你的默认档位 | 自动同意 / 先问我 / 自动回绝；这个文件坏了会回落到「先问我」 |

`approval` 的初始值不是硬编码的：它读你 profile 的默认档位——默认档位是 `approval: never`（沙箱全开、不问人）时种「先问我」，否则种「自动同意」。因为 `never` 的档位下宿主在分发前就拒了，种「自动同意」永远轮不到。

也可以不管文件，直接去 DSH 设置页的「增强」那一节：改文本、改开关、点「检查」看有没有真的注入、写或摘 Enhanced 权限档。

## Enhanced 权限档（可选）

宿主内置的 `danger-full-access` 档是「沙箱全开 **并且** 审批不问人（`never`）」。想要「沙箱全开但越界仍问你」，需要一个自定义档；而宿主的档位表只认插件配置里定义的名字，所以只能写进你自己的 profile。

怎么用：设置页「增强」→ 04「Enhanced 权限档」→ 点「写入 Enhanced 档」→ 重启。之后左下角档位菜单、`/permission`、设置页的「默认档位」下拉里会多一个纯文字的 **Enhanced**（沙箱全开、审批 `ask`）。

- **它写了什么**：当前 profile 的 `cordis.patch.yml` 里 `permission` 行的档位表。因为 patch 的 `config` 是**整块替换**，本工具写的是完整表（宿主基础三档 + enhanced）——只写一条会把另外三档抹掉。
- **它没改什么**：不动你的默认档位。原来没有 `defaultPreset` 就仍然没有，宿主按组合的沙箱与审批推导。
- **写前备份**：每次写或摘都先存一份 `cordis.patch.yml.bak-enhance-<时间>`，写坏了能覆盖回去。
- **怎么撤**：同一节点「移除 Enhanced 档」，或手工删掉 patch 里 `enhanced:` 那三行，然后重启。
- **什么时候生效**：重启 DeepSeek Harness。写档是这一页唯一需要重启的动作。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-enhance
```

然后重启。`<DSH_HOME>/enhance/` 里你写的文本、开关、以及 `.bak` 备份都会保留；想彻底清掉就自己删这个目录。**已经写进去的 Enhanced 档不会自动消失**——它是你 profile 里的配置，按上面「怎么撤」那一条摘掉。

## 它到底改了什么

DSH 的程序和自带提示词一个字节都不动。装和用加起来只碰三处：

| 改的地方 | 具体做了什么 |
|---|---|
| profile 的 `package.json` 与 `dsh.profile.bundles` | 记一笔这个包；`cordis.patch.yml` 由宿主在组合时叠加本条目的 bundle patch |
| `<DSH_HOME>/enhance/` | 放这个工具的数据。`state.json`（开关）与 `content-scope.txt`（你写的那段话）只在没有的时候才创建，已经有就不覆盖 |
| profile 的 `cordis.patch.yml` | **只有你点「写入 Enhanced 档」时才会被改**：写前备份 `.bak-enhance-<时间>`，写的是完整档位表；点「移除」会把我们写的那三行摘掉 |

它**不会**清空你配置里的 `personaSuffix` 或 `suffix`。本工具只在你那段之后追加提示词，两者并存时按注册顺序排列。

## 升级之后

**升级 DSH 是零操作**：这个包不碰宿主配置文件、不派生任何东西、不读宿主 `app.asar`，所以宿主升级后你什么都不用做。

要做的是「声明还算不算数」这件事：DSH 发了新的 rc 之后，照 [docs/compatibility.md](docs/compatibility.md) 的例行核验跑一遍（约 15 分钟）：重数触点 → 逐包 tree-diff → 冒烟 → 改两处声明。核验过了，就把新版本号加进 `package.json` 的 `dsh.compatibility`，README 那句派生句由门禁盯着一起改。

如果本机 DSH 版本超出声明范围，`node scripts/check.mjs` 会直接告诉你：

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

*一条消息的一生：你写的那段话怎么进到系统提示里，以及怎么用会话日志证明它真的进去了。*

![四道门：为什么这次没有注入](docs/images/04-injection-gates.png)

*四道门：总开关、内容边界开关、文本非空、文本不超过 8 KB——哪道没通过、原因是什么。*

![审批三态](docs/images/05-approval-three-states.png)

*审批三态：自动同意 / 先问我 / 自动回绝分别是什么结果，以及开关文件坏了为什么回落到「先问我」。*

还有一页把 DSH 的系统提示是怎么一层层拼起来的、dsh-enhance 接在哪一档讲清楚了：`showcase/prompt-assembly.html`（下载后用浏览器打开）。

## 许可

[MIT](LICENSE)
