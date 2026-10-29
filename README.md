# dsh-enhance

**DSH 老说「我不能」，不是它不会，是它开口前先读了一段很保守的提示词。**

DSH 每次回答前，都会先读一段很长的系统提示词：它是谁、能调哪些工具、该用什么语气。这段内容由 DSH 自己拼，没留给你改的地方。

这个工具不碰那段内容，只在它的最后接上你写的一段纯文本。写破甲词，它就不那么爱说「我不能」；写人设、写内容规矩，也一样。以后你只改一个 txt，别的不用管。

改完存盘，下一条消息就按新的来，不用重启。工具自己不带任何提示词，你写什么，模型就读什么；DSH 的程序和自带提示词，一个字不改。

哪天不想要了，卸载能把 DSH 还原成装之前的样子。装了什么、改了哪几行，都有记录。

**适用版本**：dsh-enhance `1.0.0` · DeepSeek Harness `0.2.1-rc.3`。不用单独装 Node（安装脚本用 DSH 自带的）。

## 安装

两种装法，二选一：

### 市场 / 一行装（bundle）

```powershell
dsh plugin --profile desktop add github:wufeng0105/dsh-enhance
```

装完重启 DeepSeek Harness。这条路径只把本包装进这个 profile 的依赖和 `bundles`，**profile 自己的 `cordis.patch.yml` 一个字节不改**；装的是内容边界注入 + 审批三态 + 设置页。它不带「权限菜单图标」和 `enhanced` 预设——要这些就用下面的完整安装。

### 完整安装（桌面版，双击）

**下载或 clone 仓库，然后双击 `enhance-install.cmd`，就这一下。** 它会自己找 DSH 和它的 home，先说明找到了什么、打算做什么，问一句「继续？[Y/n]」，回车就开始装；安装过程会把改了哪几行打出来，装完自己跑一遍检查，最后提示你重启 DeepSeek Harness。

重启后在 DSH 设置页的 enhance 那一节点一次「开始检查」，确认真的生效了。

不想用菜单、想带参数跑的话：

```powershell
.\enhance-install.ps1 -DryRun                  # 只看会改什么，不写盘
.\enhance-install.ps1 -Yes                     # 不问，直接装
.\enhance-install.ps1 -Profiles desktop,web    # 默认只装桌面版，这里指定多装
.\enhance-install.ps1 -DshRoot "D:\...\DeepSeek Harness" -Home "D:\dsh-home"   # 路径不是默认值时
```

几点说明：

- 双击 `.cmd` 最省事：它自己处理 PowerShell 执行策略，还会在 `pwsh` 不在时退回系统自带的 Windows PowerShell。
- 默认只装桌面版；`headless` / `web` 要用 `-Profiles` 指定（这些版本要已经有配置文件）；一个能装的都没有时会直接拒绝，不会装一半。
- 已经装过、版本又一样时，它不会重装，只跑一遍校验（不动任何文件，也不提示重启）。
- 装完只提示重启，不会自动重启。

## 卸载

- **一行装（bundle）**：`dsh plugin --profile desktop remove dsh-enhance`，然后重启。`<DSH_HOME>/enhance/` 里你写的文本和开关会保留；想彻底清掉就删掉这个目录。
- **完整安装**：**双击 `enhance-uninstall.cmd`。** 菜单选 `1` 保留备份（默认：先把你的文本和开关归档，再删掉工具装的文件）或 `2` 彻底清理（会再确认一次），然后重启 DSH 就行。

带参数跑的话：

```powershell
.\enhance-uninstall.ps1 -DryRun            # 只看计划
.\enhance-uninstall.ps1 -Yes               # 不问，按默认方式（保留备份）
.\enhance-uninstall.ps1 -Thorough -Yes     # 不问，彻底清理
```

默认卸载会把 DSH 的配置还原成装之前的样子，一处不差。

## 它到底改了什么

DSH 的程序和自带提示词不动。一行装只动 profile 清单；完整安装还会改下面这些：

