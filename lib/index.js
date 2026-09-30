/**
 * dsh-tide-badge —— 宿主半边
 *
 * 一条只读路由：GET /plugins/tide-badge/state
 *
 *   返回该时刻的计费时段（峰/谷，含**法定节假日**与周末规则）、下一次切换时刻，
 *   以及账户余额。时段判定与节假日表来自 lib/season.mjs 与 lib/holidays.mjs，
 *   前端由 build.mjs 内联同一份源码，**保证两端同源**，前端不必自己维护节假日。
 *
 * 余额取数（两条路，账号优先）：
 *   ① 桌面端账号登录态：`ctx.get('deepseekAccount').getBalance(...)`
 *      —— 官方 API 的 /user/balance 只认 `sk-` 开头的 API Key，而桌面端登录用的是
 *      OAuth 授权，所以登录用户必须走这条路。token 注入、客户端请求头、失效清理
 *      都由 DSH 自己负责。
 *   ② API Key：`ctx.credentials.resolve('DEEPSEEK_API_KEY')` → GET /user/balance。
 *      账号路不可用时才走，作为兜底。
 *
 *   为什么账号优先：若凭据里残留一个**无效**的 API Key，密钥路的失败会掩盖本该
 *   成功的账号路（本机踩过：一个 32 位十六进制串导致长期 401）。
 *
 * 设计约束：
 *   - 两条路互不干扰，任一条失败都不抛出，一律降级成前端可渲染的状态。
 *   - 余额只在宿主进程内处理，API Key 不出进程，浏览器只拿到数字。
 *   - 不写任何文件。
 *
 * @module dsh-tide-badge
 */

import {
  describePhase,
  isPeak,
  nextFlip,
  holidayCoverageWarning,
  HOLIDAY_VALLEY,
} from './season.mjs'

export const name = 'tide-badge'

/** 路由与凭据。deepseekAccount 刻意**不写进 inject**（见文件头注释）。 */
export const inject = ['webServer']

/** 余额接口，本插件唯一的对外网络目的地。 */
const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'

/** 路由路径。 */
export const ROUTE = '/plugins/tide-badge/state'

/** 余额读数的复用时长。 */
const TTL_MS = 60_000

/** 单次请求超时。 */
const TIMEOUT_MS = 15_000

const message = (err) => String((err && err.message) || err)

/**
 * 向 deepseekAccount 声明本客户端身份（契约要求，用于语言与超时换算）。
 * @returns {{version: string, locale: string, timezoneOffsetSeconds: number}}
 */
function clientMetadata() {
  return {
    version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
    locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/**
 * 账号路：走 DSH 的 deepseekAccount 服务读余额。
 *
 * 失败时**必须带上原因**，不能只返回 null：否则"服务不存在 / 未登录 / 平台查询失败 /
 * 钱包为空"四种情况在界面上长得一模一样，没法排查（本机就为此绕过一次弯路）。
 *
 * @returns {Promise<object>} 成功时是归一化余额，失败时是 { ok:false, reason }。
 */
async function readAccountBalance(ctx) {
  let account = null
  try {
    account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null
  } catch (err) {
    return { ok: false, reason: '读取 deepseekAccount 服务抛错: ' + message(err) }
  }
  if (!account || typeof account.getBalance !== 'function') {
    return { ok: false, reason: '当前构建没有 deepseekAccount 服务（仅支持桌面端账号登录）' }
  }

  // 余额查询打的是 platform.deepseek.com。本机实测该域名的 TLS 会**间歇性**失败
  // （杀软 HTTPS 解密插入自签证书 → Node 的 undici 不信任，报 SELF_SIGNED_CERT_IN_CHAIN，
  // 约 3/8 概率）。失败是随机的，所以带重试；等待成功那一次即可。
  let result = null
  let lastThrew = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt))
    try {
      result = await account.getBalance(clientMetadata())
      lastThrew = null
    } catch (err) {
      lastThrew = err
      continue
    }
    if (result !== null && result !== undefined && result.status === 'ready') break
  }
  if (result === null || result === undefined) {
    return {
      ok: false,
      reason: lastThrew === null
        ? '账号未登录（或授权在查询期间失效）'
        : `账号余额查询抛错（已重试 3 次）: ${message(lastThrew)}`,
    }
  }
  if (result.status !== 'ready') {
    return {
      ok: false,
      reason: '平台余额查询失败（已重试 3 次）。若账号登录正常，通常是网络/TLS 被拦截——'
        + '本机可设 NODE_EXTRA_CA_CERTS 指向杀软根证书解决；也可能登录态已过期，请在设置里重新登录。',
    }
  }
  const walletsRaw = Array.isArray(result.value) ? result.value : []
  if (walletsRaw.length === 0) {
    return { ok: false, reason: '该账号没有余额钱包' }
  }

  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const wallets = walletsRaw.filter((w) => w && num(w.balance) !== null)
  if (wallets.length === 0) {
    return { ok: false, reason: '平台返回的钱包数据无法解析: ' + JSON.stringify(walletsRaw).slice(0, 160) }
  }

  const currency = wallets.some((w) => String(w.currency || '').toUpperCase() === 'CNY')
    ? 'CNY'
    : String((wallets[0] && wallets[0].currency) || 'CNY').toUpperCase()
  const sumOf = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((w) => w && String(w.currency || 'CNY').toUpperCase() === currency && num(w.balance) !== null)
      .reduce((s, w) => s + Number(w.balance), 0)

  // 充值 + 赠金。与密钥路的 total_balance 同口径（那个字段本身也是两者相加）。
  const toppedUp = sumOf(result.value)
  const granted = sumOf(result.bonusWallets)
  return {
    ok: true,
    source: 'account',
    currency,
    total: Number((toppedUp + granted).toFixed(6)),
    toppedUp: Number(toppedUp.toFixed(6)),
    granted: Number(granted.toFixed(6)),
    isAvailable: true,
  }
}

