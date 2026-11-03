/**
 * 包根入口——**只为满足市场插件的一次装后校验而存在**，不承载任何功能。
 *
 * 为什么需要它：市场装完一个包后会跑 `hasLoadableEntry`（dshmarket `lib/profile.js`），
 * 它要求包根有 `main` / `exports` / 根 `index.js` 三者之一。纯 patch 载体（本包就是）
 * 按构造没有，于是被判「没有可安装的内容」并从 profile 里当场删掉——安装流程走完了，
 * 东西却没了，报的还是「需要构建授权」这种与事实无关的兜底文案。已提上游：
 * https://github.com/dsh-market/dsh-market/issues/1091
 *
 * 宿主从不加载这个文件：bundle 只加载 `cordis.patch.yml` 里 patch 行所指的模块
 * （`enhance-scope/`、`auto-approve/`、`ui/`），包根本身不在组合树里。实测确认：
 * 加上它之后 `--dump-config` 仍然只有那三个入口，冒烟 44/44 照过。
 *
 * ⚠️ 拆除条件：上游把 #1091 修好之后，删掉本文件、删掉 `package.json` 的 `main`、
 * 并删掉 `scripts/check.mjs` 里 `gateBundle` 那段「包根缺可加载入口」的判定——三处一起。
 * 只删一处会让门禁变红（那是故意的：市场看不见，门禁就是它唯一的哨兵）。
 */

export {}
