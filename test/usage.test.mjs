// usage.test.mjs — the credit card, against the real account-context shape.
//
// The bug this guards (T-39): a free plan reports `quota.total: null` — there is
// no cap, only a balance — and the reader turned that into `Number(null) === 0`,
// failed the "total > 0" gate and told magpie "the account reports no credits"
// while `remaining` said 399.9409. So:
//
//	· total > 0 + used  ⇒ a percentage window (`used` percent + `limit: 100`)
//	· only remaining    ⇒ a wallet window (`balance`, no `used`, no `limit`)
//	· neither           ⇒ a 说明 · window naming the reason, never a bare error
//
// Naming is the cross-plugin rule (magpie-plugins/UNIFIED-PLAN.md §1.1): every
// window name starts with `额度 · ` / `停用 · ` / `说明 · `.
import test from 'node:test'
import assert from 'node:assert/strict'
import { qwenworkUsage } from '../index.mjs'

const OPENAPI = 'https://gateway.qwenwork.invalid'
const QUOTA = '额度 · '
const STOP = '停用 · '
const NOTE = '说明 · '

const originalFetch = globalThis.fetch
test.after(() => { globalThis.fetch = originalFetch })

// The account-context of a signed-in free account, exactly as the gateway
// answers it (HTTP 200, real field names and values).
const context = (over = {}) => ({
  code: 'ok',
  data: {
    user: { id: '48c7fd32-fixture', name: '七七', username: '3411pku' },
    plan: {
      pid: 'subscription-cn-free', name: '个人免费版', user_type: 'personal',
      next_due_date: null, next_refresh_date: null, is_subscribed: false, sessions: 10, storage: 1,
    },
    quota: { total: null, used: null, remaining: 399.9409, exceeded: false },
    ...over,
  },
})

const serve = (body, { status = 200 } = {}) => {
  globalThis.fetch = async () => Response.json(body, { status })
}
const serveRaw = (fn) => { globalThis.fetch = fn }

// Read the card the way magpie does: one usage hook, one signed-in account.
const read = async () => {
  const usage = qwenworkUsage(OPENAPI)
  return usage(async () => ({ type: 'oauth', access: 'fixture-access', expires: 0 }))
}
const windowNamed = (usage, name) => (usage.windows ?? []).find((w) => w.name === name)

test('1) total:null + remaining:399.9409 ⇒ one 额度 window carrying balance', async () => {
  serve(context())
  const usage = await read()
  const main = windowNamed(usage, `${QUOTA}Credits`)
  assert.ok(main, `缺额度窗: ${JSON.stringify(usage.windows)}`)
  assert.equal(main.balance, 399.9409, 'balance 就是还剩多少（number，路由按它排序）')
  assert.equal(typeof main.balance, 'number')
  assert.equal(main.unit, 'credits')
  assert.equal(main.display, '399.94 credits')
})

test('2) total:null + remaining ⇒ no used, no limit, not aside', async () => {
  serve(context())
  const usage = await read()
  const main = windowNamed(usage, `${QUOTA}Credits`)
  assert.equal(main.used, undefined, '不许发 used（会被算成 100% 已用）')
  assert.equal(main.limit, undefined, '不许发 limit（免费版没有总量）')
  assert.equal(main.aside, undefined, '主窗要参与路由排序')
})

test('3) total:null + remaining:399.9409 ⇒ no error (regression of T-39)', async () => {
  serve(context())
  const usage = await read()
  assert.equal(usage.error, undefined, `剩余额度存在时绝不能说读不到: ${usage.error}`)
  assert.equal(usage.signIn, 'kept')
})

test('4) total:1000 used:600 ⇒ percentage window (used 60, limit 100)', async () => {
  serve(context({ quota: { total: 1000, used: 600, remaining: 400, exceeded: false } }))
  const usage = await read()
  const main = windowNamed(usage, `${QUOTA}Credits`)
  assert.ok(main, `缺额度窗: ${JSON.stringify(usage.windows)}`)
  assert.equal(main.used, 60)
  assert.equal(main.limit, 100)
  assert.equal(main.balance, undefined, '有总量时按百分比，不给 balance')
  assert.equal(main.display, '600 / 1000 credits')
})

test('5) exceeded:true ⇒ 停用 · 额度耗尽 with used:100, first in the list', async () => {
  serve(context({ quota: { total: 1000, used: 1000, remaining: 0, exceeded: true } }))
  const usage = await read()
  const stop = windowNamed(usage, `${STOP}额度耗尽`)
  assert.ok(stop, `缺停用窗: ${JSON.stringify(usage.windows)}`)
  assert.equal(stop.used, 100, 'used:100 是唯一让路由跳过该号的开关')
  assert.equal(stop.aside, undefined, '停用窗不能带 aside（带了就不参与路由）')
  assert.equal(stop.limit, undefined, '停用窗不带 limit / amount')
  assert.equal(usage.windows[0], stop, '停用窗排最前（数组顺序就是 UI 顺序）')
})

