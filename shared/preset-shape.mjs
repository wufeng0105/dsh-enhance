/**
 * 从 profile patch 里读默认档位。
 *
 * 唯一消费者是 `shared/seed.mjs`：首装播种审批值时要知道宿主默认档位的
 * `approval` 策略——默认档位是 `never` 的话，宿主在分发前就 `rejected`，
 * 我们种下的 `allow` 永远轮不到，那种情况必须种 `ask`（问人，语义诚实）。
 *
 * 只做行级解析，不引 YAML：patch 的键顺序不是我们该假设的（生成的 patch 会把
 * `defaultPreset` 排在 `presets` 前面），所以两个键各自独立定位。
 *
 * @module shared/preset-shape
 */

/**
 * Read `defaultPreset` and that preset's `approval` from a profile patch.
 *
 * @param {string} text
 * @returns {{ name: string, approval: string | undefined } | undefined}
 */
export function defaultPresetApproval(text) {
  const lines = text.split(/\r?\n/)
  const declared = lines.find((line) => /^[ \t]*defaultPreset:[ \t]*\S/.test(line))
  if (declared === undefined) return undefined
  const name = declared.replace(/^.*defaultPreset:[ \t]*/, '').replace(/^['"]|['"]$/g, '').trim()
  if (name === '') return undefined
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = lines.findIndex((line) => new RegExp(`^[ \\t]*${escaped}:[ \\t]*$`).test(line))
  if (start < 0) return { name, approval: undefined }
  const base = (lines[start].match(/^[ \t]*/) ?? [''])[0].length
  for (let scan = start + 1; scan < lines.length; scan += 1) {
    const line = lines[scan]
    if (line.trim() === '') continue
    if (line.length - line.trimStart().length <= base) break
    const approval = /^[ \t]*approval:[ \t]*(\S+)/.exec(line)
    if (approval !== null) return { name, approval: approval[1] }
  }
  return { name, approval: undefined }
}
