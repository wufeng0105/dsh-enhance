/**
 * 行级 patch 手术的公共工具。
 *
 * 为什么单拎出来：改 profile patch 的地方都要"按行改一处、其余一个字节不动"。
 * 之前几处各写一套 `split('\n')`，CRLF 的 patch 上 `/…[ \t]*$/` 全部落空——
 * 结果是追加重复行、静默不恢复，而按行盯着的检查看起来全绿。
 * 同一个仓里换行有两种切法是这类 bug 的根；这里只留一种。
 *
 * 约定：**检测到的行尾原样写回**，混合行尾按"含 `\r\n` 即 CRLF"处理（本项目没有真正的混合文件）。
 *
 * 「只改该改的那几行、其余逐字节不动」是本包对用户配置的承诺，与主线同一条线。
 */

/** @param {string} text @returns {'\r\n' | '\n'} */
export function eolOf(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n'
}

/** 按行切，去掉行尾的 `\r`。@param {string} text @returns {string[]} */
export function splitLines(text) {
  return String(text).split(/\r?\n/)
}

/** 按原行尾拼回去。@param {string[]} lines @param {'\r\n' | '\n'} eol */
export function joinLines(lines, eol) {
  return lines.join(eol)
}