/**
 * 密钥路：读 DEEPSEEK_API_KEY 请求官方余额接口。
 * @returns {Promise<object>} 归一化后的余额或错误状态。
 */
async function readKeyBalance(ctx) {
  let key = null
  try {
    const resolved = await ctx.credentials?.resolve?.('DEEPSEEK_API_KEY')
    if (resolved?.value) key = resolved.value
  } catch {
    /* 落到环境变量 */
  }
  if (!key) key = process.env.DEEPSEEK_API_KEY || undefined
  if (!key) {
    return { ok: false, state: 'no-credential', error: '未登录 DeepSeek 账号，且未配置 DEEPSEEK_API_KEY' }
  }

  try {
    const response = await fetch(BALANCE_ENDPOINT, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      return { ok: false, state: 'error', error: `HTTP ${response.status}: ${text.slice(0, 200)}` }
    }
    const parsed = JSON.parse(text)
    const info = Array.isArray(parsed?.balance_infos) ? parsed.balance_infos[0] : undefined
    if (info === undefined) {
      return { ok: false, state: 'empty', error: '余额响应中没有 balance_infos 字段' }
    }
    return {
      ok: true,
      source: 'key',
      // 币种由接口给出，绝不假设：给美元账户标人民币符号比没有数字更糟。
      currency: String(info.currency ?? ''),
      // is_available 是响应的**顶层**字段，与 balance_infos 平级。
      isAvailable: parsed?.is_available === true,
      total: Number(info.total_balance ?? 0),
      granted: Number(info.granted_balance ?? 0),
      toppedUp: Number(info.topped_up_balance ?? 0),
    }
  } catch (err) {
    return { ok: false, state: 'error', error: message(err) }
  }
}

/**
 * 账号只读诊断（`?probe=account`）。
 *
 * 把 deepseekAccount 各方法的原始状态摊开，用来区分「没登录」「登录态被平台吊销」
 * 「查询抛错」这几种在界面上长得一样的失败。**不返回任何凭据内容**，token 只报长度与尾号。
 *
 * @returns {Promise<object>}
 */
