/**
 * douyin.ts SDK 会话层：Cookie 两种形态互转 + 账号身份自举 + Bot 实例缓存。
 *
 * 插件历史数据存 Cookie-Editor 导出的 JSON 数组，而 douyin.ts 只认
 * "a=1; b=2" 请求头串，两边都要转，转换逻辑集中在此。
 *
 * 关于 uid：douyin.ts 的 Bot.start() 在未传 userId 时，会先用 device_id=0
 * 请求 imdesktop.douyin.com 的 profile/self 自举 uid，而该端点对未注册设备
 * 恒返回 8「用户未登录」，导致 start() 必然失败。因此这里必须自行解析 uid
 * 并在构造 Bot 时显式传入（参照 dmmdekkd/karin-plugin-adapter-douyin 的做法：
 * 它也从不依赖自举，而是把 uid 落库后直接交给 IM 客户端）。
 *
 * SDK 版本：**必须 0.6.6 及以上**。
 *   0.6.5 起 `frd.follows/fans/mutual` 整组被删（主站 following/list 换成 spotlight/relation），
 *   好友名单改由 familiar/list 提供；而 0.6.6 内部那条 familiar/list 链路的 version_code
 *   仍是默认的 1.1.34，服务端不认时是静默返回 0 人。所以好友名单统一走
 *   `listFriends()` → `bot.social.familiar()`（它显式设了 version_code=21.6.0）。
 */
import util from 'node:util'
import { Bot } from 'douyin.ts'
import { getConfig } from './config.js'
import { normalizeDevice } from './database.js'

/** Cookie 属性字段：这些不是键值对，转 header 串时丢弃 */
const ATTRIBUTE_FIELDS = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite'])

/** accountId → { bot, cookie }；Cookie 更新后不能复用旧长连接 */
const bots = new Map()

/**
 * 云崽 logger → SDK Log 接口的桥。
 * 云崽 logger 是 (...args) 变参且 Error 对象不打印堆栈，故 Error 走 util.inspect。
 */
export function createSdkLog(tag) {
  const prefix = tag ? `[抖音续火][${tag}]` : '[抖音续火]'
  const stringify = (msg) => (typeof msg === 'string' ? msg : util.inspect(msg, { depth: 10, colors: false }))
  return {
    info: (msg) => log('info', `${prefix} ${stringify(msg)}`),
    warn: (msg) => log('warn', `${prefix} ${stringify(msg)}`),
    error: (msg) => log('error', `${prefix} ${stringify(msg)}`),
  }
}

/**
 * Cookie JSON 数组 → "a=1; b=2" 请求头串。
 *
 * 不按域名/路径筛选：douyin.ts 的 WS 握手直接使用这份原串，并从中单独提取
 * session_tlb_tag、passport_mfa_token 作为握手头，筛掉会导致连不上。
 */
export function toCookieHeader(cookies) {
  if (!Array.isArray(cookies)) return ''
  const pairs = []
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object') continue
    const name = typeof cookie.name === 'string' ? cookie.name.trim() : ''
    if (!name || ATTRIBUTE_FIELDS.has(name.toLowerCase())) continue
    const value = cookie.value == null ? '' : String(cookie.value)
    pairs.push(`${name}=${value}`)
  }
  return pairs.join('; ')
}

/**
 * "a=1; b=2" 请求头串 → Cookie-Editor 形状数组（登录成功后回填网页与落库）。
 * 值里可能含 "="（如 base64），故只按第一个 "=" 切分。
 */
export function toCookieArray(header, { domain = '.douyin.com' } = {}) {
  if (typeof header !== 'string' || !header.trim()) return []
  const cookies = []
  const seen = new Set()
  for (const part of header.split(/[;\n]/)) {
    const item = part.trim()
    if (!item) continue
    const eq = item.indexOf('=')
    if (eq <= 0) continue
    const name = item.slice(0, eq).trim()
    if (!name || ATTRIBUTE_FIELDS.has(name.toLowerCase()) || seen.has(name)) continue
    seen.add(name)
    cookies.push({
      domain,
      hostOnly: false,
      httpOnly: false,
      name,
      path: '/',
      sameSite: 'no_restriction',
      secure: true,
      session: true,
      value: item.slice(eq + 1).trim(),
    })
  }
  return cookies
}

