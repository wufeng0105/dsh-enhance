/**
 * 兼容声明的唯一实现：`package.json` 的 `engines.dsh` 区间怎么读、怎么判、怎么展示。
 *
 * 三个消费方都从这一个模块派生，谁也不自己再解析一遍：
 *   - `scripts/check.mjs` 的 version 门禁（声明形状、README 派生句、本机版本超范围判红）；
 *   - `enhance-scope` 的版本行快照（`compatSnapshot`）；
 *   - README 的适用版本句（由门禁逐字核对）。
 *
 * 为什么区间不是版本数组：宿主在插件安装/装载的三个时机读 `engines.dsh` 做 semver
 * 匹配（装前 preflight 拒装、装后校验回滚、profile 启动时禁用插件行），字段是给宿主
 * 读的，就必须是宿主认的形状——npm engines 区间。声明与门禁共用一处来源，两处各写
 * 一份就会「改了声明忘改门禁」。
 *
 * 区间形状有意收窄：只认 `">=A <B"` 双边界（A、B 为 x.y.z[-pre]，不带 build meta、
 * 不带其它算符）。宽进意味着把宿主已经拒掉的写法在门禁里悄悄放行；收窄到我们实际
 * 声明的形状，写歪即红。
 *
 * @module shared/compat
 */

/** 区间字符串的形状：`>=x.y.z[-pre] <x.y.z[-pre]`，首尾各一界，中间一个空格。 */
const RANGE_RE = /^>=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) <(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

/** 单个版本串（无 build meta）。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * 解析 `engines.dsh` 区间。认且只认 `">=min <max"`。
 * @param {string} spec
 * @returns {{ min: string, max: string, maxExclusive: true } | { error: string }}
 */
export function parseEnginesDsh(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') {
    return { error: 'engines.dsh 必须是非空字符串' }
  }
  const match = RANGE_RE.exec(spec.trim())
  if (match === null) {
    return { error: `engines.dsh 区间形状不认（只认 ">=A <B" 双边界）：${spec}` }
  }
  return { min: match[1], max: match[2], maxExclusive: true }
}

/**
 * semver 优先序比较：a < b 返回 -1，相等 0，a > b 返回 1。
 *
 * 解析先分离再切分：第一个 `-` 之前是核心段（三个数字），之后是预发布段
 * （点分标识符）。直接 `split('.')` 会把 `1-rc` 留在数字段里变成 NaN——
 * 这条实现写错过一次，被 tests/compat.test.mjs 的边界用例当场逮住。
 *
 * 数字段按数值比；预发布按 semver：有 pre 排在无 pre 之前，标识符数值段按
 * 数值、其余按字母序，数值标识符恒低于字母标识符；标识符多的更大。
 * @param {string} a
 * @param {string} b
 */
export function compareSemver(a, b) {
  const split = (value) => {
    const text = String(value)
    const hyphen = text.indexOf('-')
    return hyphen === -1
      ? { core: text.split('.'), pre: '' }
      : { core: text.slice(0, hyphen).split('.'), pre: text.slice(hyphen + 1) }
  }
  const pa = split(a)
  const pb = split(b)
  for (let i = 0; i < 3; i += 1) {
    const na = Number(pa.core[i])
    const nb = Number(pb.core[i])
    if (na !== nb) return na < nb ? -1 : 1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === '') return 1
  if (pb.pre === '') return -1
  const idsA = pa.pre.split('.')
  const idsB = pb.pre.split('.')
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i += 1) {
    const idA = idsA[i] ?? ''
    const idB = idsB[i] ?? ''
    if (idA === '') return -1
    if (idB === '') return 1
    if (idA === idB) continue
    const numA = /^\d+$/.test(idA)
    const numB = /^\d+$/.test(idB)
    if (numA && numB) return Number(idA) < Number(idB) ? -1 : 1
    if (numA !== numB) return numA ? -1 : 1
    return idA < idB ? -1 : 1
  }
  return 0
}

/**
 * 版本是否落在区间内（含下界、不含上界）。
 * @param {{ min: string, max: string }} parsed
 * @param {string} version
 */
export function inRange(parsed, version) {
  if (!VERSION_RE.test(String(version ?? ''))) return false
  return compareSemver(version, parsed.min) >= 0 && compareSemver(version, parsed.max) < 0
}

/**
 * 展示派生：给人看的那段「已验范围」。
 *
 * 规则只有一条分支：上界是 `X-rc.N`（N≥2）时，排他上界在 rc 线上恰好等于
 * 「到 X-rc.N-1 为止」——`<0.2.1-rc.6` 展示成 `0.2.1-rc.1–0.2.1-rc.5`。
 * 其余形状（上界是非 rc 版本、或 rc.1）不硬凑首尾，直接写「X 起 · Y 之前」，
 * 不含糊也不撒谎。
 * @param {{ min: string, max: string }} parsed
 */
export function displayRange(parsed) {
  const match = /^(\d+\.\d+\.\d+)-rc\.(\d+)$/.exec(parsed.max)
  if (match !== null && Number(match[2]) >= 2) {
    const last = `${match[1]}-rc.${Number(match[2]) - 1}`
    if (compareSemver(last, parsed.min) >= 0) return `${parsed.min}–${last}`
  }
  return `${parsed.min} 起 · ${parsed.max} 之前`
}

/**
 * 从 package.json 对象读兼容声明（engines.dsh 区间 + 证据元数据）。
 * 元数据（tested/basis/verifiedAt/doc）描述「这条区间怎么验的」，不是第二份区间。
 * @param {object} pkg package.json 解析后的对象
 * @returns {{ enginesDsh: string, tested: string, basis: string, verifiedAt: string, doc: string } | { error: string }}
 */
export function declarationOf(pkg) {
  const spec = pkg?.engines?.dsh
  if (typeof spec !== 'string' || spec.trim() === '') {
    return { error: '缺兼容声明：package.json 的 engines.dsh（README 的适用版本句、本机超范围时的提示、宿主的装/载门禁都靠它）' }
  }
  const parsed = parseEnginesDsh(spec)
  if (parsed.error !== undefined) return { error: parsed.error }
  const meta = pkg?.dsh?.compatibility ?? {}
  if (typeof meta.tested !== 'string' || !VERSION_RE.test(meta.tested)) {
    return { error: `兼容元数据的 tested 必须是版本号：${String(meta.tested)}` }
  }
  if (!inRange(parsed, meta.tested)) {
    return { error: `兼容元数据的 tested=${meta.tested} 必须落在 engines.dsh 区间内` }
  }
  if (typeof meta.basis !== 'string' || meta.basis.trim() === '') {
    return { error: '兼容元数据的 basis 必须是非空字符串' }
  }
  if (typeof meta.verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(meta.verifiedAt)) {
    return { error: '兼容元数据的 verifiedAt 必须是 YYYY-MM-DD' }
  }
  if (typeof meta.doc !== 'string' || meta.doc.trim() === '') {
    return { error: '兼容元数据的 doc 必须是路径' }
  }
  return { enginesDsh: spec.trim(), tested: meta.tested, basis: meta.basis, verifiedAt: meta.verifiedAt, doc: meta.doc }
}

/** basis → 中文口径（README 派生句用）。 */
export function basisLabel(basis) {
  return { 'source-level': '源码级核验', runtime: '运行期验证' }[basis] ?? basis
}
