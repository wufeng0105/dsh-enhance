#!/usr/bin/env node
/**
 * 装一个本地 pre-push 钩子：对每个将被推送的 ref（stdin 给出的本地 sha）跑 fast 层，
 * 而不是对脏工作树跑。
 *
 * 私有 GitHub Free 仓库拿不到服务端分支保护（API 403），所以这是不依赖套餐的阻塞路径：
 * fast 层不过，推送在本机就停下。
 *
 * 钩子是本地的、按 clone 手动启用：每个 clone 跑一次。`git push --no-verify` 仍能绕过它——
 * 所以这是「个人开发时的阻塞」，不是仓库级强制；这一点写在 README 的门禁说明里。
 *
 * 用法：node scripts/install-hooks.mjs
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const gitDir = join(root, '.git')

if (!existsSync(gitDir)) {
  console.error('install-hooks: not a git checkout (missing .git)')
  process.exit(1)
}

const hooksDir = join(gitDir, 'hooks')
mkdirSync(hooksDir, { recursive: true })
const hook = join(hooksDir, 'pre-push')
const body = [
  '#!/bin/sh',
  '# Installed by scripts/install-hooks.mjs — runs the fast gate layer against every pushed ref.',
  'set -e',
  'tmp=',
  'cleanup() { if [ -n "$tmp" ]; then git worktree remove --force "$tmp" >/dev/null 2>&1 || rm -rf "$tmp"; fi; }',
  'trap cleanup EXIT',
  'if [ -t 0 ]; then shas=HEAD; else shas=$(awk \'{print $2}\' | sort -u); fi',
  '[ -n "$shas" ] || shas=HEAD',
  'for sha in $shas; do',
  '  case "$sha" in 0000000000000000000000000000000000000000) continue;; esac',
  '  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t enhance-hook)',
  '  git worktree add --detach "$tmp" "$sha" >/dev/null',
  '  ( cd "$tmp" && node scripts/check.mjs --layer fast )',
  '  git worktree remove --force "$tmp" >/dev/null 2>&1 || rm -rf "$tmp"',
  '  tmp=',
  'done',
  '',
].join('\n')
writeFileSync(hook, body, { mode: 0o755 })
chmodSync(hook, 0o755)
console.log(`installed ${hook}`)
