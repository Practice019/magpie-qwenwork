// importer.mjs —— `auth.import`：从文件批量导入 QwenWork 账号。
//
// # 这是 magpie 自己的钩子（OpenCode 会忽略）
//
// 用户点了供应商编辑页里的「从文件导入账号…」，magpie 弹文件选择器，把每个文件的
// **文本内容**交给这个钩子：
//
//	auth.import(texts, { signal }) → 一组登录结果
//
// 每个结果与一次正常登录的产出**同形**：
//
//	成功 → { type:"success", access, expires, accountId, metadata }
//	失败 → { type:"failed", error:"文件 N 第 M 条：<原因>" }
//
// # 为什么宽容解析
//
// 用户的账号 JSON 来自不同工具，形状至少有四种（都认）：
//
//	{ "access": "eyJ...", "accountId": "uuid", "expires": 1797702136000 }
//	{ "access_token": "eyJ...", "user": {"id":"uuid","name":"七七"} }
//	{ "key": "eyJ..." }
//	{ "token": "eyJ..." }
//
// 外层容器还可能是数组、`{provider, version:1, accounts:[…]}`，或每行一个对象的
// NDJSON（中间坏一行只丢那一行，不连坐整份文件）。
//
// # 硬约束（协议 §2.8，别再犯）
//
//	① `access` 是唯一必填项（loader / usage 都拿它调上游）
//	② `accountId` **绝不为空**（空串会让卡片显示成 `Signed in ()`）
//	③ `metadata` 只放非空值（空串等于没写）
//	④ `expires` 是**毫秒**；上游给秒（小量级）自动 ×1000
//	⑤ 单次最多 `IMPORT_MOST` 条，超出必须**明说还剩几条**，不许静默截断
//
// # 去重为什么读 plugin-auth.json
//
// magpie 按登录的方式保存成功项（新增账号或覆盖同一个账号），插件这边**不写**
// 那个文件，只读它做去重。读不到（目录缺失、文件损坏）就当没有已存在的号——
// 重复导入同一个 token 最多多一条账号，不会丢数据。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** magpie 单次最多收 100 条（`IMPORT_MOST`，见 host.js）。 */
export const IMPORT_MOST = 100

/**
 * 给界面显示的一句话：要选什么文件。
 *
 * ⚠ 最多 300 字节（magpie 会截断），所以写短。
 */
export const IMPORT_FROM =
  'QwenWork 账号 UTF-8 JSON（单对象、数组、version: 1 容器，或每行一个对象的 NDJSON；字段：access 必需，accountId/expires/name 可选）'

/** 一个 provider 的账号键：`qwenwork`、`qwenwork#1`、`qwenwork#2` … */
const isMineKey = (key, provider) => key === provider || key.startsWith(`${provider}#`)

/**
 * 已存在账号的 access → key 索引。
 *
 * 读 `plugin-auth.json`；任何失败都当成「没有已存在的号」：这是一个副作用很小的
 * 去重提示，读不到不该让整次导入失败。
 *
 * @param {string} configDir magpie 的配置目录（`input.directory`）
 * @param {string} provider provider id
 * @returns {Map<string, string>}
 */
export function existingIndex(configDir, provider) {
  /** @type {Map<string, string>} */
  const out = new Map()
  try {
    const all = JSON.parse(readFileSync(join(configDir, 'plugin-auth.json'), 'utf8'))
    for (const [key, value] of Object.entries(all ?? {})) {
      if (!isMineKey(key, provider)) continue
      const token = tokenOfRecord(value)
      if (token) out.set(token, key)
    }
  } catch {
    // 目录不存在 / 文件损坏 / 没有权限：都当作「一个已存在的号也没有」
  }
  return out
}

/**
 * 一个已保存账号里的 token，键名与导入认的那几个一致。
 *
 * 宿主保存 oauth 登录时把 access 放在 `access`，粘贴型放在 `key`，两种都要认。
 *
 * @param {any} value
 * @returns {string}
 */
function tokenOfRecord(value) {
  if (!value || typeof value !== 'object') return ''
  for (const name of ['access', 'access_token', 'key', 'token']) {
    const raw = value[name]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return ''
}

/** 一个值是不是「有内容的字符串」。 */
const textOf = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * 秒级时间戳 ×1000 变毫秒。
 *
 * 判据：小于 1e12 的数一定不是毫秒（1e12 ms ≈ 2001 年），上游给的秒级都在这之下。
 *
 * @param {any} raw
 * @returns {number} 毫秒；认不出 0
 */
export function expiresOf(raw) {
  const n = typeof raw === 'string' ? Number(raw.trim()) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

/**
 * JWT 里的 `sub`，用作没有 accountId 时的兜底。
 *
 * 只解 payload，**不验签**：这里只想要一个稳定的标识串，验签是上游的事。
 *
 * @param {string} token
 * @returns {string}
 */
export function subjectOf(token) {
  const parts = String(token ?? '').split('.')
  if (parts.length < 2) return ''
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString('utf8')
    const sub = JSON.parse(json)?.sub
    return typeof sub === 'string' ? sub.trim() : ''
  } catch {
    return ''
  }
}

/**
 * JWT 里的 `exp`，用作没有 expires 时的兜底。
 *
 * @param {string} token
 * @returns {number} 毫秒；认不出 0
 */
export function expiryOfToken(token) {
  const parts = String(token ?? '').split('.')
  if (parts.length < 2) return 0
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString('utf8')
    return expiresOf(JSON.parse(json)?.exp)
  } catch {
    return 0
  }
}