| 改的地方 | 具体做了什么 |
|---|---|
| 一行装（bundle） | 只往 profile 的 `package.json` 加一条依赖、在 `dsh.profile.bundles` 记一笔；不改 `cordis.patch.yml` |
| `<DSH_HOME>/enhance/` | 放这个工具的文件。`state.json`（开关）和 `content-scope.txt`（你写的那段话）只在没有的时候才创建，已经有就不覆盖；一行装会在首次加载时自动补齐 |
| DSH 的配置 `cordis.patch.yml`（完整安装） | 加几行记录，让 DSH 开机时加载它；桌面版还会把权限菜单换成它的版本 |
| 权限档位（完整安装） | 多一个 `enhanced` 档（沙箱全开、审批仍问人）。原来没有默认档位的话，会把默认设成它 |
| 自带的「人格后缀」（完整安装） | 如果你在配置里写过 `personaSuffix` 或 `suffix` 这段文字，它会被清空——这个位置要让给那段提示词；卸载会还原 |
| 备份（完整安装） | 每次动配置前先存一份 `.bak-enhance-<时间>`，卸载时按备份还原 |

装之前可以用 `-DryRun` 跑一次，上面这些改动作它会逐条打出来，你看一眼再决定装不装。

## 使用

改 `<DSH_HOME>/enhance/content-scope.txt` 里那段话：存盘就生效，下一条消息就带上；最多 8 KB（会自动去 BOM、统一换行、去控制字符、去首尾空白）。仓库根目录的那个 `content-scope.txt` 只是首次安装（或首次加载）时抄进去的默认内容，你的文件已经存在就不会被覆盖。

开关在 `<DSH_HOME>/enhance/state.json`：

| 开关 | 装好时 | 管什么 |
|---|---|---|
| `enabled` | 开 | 关掉 = 全部停下 |
| `contentScope` | 开 | 关掉 = 不注入那段话 |
| `approval` | 自动放行 | 自动放行 / 每次问人 / 直接拒绝；这个文件坏了会回落到「每次问人」 |

**装好时审批是自动放行的**，工具操作不会弹窗。不想这样，就在设置页把它改成「每次问人」或「直接拒绝」。

也可以不管文件，直接去 DSH 设置页的 enhance 那一节：改文本、改开关、点「开始检查」看有没有真的注入、点卸载。

## 升级之后

DSH 升级后，先在仓库根跑一次 `node doctor.mjs --home <DSH_HOME>`。如果设置页里的权限菜单图标不对，按新版本重新生成一次：

```powershell
node enhance-permissions/build-client.mjs --asar "<DSH_ROOT>\resources\app.asar"
```

## 让 AI 帮你装

不想自己动手：把下面整段发给任意 AI（Claude / Codex / 你自己的 DSH 会话都行），它会照做。

```text
帮我在这台机器上安装 dsh-enhance —— 一个 DeepSeek Harness 的本地破甲插件。
仓库：https://github.com/wufeng0105/dsh-enhance

要求：
1. 先确认本机已经装好 DeepSeek Harness（不用另外装 Node，安装脚本会用 DSH 自带的 node）。
2. 把仓库下载下来（git clone 或解压 ZIP 都行），进到仓库根目录。
3. 先跑 `pwsh -NoProfile -ExecutionPolicy Bypass -File .\enhance-install.ps1 -DryRun`，把输出原样贴给我。
4. 我确认后再跑 `pwsh -NoProfile -ExecutionPolicy Bypass -File .\enhance-install.ps1 -Yes`，它会装好并自动跑一遍检查。
5. 把检查输出原样贴给我；全部 PASS 后停手，只告诉我「请重启 DeepSeek Harness」。不要自动重启、不要改 DSH 源码、不要动别的插件和配置。

如果找不到 DeepSeek Harness 装在哪，先告诉我，不要猜。
```

## 图

![运行期架构：它只靠 DSH 配置里的几行记录接进去，不改程序本体](docs/images/01-runtime-architecture.png)

*运行期架构：它只靠 DSH 配置里的几行记录接进去，不改程序本体。*

![一条消息的一生](docs/images/02-message-lifecycle.png)

*一条消息的一生：你写的那段话怎么进到系统提示里，以及怎么用会话日志证明它真的进去了。*

![四道门：为什么这次没有注入](docs/images/04-injection-gates.png)

*四道门：总开关、内容边界开关、文本非空、文本不超过 8 KB——哪道没通过、原因是什么。*

![审批三态](docs/images/05-approval-three-states.png)

*审批三态：自动放行 / 每次问人 / 直接拒绝分别是什么结果，以及开关文件坏了为什么回落到「每次问人」。*

还有一页把 DSH 的系统提示是怎么一层层拼起来的、dsh-enhance 接在哪一档讲清楚了：`showcase/prompt-assembly.html`（下载后用浏览器打开）。

## 许可

[MIT](LICENSE)
