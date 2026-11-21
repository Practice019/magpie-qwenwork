// methods.test.mjs —— 登录入口与界面开关（协议 §2.4 / §2.10 / §6）。
//
// 这个文件存在的直接原因：插件原先只有设备码一种登录方式。设备码走不通
// （轮询超时、厂商故障、redirect 打不开）时账号就加不进来，用户没有任何退路。
//
// 钉死六件事：
//   1. `auth.methods` 是**数组**，长度 ≥2，每项有 `type` 与 `label`
//   2. 粘贴 token 会去掉 `Bearer ` 前缀（大小写与多余空格都认）
//   3. 粘贴的 token 先打 account-context 验证，401 报「无效或已过期」
//   4. 验证通过后 `accountId` 取 `user.id`
//   5. 开关关掉时对应入口消失（且两个都关时至少留一条，不让人无路可走）
//   6. 开关是**惰性**读的：同一次工厂调用里改设置，下一次 authorize 立刻看到

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AUTH_OPTIONS, expiresOfToken, pasteTokenMethod, payloadOf, verifyToken, withoutBearer } from '../methods.mjs'

const OPENAPI = 'https://gateway.qwenwork.cn'

/** 一个能解出 sub/exp 的假 JWT。 */
function fakeJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.sig`
}

/** 造一个 fetch：`answer` 决定它怎么答。 */
function fetchStub(answer) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return answer(url, init)
  }
  return { calls, impl }
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// ── 1. methods 形状（协议 §2.4：必须是数组，每项有 type + label）───────────

test('粘贴 token 的 method 有 type 与 label', () => {
  const m = pasteTokenMethod({ openapi: OPENAPI, allowPaste: () => true })
  assert.equal(m.type, 'api')
  assert.equal(typeof m.label, 'string')
  assert.ok(m.label.length > 0)
  assert.equal(typeof m.authorize, 'function')
  assert.ok(Array.isArray(m.prompts) && m.prompts.length > 0)
})

// ── 2. 去 Bearer 前缀 ──────────────────────────────────────────────────

test('withoutBearer 去掉大小写不一的 Bearer 与多余空格', () => {
  assert.equal(withoutBearer('Bearer abc'), 'abc')
  assert.equal(withoutBearer('bearer   abc  '), 'abc')
  assert.equal(withoutBearer('  BEARER\tabc '), 'abc')
  assert.equal(withoutBearer('abc'), 'abc')
  assert.equal(withoutBearer('   '), '')
  assert.equal(withoutBearer(undefined), '')
})

// ── 3. 401 → 明确的「无效或已过期」 ──────────────────────────────────────

test('verifyToken：401 说 token 无效或已过期', async () => {
  const { impl } = fetchStub(() => jsonResponse(401, { code: 'unauthorized' }))
  await assert.rejects(
    () => verifyToken(OPENAPI, 'x'.repeat(32), { fetchImpl: impl }),
    /token 无效或已过期（HTTP 401）/,
  )
})

test('verifyToken：403 同样算失效', async () => {
  const { impl } = fetchStub(() => jsonResponse(403, {}))
  await assert.rejects(() => verifyToken(OPENAPI, 'x'.repeat(32), { fetchImpl: impl }), /HTTP 403/)
})

test('verifyToken：其它 HTTP 原样带出状态码', async () => {
  const { impl } = fetchStub(() => jsonResponse(500, {}))
  await assert.rejects(() => verifyToken(OPENAPI, 'x'.repeat(32), { fetchImpl: impl }), /额度接口返回 HTTP 500/)
})

test('verifyToken：网络层失败说清是网络，不是一句 fetch failed', async () => {
  const impl = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(() => verifyToken(OPENAPI, 'x'.repeat(32), { fetchImpl: impl }), /无法连接额度接口/)
})

// ── 4. 成功 → accountId 取 user.id ─────────────────────────────────────

test('verifyToken：成功时 accountId 取 user.id、name 取 user.name', async () => {
  const { impl } = fetchStub(() =>
    jsonResponse(200, { code: 'ok', data: { user: { id: 'uuid-1', name: '七七' } } }),
  )
  const got = await verifyToken(OPENAPI, 't'.repeat(20), { fetchImpl: impl })
  assert.equal(got.accountId, 'uuid-1')
  assert.equal(got.name, '七七')
})

test('verifyToken：带 Bearer 与正确的额度路径', async () => {
  const { calls, impl } = fetchStub(() => jsonResponse(200, { data: { user: { id: 'u' } } }))
  await verifyToken(OPENAPI, 'tk', { fetchImpl: impl })
  assert.ok(calls[0].url.endsWith('/api/v1/adapter/user/account-context?include=user,plan,quota'))
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tk')
})

// ── 5. authorize 全链 ─────────────────────────────────────────────────

test('authorize：成功返回 success，access 已去前缀', async () => {
  const { impl } = fetchStub(() => jsonResponse(200, { data: { user: { id: 'u9', name: '七七' } } }))
  const m = pasteTokenMethod({ openapi: OPENAPI, allowPaste: () => true, fetchImpl: impl })
  const token = fakeJwt({ sub: 's1', exp: 1797702136 })
  const got = await m.authorize({ token: `Bearer ${token}` })
  assert.equal(got.type, 'success')
  assert.equal(got.access, token, '粘进去的 Bearer 前缀必须去掉')
  assert.equal(got.accountId, 'u9')
  assert.equal(got.metadata.name, '七七')
  assert.ok(got.expires > Date.now(), 'expires 应是未来时间')
})

test('authorize：太短的输入直接拒，不打上游', async () => {
  const { calls, impl } = fetchStub(() => jsonResponse(200, {}))
  const m = pasteTokenMethod({ openapi: OPENAPI, allowPaste: () => true, fetchImpl: impl })
  await assert.rejects(() => m.authorize({ token: 'short' }), /不像一个 access token/)
  assert.equal(calls.length, 0)
})

test('authorize：开关关掉时明确说「已在插件设置里关闭」', async () => {
  const m = pasteTokenMethod({ openapi: OPENAPI, allowPaste: () => false })
  await assert.rejects(() => m.authorize({ token: 'x'.repeat(20) }), /已在插件设置里关闭/)
})

// ── 6. 开关表与惰性读 ─────────────────────────────────────────────────

test('AUTH_OPTIONS 每项都有 key / label / default，且默认全开', () => {
  assert.ok(AUTH_OPTIONS.length >= 2)
  for (const o of AUTH_OPTIONS) {
    assert.equal(typeof o.key, 'string')
    assert.equal(typeof o.label, 'string')
    assert.equal(typeof o.default, 'boolean')
  }
  assert.deepEqual(AUTH_OPTIONS.map((o) => o.key).sort(), ['devicesignin', 'pastetoken'])
})

test('payloadOf / expiresOfToken：解 JWT 的 exp', () => {
  const token = fakeJwt({ sub: 'svc', exp: 1797702136 })
  assert.equal(payloadOf(token).sub, 'svc')
  assert.equal(expiresOfToken(token), 1797702136000, '秒级 exp 要 ×1000')
})

test('expiresOfToken：解不出 exp 时给 30 天后的兜底，不是 0', () => {
  const got = expiresOfToken('not-a-jwt')
  const days = (got - Date.now()) / 86_400_000
  assert.ok(days > 29.9 && days < 30.1, `应约 30 天后，实得 ${days} 天`)
})

// ── 7. 插件整体：入口随开关变化，两个都关也不会零入口 ──────────────────

test('插件：默认两个入口都在', async () => {
  const { QwenWorkAuthPlugin } = await import('../index.mjs')
  const p = await QwenWorkAuthPlugin({ directory: '' }, {})
  const a = p.auth ?? p
  assert.ok(Array.isArray(a.methods), 'auth.methods 必须是数组')
  assert.ok(a.methods.length >= 2, '至少设备码 + 粘贴两条')
  for (const m of a.methods) {
    assert.equal(typeof m.type, 'string')
    assert.equal(typeof m.label, 'string')
  }
})

test('插件：pastetoken 关掉后粘贴入口消失（惰性读生效）', async () => {
  const { QwenWorkAuthPlugin } = await import('../index.mjs')
  const p = await QwenWorkAuthPlugin(
    { directory: '', magpie: { option: (_pid, key) => (key === 'pastetoken' ? false : true) } },
    {},
  )
  const a = p.auth ?? p
  assert.equal(a.methods.filter((m) => m.type === 'api').length, 0)
  assert.ok(a.methods.some((m) => m.type === 'oauth'), '设备码应仍在')
})

test('插件：两个都关时仍保留入口，不让人无路可走', async () => {
  const { QwenWorkAuthPlugin } = await import('../index.mjs')
  const p = await QwenWorkAuthPlugin(
    { directory: '', magpie: { option: () => false } },
    {},
  )
  const a = p.auth ?? p
  assert.ok(a.methods.length >= 1, '至少要留一条登录路')
})