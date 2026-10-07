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
 */
import util from 'node:util'
import { Bot, chatIdOf } from 'douyin.ts'
import { getConfig } from './config.js'

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

/** 按 secUid 批量补全昵称，复用 SDK 桌面 IM 接口与设备身份。 */
export async function hydrateFriendNames(bot, friends) {
  const pending = [...new Set(friends.filter((friend) => !String(friend.nickname || '').trim() && friend.secUid).map((friend) => friend.secUid))]
  if (pending.length === 0) return friends
  const profiles = await bot.im().getUserProfiles(pending)
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

/**
 * 取账号对应的 Bot 实例，未启动则启动。
 *
 * 失败实例一律丢弃重建：start() 抛错可能发生在 im.start() 握手中途，此时
 * 实例字段已写入且 stop() 不重置它们，复用会让后续重试空转返回。
 */
export async function getBot(account, { persistUid } = {}) {
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
  const bot = new Bot({ cookie, userId, log: createSdkLog(account.name) })
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
  // SDK 不暴露原始 cookie 串，这里挂一份供资料类接口复用
  bot.cookieString = cookie
  bots.set(key, { bot, cookie })
  return bot
}

/** 关闭并遗忘指定账号连接；accountId 省略时关闭全部 */
export function closeBot(accountId) {
  if (accountId === undefined) return closeAllBots()
  const entry = bots.get(accountId)
  if (!entry) return false
  bots.delete(accountId)
  try {
    entry.bot.stop()
  } catch {}
  return true
}

export function closeAllBots() {
  const count = bots.size
  for (const [key, entry] of bots) {
    bots.delete(key)
    try {
      entry.bot.stop()
    } catch {}
  }
  return count
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
/** SDK 0.6.2 的列表方法丢弃分页信息，在协议响应处保留服务端游标。 */
export async function listAllChats(bot) {
  const im = bot.im()
  const friends = await listAllPages(im, 'getFriendList', 203, 'inbox', '好友')
  const groups = await listAllPages(im, 'getGroupList', 2006, 'conversationList', '群聊')
  return {
    friends: friends.map((friend) => ({ ...friend, chatId: chatIdOf({ ...friend, conversationType: 1 }) })),
    groups: groups.map((group) => ({ ...group, chatId: chatIdOf({ ...group, conversationType: 2 }) })),
  }
}

async function listAllPages(im, method, command, bodyKey, label) {
  // transport 是 SDK 0.6.2 的内部字段；不匹配时明确报错，避免展示不完整的列表。
  const transport = im.transport
  if (typeof transport?.sendCookieProto !== 'function') {
    throw new Error('当前 douyin.ts 版本不支持会话分页，请检查 SDK 版本')
  }
  const original = transport.sendCookieProto
  const values = new Map()
  const cursors = new Set()
  const pageSize = 100
  let cursor = 0
  let responseBody
  transport.sendCookieProto = async function (...args) {
    const response = await original.apply(this, args)
    if (args[0] === command) responseBody = response?.body?.[bodyKey]
    return response
  }
  try {
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      if (cursors.has(String(cursor))) throw new Error(label + '列表游标未推进')
      cursors.add(String(cursor))
      responseBody = undefined
      const page = await im[method]({ cursor, count: pageSize })
      if (!responseBody) throw new Error(label + '列表缺少分页响应')
      let added = 0
      for (const value of page) {
        const key = String(value.conversationId)
        if (!values.has(key)) added += 1
        values.set(key, value)
      }
      if (command === 203) {
        if (!Number(responseBody.hasMore)) return [...values.values()]
        const next = String(responseBody.nextCursor ?? '')
        const numericCursor = Number(next)
        if (!next || !Number.isSafeInteger(numericCursor)) {
          throw new Error(label + '列表返回了无效游标')
        }
        cursor = numericCursor
      } else {
        // cmd 2006 的 SDK 协议没有 has_more，以未过滤的会话数推进偏移。
        const rawCount = responseBody.conversations?.length ?? 0
        if (rawCount === 0 || (pageNumber > 0 && added === 0)) return [...values.values()]
        cursor += rawCount
      }
    }
    throw new Error(label + '列表分页超过 100 页，无法确认已获取完整列表')
  } finally {
    transport.sendCookieProto = original
  }
}

export async function buildChatIndex(bot) {
  const { friends: rawFriends, groups } = await listAllChats(bot)
  // 好友昵称需二次补全：会话列表接口返回的 nickname 恒为空
  const friends = await hydrateFriendNames(bot, rawFriends)
  const index = new Map()
  const ambiguous = new Set()
  for (const friend of friends) {
    if (String(friend.uid) === String(bot.id)) continue
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
