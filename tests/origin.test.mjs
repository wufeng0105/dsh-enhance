/**
 * `enhance-scope` 路由的纯函数测试：来源判定与读体限长。
 *
 * 这一组钉住来源判定的三条顺序：
 *   - 跨站 Origin 必须被拒；
 *   - **Host 是域名时必拒**，哪怕 Origin 与 Host 一模一样——DNS rebinding 的构造就是这样；
 *   - `Origin: null` 拒，缺失放行（curl / CLI / Electron 主进程）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { __testing } from '../enhance-scope/index.js'

const { sameOrigin, readJson, BODY_LIMIT } = __testing

/** 造一个够 `sameOrigin` 用的最小请求。 */
function request({ remote = '127.0.0.1', host = '127.0.0.1:3080', origin } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  return { socket: { remoteAddress: remote }, headers }
}

test('同源请求放行', () => {
  assert.equal(sameOrigin(request({ origin: 'http://127.0.0.1:3080' })), true)
})

test('没有 Origin 的请求放行（curl / CLI / Electron 主进程）', () => {
  assert.equal(sameOrigin(request()), true)
  assert.equal(sameOrigin(request({ origin: '' })), true)
})

test('跨站 Origin 拒绝', () => {
  assert.equal(sameOrigin(request({ origin: 'https://evil.example' })), false)
  assert.equal(sameOrigin(request({ origin: 'http://127.0.0.1:3081' })), false)
})

test('Host 是域名时拒绝——即使 Origin 与 Host 完全一致（DNS rebinding）', () => {
  const host = 'attacker.example:3080'
  assert.equal(sameOrigin({ socket: { remoteAddress: '127.0.0.1' }, headers: { host, origin: `http://${host}` } }), false)
  // 同一主机名、但没有 Origin 头（非浏览器客户端）也必须拒：挡的是 Host，不是 Origin
  assert.equal(sameOrigin({ socket: { remoteAddress: '127.0.0.1' }, headers: { host } }), false)
})

test('Origin: null 拒绝（沙箱 iframe / file:// 页面的默认值）', () => {
  assert.equal(sameOrigin(request({ origin: 'null' })), false)
})

test('Electron 的 app: scheme 放行', () => {
  assert.equal(sameOrigin(request({ origin: 'app://dsh' })), true)
})

test('远端不是回环就拒绝', () => {
  assert.equal(sameOrigin(request({ remote: '10.2.0.10', origin: 'http://127.0.0.1:3080' })), false)
})

test('回环的三种写法都认', () => {
  assert.equal(sameOrigin(request({ host: 'localhost:3080', origin: 'http://localhost:3080' })), true)
  assert.equal(sameOrigin(request({ host: '[::1]:3080', origin: 'http://[::1]:3080' })), true)
  assert.equal(sameOrigin(request({ remote: '::1', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), true)
})

test('file:// 与畸形 Origin 拒绝', () => {
  assert.equal(sameOrigin(request({ origin: 'file:///C:/x.html' })), false)
  assert.equal(sameOrigin(request({ origin: 'not a url' })), false)
})

/** 把若干块拼成一个能 `for await` 的假请求体。 */
function bodyOf(...chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk, 'utf8')
    },
  }
}

test('readJson：空体给 {}，合法 JSON 原样', async () => {
  assert.deepEqual(await readJson(bodyOf('')), {})
  assert.deepEqual(await readJson(bodyOf('{"op":"state"}')), { op: 'state' })
})

test('readJson：超过硬上限抛 ETOOLARGE', async () => {
  await assert.rejects(() => readJson(bodyOf('x'.repeat(BODY_LIMIT + 8))), (error) => error.code === 'ETOOLARGE')
})

test('readJson：非法 JSON 与数组都抛 EBADOP', async () => {
  await assert.rejects(() => readJson(bodyOf('{"op":')), (error) => error.code === 'EBADOP')
  await assert.rejects(() => readJson(bodyOf('[1,2]')), (error) => error.code === 'EBADOP')
})
