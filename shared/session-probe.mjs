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
 * 只扫最新一份会误判：desktop / web / headless 共用一个 sessions 目录，最新那份可能是
 * 另一个 profile 的会话。所以按 mtime 倒序扫最近若干个，任一命中即通过。
 *
 * 上限：单个文件 64 MB，超过就跳过（提示词在几十 KB 量级，撞到 64 MB 说明选错了文件）。
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 单个日志文件的解压上限。 */
const MAX_BYTES = 64 * 1024 * 1024

/** 一次检查最多扫多少个最近会话。 */
const SCAN_LIMIT = 10

/** 会话文件的固定名（换版本会变，变了这里就要跟着改）。 */
const SESSION_FILE = 'session.v4.jsonl.zstd'

/** zstd 帧魔数。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 最近的会话文件，按 mtime 倒序。目录结构固定两层：`sessions/<workspace>/<session>/`。
 * @param {string} sessionsDir
 * @param {number} [limit]
 * @returns {{ file: string, mtimeMs: number }[]}
 */
export function recentSessionFiles(sessionsDir, limit = SCAN_LIMIT) {
  const out = []
  let workspaces
  try {
    workspaces = readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return out
  }
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
      out.push({ file, mtimeMs: stat.mtimeMs })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, Math.max(1, limit))
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

/** 读整个文件（显式 fd：宿主的 fs 可能被 asar 垫片包过，这里要磁盘原始字节）。 */
function readAll(file, size) {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(size)
    const read = readSync(fd, buffer, 0, size, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * 在最近若干个会话里找 `needle`。任一命中即通过（不同 profile 共用一个 sessions 目录，
 * 只看最新一份会误判）。返回 Promise 是为了调用方语义稳定（内部是同步的）。
 * @param {string} sessionsDir
 * @param {string} needle 已经归一过的文本（`normalizeText` 之后）
 * @returns {Promise<{ ok: boolean, detail: string, file?: string, sessionAt?: string, hits?: number, textLen?: number, frames?: number, bytes?: number }>}
 */
export async function sessionContains(sessionsDir, needle) {
  const wanted = String(needle ?? '')
  if (wanted.length === 0) return { ok: false, detail: '文本为空，没有可验的目标' }

  const candidates = recentSessionFiles(sessionsDir, SCAN_LIMIT)
  if (candidates.length === 0) return { ok: false, detail: `没有会话日志（${sessionsDir} 下没有 ${SESSION_FILE}）` }

  let scanned = 0
  let skipped = 0
  let lastAt
  for (const candidate of candidates) {
    let stat
    try {
      stat = statSync(candidate.file)
    } catch {
      continue
    }
    scanned += 1
    lastAt = stat.mtime.toISOString()
    if (stat.size > MAX_BYTES) {
      skipped += 1
      continue
    }
    let decoded
    try {
      decoded = decompressFrames(readAll(candidate.file, stat.size))
    } catch {
      continue
    }
    // 只认「system-prompt 记录里出现这句话」。
    // 整份文本匹配会假绿：任何会话只要读过含这句话的文件（比如本项目的 gates），
    // 工具结果里就会有它；那证明不了注入，只证明文件被读过。
    let hits = 0
    for (const line of decoded.text.split('\n')) {
      if (!line.includes('"system-prompt"')) continue
      if (line.includes(wanted) || (wanted.includes('\n') && line.includes(wanted.replace(/\n/g, '\\n')))) hits += 1
    }
    if (hits > 0) {
      return {
        ok: true,
        detail: `命中 ${hits} 次`,
        file: candidate.file,
        sessionAt: stat.mtime.toISOString(),
        hits,
        textLen: decoded.text.length,
        frames: decoded.frames,
        bytes: stat.size,
      }
    }
  }

  const suffix = skipped > 0 ? `（跳过 ${skipped} 份超大日志）` : ''
  return {
    ok: false,
    detail: `最近 ${scanned} 个会话里都没有这段文本${suffix}${lastAt === undefined ? '' : `（最新 ${lastAt.slice(11, 16)}）`}——装好后先发一条消息再检查`,
  }
}
