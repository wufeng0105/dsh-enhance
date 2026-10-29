/**
 * `clientCheck` 的测试：检查第四项「enhance-permissions/client.js」。
 *
 * 这一项长期只有一句误导性文案：它只做正则匹配「有没有 source-sha256 戳」，
 * 既不校验哈希、也不读 asar，所以只能证明「文件在且带来源记录」。
 * 下面把「能证明什么」和「不能证明什么」都钉住，避免文案再退回「带戳 = 已对齐」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __testing } from '../enhance-scope/index.js'

const { clientCheck } = __testing

/** 造一个只有 enhance-permissions/ 的临时插件目录。 */
function fixture(clientContent) {
  const dir = mkdtempSync(join(tmpdir(), 'enh-client-'))
  mkdirSync(join(dir, 'enhance-permissions'), { recursive: true })
  if (clientContent !== undefined) {
    writeFileSync(join(dir, 'enhance-permissions', 'client.js'), clientContent, 'utf8')
  }
  return dir
}

const SHA = 'a'.repeat(64)
const STAMPED = `// enhance-permissions/client.js — generated\n// source-sha256: ${SHA}\n\nmodule.exports = {}\n`

test('client：带合格戳时通过，且文案明说「只证明文件完整」', () => {
  const dir = fixture(STAMPED)
  try {
    const result = clientCheck(dir)
    assert.equal(result.name, 'client')
    assert.equal(result.pass, true)
    // 关键：不许暗示「已对齐」。必须出现「文件完整」这一限定。
    assert.match(result.detail, /存在/)
    assert.match(result.detail, /文件完整/)
    // 必须给出真正的代际检查命令，因为这一项自己做不到
    assert.match(result.detail, /--check/)
    assert.match(result.detail, /--asar/)
    // 明确指向同代判定
    assert.match(result.detail, /同代/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('client：文件不存在时判失败，并给生成命令', () => {
  const dir = fixture(undefined)
  try {
    const result = clientCheck(dir)
    assert.equal(result.pass, false)
    assert.match(result.detail, /不存在/)
    // WCAG 3.3.3：给怎么改
    assert.match(result.detail, /build-client\.mjs --asar/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('client：文件在但没有戳时判失败（这是「存在」与「有来源记录」两件事）', () => {
  const dir = fixture('module.exports = {}\n')
  try {
    const result = clientCheck(dir)
    assert.equal(result.pass, false)
    assert.match(result.detail, /不存在/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('client：戳的格式不对时不放过（必须 64 位十六进制）', () => {
  const cases = [
    '// source-sha256: abc\n',            // 太短
    `// source-sha256: ${'z'.repeat(64)}\n`, // 非十六进制
    `//source-sha256: ${SHA}\n`,          // 少一个空格
    `  // source-sha256: ${SHA}\n`,       // 行首缩进
    `// source-sha256: ${SHA} extra\n`,   // 行尾多东西
  ]
  for (const content of cases) {
    const dir = fixture(content)
    try {
      assert.equal(clientCheck(dir).pass, false, `不该通过：${JSON.stringify(content)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('client：伪造一个合格格式的戳会通过——这是已知弱点，钉住它', () => {
  // 这不是「应该通过」，而是「现在会通过」。写成测试是为了让弱点可见：
  // 谁手写一行 64 个 0 就能让这一项变绿。真正的代际检查只能靠 --check。
  const dir = fixture(`// source-sha256: ${'0'.repeat(64)}\n`)
  try {
    assert.equal(clientCheck(dir).pass, true)
    // 因此文案必须避免让用户以为「通过 = 派生件没问题」
    assert.doesNotMatch(clientCheck(dir).detail, /已对齐|没问题|已是最新/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('client：读目录当文件时不抛，按失败处理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enh-client-'))
  // 把 client.js 造成目录，readFileSync 会 EISDIR
  mkdirSync(join(dir, 'enhance-permissions', 'client.js'), { recursive: true })
  try {
    const result = clientCheck(dir)
    assert.equal(result.pass, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
