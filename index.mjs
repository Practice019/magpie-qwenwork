// QwenWork provider. Chat completions are rewritten as QwenWork's own
// agent_chat_generation request by the vendored adapter (vendor/qoder.mjs):
// the host's tools ride along, tool calls come back structured, and the
// host agent keeps its loop. Magpie auth supplies the account; COSY signing,
// the request codec and the endpoint stay in the adapter.
import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'

const defaults = JSON.parse(readFileSync(new URL('./defaults.json', import.meta.url), 'utf8'))
// The provider's picture, as magpie reads it: a data:image URI on the auth hook.
const pluginIcon = (() => {
  try { return `data:image/png;base64,${readFileSync(new URL('./icon.png', import.meta.url)).toString('base64')}` } catch { return '' }
})()

function setting(name) {
  const value = (process.env['QWENWORK_' + name] ?? defaults[name])?.trim()
  if (!value) throw new Error(`QWENWORK_${name} is not configured`)
  return value
}
function origin(name) {
  let url
  try { url = new URL(setting(name)) } catch { throw new Error(`QWENWORK_${name} must be an https address`) }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`QWENWORK_${name} must be an https origin`)
  return url.origin
}

// Window names follow the rule every magpie plugin shares
// (magpie-plugins/UNIFIED-PLAN.md §1.1): `额度 · ` takes part in routing,
// `停用 · ` carries used:100 and is what makes the router skip the account,
// `说明 · ` is an aside that only explains. No bare names, ever.
export const QUOTA_PREFIX = '额度 · '
export const STOP_PREFIX = '停用 · '
export const NOTE_PREFIX = '说明 · '

// toNum reads a credit count out of the gateway's JSON. A free plan answers
// `total: null` for "no cap", so a missing value must stay unknown — it must
// never collapse to 0, because `Number(null) === 0` is exactly what once turned
// a 399.94 balance into "the account reports no credits".
const toNum = (v) => {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v)
  return Number.isFinite(n) ? n : undefined
}

// credits renders a credit count as magpie shows one: no trailing zeros, at
// most two decimals (1982.1652 -> "1982.17", 2000 -> "2000").
const credits = (v) => {
  const n = toNum(v)
  if (n === undefined) return '0'
  return String(Math.round(n * 100) / 100)
}

const planWindow = (name) => ({ name: `${NOTE_PREFIX}计划 ${name}`, aside: true, display: name })
const unreadableWindow = (reason, display) => ({ name: `${NOTE_PREFIX}额度不可读（${reason}）`, aside: true, display })
const lapsedWindow = () => ({ name: `${NOTE_PREFIX}登录失效`, aside: true, display: '登录已过期，请重新登录' })

// qwenworkWindows renders one account-context as magpie's usage card.
//
// The gateway carries quota {total, used, remaining, exceeded} in the plan's
// credit unit, and plan {name, next_refresh_date, next_due_date}. Three cases,
// and each one renders differently:
//
//	① a paid plan caps credits → total > 0, so used/total is a real percentage:
//	   `used` (percent) + `limit: 100`, and magpie draws a bar
//	② the free plan has no cap → total is null and only `remaining` is known;
//	   that is a prepaid wallet, so the window carries `balance` + `unit` and no
//	   used/limit (used+limit would be read as "100% consumed")
//	③ neither is readable → a 说明 · window naming the reason. Never a top-level
//	   `error`: that replaces the whole window area and reads as "account dead".
//
// `exceeded: true` adds `停用 · 额度耗尽` with used:100 — the only signal that
// makes the router skip the account — ahead of the credit window.
export function qwenworkWindows(ctx = {}) {
  const plan = ctx?.plan && typeof ctx.plan === 'object' ? ctx.plan : undefined
  const q = ctx?.quota && typeof ctx.quota === 'object' ? ctx.quota : undefined
  const total = toNum(q?.total)
  const remaining = toNum(q?.remaining)
  const usedField = toNum(q?.used)
  const used = usedField ?? (total !== undefined && total > 0 && remaining !== undefined ? total - remaining : undefined)
  const exceeded = q?.exceeded === true || String(q?.exceeded) === 'true'

  const windows = []
  if (exceeded) windows.push({ name: `${STOP_PREFIX}额度耗尽`, used: 100, display: 'Credits 已用尽；充值或等计划刷新后自动恢复' })
  if (total !== undefined && total > 0 && used !== undefined && used >= 0) {
    windows.push({ name: `${QUOTA_PREFIX}Credits`, used: Math.min(100, (100 * used) / total), limit: 100, display: `${credits(used)} / ${credits(total)} credits` })
  } else if (remaining !== undefined) {
    windows.push({ name: `${QUOTA_PREFIX}Credits`, balance: remaining, unit: 'credits', display: `${credits(remaining)} credits` })
  } else if (q) windows.push(unreadableWindow('额度字段为空', '接口返回的 quota 里没有 total / used / remaining'))
  else windows.push(unreadableWindow('接口未返回 quota', '接口未返回 quota 字段'))
  if (plan?.name) windows.push(planWindow(String(plan.name)))

  // A null refresh/due date means "not scheduled": no `until` at all, rather
  // than an epoch-zero or an Invalid Date.
  const refresh = plan?.next_refresh_date ?? plan?.next_due_date
  const at = refresh ? new Date(refresh) : null
  return {
    windows,
    ...(plan?.name ? { plan: String(plan.name) } : {}),
    ...(at && !Number.isNaN(at.getTime()) ? { until: at.toISOString() } : {}),
  }
}