/**
 * 解析账号的抖音数字 uid。
 *
 * 优先用数据库里已存的 uid；没有则打 imdesktop 的 profile/self 取回并落库。
 *
 * 这里**必须**用 imdesktop 域 + aid=339757（桌面 IM 参数）：插件扫码走的是
 * douyin.ts 的 login()，产出的是桌面客户端会话，实测该会话在 imdesktop 下
 * 返回 status_code=0 与 uid，换到 www.douyin.com + aid=6383 则恒为
 * 8「用户未登录」。反之，从浏览器导出的 web 会话才认 www 域——两者不通用。
 */
export async function resolveUid(account, { persist } = {}) {
  const saved = String(account.douyinUid || '').trim()
  if (/^\d+$/.test(saved)) return saved

  const cookie = toCookieHeader(account.cookies)
  if (!cookie) throw new Error(`账号“${account.name}”没有可用的 Cookie，请重新扫码或粘贴`)

  const baseParams = {
    version_name: '1.2.1',
    version_code: '1.2.1',
    device_platform: 'win32',
    screen_width: '1707',
    screen_height: '1067',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Mozilla',
    browser_version: '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    browser_online: 'true',
    cookie_enabled: 'true',
    device_id: '0',
    did: '0',
    iid: '0',
    channel: '0',
  }
  const endpoints = [
    ['https://imdesktop.douyin.com/aweme/v1/web/user/profile/self/', { aid: '339757' }],
    // Cookie-Editor 导出的网页会话不一定包含桌面 IM 登录态，兼容网页资料接口。
    ['https://www.douyin.com/aweme/v1/web/user/profile/self/', { aid: '6383' }],
  ]
  let payload
  let lastError
  for (const [endpoint, extra] of endpoints) {
    const params = new URLSearchParams({ ...baseParams, ...extra })
    try {
      const response = await fetch(`${endpoint}?${params}`, {
        headers: { cookie, referer: endpoint.startsWith('https://www.') ? 'https://www.douyin.com' : 'https://imdesktop.douyin.com', 'user-agent': IM_USER_AGENT },
        signal: AbortSignal.timeout(20000),
      })
      payload = await response.json()
      const uid = payload?.user?.uid || payload?.data?.user?.uid
      if (uid) break
    } catch (error) {
      lastError = error
    }
  }
  if (!payload && lastError) {
    throw new Error(`账号“${account.name}”校验 Cookie 失败：${lastError.message || lastError}`)
  }
  const uid = payload?.user?.uid || payload?.data?.user?.uid
  if (!uid) {
    // status_code=8「用户未登录」。该接口对桌面 IM 会话会恒返回 8（实测：
    // 同一份 Cookie 打 im/user/info 是 status_code=0，打 profile/self 却是 8），
    // 所以它拿不到 uid 并不代表 Cookie 失效——只代表缺少扫码时签发的 device_id。
    // 正确做法是走「扫码获取 Cookie」让 login() 把 userId 一并带回来，而不是在这里死磕。
    const hint = Number(payload?.status_code) === 8
      ? '无法解析登录身份，请用本页「扫码获取 Cookie」重新登录（扫码会一并记录账号身份）'
      : 'Cookie 中缺少登录态'
    throw new Error(`账号“${account.name}”${hint}`)
  }
  const resolved = String(uid)
  if (typeof persist === 'function') {
    await persist(resolved).catch((error) => {
      log('warn', `[抖音续火][${account.name}] 记录 uid 失败：${error?.message || error}`)
    })
  }
  return resolved
}

/**
 * 按 secUid 批量补全昵称，复用 SDK 桌面 IM 接口与设备身份。
 *
 * 好友名单的主源已改成 familiar/list 并自带 nickname（remark_name 优先），
 * 所以这里只是兜底：补那些接口偶发不返回昵称的人。
 */
