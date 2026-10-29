/**
 * 权限选择器替换的宿主半。
 *
 * 行为在 `client.js`（从宿主 bundle 派生、多一个 `enhanced` 图标）。宿主半存在的唯一理由
 * 是 Loader 行必须 import 到这一侧的某个入口；它不注册任何服务。
 */

/** 诊断名；只出现在 Loader 日志与失败链里。 */
export const name = 'enhance-permissions'

/** 宿主侧无事可做：这一行是为了它的浏览器半。 */
export function apply() {}