// qwenworkUsage reads the account's credits for magpie's usage bar. The
// account-context the sign-in already uses carries them, so reading the card
// makes no extra request of its own.
export function qwenworkUsage(openapi) {
  return async (getAuth) => {
    let signIn = 'kept'
    try {
      const a = await getAuth()
      if (a?.type !== 'oauth' || !String(a.access ?? '').trim() || (a.expires > 0 && a.expires <= Date.now())) return { signIn: 'expired', windows: [lapsedWindow()] }
      const res = await fetch(`${openapi}/api/v1/adapter/user/account-context?include=user,plan,quota`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${a.access}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 401 || res.status === 403) return { signIn: 'expired', windows: [lapsedWindow()] }
      if (!res.ok) return { signIn, windows: [unreadableWindow(`HTTP ${res.status}`, `额度接口返回 HTTP ${res.status}`)] }
      const ctx = (await res.json())?.data ?? {}
      return { signIn, ...qwenworkWindows(ctx) }
    } catch (e) {
      return { signIn, windows: [unreadableWindow('网络', String(e?.message ?? e).slice(0, 160))] }
    }
  }
}

export async function QwenWorkAuthPlugin({ client }) {
  const clientId = setting('CLIENT_ID')
  const web = origin('WEB')
  const openapi = origin('OPENAPI')
  const api = origin('API')
  const rsa = setting('RSA_PUBLIC_KEY').replaceAll('\\n', '\n')
  try { if (createPublicKey(rsa).asymmetricKeyType !== 'rsa') throw new Error() } catch { throw new Error('QWENWORK_RSA_PUBLIC_KEY must be an RSA public key in PEM form') }
  const site = {
    id: 'qwenwork', name: 'QwenWork', clientId, web, openapi, api, rsaKey: rsa,
    cosyVersion: setting('COSY_VERSION'), redirect: 'qwenwork-cn://',
    deviceOnly: true, deviceRefreshTarget: 'c', modelScene: 'qwork', listAllModels: true,
    clientType: '6', businessProduct: 'qoder_work', sessionType: 'qoder_work',
    userInfoPath: '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing',
    normalizeUser: v => (v?.data ?? v)?.user ?? (v?.data ?? v),
    models: [],
    // The adapter prefixes this under the host's own system messages; worded
    // for QwenWork, not the Qoder brand the adapter was shared from.
    systemPrompt: 'You are QwenWork (qw), a helpful assistant. Use the instructions below and the tools available to you to assist the user.',
  }
  const { makePlugin } = await import('./vendor/qoder.mjs')
  const plugin = await makePlugin(site)({ client })
  plugin.auth.usage = qwenworkUsage(openapi)
  plugin.auth.icon = pluginIcon
  return plugin
}
