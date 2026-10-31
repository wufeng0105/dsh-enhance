# dsh-enhance _(dsh-enhance)_

[![CI](https://github.com/wufeng0105/dsh-enhance/actions/workflows/ci.yml/badge.svg)](https://github.com/wufeng0105/dsh-enhance/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

在 DeepSeek Harness 的系统提示末尾追加一段你自己写的文本——人设、内容边界、破甲词都行。存盘即生效，下一条消息就带上。不用重启，不改宿主。

简体中文 | [English](./README.en.md)

## 它做什么

DeepSeek Harness 每次回答前，都会先读一段很长的系统提示：它是谁、能调哪些工具、该用什么语气。这段内容由宿主自己拼，没留给你改的位置。

`dsh-enhance` 是一个 cordis 插件 bundle：它注册多一段提示词，接在宿主的 persona suffix 后面。文字你写，宿主自己的提示词一个字节不动。

- **内容边界**——一个文本文件，最多 8 KB，接在每条系统提示的末尾。
- **越界审批**——动作超出当前档位允许的范围时，自动放行、问你要么直接回绝，你选。
- **Enhanced 权限档**（可选）——往你的 profile 里多加一个「沙箱全开、越界仍问你」的档位。
- **检查**——读会话日志读回来，证明这段文字真的进了提示词。
- **有界的兼容性**——一条 `engines.dsh` 区间，已对 `DeepSeek Harness 0.2.1-rc.1–0.2.1-rc.5（0.2.1-rc.5 实测，全系源码级核验）` 核验过。宿主自己在装的时候和启动的时候都执行这条声明。

## 目录

- [它做什么](#它做什么)
- [安装](#安装)
  - [依赖](#依赖)
- [用法](#用法)
  - [设置页](#设置页)
  - [卸载](#卸载)
- [它怎么接进去的](#它怎么接进去的)
  - [一条消息的全程](#一条消息的全程)
  - [一次保存的全程](#一次保存的全程)
- [兼容性](#兼容性)
- [Enhanced 权限档](#enhanced-权限档)
- [维护者](#维护者)
- [如何贡献](#如何贡献)
- [许可证](#许可证)

## 安装

```powershell
dsh plugin --profile desktop add github:wufeng0105/dsh-enhance
```

装完重启 DeepSeek Harness。别的都不用做——不用单独装 Node，不用改宿主配置。

想从 clone 装：

```powershell
git clone https://github.com/wufeng0105/dsh-enhance.git
dsh plugin --profile desktop add .\dsh-enhance
```

### 依赖

Node.js ≥ 22（宿主自带一个），以及落在上面那个已验区间里的 DeepSeek Harness。

## 用法

写下你想追加的那段文字。改插件建好的文件，或者直接用设置页：

```powershell
# <DSH_HOME>/enhance/content-scope.txt 放文字本身。
# <DSH_HOME>/enhance/state.json 放三个开关。
notepad "$env:USERPROFILE\.dsh\enhance\content-scope.txt"
```

三个开关决定它起不起作用、怎么起作用：

| 字段 | 默认 | 管什么 |
| --- | --- | --- |
| `enabled` | 开 | 总开关。关掉 = 全部停下。 |
| `contentScope` | 开 | 关掉 = 不接那段文本。 |
| `approval` | 看情况 | `allow` / `ask` / `deny`——越界时自动同意、先问我、自动回绝。 |

`state.json` 坏了不会静默放行：回落到「先问我」。

### 设置页

重启后，DSH 的设置页里会多出「增强」一节，四组：内容边界、越界审批、Enhanced 权限档、检查。它写的是同样那两个文件，所以页面里的文本框和你手改的文件始终一致。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-enhance
```

然后重启。`<DSH_HOME>/enhance/` 里你写的文本和开关会保留；想一并清掉就删掉那个目录。

## 它怎么接进去的

这个 bundle 往 profile 的 `cordis.patch.yml` 里插三条入口。宿主其他地方一律不碰。

![宿主组合与三个插件的接缝](./docs/figures/01-host-seams.svg)

`enhance-scope` 注册提示词段、给设置页提供唯一那个接口；`auto-approve` 应答审批请求；界面那半挂在宿主的设置槽位上。

### 一条消息的全程

你的文字是靠宿主每次装配时回调一个函数进入提示词的——这一段的 order 是从宿主自己的 persona suffix 顺序读来的，不是写死的数。

![一条消息怎么进到系统提示末尾](./docs/figures/02-prompt-injection.svg)

想看这套装配的完整推演——原版注册表怎么现场排序、我们怎么在最后一档贴一页纸、怎么用会话日志证明它真的进去了——另有一页长文：[系统提示是怎么拼起来的](./showcase/prompt-assembly.html)。

### 一次保存的全程

设置页走宿主本地 HTTP 服务上唯一那条路由。文字先验大小、**再**改状态，所以超限的保存不会把两个文件改坏。

![设置页一次保存的往返](./docs/figures/03-save-roundtrip.svg)

## 兼容性

`package.json` 里的 `engines.dsh` 是唯一权威。宿主在装前、装后、启动装载时都会读它——不兼容的版本会被直接拒掉，而不是装进去再说。

DeepSeek Harness 出了新版本，下面这套流程约 15 分钟跑完，最后只剩一处可审的 diff：

![例行核验五步](./docs/figures/04-compat-verify.svg)

完整契约——核了哪些宿主接缝、这条区间怎么被执行、怎么扩区间——在 [docs/compatibility.md](./docs/compatibility.md)。

## Enhanced 权限档

`danger-full-access` 的意思是「沙箱全开 **而且** 从不问人」。想要「沙箱全开、但仍问你」，得有一个自定义档，而宿主只认 profile 里定义过的档名。

![Enhanced 档的写入、生效与撤净](./docs/figures/05-enhanced-preset.svg)

写档是这个包里唯一会碰宿主配置的动作，而且只在你点那个按钮时才发生。档位表是写全的——profile patch 的 `config` 是整块替换而不是合并，只写新档会把内置三档一起抹掉。你的默认档位不会被改，每次写档都会在 patch 旁边留一份带时间戳的 `.bak`。

## 维护者

[wufeng0105](https://github.com/wufeng0105)

## 如何贡献

issue 与 pull request 都在 [GitHub](https://github.com/wufeng0105/dsh-enhance/issues) 上开。提 PR 之前先跑 `node scripts/check.mjs`——它跑七道门禁（version / syntax / tests / graph / docs / readme / bundle），必须 exit 0。改动要保持 [docs/terminology.md](./docs/terminology.md) 里的术语一致；README 里那句适用版本是从 `package.json` 派生的，改版本区间要先改声明。

## 许可证

MIT © 2026 wufeng0105——见 [LICENSE](./LICENSE)。
