#!/usr/bin/env node
/**
 * 未文档化宿主字段禁令（补审计 §3.3 的第二处：`ctx.systemPrompt.layers` 这类入口只有声明式登记）。
 *
 * 背景：`docs/brand-persona.md` 把「运行时改写宿主提示词（H′）」这条挂起路线记在
 * `SystemPrompt.section()` 的 `this.layers.effect()` / `assemble()` 的 `this.layers.merge()`
 * 上——那是宿主**未文档化**的内部字段。一旦生产代码真的去点它，宿主改个名就静默失效；
 * 而 `graph` 门只比自家 `code-map.json`，看不见这类入口。
 *
 * 所以：生产代码（`enhance-scope/`、`shared/`、`ui/`）里出现 `layers` / `*.layers`
 * / `layers.*` / `systemPrompt.layers` 这类入口即红，**除非**登记在
 * `scripts/host-fields-allowlist.json`（每条写清 field + 文件 + 为什么非用不可）。
 *
 * 不静默放过：三个生产目录缺一个、或者一个文件都没扫到，判红——「扫不到」不是「干净」。
 *
 * 用法：node tools/field-check.mjs [--root <项目根>]
 * 退出码：0 干净；1 有未登记入口 / 目录缺失 / 用法错。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRODUCTION_DIRS = ['enhance-scope', 'shared', 'ui']
export const ALLOWLIST_PATH = 'scripts/host-fields-allowlist.json'

/** 未文档化入口的词根。要加新词根时先问：宿主文档里有没有它？ */
const FIELD_ROOT = /(?<![A-Za-z0-9_$])layers(?![A-Za-z0-9_$])/g

/** 允许清单的形状（坏形状判红，不退回「什么都允许」）。 */
function readAllowlist(root) {
  const path = join(root, ALLOWLIST_PATH)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { errors: [`允许清单读不出来（${ALLOWLIST_PATH}）：${String(error?.message ?? error)}`] }
  }
  if (!Array.isArray(parsed?.fields)) return { errors: [`允许清单缺 fields 数组：${ALLOWLIST_PATH}`] }
  const errors = []
  const fields = []
  parsed.fields.forEach((entry, index) => {
    if (typeof entry?.field !== 'string' || entry.field.trim() === '') {
      errors.push(`允许清单 fields[${index}] 缺 field 字符串`)
      return
    }
    if (entry.files !== undefined && (!Array.isArray(entry.files) || !entry.files.every((item) => typeof item === 'string'))) {
      errors.push(`允许清单 fields[${index}].files 必须是字符串数组`)
      return
    }
    fields.push({ field: entry.field.trim(), files: entry.files, reason: String(entry.reason ?? '') })
  })
  return { fields, errors }
}

/** 走盘收生产文件；目录不在或没文件都记成错误（禁令不能静默失效）。 */
function productionFiles(root) {
  const errors = []
  const files = []
  for (const dir of PRODUCTION_DIRS) {
    const path = join(root, dir)
    if (!existsSync(path)) {
      errors.push(`生产目录不在：${dir}/（禁令无从检查，判红）`)
      continue
    }
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
          walk(join(current, entry.name))
        } else if (/\.(mjs|cjs|js)$/.test(entry.name)) files.push(join(current, entry.name))
      }
    }
    walk(path)
  }
  if (files.length === 0 && errors.length === 0) errors.push('生产目录里一个 .js/.mjs 都没扫到（禁令静默失效，判红）')
  return { files, errors }
}

/**
 * 找出源码里的未文档化入口。
 * @param {string} text
 * @returns {{ token: string, candidates: string[] }[]}
 */
export function findFieldEntries(text) {
  const out = []
  for (const match of text.matchAll(FIELD_ROOT)) {
    const at = match.index ?? 0
    const before = text.slice(0, at)
    const after = text.slice(at + match[0].length)
    const suffix = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(after)
    const prefix = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(before)
    const candidates = []
    if (suffix !== null) candidates.push(`layers.${suffix[1]}`)
    if (prefix !== null) candidates.push(`${prefix[1]}.layers`)
    candidates.push('layers')
    out.push({ token: candidates[0], candidates })
  }
  return out
}

/**
 * 跑一遍禁令检查。
 * @param {string} [root]
 * @returns {{ errors: string[], files: number, allowed: number, entries: number }}
 */
export function checkFields(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const errors = []
  const allowlist = readAllowlist(root)
  errors.push(...allowlist.errors)
  const production = productionFiles(root)
  errors.push(...production.errors)
  let entries = 0
  let allowed = 0
  for (const file of production.files) {
    const rel = relative(root, file).split(sep).join('/')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      for (const entry of findFieldEntries(line)) {
        entries += 1
        const permit = (allowlist.fields ?? []).find((item) => item.field === entry.token || entry.candidates.includes(item.field))
        const fileOk = permit !== undefined && (permit.files === undefined || permit.files.includes(rel))
        if (permit !== undefined && fileOk) {
          allowed += 1
          continue
        }
        const hint = permit !== undefined
          ? `「${permit.field}」已登记但没覆盖 ${rel}（允许清单写着只许在 ${permit.files?.join(' / ')} 用）`
          : `把它登记进 ${ALLOWLIST_PATH} 并写清为什么非用不可，否则别用`
        errors.push(`${rel}:${index + 1} 出现未文档化宿主字段入口「${entry.token}」：${hint}`)
      }
    })
  }
  return { errors, files: production.files.length, allowed, entries }
}

// 直接运行时打印结果；被 import 时只导出函数。
if (process.argv[1] !== undefined && process.argv[1].endsWith('field-check.mjs')) {
  const args = process.argv.slice(2)
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') {
      const value = args[index + 1]
      if (typeof value !== 'string' || value.trim() === '') {
        console.error('field-check: --root 需要一个值')
        process.exit(1)
      }
      root = resolve(value)
      index += 1
    } else {
      console.error(`field-check: 未知参数：${args[index]}`)
      process.exit(1)
    }
  }
  const result = checkFields(root)
  if (result.errors.length > 0) {
    console.error(`[fields] ${result.errors.length} 项：`)
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log(`[fields] OK：${PRODUCTION_DIRS.length} 个生产目录 / ${result.files} 个文件里没有未登记的宿主字段入口（扫到 ${result.entries} 处 layers，${result.allowed} 处已登记放行）`)
  process.exit(0)
}