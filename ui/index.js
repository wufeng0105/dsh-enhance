/**
 * 设置页外壳 —— 宿主半。
 *
 * 页面本身在 `client.js`（浏览器半），这里只需要让 Loader 有一行可 import 的宿主入口：
 * 它不注册任何服务、不监听任何事件。把客户端半挂上去靠 `package.json` 的
 * `dsh.client.platform = "web"` 与 `exports["./client"]`。
 *
 * 宿主半存在只是为了让 profile patch 里那一行有东西可指——它不碰宿主任何东西，
 * 与「只追加一段文本」那条主线一致。
 */

/** 诊断标签；只出现在 Loader 日志与失败链里。 */
export const name = 'enhance-ui'

/** 宿主侧无事可做。 */
export function apply() {}