export async function hydrateFriendNames(bot, friends) {
  const pending = [...new Set(friends.filter((friend) => !String(friend.nickname || '').trim() && friend.secUid).map((friend) => friend.secUid))]
  if (pending.length === 0) return friends
  let profiles
  try {
    profiles = await bot.im().getUserProfiles(pending)
  } catch (error) {
    // 这条链路走 www-hj 主站域，桌面会话可能被拒（实测 code=8）。
    // 昵称缺失只影响可读性，不能让整个好友名单跟着失败。
    log('warn', `[抖音续火] 补全 ${pending.length} 个好友昵称失败（${error?.message || error}），保留接口返回的原昵称`)
    return friends
  }
  return friends.map((friend) => {
    const nickname = profiles.get(friend.secUid)?.nickname
    return nickname ? { ...friend, nickname } : friend
  })
}

/** 云崽 logger 的兜底：脱离云崽进程（调试脚本）时退回 console，避免日志本身抛错掩盖真实异常 */
function log(level, ...args) {
  const target = globalThis.logger?.[level]
  if (typeof target === 'function') return target.call(globalThis.logger, ...args)
  console[level === 'error' ? 'error' : 'log'](...args)
}

const IM_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

/** familiar/list 单页条数（SDK 默认 100，这里与其保持一致，减少翻页轮次） */
const FAMILIAR_PAGE_SIZE = 100

/**
 * familiar/list 最多翻几页。
 *
 * 该接口不返回 has_more，只能靠「本页不满」判定到底；而游标万一不推进就会一直转，
 * 所以必须有硬上限兜底。100 × 30 = 3000 人，远超正常好友量。
 */
const FAMILIAR_MAX_PAGES = 30

/**
 * 取账号对应的 Bot 实例，未启动则启动。
 *
 * 失败实例一律丢弃重建：start() 抛错可能发生在 im.start() 握手中途，此时
 * 实例字段已写入且 stop() 不重置它们，复用会让后续重试空转返回。
 *
 * 设备身份：有已存设备就注入（SDK 跳过 device_register）；没有则由 SDK 注册新设备，
 * start 成功后经 persistDevice 回写，下次续火沿用同一设备，避免频繁换设备触发 MFA。
 */
export async function getBot(account, { persistUid, persistDevice } = {}) {
  const key = account.id === undefined ? account.name : account.id
  const cookie = toCookieHeader(account.cookies)
  if (!cookie) throw new Error(`账号“${account.name}”没有可用的 Cookie，请重新扫码或粘贴`)
  const cached = bots.get(key)
  if (cached && cached.cookie === cookie && String(cached.bot.id) === String(account.douyinUid || cached.bot.id)) return cached.bot
  if (cached) {
    bots.delete(key)
    try { cached.bot.stop() } catch {}
  }
  // 必须显式传 userId：否则 start() 会用 device_id=0 去 imdesktop 自举 uid 而恒失败
  const userId = await resolveUid(account, { persist: persistUid })
  const savedDevice = normalizeDevice(account.douyinDevice)
  const bot = new Bot({ cookie, userId, device: savedDevice, log: createSdkLog(account.name) })
  try {
    await bot.start()
  } catch (error) {
    // 失败实例不可复用，必须关掉并从缓存移除，保证下次是全新实例
    try {
      bot.stop()
    } catch {}
    bots.delete(key)
    throw new Error(`账号“${account.name}”连接抖音失败：${error?.message || error}`)
  }
  const device = normalizeDevice(bot.device)
  if (device && device.deviceId !== savedDevice?.deviceId && typeof persistDevice === 'function') {
    await persistDevice(device).catch((error) => {
      log('warn', `[抖音续火][${account.name}] 记录设备身份失败：${error?.message || error}`)
    })
  }
  // SDK 不暴露原始 cookie 串，这里挂一份供资料类接口复用
  bot.cookieString = cookie
  bots.set(key, { bot, cookie, name: account.name })
  return bot
}