/**
 * 一条记录 → 一个账号，或一条失败说明。
 *
 * @param {any} row
 * @param {string} where 「文件 N 第 M 条」
 * @param {Map<string, string>} existing
 * @param {string} provider
 * @returns {{type:'success', access:string, expires:number, accountId:string, metadata:object}|{type:'failed', error:string}}
 */
export function accountOf(row, where, existing, provider) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { type: 'failed', error: `${where}：不是一对象` }
  }

  let access = ''
  for (const name of ['access', 'access_token', 'key', 'token']) {
    const got = textOf(row[name])
    if (got) { access = got.replace(/^Bearer\s+/i, ''); break }
  }
  if (!access) return { type: 'failed', error: `${where}：缺少 access` }

  const seen = existing.get(access)
  if (seen) return { type: 'failed', error: `${where}：该 access 已存在（key=${seen}）` }

  const accountId =
    textOf(row.accountId) || textOf(row.account_id) || textOf(row?.user?.id) || subjectOf(access) || access.slice(0, 8)

  const expires = expiresOf(row.expires ?? row.expire) || expiryOfToken(access)

  /** @type {object} */
  const metadata = {}
  const name = textOf(row.name) || textOf(row?.user?.name) || textOf(row.display_name)
  if (name) metadata.name = name

  return { type: 'success', access, expires, accountId, metadata }
}

/**
 * 一份文件文本 → 若干条记录。
 *
 * 先整份 `JSON.parse`；失败则按 NDJSON 逐行。注释行（`#` / `//`）和空行跳过，
 * 坏行只丢那一行。
 *
 * @param {string} text
 * @returns {{rows: any[], bad: number[]}} `bad` 是坏行的 1 基行号
 */
export function recordsOf(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').trim()
  if (!source) return { rows: [], bad: [] }

  try {
    const whole = JSON.parse(source)
    if (Array.isArray(whole)) return { rows: whole, bad: [] }
    if (whole && typeof whole === 'object') {
      // `{provider, version:1, accounts:[…]}` 与 `{version:1, accounts:{…}}` 都认
      const container = whole.accounts ?? whole.items ?? whole.data
      if (Array.isArray(container)) return { rows: container, bad: [] }
      if (container && typeof container === 'object') return { rows: Object.values(container), bad: [] }
      return { rows: [whole], bad: [] }
    }
    return { rows: [], bad: [] }
  } catch {
    // 落到逐行
  }

  /** @type {any[]} */
  const rows = []
  /** @type {number[]} */
  const bad = []
  const lines = source.split(/\r?\n/)
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      bad.push(index + 1)
    }
  })
  return { rows, bad }
}

/**
 * 造 `auth.import` 与 `auth.importFrom`。
 *
 * @param {{configDir?: string, provider?: string, log?: {warn?: Function}}} [opts]
 * @returns {{importFrom: string, import: (texts: string[], o?: {signal?: AbortSignal}) => Promise<any[]>}}
 */
export function makeImportHook(opts = {}) {
  const provider = String(opts.provider ?? 'qwenwork')
  const configDir = String(opts.configDir ?? '')

  return {
    importFrom: IMPORT_FROM,

    /**
     * @param {string[]|string} texts 每个文件的内容（magpie 传数组）
     * @returns {Promise<object[]>} 每个文件的每条记录一个结果
     */
    async import(texts) {
      const files = Array.isArray(texts) ? texts : [texts]
      const existing = configDir ? existingIndex(configDir, provider) : new Map()

      /** @type {object[]} */
      const out = []
      let taken = 0
      let skipped = 0

      files.forEach((text, fileIndex) => {
        const file = fileIndex + 1
        const { rows, bad } = recordsOf(text)

        for (const line of bad) {
          out.push({ type: 'failed', error: `文件 ${file} 第 ${line} 行：不是合法 JSON` })
        }

        rows.forEach((row, rowIndex) => {
          const where = `文件 ${file} 第 ${rowIndex + 1} 条`
          if (taken >= IMPORT_MOST) {
            skipped += 1
            return
          }
          const got = accountOf(row, where, existing, provider)
          if (got.type === 'success') {
            taken += 1
            // 同批次内重复：后面的当作已存在
            existing.set(got.access, `${provider}（本次导入）`)
          }
          out.push(got)
        })
      })

      if (skipped > 0) {
        out.push({
          type: 'failed',
          error: `单次最多导入 ${IMPORT_MOST} 条，本次还有 ${skipped} 条未处理；请再导入一次剩余部分`,
        })
      }

      return out
    },
  }
}