// plugins-shape.test.mjs — CONTRACT §1 / §12：插件对象的形状。
//
// qwenwork 与别的插件不同：它靠 vendor/qoder.mjs 的 makePlugin(site) 生成对象，
// 再用 Object.assign 补钩子。这是唯一允许的"组装层例外"，但补完之后**形状必须与
// 其它插件一致**，否则卡片少得静默、少一块。
import test from 'node:test'
import assert from 'node:assert/strict'
import { QwenWorkAuthPlugin } from '../index.mjs'

function withEnv() {
  const set = {
    QWENWORK_CLIENT_ID: 'fixture-client',
    QWENWORK_WEB: 'https://web.qwenwork.invalid',
    QWENWORK_OPENAPI: 'https://gateway.qwenwork.invalid',
    QWENWORK_API: 'https://api.qwenwork.invalid',
    QWENWORK_COSY_VERSION: '1.0.0',
  }
  const saved = {}
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v }
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('CONTRACT 1-01: the assembled plugin carries provider / methods / usage', async () => {
  const restore = withEnv()
  try {
    const p = await QwenWorkAuthPlugin({ client: {} })
    assert.equal(typeof p.auth.provider, 'string')
    assert.ok(p.auth.provider.length > 0, 'auth.provider 是卡片的唯一绑定')
    assert.ok(Array.isArray(p.auth.methods), 'auth.methods 必须是数组')
    assert.equal(typeof p.auth.usage, 'function')
    assert.equal(typeof p.provider.models, 'function')
  } finally { restore() }
})

test('CONTRACT 12-02: multi-account sign-in offers an OAuth way in', async () => {
  const restore = withEnv()
  try {
    const p = await QwenWorkAuthPlugin({ client: {} })
    assert.ok(p.auth.methods.some((m) => m.type === 'oauth'), '「添加另一个」必须有一条 OAuth')
  } finally { restore() }
})

test('CONTRACT 12-03: the import row needs auth.import and auth.importFrom together', async () => {
  const restore = withEnv()
  try {
    const p = await QwenWorkAuthPlugin({ client: {} })
    assert.equal(typeof p.auth.import, 'function')
    assert.ok(p.auth.importFrom, '没有 importFrom 时按钮画出但缺说明')
  } finally { restore() }
})

test('CONTRACT 1-03 / 2-04: icon is data:, and options carry no check-in or proxy switch', async () => {
  const restore = withEnv()
  try {
    const p = await QwenWorkAuthPlugin({ client: {} })
    assert.match(String(p.auth.icon || ''), /^(data:image\/|https:\/\/)/)
    assert.ok(Array.isArray(p.auth.options))
    for (const o of p.auth.options) {
      assert.doesNotMatch(String(o.key), /check.?in|proxy/, '签到/代理粒度归宿主（CONTRACT 2-02 / 2-04）')
      assert.equal(typeof o.default, 'boolean')
    }
  } finally { restore() }
})
