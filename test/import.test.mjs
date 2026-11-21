// import.test.mjs —— `auth.import`（协议 §2.8）。
//
// 这个钩子是「从文件导入账号…」那一行的唯一开关：没有它，供应商编辑页里
// 根本不出现导入入口（真机核对：loomy / officeace / codearts 都有，qwenwork 原先没有）。
//
// 钉死七件事：
//   1. 单对象 / 数组 / version:1 容器 / NDJSON 四种形状全认
//   2. NDJSON 中间坏行只丢那一行，不连坐整份文件
//   3. 缺 access 的那条明确说「缺少 access」
//   4. 已存在的 token 拒绝并说清 key（去重读 plugin-auth.json）
//   5. `expires` 秒级自动 ×1000
//   6. `accountId` 绝不为空（user.id → JWT sub → token 前缀）
//   7. 超 100 条不静默截断，多返回一条说明还剩几条

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IMPORT_FROM, IMPORT_MOST, accountOf, expiresOf, makeImportHook, recordsOf, subjectOf } from '../import.mjs'

/** 一个能解出 sub/exp 的假 JWT。 */
function fakeJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256' })}.${enc(payload)}.sig`
}

/** 一个临时配置目录，可带一份 plugin-auth.json。 */
function configDirWith(auth) {
  const dir = mkdtempSync(join(tmpdir(), 'qw-import-'))
  if (auth) writeFileSync(join(dir, 'plugin-auth.json'), JSON.stringify(auth), 'utf8')
  return dir
}

// ── 1. 四种文件形状 ───────────────────────────────────────────────────

test('recordsOf：单对象', () => {
  const { rows, bad } = recordsOf(JSON.stringify({ access: 'a'.repeat(20) }))
  assert.equal(rows.length, 1)
  assert.equal(bad.length, 0)
})

test('recordsOf：数组', () => {
  const { rows } = recordsOf(JSON.stringify([{ access: 'a' }, { access: 'b' }, { access: 'c' }]))
  assert.equal(rows.length, 3)
})

test('recordsOf：version:1 容器（accounts 数组与对象都认）', () => {
  assert.equal(recordsOf(JSON.stringify({ version: 1, accounts: [{ access: 'a' }] })).rows.length, 1)
  assert.equal(recordsOf(JSON.stringify({ version: 1, accounts: { one: { access: 'a' } } })).rows.length, 1)
})

test('recordsOf：NDJSON 三行 + 注释行跳过', () => {
  const text = ['# 注释', '{"access":"a"}', '// 也算注释', '', '{"access":"b"}'].join('\n')
  const { rows, bad } = recordsOf(text)
  assert.equal(rows.length, 2)
  assert.equal(bad.length, 0)
})

// ── 2. 坏行只丢那一行 ─────────────────────────────────────────────────

test('recordsOf：NDJSON 中间坏行只记那一行的行号', () => {
  const text = ['{"access":"a"}', '{ 坏行', '{"access":"b"}'].join('\n')
  const { rows, bad } = recordsOf(text)
  assert.equal(rows.length, 2, '好行不能连坐')
  assert.deepEqual(bad, [2])
})

test('import：坏行变成一条 failed，其余照常成功', async () => {
  const hook = makeImportHook({ configDir: configDirWith(null), provider: 'qwenwork' })
  const text = ['{"access":"' + 'a'.repeat(20) + '"}', 'NOT JSON', '{"access":"' + 'b'.repeat(20) + '"}'].join('\n')
  const out = await hook.import([text])
  assert.equal(out.filter((r) => r.type === 'success').length, 2)
  const failed = out.filter((r) => r.type === 'failed')
  assert.equal(failed.length, 1)
  assert.match(failed[0].error, /第 2 行：不是合法 JSON/)
})

// ── 3. 缺 access ─────────────────────────────────────────────────────

test('accountOf：缺 access 说「缺少 access」', () => {
  const got = accountOf({ name: 'x' }, '文件 1 第 1 条', new Map(), 'qwenwork')
  assert.equal(got.type, 'failed')
  assert.match(got.error, /缺少 access/)
})

test('accountOf：认 access / access_token / key / token 四种键名', () => {
  for (const name of ['access', 'access_token', 'key', 'token']) {
    const got = accountOf({ [name]: 'z'.repeat(20) }, 'w', new Map(), 'qwenwork')
    assert.equal(got.type, 'success', `${name} 应被认`)
  }
})

// ── 4. 去重 ───────────────────────────────────────────────────────────

test('import：已存在的 token 拒绝并说清 key', async () => {
  const token = 'e'.repeat(24)
  const dir = configDirWith({ qwenwork: { type: 'oauth', access: token } })
  const hook = makeImportHook({ configDir: dir, provider: 'qwenwork' })
  const out = await hook.import([JSON.stringify({ access: token })])
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'failed')
  assert.match(out[0].error, /已存在（key=qwenwork）/)
})