async function probeAccount(ctx) {
  const out = { service: false }
  let account = null
  try {
    account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null
  } catch (err) {
    out.getThrew = message(err)
  }
  if (!account) return out
  out.service = true
  out.methods = Object.keys(account).filter((k) => typeof account[k] === 'function').sort()

  if (typeof account.getState === 'function') {
    try {
      const st = await account.getState()
      out.state = st === null || st === undefined ? null : {
        status: st.status,
        attemptPhase: st.attempt === null || st.attempt === undefined ? null : st.attempt.phase,
        attemptError: st.attempt === null || st.attempt === undefined ? null : (st.attempt.errorCode ?? null),
      }
    } catch (err) {
      out.stateThrew = message(err)
    }
  }

  if (typeof account.getPlatformSession === 'function') {
    try {
      const s = await account.getPlatformSession()
      out.session = s === null || s === undefined ? null : {
        origin: s.origin,
        hasToken: typeof s.token === 'string' && s.token.length > 0,
        tokenLength: typeof s.token === 'string' ? s.token.length : 0,
        tokenTail: typeof s.token === 'string' ? s.token.slice(-4) : null,
        userId: s.userId ?? null,
        headerNames: s.requestHeaders ? Object.keys(s.requestHeaders) : [],
      }
    } catch (err) {
      out.sessionThrew = message(err)
    }
  }

  if (typeof account.getBalance === 'function') {
    try {
      const r = await account.getBalance(clientMetadata())
      out.balance = r === null || r === undefined ? null : {
        status: r.status,
        walletCount: Array.isArray(r.value) ? r.value.length : null,
        bonusCount: Array.isArray(r.bonusWallets) ? r.bonusWallets.length : null,
      }
    } catch (err) {
      out.balanceThrew = message(err)
    }
  }

  if (typeof account.getProfile === 'function') {
    try {
      const p = await account.getProfile(clientMetadata())
      out.profile = p === null || p === undefined ? null : { status: p.status, hasId: Boolean(p.value && p.value.id) }
    } catch (err) {
      out.profileThrew = message(err)
    }
  }

  return out
}

export function apply(ctx) {
  let cached = null
  let inflight = null

  // 启动自检：节假日表没覆盖当年或次年时在日志里提醒（不影响运行）。
  const coverageWarning = holidayCoverageWarning()
  if (coverageWarning !== null) {
    try {
      ctx.logger?.warn?.('[tide-badge] ' + coverageWarning)
    } catch {
      /* 无 logger 时静默 */
    }
  }

  /**
   * 账号优先，API Key 兜底。
   *
   * 账号路失败时**不留白**：把它给出的原因并入最终错误文案，这样界面上能直接看出
   * 是"未登录"、"平台查询失败"还是"没有钱包"，而不是笼统一句"未配置"。
   */
  const readBalance = async () => {
    const fromAccount = await readAccountBalance(ctx)
    if (fromAccount.ok) return fromAccount
    const fromKey = await readKeyBalance(ctx)
    if (fromKey.ok) return fromKey
    return { ...fromKey, accountReason: fromAccount.reason }
  }

  const balance = async (force) => {
    if (!force && cached !== null && Date.now() - Date.parse(cached.at) < TTL_MS) return cached
    if (inflight !== null) return inflight
    inflight = readBalance()
      .then((result) => {
        cached = { at: new Date().toISOString(), ...result }
        return cached
      })
      .catch((err) => ({ at: new Date().toISOString(), ok: false, state: 'error', error: message(err) }))
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  const sameOrigin = (req) => {
    const headers = req.headers ?? {}
    const origin = headers.origin
    if (origin === undefined) return true
    try {
      return new URL(origin).host === String(headers.host ?? '')
    } catch {
      return false
    }
  }

  const send = (res, status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () =>
        httpCtx.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (req, res) => {
            if (!sameOrigin(req)) {
              send(res, 403, { ok: false, state: 'forbidden', error: '跨域请求已被拒绝' })
              return
            }
            const url = new URL(req.url ?? ROUTE, 'http://x')
            const force = url.searchParams.get('refresh') === '1'
            const now = new Date()
            const phase = describePhase(now)
            const bal = await balance(force)
            // ?probe=account 时附带账号只读诊断：把"到底哪种失败"摊开，避免靠猜。
            // 不返回任何凭据内容，只返回状态与失败原因。
            let probe
            if (url.searchParams.get('probe') === 'account') probe = await probeAccount(ctx)
            send(res, 200, {
              ok: true,
              now: now.getTime(),
              // 时段判定：峰/谷、节假日与周末标记、下一次切换、以及节假日清单
              season: {
                peak: phase.peak,
                kind: phase.kind,
                holiday: phase.holiday,
                weekend: phase.weekend,
                countdown: phase.countdown,
                flipAt: phase.flipAt,
                nextLabel: phase.nextLabel,
                beijing: phase.beijing,
                color: phase.color,
                title: phase.title,
                // 前端倒计时与宿主同源，避免节假日算错切换点
                holidays: Object.keys(HOLIDAY_VALLEY).sort(),
              },
              balance: bal,
              ...(probe === undefined ? {} : { probe }),
            })
          },
        }),
      'tide-badge: state route',
    )
  })
}

// 供测试直接引用，不参与运行时装配
export const __internal = { isPeak, nextFlip, readAccountBalance, readKeyBalance, probeAccount }