/** 关闭并遗忘指定账号连接；accountId 省略时关闭全部 */
export function closeBot(accountId) {
  if (accountId === undefined) return closeAllBots()
  const entry = bots.get(accountId)
  if (!entry) {
    log('info', `[抖音续火] 账号 ${accountId} 没有缓存连接，无需断开`)
    return false
  }
  bots.delete(accountId)
  try {
    entry.bot.stop()
    log('info', `[抖音续火] 账号 ${entry.name || accountId} SDK 连接已断开`)
    return true
  } catch (error) {
    log('warn', `[抖音续火] 账号 ${entry.name || accountId} SDK 连接断开失败：${error?.message || error}`)
    return false
  }
}

export function closeAllBots() {
  const count = bots.size
  for (const [key] of bots) closeBot(key)
  if (count > 0) log('info', `[抖音续火] 已执行 ${count} 个 SDK 连接的关闭清理`)
  return count
}

/**
 * 由双方 uid 拼 p2p conversationId。
 *
 * 格式取自 SDK 的 parsePeerFromConversationId：`0:1:uidA:uidB`（它按 parts[1] === '1'
 * 判私聊，uid 在 parts[2] / parts[3]）。两个 uid 的先后顺序 SDK 没有写死的地方，
 * 实测样本都是按数值升序，故这里按 BigInt 升序拼——uid 是 19 位，超出 Number 精度。
 */
function p2pConversationId(myUid, peerUid) {
  // 任一侧不是纯数字就拼不出合法 id（BigInt 还会抛），交由调用方丢弃
  if (!/^\d+$/.test(String(myUid)) || !/^\d+$/.test(String(peerUid))) return ''
  const [a, b] = BigInt(myUid) <= BigInt(peerUid) ? [myUid, peerUid] : [peerUid, myUid]
  return `0:1:${a}:${b}`
}

/**
 * 好友必须带一个「能被 SDK 解析」的 chatId，否则该好友只能看不能发。
 *
 * chatId 有两个来源：
 *   1. 条目自带真实会话（`bot.frd.list()` 会把 cmd=203 的会话按 uid 交叉匹配进来，
 *      于是 conversationId 非空）—— 直接用真会话拼，发出去落进已有会话。
 *      注意不能直接信 SDK 给的 chatId：chatIdOf() 拼的是
 *      `1:${conversationShortId}:${conversationId}`，会话缺失时 shortId 是空串，
 *      SDK 自己会拼出 `1::` 这种非法串，toAddress() 直接抛「非法 chatId」。
 *   2. 没有会话记录（`bot.social.familiar()` 只给 uid/secUid/nickname）——
 *      按双方 uid 推导 conversationId，SDK 的 send 允许 shortId 为 0。
 */
function attachChatId(friend, myUid) {
  if (friend.conversationId) {
    const chatId = `1:${friend.conversationShortId || '0'}:${friend.conversationId}`
    return { ...friend, chatId }
  }
  const derived = p2pConversationId(myUid, friend.uid)
  if (!derived) return undefined
  return { ...friend, conversationId: derived, conversationShortId: '0', chatId: `1:0:${derived}` }
}

/**
 * 拉全量好友名单。
 *
 * 主源用公开的 `bot.social.familiar()`：它显式设了 `familiar/list` 要求的
 * `version_code=21.6.0`，并按 cursor 翻页。
 *
 * **不要直接用 `bot.frd.list()` 当好友来源**（0.6.6 实测）：它的好友名单同样来自
 * `familiar/list`，但内部 `fetchFamiliarRows()` 走的是默认指纹 `version_code=1.1.34`，
 * 且服务端非 0 时是 `break` 而不是抛错——于是静默返回 0 个好友，调用方完全看不出原因。
 * 这正是 0.6.5 起「互关好友恒为 0 人」的根因。
 *
 * 三级回落：social.familiar() → frd.list() → 空名单（由调用方决定如何提示）。
 */
