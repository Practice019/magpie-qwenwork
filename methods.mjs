// methods.mjs —— 登录入口与界面开关。
//
// # 现状（这次要改的事）
//
// 这个插件原先只有 vendor 生成的一种登录方式：设备码（oauth）。
// 设备码走不通的时候（轮询超时、redirect 打不开、厂商临时故障），账号就加不进来。
// 协议 §6 要求至少还有一条**不依赖客户端**的路，这里补上「粘贴 access token」。
//
// # 为什么粘贴出来的 token 要先验证一次
//
// 用户粘的东西可能是别的站点的 token、可能是过期的、可能多带了 `Bearer ` 前缀。
// 让宿主持有一个用不了的 token，症状会推迟到第一次对话才出现，而且报错在
// 「模型不可用」那一层，看不出根因。这里立刻打一次 account-context：
// 通了才收，不通就把上游的原话带回去。
//
// # 界面开关必须惰性读（协议 §2.10 / loomy 真机事故）
//
// 宿主是「先调插件工厂、后登记钩子」（host.js L1526 调工厂、L1544 才 hooks.push），
// 而 `option()` 内部查 `auths()`（L1760，只认已登记的钩子）⇒ **工厂期**问出来的值
// 是「未声明的键 = false」，不是用户设置。所以下面所有读开关的地方都包成函数，
// 等钩子被调用时才问。

/** 粘贴 token 时取到的账号信息。 */
export const ACCOUNT_CONTEXT_PATH = '/api/v1/adapter/user/account-context?include=user,plan,quota'

/** 一个 token 长什么样：JWT 三段，或一段看不出结构的串。只用来挡住明显空的输入。 */
const looksLikeToken = (v) => typeof v === 'string' && v.trim().length >= 16

/** 去掉 `Bearer ` 前缀（大小写与空格都认）。 */
export function withoutBearer(raw) {
  return String(raw ?? '').trim().replace(/^Bearer\s+/i, '').trim()
}

/**
 * JWT payload，不验签。
 *
 * @param {string} token
 * @returns {any} 认不出返回 null
 */
export function payloadOf(token) {
  const parts = String(token ?? '').split('.')
  if (parts.length < 2) return null
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * 一个粘贴进来的 token 的到期时间（毫秒）。
 *
 * 解不出 `exp` 就给 30 天后：宿主会在这之后提示重新登录，比「永不过期」诚实。
 *
 * @param {string} token
 * @returns {number}
 */
export function expiresOfToken(token) {
  const exp = Number(payloadOf(token)?.exp)
  if (Number.isFinite(exp) && exp > 0) return exp < 1e12 ? Math.round(exp * 1000) : Math.round(exp)
  return Date.now() + 30 * 24 * 60 * 60 * 1000
}

/**
 * 用 account-context 验证一个 token，并取出账号信息。
 *
 * @param {string} openapi 上游 origin
 * @param {string} token 已去掉 Bearer
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<{accountId: string, name: string}>}
 */
export async function verifyToken(openapi, token, opts = {}) {
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 20_000

  let res
  try {
    res = await doFetch(`${openapi}${ACCOUNT_CONTEXT_PATH}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    // 网络层失败也要说清是网络：直接抛 e 的话宿主只会显示一句 fetch failed
    throw new Error(`QwenWork: 无法连接额度接口（${String(e?.message ?? e).slice(0, 120)}）`)
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(`QwenWork: token 无效或已过期（HTTP ${res.status}）`)
  }
  if (!res.ok) {
    throw new Error(`QwenWork: 额度接口返回 HTTP ${res.status}`)
  }

  let body
  try {
    body = await res.json()
  } catch {
    throw new Error('QwenWork: 额度接口返回的不是 JSON')
  }

  const user = body?.data?.user ?? body?.user ?? {}
  const accountId = String(user?.id ?? '').trim() || String(payloadOf(token)?.sub ?? '').trim() || token.slice(0, 8)
  const name = String(user?.name ?? '').trim()

  return { accountId, name }
}

/**
 * 「粘贴 access token」这个登录方式。
 *
 * @param {{openapi: string, fetchImpl?: typeof fetch, allowPaste: () => boolean}} opts
 * @returns {object} magpie 的 method 对象
 */
export function pasteTokenMethod(opts) {
  return {
    type: 'api',
    label: '粘贴 QwenWork access token',
    labels: { zh: '粘贴 QwenWork access token', en: 'Paste a QwenWork access token' },
    placeholder: 'access token（可带 Bearer 前缀）',
    prompts: [
      {
        type: 'text',
        key: 'token',
        message: '把 QwenWork 的 access token 粘进来（登录后从浏览器或客户端取出）',
        validate: (v) => (looksLikeToken(withoutBearer(v)) ? true : '这不像一个 token（至少 16 个字符）'),
      },
    ],
    /**
     * @param {{token?: string}} inputs
     * @returns {Promise<object>} 登录结果
     */
    async authorize(inputs) {
      if (!opts.allowPaste()) throw new Error('QwenWork: 粘贴登录已在插件设置里关闭')

      const token = withoutBearer(inputs?.token)
      if (!looksLikeToken(token)) throw new Error('QwenWork: 这不像一个 access token')

      const { accountId, name } = await verifyToken(opts.openapi, token, { fetchImpl: opts.fetchImpl })

      /** @type {object} */
      const metadata = {}
      if (name) metadata.name = name

      return { type: 'success', access: token, expires: expiresOfToken(token), accountId, metadata }
    },
  }
}

/**
 * 界面开关（`auth.options`）的声明表。
 *
 * 形状照 PLUGIN-SPEC §2 第 22 行：`[{key, label, description?, default?, labels?, descriptions?}]`。
 * 用户拨的值由 `input.magpie.option(provider, key)` 读回（见 index.mjs 的惰性读法）。
 */
export const AUTH_OPTIONS = Object.freeze([
  {
    key: 'devicesignin',
    label: '允许设备码登录',
    labels: { zh: '允许设备码登录', en: 'Allow device-code sign-in' },
    description: '设备码是 QwenWork 的原生登录方式：显示一个码，在浏览器里确认。关掉后只能用粘贴 token。',
    descriptions: {
      zh: '设备码是 QwenWork 的原生登录方式：显示一个码，在浏览器里确认。关掉后只能用粘贴 token。',
      en: 'Device code is QwenWork’s native sign-in: show a code, confirm in a browser. Off leaves pasting a token only.',
    },
    default: true,
  },
  {
    key: 'pastetoken',
    label: '允许粘贴 access token',
    labels: { zh: '允许粘贴 access token', en: 'Allow pasting an access token' },
    description: '设备码走不通时的备用入口：把 token 粘进来，插件先打一次额度接口验证，通了才收。',
    descriptions: {
      zh: '设备码走不通时的备用入口：把 token 粘进来，插件先打一次额度接口验证，通了才收。',
      en: 'The fallback when device code fails: paste a token; it is checked against the quota endpoint before it is kept.',
    },
    default: true,
  },
])