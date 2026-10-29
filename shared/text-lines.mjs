/**
 * 行级 patch 手术的公共工具。
 *
 * 为什么单拎出来：`install.mjs` 与 `uninstall.mjs` 都要"按行改一处、其余一个字节不动"。
 * 之前两处各写一套 `split('\n')`，CRLF 的 patch 上 `/…[ \t]*$/` 全部落空——
 * 结果是 install 追加重复行、uninstall 静默不恢复，而 `doctor` 用 `/\r?\n/` 看起来全绿。
 * 同一个仓里换行有两种切法是这类 bug 的根；这里只留一种。
 *
 * 约定：**检测到的行尾原样写回**，混合行尾按"含 `\r\n` 即 CRLF"处理（本项目没有真正的混合文件）。
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

/**
 * 从 `lines` 里摘掉一个 `- id: <id>` 条目：id 行 + 它下面所有缩进更深的行。
 * @param {string[]} lines
 * @param {string} id
 * @returns {{ lines: string[], removed: boolean }}
 */
export function removeRowBlock(lines, id) {
  const rowPattern = new RegExp(`^([ \\t]*)-[ \\t]*id:[ \\t]*${id}[ \\t]*$`)
  for (let index = 0; index < lines.length; index += 1) {
    const match = rowPattern.exec(lines[index])
    if (match === null) continue
    const base = match[1].length
    let end = index + 1
    while (end < lines.length) {
      const line = lines[end]
      const indent = line.length - line.trimStart().length
      if (line.trim() !== '' && indent <= base) break
      end += 1
    }
    // 顺手吃掉紧贴在前面的空行，避免留下双空行
    let start = index
    if (start > 0 && lines[start - 1].trim() === '') start -= 1
    lines.splice(start, end - start)
    return { lines, removed: true }
  }
  return { lines, removed: false }
}

/**
 * 摘掉 `- insert:` 块里的一行；块空了就把 `- insert:` 那行也摘掉。
 * @param {string[]} lines
 * @param {string} id
 * @returns {{ lines: string[], removed: boolean }}
 */
export function removeInsertRow(lines, id) {
  const rowPattern = new RegExp(`^[ \\t]*-[ \\t]*id:[ \\t]*${id}[ \\t]*$`)
  for (let index = 0; index < lines.length; index += 1) {
    if (!rowPattern.test(lines[index])) continue
    const indent = lines[index].length - lines[index].trimStart().length
    let end = index + 1
    while (end < lines.length) {
      const line = lines[end]
      const lineIndent = line.length - line.trimStart().length
      if (line.trim() !== '' && lineIndent <= indent) break
      end += 1
    }
    lines.splice(index, end - index)
    // 找最近的 `- insert:` 祖先，看它还有没有孩子
    for (let back = index - 1; back >= 0; back -= 1) {
      if (!/^[ \t]*-[ \t]*insert:[ \t]*$/.test(lines[back])) {
        if (/^\s*-\s/.test(lines[back])) break
        continue
      }
      const insertIndent = lines[back].length - lines[back].trimStart().length
      const hasChild = (() => {
        for (let scan = back + 1; scan < lines.length; scan += 1) {
          const line = lines[scan]
          if (line.trim() === '') continue
          const lineIndent = line.length - line.trimStart().length
          if (lineIndent <= insertIndent) return false
          return true
        }
        return false
      })()
      if (!hasChild) {
        // 先摘 `- insert:` 本身，再向上吃注释与空行；先摘空行会把 insert 留成悬空
        lines.splice(back, 1)
        let start = back
        while (start > 0 && /^[ \t]*#/.test(lines[start - 1])) {
          start -= 1
          lines.splice(start, 1)
        }
        if (start > 0 && lines[start - 1].trim() === '') lines.splice(start - 1, 1)
      }
      break
    }
    return { lines, removed: true }
  }
  return { lines, removed: false }
}