export async function listFriends(bot) {
  const myUid = String(bot.id || '')
  const seen = new Set()
  const collected = []
  let usedFallback = false

  /**
   * 收下一批条目。返回本批里有多少个是首次见到的 uid ——
   * familiar/list 不返回 has_more，只能靠「本页没新面孔」或「本页不满」判断到底。
   */
  const collect = (rows, pageSize) => {
    let accepted = 0
    for (const row of rows ?? []) {
      const uid = String(row?.uid ?? '')
      if (!uid || uid === myUid || seen.has(uid)) continue
      seen.add(uid)
      accepted += 1
      const friend = attachChatId(
        {
          uid,
          ...(row.secUid ? { secUid: row.secUid } : {}),
          nickname: String(row.nickname ?? ''),
          ...(row.conversationShortId ? { conversationShortId: row.conversationShortId } : {}),
          lastMessageTime: Number(row.lastMessageTime ?? 0),
          unreadCount: Number(row.unreadCount ?? 0),
        },
        myUid,
      )
      // uid 非纯数字时推不出 conversationId，这种条目发不出去，直接丢弃
      if (friend) collected.push(friend)
    }
    return { accepted, complete: (rows?.length ?? 0) < pageSize }
  }

  // 主源：social.familiar() 自带正确的 version_code，单次请求，手动翻页
  try {
    let cursor = 0
    for (let page = 0; page < FAMILIAR_MAX_PAGES; page += 1) {
      const rows = await bot.social.familiar({ cursor, count: FAMILIAR_PAGE_SIZE })
      const { accepted, complete } = collect(rows, FAMILIAR_PAGE_SIZE)
      if (complete || accepted === 0) break
      cursor += FAMILIAR_PAGE_SIZE
    }
  } catch (error) {
    log('warn', `[抖音续火] social.familiar() 拉取好友名单失败（${error?.message || error}），回退 frd.list()`)
  }

  // 兜底：frd.list() 自带 cursor 翻页，但可能因 version_code 静默返回空
  if (collected.length === 0) {
    try {
      const rows = await bot.frd.list({ count: FAMILIAR_PAGE_SIZE })
      collect(rows, FAMILIAR_PAGE_SIZE)
      if (collected.length > 0) {
        usedFallback = true
        log('warn', '[抖音续火] social.familiar() 无数据，已回退 frd.list()')
      }
    } catch (error) {
      log('warn', `[抖音续火] frd.list() 拉取好友名单也失败（${error?.message || error}）`)
    }
  }

  const friends = await hydrateFriendNames(bot, collected)
  // 好友总数是「0.6.6 适配是否生效」最直接的可观测点。
  if (friends.length === 0) {
    log('warn', '[抖音续火] 好友名单为空：familiar/list 可能被服务端拒绝、无好友，或实际加载的仍是 0.6.4（该版本没有 bot.social）')
  } else {
    log('info', `[抖音续火] 好友名单 ${friends.length} 个`)
  }
  if (usedFallback) {
    log('warn', '[抖音续火] 当前名单来自 frd.list()：新版 SDK 该路径会静默返回 0 人或只给最近会话，请确认 douyin.ts 已装到 0.6.6')
  }
  return friends
}

/**
 * 会话名 → chatId 索引。
 *
 * chatId 形如 `1:98765:0:1:111:222`（好友，conversationId 自带冒号）或
 * `2:123456:7123456789012345678`（群），格式不承诺稳定且不可落库，
 * 故此处只做当次运行期的映射，一律当不透明串处理、不解析。
 *
 * 旧实现是在聊天页统一搜索，好友与群都能命中，因此这里也必须合并查找。
 */
export async function buildChatIndex(bot) {
  const [friends, groups] = await Promise.all([
    listFriends(bot),
    bot.grp.list(),
  ])
  const index = new Map()
  const ambiguous = new Set()
  for (const friend of friends) {
    addName(index, ambiguous, friend.nickname, friend.chatId)
  }
  for (const group of groups) {
    addName(index, ambiguous, group.name, group.chatId)
  }
  return { index, ambiguous }
}

function addName(index, ambiguous, name, chatId) {
  const key = typeof name === 'string' ? name.trim() : ''
  if (!key || !chatId) return
  if (index.has(key) && index.get(key) !== chatId) {
    ambiguous.add(key)
    return
  }
  index.set(key, chatId)
}

/**
 * 默认消息模板的兜底文案：模板与一言都为空时不应发出空消息。
 * 与旧实现一致，这里只负责让调用方拿到可发送内容。
 */
export function fallbackText() {
  const template = String(getConfig()?.message?.template || '').trim()
  return template
}
