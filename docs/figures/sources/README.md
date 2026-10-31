# 图的源与产物

README 里的五张图是 Archify 生成的。这个目录留的是**源**，仓库根的 `docs/figures/*.svg` 是**产物**。

## 三步

```powershell
# 1. 源 JSON → 交互式 HTML（780 KB，带 viewer，可缩放、可搜索、可导出）
node <archify>/bin/archify.mjs finalize <type> docs/figures/sources/<name>.json <out>.html \
  --repo-root . --quality showcase

# 2. 交互式 HTML → 独立 SVG（GitHub 能渲染的那种）
node scripts/extract-figure-svg.mjs <out>.html docs/figures/<name>.svg
```

第 2 步不能省：Archify 的交付物是 HTML，GitHub 的 Markdown 只渲染 `<img src="*.svg">`。
只截 `<svg>` 会丢掉定义在文档 `<style>` 里的类规则，图会渲染成没有配色的线框。

## 为什么源里写了 `meta.repository`

每份源 JSON 都钉了一个 revision：

```json
"repository": {
  "url": "https://github.com/wufeng0105/dsh-enhance",
  "revision": "bfe1ef22a58e8b135b797380968e2daa75bdb026"
}
```

Archify 在 `finalize` 时会拿这个 revision 去本地 Git 检出里逐条核对 `sources` 里引用的
文件与行号——引错了就是红的。改图时请一并更新它。

## 改图之后

1. 改 `sources/*.json`；
2. 跑上面两步；
3. `node scripts/check.mjs --layer fast` 必须仍然 7/7；
4. 提交时把 `docs/figures/*.svg` 与 `docs/figures/sources/*.json` 一起带上。
