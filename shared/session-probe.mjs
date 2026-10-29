/**
 * 会话日志探针：证明「内容边界真的进了系统提示」。
 *
 * 用途：`POST /enhance/api` 的 `check` op（页面上的「检查」按钮）。
 * 它在**运行时**回答一个文件层回答不了的问题：插件挂上了、文件也在，但这一次装配
 * 内容边界到底有没有拼进提示词？唯一可信的证据是会话日志里 system 事件的原文。
 *
 * 日志形状：`<home>/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，
 * zstd 压缩的 jsonl，**追加写，一个文件里有多帧**。
 *
 * 实测（2026-10-28）：宿主自带的 Node 是 **v24.21.0**，`zstdDecompressSync` 与流式
 * `createZstdDecompress` 都只解第一帧（30 KB 的日志只回来 179 字符），于是进程内永远
 * 找不到文本；PATH 上的 v24.22.1 才解全。判据不能随宿主小版本漂移，所以这里按帧切：
 * 找 zstd 魔数、逐帧解、拼起来。
 *
 * 上限：单个文件 64 MB，超过就跳过（提示词在几十 KB 量级，撞到 64 MB 说明选错了文件）。
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 单个日志文件的解压上限。 */
const MAX_BYTES = 64 * 1024 * 1024

/** 会话文件的固定名（换版本会变，变了这里就要跟着改）。 */
const SESSION_FILE = 'session.v4.jsonl.zstd'

/** zstd 帧魔数。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 找最新的一个会话文件。目录结构固定两层：`sessions/<workspace>/<session>/`。
 * @param {string} sessionsDir
 * @returns {{ file: string, mtimeMs: number } | undefined}
 */
export function newestSessionFile(sessionsDir) {
  let workspaces
  try {
    workspaces = readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return undefined
  }
  let best
  for (const workspace of workspaces) {
    const workspaceDir = join(sessionsDir, workspace.name)
    let sessions
    try {
      sessions = readdirSync(workspaceDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      const file = join(workspaceDir, session.name, SESSION_FILE)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      if (best === undefined || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs }
    }
  }
  return best
}

/**
 * 解压一份可能含多帧的 zstd。假魔数（出现在压缩数据里）会让那一段解不开，跳过即可——
 * 只影响命中数，不影响「有没有」这个判断。
 * @param {Buffer} raw
 * @returns {{ text: string, frames: number, partial: boolean }}
 */
export function decompressFrames(raw) {
  const offsets = []
  for (let index = 0; index + 4 <= raw.length; index += 1) {
    if (raw.compare(MAGIC, 0, 4, index, index + 4) === 0) offsets.push(index)
  }
  if (offsets.length <= 1 || offsets[0] !== 0) {
    return { text: zstdDecompressSync(raw).toString('utf8'), frames: 1, partial: false }
  }
  let text = ''
  let frames = 0
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : raw.length
    try {
      text += zstdDecompressSync(raw.subarray(start, end)).toString('utf8')
      frames += 1
    } catch {
      // 假魔数：这一段跳过，下一帧接着拼
    }
  }
  return { text, frames, partial: frames === 0 }
}

/**
 * 在最新会话里找 `needle`。返回 Promise 是为了调用方语义稳定（内部是同步的）。
 * @param {string} sessionsDir
 * @param {string} needle 已经归一过的文本（`normalizeText` 之后）
 * @returns {Promise<{ ok: boolean, detail: string, file?: string, sessionAt?: string, hits?: number, textLen?: number, frames?: number, bytes?: number }>}
 */
export async function sessionContains(sessionsDir, needle) {
  const wanted = String(needle ?? '')
  if (wanted.length === 0) return { ok: false, detail: '文本为空，没有可验的目标' }

  const newest = newestSessionFile(sessionsDir)
  if (newest === undefined) return { ok: false, detail: `没有会话日志（${sessionsDir} 下没有 ${SESSION_FILE}）` }

  let stat
  try {
    stat = statSync(newest.file)
  } catch {
    return { ok: false, detail: `读不到 ${newest.file}` }
  }
  if (stat.size > MAX_BYTES) return { ok: false, detail: `会话日志 ${stat.size} B，超过 ${MAX_BYTES} B 上限，跳过` }

  let raw
  try {
    // 显式 fd 读：宿主的 fs 可能被 asar 垫片包过，这里要磁盘原始字节
    const fd = openSync(newest.file, 'r')
    try {
      const buffer = Buffer.allocUnsafe(stat.size)
      const read = readSync(fd, buffer, 0, stat.size, 0)
      raw = buffer.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    return { ok: false, detail: `读取失败：${String(error?.message ?? error)}` }
  }

  let decoded
  try {
    decoded = decompressFrames(raw)
  } catch (error) {
    return { ok: false, detail: `解压失败：${String(error?.message ?? error)}` }
  }

  // 只认「system-prompt 记录里出现这句话」。
  // 整份文本匹配会假绿：任何会话只要读过含这句话的文件（比如本项目的 gates），
  // 工具结果里就会有它；那证明不了注入，只证明文件被读过。
  let hits = 0
  for (const line of decoded.text.split('\n')) {
    if (!line.includes('"system-prompt"')) continue
    if (line.includes(wanted) || (wanted.includes('\n') && line.includes(wanted.replace(/\n/g, '\\n')))) hits += 1
  }
  return {
    ok: hits > 0,
    detail: hits > 0 ? `命中 ${hits} 次` : '会话里没有这段文本',
    file: newest.file,
    sessionAt: stat.mtime.toISOString(),
    hits,
    textLen: decoded.text.length,
    frames: decoded.frames,
    bytes: stat.size,
  }
}
