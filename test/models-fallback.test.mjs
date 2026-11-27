// plugins-models.test.mjs — CONTRACT 6-02：不是账号自己的列表必须打标记。
//
// 宿主读 Symbol.for("magpie.fellBack")：带这个标记的列表**不参与路由**。
// 没有它，一次上游失败会让宿主拿插件兜底的默认表当"账号的计划"去派活。
import test from 'node:test'
import assert from 'node:assert/strict'
import { QwenWorkAuthPlugin } from '../index.mjs'

const FALLBACK = Symbol.for('magpie.fellBack')

// 造一个最小可用的环境：工厂需要这几个 setting。
function withEnv(extra = {}) {
  const saved = {}
  const set = {
    QWENWORK_CLIENT_ID: 'fixture-client',
    QWENWORK_WEB: 'https://web.qwenwork.invalid',
    QWENWORK_OPENAPI: 'https://gateway.qwenwork.invalid',
    QWENWORK_API: 'https://api.qwenwork.invalid',
    QWENWORK_COSY_VERSION: '1.0.0',
    QWENWORK_RSA_PUBLIC_KEY: process.env.QWENWORK_RSA_PUBLIC_KEY,
    ...extra,
  }
  for (const [k, v] of Object.entries(set)) {
    saved[k] = process.env[k]
    if (v !== undefined) process.env[k] = v
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const originalFetch = globalThis.fetch
test.after(() => { globalThis.fetch = originalFetch })

test('CONTRACT 6-02: an unsigned account keeps the defaults, marked fallen back', async () => {
  const restore = withEnv()
  try {
    const plugin = await QwenWorkAuthPlugin({ client: {} })
    const got = await plugin.provider.models({ models: {} }, { auth: undefined })
    assert.equal(got[FALLBACK], true, 'a list that is not the account\'s own must say so')
  } finally {
    restore()
  }
})

test('CONTRACT 6-02: a failed model read is marked fallen back, never passed off as the plan', async () => {
  const restore = withEnv()
  globalThis.fetch = async () => { throw new Error('network down') }
  try {
    const plugin = await QwenWorkAuthPlugin({ client: {} })
    const auth = { type: 'oauth', access: 'tok', refresh: 'r', expires: Date.now() + 3_600_000 }
    const got = await plugin.provider.models({ models: {} }, { auth })
    assert.equal(got[FALLBACK], true)
  } finally {
    globalThis.fetch = originalFetch
    restore()
  }
})