test('import：同批次内重复，第二条也算已存在', async () => {
  const token = 'd'.repeat(24)
  const hook = makeImportHook({ configDir: configDirWith(null), provider: 'qwenwork' })
  const out = await hook.import([JSON.stringify([{ access: token }, { access: token }])])
  assert.equal(out[0].type, 'success')
  assert.equal(out[1].type, 'failed')
  assert.match(out[1].error, /已存在/)
})

test('import：读不到 plugin-auth.json 时不炸，只是没有去重', async () => {
  const hook = makeImportHook({ configDir: join(tmpdir(), 'qw-does-not-exist-xyz'), provider: 'qwenwork' })
  const out = await hook.import([JSON.stringify({ access: 'f'.repeat(24) })])
  assert.equal(out[0].type, 'success')
})

// ── 5. expires 秒级 ×1000 ────────────────────────────────────────────

test('expiresOf：秒级 ×1000，毫秒原样，认不出 0', () => {
  assert.equal(expiresOf(1797702136), 1797702136000)
  assert.equal(expiresOf(1797702136000), 1797702136000)
  assert.equal(expiresOf('1797702136'), 1797702136000)
  assert.equal(expiresOf(null), 0)
  assert.equal(expiresOf('nope'), 0)
})

test('accountOf：上游给秒级 expire，结果是毫秒', () => {
  const got = accountOf({ access: 'q'.repeat(20), expire: 1797702136 }, 'w', new Map(), 'qwenwork')
  assert.equal(got.expires, 1797702136000)
})

// ── 6. accountId 绝不为空 ────────────────────────────────────────────

test('accountId 优先级：accountId → user.id → JWT sub → token 前缀', () => {
  assert.equal(accountOf({ access: 'a'.repeat(20), accountId: 'A' }, 'w', new Map(), 'p').accountId, 'A')
  assert.equal(
    accountOf({ access: 'a'.repeat(20), user: { id: 'UID' } }, 'w', new Map(), 'p').accountId,
    'UID',
  )
  const jwt = fakeJwt({ sub: 'SUB' })
  assert.equal(accountOf({ access: jwt }, 'w', new Map(), 'p').accountId, 'SUB')
  const plain = 'abcdefgh' + 'i'.repeat(20)
  assert.equal(accountOf({ access: plain }, 'w', new Map(), 'p').accountId, plain.slice(0, 8))
})

test('accountId 永远不是空串', () => {
  for (const row of [{ access: 'a'.repeat(20) }, { access: fakeJwt({}) }, { access: 'z' }]) {
    const got = accountOf(row, 'w', new Map(), 'p')
    if (got.type === 'success') assert.ok(got.accountId.length > 0, JSON.stringify(row))
  }
})

test('subjectOf：解不出就是空串，不抛异常', () => {
  assert.equal(subjectOf('not-a-jwt'), '')
  assert.equal(subjectOf(''), '')
  assert.equal(subjectOf(fakeJwt({ sub: 'ok' })), 'ok')
})

// ── 7. 上限 100 条不静默截断 ─────────────────────────────────────────

test(`import：超过 ${IMPORT_MOST} 条时多一条说明还剩几条`, async () => {
  const rows = Array.from({ length: IMPORT_MOST + 5 }, (_, i) => ({ access: `t${i}`.padEnd(20, 'x') }))
  const hook = makeImportHook({ configDir: configDirWith(null), provider: 'qwenwork' })
  const out = await hook.import([JSON.stringify(rows)])
  const success = out.filter((r) => r.type === 'success')
  assert.equal(success.length, IMPORT_MOST, `最多收 ${IMPORT_MOST} 条`)
  const tail = out.filter((r) => r.type === 'failed' && /未处理/.test(r.error ?? ''))
  assert.equal(tail.length, 1)
  assert.match(tail[0].error, /还有 5 条未处理/)
})

// ── 8. importFrom 文案（协议 §2.8：必须同时给 importFrom）─────────────

test('IMPORT_FROM 在、写得短（magpie 会截断到 300 字节）', () => {
  assert.equal(typeof IMPORT_FROM, 'string')
  assert.ok(IMPORT_FROM.length > 0)
  assert.ok(Buffer.byteLength(IMPORT_FROM, 'utf8') <= 300, 'importFrom 不能超过 300 字节')
})

test('makeImportHook 同时给出 import 与 importFrom', () => {
  const hook = makeImportHook({ provider: 'qwenwork' })
  assert.equal(typeof hook.import, 'function')
  assert.equal(typeof hook.importFrom, 'string')
})