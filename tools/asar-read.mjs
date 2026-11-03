/**
 * 最小 asar 只读读取器（零依赖）。
 *
 * 为什么进仓：`tools/host-check.mjs` 要拿**宿主原文**当基准核对，而 asar 头是宿主自己的
 * 二进制格式。以前这类件是写一次丢在 `%TEMP%` 的临时脚本（审计 §3.4 点过这处「核过了
 * 但没记怎么核」），换台机器就复跑不了。这里把唯一一份最小实现落到仓库里。
 *
 * 只读，不写盘、不解包：
 *   - 头部布局：8 字节（4 字节保留 + 4 字节 headerSize）+ header JSON；header 前 4 字节是
 *     JSON 字节长度（相对 header 起点偏移 4），JSON 本身从偏移 8 开始；
 *   - 条目数据从 `8 + headerSize + offset` 开始，按 `size` 截；
 *   - `unpacked` 的条目在磁盘上，按 `<archive>.unpacked` 读（宿主当前版本不会用到，留着不骗人）。
 *
 * @module tools/asar-read
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 打开一个 asar 归档（只读）。
 * @param {string} archive asar 文件路径
 * @returns {{ entries: {path: string, node: object}[], header: object, read: (path: string) => Buffer, close: () => void }}
 * @throws 文件不存在、太短、头长度不合理、头不是 JSON —— 都抛，由调用方判红
 */
export function openAsar(archive) {
  if (!existsSync(archive)) throw new Error(`asar 不存在：${archive}`)
  const total = statSync(archive).size
  if (total < 16) throw new Error(`不是 asar（文件只有 ${total} 字节）：${archive}`)
  const fd = openSync(archive, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    readSync(fd, sizeBuf, 0, 8, 0)
    const headerSize = sizeBuf.readUInt32LE(4)
    if (headerSize <= 0 || 8 + headerSize > total) {
      throw new Error(`asar 头长度不合理（headerSize=${headerSize}，文件 ${total} 字节）：${archive}`)
    }
    const headerBuf = Buffer.alloc(headerSize)
    readSync(fd, headerBuf, 0, headerSize, 8)
    const jsonLength = headerBuf.readUInt32LE(4)
    if (jsonLength <= 0 || jsonLength + 8 > headerSize) {
      throw new Error(`asar 头里的 JSON 长度不合理（${jsonLength}）：${archive}`)
    }
    let header
    try {
      header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLength))
    } catch (error) {
      throw new Error(`asar 头不是 JSON（${String(error?.message ?? error)}）：${archive}`)
    }
    const baseOffset = 8 + headerSize
    const entries = []
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node?.files ?? {})) {
        const entryPath = prefix === '' ? name : `${prefix}/${name}`
        if (child !== null && typeof child === 'object' && child.files !== undefined) walk(child, entryPath)
        else entries.push({ path: entryPath, node: child })
      }
    }
    walk(header, '')
    if (entries.length === 0) throw new Error(`asar 是空的（0 个条目）：${archive}`)

    /** 按条目路径取原始字节。 */
    const read = (entryPath) => {
      const entry = entries.find((item) => item.path === entryPath)
      if (entry === undefined) throw new Error(`asar 里没有这个条目：${entryPath}`)
      if (entry.node.unpacked === true) {
        const unpacked = join(`${archive}.unpacked`, entry.node.path ?? entryPath)
        if (!existsSync(unpacked)) throw new Error(`条目标记为 unpacked 但磁盘上没有：${unpacked}`)
        return readFileSync(unpacked)
      }
      const offset = baseOffset + Number(entry.node.offset)
      const size = Number(entry.node.size)
      if (!Number.isFinite(offset) || !Number.isFinite(size) || size < 0 || offset + size > total) {
        throw new Error(`条目范围越界（offset=${entry.node.offset} size=${entry.node.size}）：${entryPath}`)
      }
      const buf = Buffer.alloc(size)
      const got = readSync(fd, buf, 0, size, offset)
      if (got !== size) throw new Error(`条目只读到 ${got}/${size} 字节：${entryPath}`)
      return buf
    }

    return { entries, header, read, close: () => closeSync(fd) }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/**
 * 在条目表里找一个文件：先按精确路径，再按后缀（宿主在 `dsh/node_modules/@deepseek-ai/…` 下，
 * 不同版本前缀可能变，后缀 `@deepseek-ai/<包>/lib/index.js` 更稳）。
 * @param {{path: string}[]} entries
 * @param {string} exact 期望的精确路径
 * @param {string} suffix 兜底后缀（以 `/` 开头）
 * @returns {{path: string, node: object}|undefined}
 */
export function findEntry(entries, exact, suffix) {
  const byExact = entries.find((entry) => entry.path === exact)
  if (byExact !== undefined) return byExact
  return entries.find((entry) => entry.path.endsWith(suffix))
}

// 直跑守卫：本文件是库，没有 CLI。曾经顶着 shebang 又没有入口，`node tools/asar-read.mjs`
// 会静默 exit 0——「看起来像跑过了」比报错更坏，所以这里必须出声并给非零退出码。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.error('asar-read 是库（由 tools/host-check.mjs import），不是 CLI。要核宿主原文请跑：node tools/host-check.mjs')
  process.exit(2)
}