test('6) quota 完全缺失 ⇒ 说明 · 额度不可读（接口未返回 quota），no error', async () => {
  serve(context({ quota: undefined }))
  const usage = await read()
  const note = windowNamed(usage, `${NOTE}额度不可读（接口未返回 quota）`)
  assert.ok(note, `缺说明窗: ${JSON.stringify(usage.windows)}`)
  assert.equal(note.aside, true)
  assert.equal(note.used, undefined, '说明窗不许带 used')
  assert.equal(usage.error, undefined, 'error 会整块吞掉窗口区')
})

test('7) plan.name ⇒ 说明 · 计划 个人免费版', async () => {
  serve(context())
  const usage = await read()
  const plan = windowNamed(usage, `${NOTE}计划 个人免费版`)
  assert.ok(plan, `缺计划说明窗: ${JSON.stringify(usage.windows)}`)
  assert.equal(plan.aside, true)
  assert.match(String(plan.display), /个人免费版/)
})

test('8) next_refresh_date / next_due_date 为 null ⇒ 不设 until', async () => {
  serve(context())
  const usage = await read()
  assert.equal(usage.until, undefined)
})

test('8b) next_refresh_date 有值 ⇒ until 是它的 ISO 时刻（别改坏）', async () => {
  serve(context({ plan: { name: '个人免费版', next_refresh_date: '2026-12-01T00:00:00Z', next_due_date: null } }))
  const usage = await read()
  assert.equal(usage.until, '2026-12-01T00:00:00.000Z')
})

test('9) 每条窗口名都以 额度 · / 停用 · / 说明 · 开头', async () => {
  const fixtures = [
    context(),
    context({ quota: { total: 1000, used: 600, remaining: 400, exceeded: false } }),
    context({ quota: { total: 1000, used: 1000, remaining: 0, exceeded: true } }),
    context({ quota: undefined }),
  ]
  for (const body of fixtures) {
    serve(body)
    const usage = await read()
    assert.ok(usage.windows.length > 0, '每份响应都至少有一条窗口')
    for (const w of usage.windows) {
      assert.match(String(w.name), /^(额度|停用|说明) · /, `非法窗口名: ${JSON.stringify(w.name)}`)
    }
  }
})

test('10) remaining 是字符串 "399.9409" ⇒ 仍解析成 number', async () => {
  serve(context({ quota: { total: null, used: null, remaining: '399.9409', exceeded: false } }))
  const usage = await read()
  const main = windowNamed(usage, `${QUOTA}Credits`)
  assert.equal(main.balance, 399.9409)
  assert.equal(usage.error, undefined)
})

test('11) HTTP 500 ⇒ 说明 · 额度不可读（HTTP 500）', async () => {
  serve({ message: 'boom' }, { status: 500 })
  const usage = await read()
  const note = windowNamed(usage, `${NOTE}额度不可读（HTTP 500）`)
  assert.ok(note, `缺说明窗: ${JSON.stringify(usage.windows)}`)
  assert.equal(note.aside, true)
  assert.equal(usage.signIn, 'kept')
})

test('12) 401 ⇒ signIn: "expired"', async () => {
  serve({ error: 'unauthorized' }, { status: 401 })
  const usage = await read()
  assert.equal(usage.signIn, 'expired')
  const note = windowNamed(usage, `${NOTE}登录失效`)
  assert.ok(note, `缺登录失效窗: ${JSON.stringify(usage.windows)}`)
  assert.equal(note.aside, true)
})

test('13) quota 存在但字段全空 ⇒ 说明 · 额度不可读（额度字段为空）', async () => {
  serve(context({ quota: {} }))
  const usage = await read()
  const note = windowNamed(usage, `${NOTE}额度不可读（额度字段为空）`)
  assert.ok(note, `缺说明窗: ${JSON.stringify(usage.windows)}`)
  assert.equal(note.aside, true)
  assert.equal(usage.error, undefined)
})

test('14) 网络异常 ⇒ 说明 · 额度不可读（网络），不抛', async () => {
  serveRaw(async () => { throw new Error('socket hang up') })
  const usage = await read()
  const note = windowNamed(usage, `${NOTE}额度不可读（网络）`)
  assert.ok(note, `缺说明窗: ${JSON.stringify(usage.windows)}`)
  assert.equal(note.aside, true)
})
