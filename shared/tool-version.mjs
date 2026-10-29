/**
 * 当前工具版本：唯一来源是仓库根的 `VERSION` 文件。
 *
 * 为什么单独一个模块：`install.mjs` 要把版本写进清单、`doctor.mjs` 要拿它比对清单、
 * `scripts/check.mjs` 要守「`package.json` 与 `VERSION` 一致」——三处必须读同一个来源，
 * 否则迟早出现两份版本号。`package.json` 的 `version` 由门禁保证与本文件读到的值一致。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** @returns {string} 例如 `1.0.0`（已 trim，不含换行）。 */
export function toolVersion() {
  return readFileSync(join(here, '..', 'VERSION'), 'utf8').trim()
}
