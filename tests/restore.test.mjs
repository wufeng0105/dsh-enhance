/**
 * `install.mjs --restore` 的契约。
 *
 * 归档只认当前格式（version 3）：字段就 enabled / contentScope / approval。
 * 不认识的版本（1、2、4…）与坏字段一律拒绝，且不写任何文件。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function home() {
  const root = mkdtempSync(join(tmpdir(), 'enhance-restore-'))
  mkdirSync(join(root, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), '[]\n', 'utf8')
  return root
}

function archive(state, text) {
  const dir = mkdtempSync(join(tmpdir(), 'enhance-archive-'))
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8')
  writeFileSync(join(dir, 'content-scope.txt'), text, 'utf8')
  return dir
}

function run(root, args) {
  return spawnSync(process.execPath, [join(repo, 'install.mjs'), '--home', root, ...args], { cwd: repo, encoding: 'utf8' })
}

function stateOf(root) {
  return JSON.parse(readFileSync(join(root, 'enhance', 'state.json'), 'utf8'))
}

const V3 = { version: 3, enabled: true, contentScope: true, approval: 'ask' }

test('restores a v3 archive as is', () => {
  const root = home()
  const src = archive(V3, 'ok')
  try {
    const result = run(root, ['--restore', src])
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.deepEqual(stateOf(root), { version: 3, enabled: true, contentScope: true, approval: 'ask', updatedAt: stateOf(root).updatedAt })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  }
})

test('refuses to overwrite existing state without --replace', () => {
  const root = home()
  const first = archive(V3, 'first')
  const second = archive({ version: 3, enabled: false, contentScope: false, approval: 'deny' }, 'second')
  try {
    assert.equal(run(root, ['--restore', first]).status, 0)
    const before = stateOf(root)
    const result = run(root, ['--restore', second])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /--replace/)
    assert.deepEqual(stateOf(root), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})

test('--replace overwrites existing state', () => {
  const root = home()
  const first = archive(V3, 'first')
  const second = archive({ version: 3, enabled: false, contentScope: false, approval: 'ask' }, 'second')
  try {
    assert.equal(run(root, ['--restore', first]).status, 0)
    const result = run(root, ['--restore', second, '--replace'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(stateOf(root).approval, 'ask')
    assert.equal(stateOf(root).version, 3)
    assert.equal(readFileSync(join(root, 'enhance', 'content-scope.txt'), 'utf8'), 'second')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})

test('rejects unknown versions and bad fields without writing', () => {
  const cases = [
    { version: 1, enabled: true, contentScope: true, approval: 'ask' },
    { version: 2, enabled: true, contentScope: true, approval: 'ask' },
    { version: 4, enabled: true, contentScope: true, approval: 'ask' },
    { version: 3, enabled: true, contentScope: true, approval: 'maybe' },
    { version: 3, enabled: 'true', contentScope: true, approval: 'ask' },
  ]
  for (const state of cases) {
    const root = home()
    const src = archive(state, 'ok')
    try {
      const result = run(root, ['--restore', src])
      assert.equal(result.status, 1, `version=${state.version} approval=${state.approval} enabled=${String(state.enabled)} 应当被拒`)
      assert.equal(existsSync(join(root, 'enhance', 'state.json')), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(src, { recursive: true, force: true })
    }
  }

  const root = home()
  const big = archive(V3, 'x'.repeat(8193))
  try {
    const result = run(root, ['--restore', big])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /limit/)
    assert.equal(existsSync(join(root, 'enhance', 'state.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(big, { recursive: true, force: true })
  }
})

test('dry-run prints a summary and writes nothing', () => {
  const root = home()
  const src = archive(V3, 'ok')
  try {
    const result = run(root, ['--restore', src, '--dry-run'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /sha256=/)
    assert.equal(existsSync(join(root, 'enhance')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  }
})
