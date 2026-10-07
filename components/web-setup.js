import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { login } from 'douyin.ts'
import { getConfig } from './config.js'
import { addAccount, getUserNotificationSettings, listAccounts, setUserEmail, setUserSuccessEmailEnabled, updateAccount } from './database.js'
import { isValidEmail, parseCookies, parseTargetNames, validateTemplate } from './account-setup.js'
import { toCookieArray, createSdkLog, getBot, hydrateFriendNames, closeBot, toCookieHeader, listAllChats } from './douyin.js'

const mountedRoutePrefix = '/douyin-auto-spark'
const standaloneRoutePrefix = '/douyin-auto-spark'
const sessions = new Map()
const scanSessions = new Map()
let routesRegistered = false
let webState
let standaloneServer
let standaloneError

export function createSetupLink({ userId, accountId }) {
  registerSetupRoutes()
  purgeExpiredSessions()
  const token = randomBytes(32).toString('hex')
  const config = getConfig()
  const minutes = Number(config.web?.linkExpiresMinutes) || 10
  const session = {
    userId: String(userId),
    accountId: accountId === undefined ? undefined : Number(accountId),
    expiresAt: Date.now() + minutes * 60 * 1000,
    submitting: false,
  }
  sessions.set(token, session)
  const expiryTimer = setTimeout(() => {
    if (sessions.get(token) !== session) return
    sessions.delete(token)
    void closeScanSession(token)
  }, minutes * 60 * 1000)
  expiryTimer.unref?.()
  session.expiryTimer = expiryTimer
  return {
    token,
    expiresMinutes: minutes,
    url: new URL(`${webState.prefix}/setup/${token}`, getBaseUrl(config)).toString(),
  }
}

export function bindSetupMessage(token, event, messageId) {
  const session = sessions.get(token)
  if (!session || messageId === undefined || messageId === null) return false
  const recall = event?.group?.recallMsg?.bind(event.group)
    || event?.friend?.recallMsg?.bind(event.friend)
    || event?.bot?.recallMsg?.bind(event.bot)
  if (!recall) return false
  session.messageId = messageId
  session.recallMessage = recall
  const seconds = Number(getConfig().web?.setupMessageRecallSeconds)
  if (Number.isFinite(seconds) && seconds > 0) {
    const timer = setTimeout(() => { void recallBoundSetupMessage(session) }, seconds * 1000)
    timer.unref?.()
    session.recallTimer = timer
  }
  return true
}

export async function recallSetupMessage(token) {
  const session = sessions.get(token)
  return recallBoundSetupMessage(session)
}

async function recallBoundSetupMessage(session) {
  if (!session?.recallMessage || session.messageRecalled) return false
  session.messageRecalled = true
  clearTimeout(session.recallTimer)
  try {
    await session.recallMessage(session.messageId)
    return true
  } catch (error) {
    session.messageRecalled = false
    logger.warn(`[抖音续火] 撤回网页链接消息失败：${error.message}`)
    return false
  }
}

export function revokeSetupLinks(userId) {
  for (const [token, session] of sessions) {
    if (session.userId === String(userId)) {
      sessions.delete(token)
      clearTimeout(session.expiryTimer)
      closeScanSession(token)
    }
  }
}

export function registerSetupRoutes() {
  if (routesRegistered) return
  const config = getConfig()
  webState = getWebState(config)
  if (webState.mode === 'mounted') registerMountedRoutes()
  else startStandaloneServer()
  routesRegistered = true
}

function getBaseUrl(config) {
  if (standaloneError) throw new Error(`独立网页服务启动失败：${standaloneError.message}`)
  const fallback = webState.mode === 'mounted'
    ? globalThis.Bot?.url
    : `http://127.0.0.1:${webState.port}`
  const value = String(config.web?.baseUrl || fallback || '').trim()
  if (!value) throw new Error('请先在插件配置中填写 web.baseUrl')
  try {
    return new URL(value.endsWith('/') ? value : `${value}/`)
  } catch {
    throw new Error('web.baseUrl 不是有效的网址')
  }
}

function getWebState(config) {
  const mode = config.web?.mountToTrss === false ? 'standalone' : 'mounted'
  const port = Number(config.web?.standalonePort) || 3065
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('web.standalonePort 必须是 1 到 65535 之间的端口')
  return { mode, port, prefix: mode === 'mounted' ? mountedRoutePrefix : standaloneRoutePrefix }
}

function registerMountedRoutes() {
  if (!globalThis.Bot?.express) throw new Error('Yunzai HTTP 服务尚未就绪，请稍后重试')
  const app = globalThis.Bot.express
  app.skip_auth.push(webState.prefix)
  app.quiet.push(webState.prefix, '/favicon.ico', '/hybridaction/')
  app.get(`${webState.prefix}/setup/:token`, (req, res) => handleSetupPage(req.params.token, res))
  app.post(`${webState.prefix}/api/setup/:token`, (req, res) => handleSetupSubmit(req.params.token, req.body, res))
  app.post(`${webState.prefix}/api/scan/start/:token`, (req, res) => handleScanStart(req.params.token, res))
  app.post(`${webState.prefix}/api/scan/mfa/:token`, (req, res) => handleScanMfa(req.params.token, req.body, res))
  app.get(`${webState.prefix}/api/scan/status/:token`, (req, res) => handleScanStatus(req.params.token, res))
  app.post(`${webState.prefix}/api/sessions/:token`, (req, res) => handleSessionList(req.params.token, req.body, res))
}

function startStandaloneServer() {
  standaloneServer = createServer((req, res) => {
    handleStandaloneRequest(req, res).catch((error) => {
      logger.error('[抖音续火] 独立网页服务请求失败', error)
      sendJson(res, 500, { ok: false, message: '服务器内部错误。' })
    })
  })
  standaloneServer.once('error', (error) => {
    standaloneError = error
    logger.error('[抖音续火] 独立网页服务启动失败', error)
  })
  standaloneServer.listen(webState.port)
  standaloneServer.unref()
  logger.mark(`[抖音续火] 独立网页服务已启动，端口 ${webState.port}`)
}

async function handleStandaloneRequest(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  const page = new RegExp(`^${webState.prefix}/setup/([a-f0-9]{64})$`).exec(url.pathname)
  const api = new RegExp(`^${webState.prefix}/api/setup/([a-f0-9]{64})$`).exec(url.pathname)
  const scanStart = new RegExp(`^${webState.prefix}/api/scan/start/([a-f0-9]{64})$`).exec(url.pathname)
  const scanMfa = new RegExp(`^${webState.prefix}/api/scan/mfa/([a-f0-9]{64})$`).exec(url.pathname)
  const scanStatus = new RegExp(`^${webState.prefix}/api/scan/status/([a-f0-9]{64})$`).exec(url.pathname)
  const sessionList = new RegExp(`^${webState.prefix}/api/sessions/([a-f0-9]{64})$`).exec(url.pathname)
  if (req.method === 'POST' && sessionList) return handleSessionList(sessionList[1], await readJsonBody(req), res)
  if (req.method === 'GET' && page) return handleSetupPage(page[1], res)
  if (req.method === 'POST' && api) return handleSetupSubmit(api[1], await readJsonBody(req), res)
  if (req.method === 'POST' && scanStart) return handleScanStart(scanStart[1], res)
  if (req.method === 'POST' && scanMfa) return handleScanMfa(scanMfa[1], await readJsonBody(req), res)
  if (req.method === 'GET' && scanStatus) return handleScanStatus(scanStatus[1], res)
  sendHtml(res, 404, renderMessagePage('页面不存在。'))
}

async function handleSetupPage(token, res) {
  const session = getSession(token)
  if (!session) return sendHtml(res, 404, renderMessagePage('链接无效或已过期，请重新向机器人发送添加或修改命令。'))
  try {
    const initial = await getInitialValues(session)
    sendHtml(res, 200, renderSetupPage(token, initial, session.accountId !== undefined))
  } catch (error) {
    logger.error('[抖音续火] 读取网页配置失败', error)
    sendHtml(res, 500, renderMessagePage('读取配置失败，请重新发送命令。'))
  }
}

async function handleSetupSubmit(token, body, res) {
  const session = getSession(token)
  if (!session) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  if (session.submitting) return sendJson(res, 409, { ok: false, message: '正在提交，请勿重复操作。' })
  session.submitting = true
  try {
    const message = await saveWebSetup(session, body)
    if (getConfig().web?.recallSetupMessageOnComplete === true) await recallSetupMessage(token)
    sessions.delete(token)
    clearTimeout(session.expiryTimer)
    closeScanSession(token)
    sendJson(res, 200, { ok: true, message })
  } catch (error) {
    session.submitting = false
    sendJson(res, 400, { ok: false, message: error.message || '提交失败，请检查输入。' })
  }
}

/**
 * 拉取该 Cookie 对应的可续火会话列表，供网页勾选。
 *
 * 客户端只提交 Cookie（扫码所得或粘贴），服务端据此建连并返回会话名。
 * 会过滤掉「自己和自己」的会话——它在好友列表里以本账号昵称出现，
 * 但发给它必然被服务端以 invalid receiverId 拒绝。
 */
async function handleSessionList(token, body, res) {
  const session = getSession(token)
  if (!session) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  let cookies
  try {
    cookies = await resolveSubmittedCookies(session, body)
  } catch (error) {
    return sendJson(res, 400, { ok: false, message: error.message })
  }
  if (!cookies.length) return sendJson(res, 400, { ok: false, message: '请先扫码获取 Cookie 或粘贴 Cookie JSON。' })

  const stored = session.accountId === undefined ? undefined : (await listAccounts(session.userId)).find((item) => item.id === session.accountId)
  const scan = scanSessions.get(token)
  const header = toCookieHeader(cookies)
  const douyinUid = scan?.status === 'success' && header === toCookieHeader(scan.cookies)
    ? scan.userId
    : stored && header === toCookieHeader(stored.cookies) ? stored.douyinUid : ''
  const placeholder = {
    id: `setup:${token}`,
    userId: session.userId,
    name: String(body?.name || '').trim() || '当前账号',
    cookies,
    douyinUid,
  }
  let bot
  try {
    bot = await getBot(placeholder)
  } catch (error) {
    return sendJson(res, 400, { ok: false, message: error.message })
  }

  try {
    const self = String(bot.id || '')
    const { friends: rawFriends, groups } = await listAllChats(bot)
    // 好友昵称要二次补全：会话列表接口返回的 nickname 恒为空，补全后才能拿到会话名
    const friends = await hydrateFriendNames(bot, rawFriends)
    const items = []
    const seen = new Set()
    const push = (name, chatId, type, lastMessage, uid) => {
      const key = String(name || '').trim()
      if (!key || !chatId || seen.has(key)) return
      // 自己与自己的会话：好友会话两端 uid 都是自己，发给它必被 invalid receiverId 拒绝
      if (type === 'friend' && String(uid) === self) return
      seen.add(key)
      items.push({ name: key, chatId, type, hasHistory: Boolean(lastMessage) })
    }
    for (const friend of friends) push(friend.nickname, friend.chatId, 'friend', friend.lastMessage, friend.uid)
    for (const group of groups) push(group.name, group.chatId, 'group', group.lastMessageTime)
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'group' ? -1 : 1))
    return sendJson(res, 200, { ok: true, items })
  } catch (error) {
    logger.error('[抖音续火] 拉取会话列表失败', error)
    return sendJson(res, 400, { ok: false, message: `拉取会话列表失败：${error?.message || error}` })
  } finally {
    closeBot(placeholder.id)
  }
}

/**
 * 取本次请求应使用的 Cookie：优先请求体传来的，其次账号已存的。
 * 修改账号时 Cookie 留空表示沿用原值。
 */
async function resolveSubmittedCookies(session, body) {
  const raw = String(body?.cookies || '').trim()
  if (raw) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Cookie 不是合法的 JSON，请重新扫码或粘贴 Cookie-Editor 导出的数组。')
    }
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Cookie 为空，请重新扫码或粘贴。')
    return parsed
  }
  if (session.accountId === undefined) return []
  const account = (await listAccounts(session.userId)).find((item) => item.id === session.accountId)
  return account?.cookies || []
}

async function handleScanStart(token, res) {
  const session = getSession(token)
  if (!session) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  try {
    const result = await startScanSession(token, { force: true })
    sendJson(res, 200, { ok: true, ...result })
  } catch (error) {
    logger.error('[抖音续火] 启动扫码登录失败', error)
    sendJson(res, 400, { ok: false, message: error.message || '启动扫码登录失败。' })
  }
}

/** 网页回填二次验证凭据：短信验证码或账号密码 */
async function handleScanMfa(token, body, res) {
  if (!getSession(token)) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  const scan = scanSessions.get(token)
  if (!scan?.mfa) return sendJson(res, 400, { ok: false, message: '当前无需二次验证，请先获取二维码。' })
  try {
    const value = String(body?.value || '').trim()
    if (!value) throw new Error('请输入验证码或密码')
    if (scan.mfa.kind === 'sms' && !/^\d{4,8}$/.test(value)) throw new Error('短信验证码应为 4 到 8 位数字')
    const pending = scan.mfa
    scan.mfa = undefined
    scan.status = 'verifying'
    scan.message = '已提交，请等待登录结果。'
    pending.resolve(value)
    sendJson(res, 200, { ok: true, message: '已提交，请等待登录结果。' })
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message || '提交二次验证失败。' })
  }
}

async function handleScanStatus(token, res) {
  if (!getSession(token)) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  const scan = scanSessions.get(token)
  if (!scan) return sendJson(res, 200, { ok: true, status: 'idle' })
  if (scan.status === 'success') {
    return sendJson(res, 200, { ok: true, status: 'success', cookies: scan.cookies, douyinUid: scan.userId || '', nickname: scan.nickname || '' })
  }
  if (scan.status === 'error') {
    const message = scan.error || '扫码登录失败。'
    closeScanSession(token)
    return sendJson(res, 200, { ok: true, status: 'error', message })
  }
  const payload = { ok: true, status: scan.status }
  if (scan.qr) payload.qr = scan.qr
  if (scan.message) payload.message = scan.message
  if (scan.mfa) payload.mfa = { kind: scan.mfa.kind, maskedMobile: scan.mfa.maskedMobile }
  if (scan.verifyUrl) payload.verifyUrl = scan.verifyUrl
  sendJson(res, 200, payload)
}

/**
 * 扫码登录：走 douyin.ts 的 login()，各阶段回调交给前端轮询展示。
 *
 * 与旧的浏览器方案不同，这里没有二维码截图与页面轮询——QR 由 login 直接给出
 * base64（或扫码页 URL），滑块等安全验证改为把地址交给用户浏览器打开，
 * 短信/密码二次验证则等前端把输入回传（scan.mfa 上的 Promise）。
 */
async function startScanSession(token, { force = false } = {}) {
  const current = scanSessions.get(token)
  if (!force && current && current.status !== 'error') return { status: current.status, qr: current.qr }

  closeScanSession(token)
  const scan = {
    token,
    status: 'waiting',
    qr: undefined,
    cookies: undefined,
    error: undefined,
    message: '正在获取二维码...',
    mfa: undefined,
    verifyUrl: undefined,
    cancelled: false,
  }
  scanSessions.set(token, scan)

  // login() 是长流程，后台跑；前端靠 /api/scan/status 轮询进度
  scan.promise = login({
    log: createSdkLog('扫码'),
    onQr: (qr) => {
      // douyin.ts 透传的是抖音接口原始 qrcode 字段，通常是裸 base64（无 data: 前缀），
      // 直接赋给 img.src 会被当成相对路径而破图，这里统一补齐；若渠道下发的是
      // 完整 data URL 或 http(s) 地址则原样使用。
      scan.qr = normalizeQrSrc(qr.base64, qr.url)
      scan.qrUrl = qr.url
      scan.message = '请使用抖音 App 扫码登录。'
      notifyQr(scan)
    },
    onStatus: (status) => {
      scan.status = status === 'confirmed' ? 'verifying' : 'waiting'
      scan.message = statusText(status)
    },
    onVerifyUrl: (url) => {
      // 滑块等本地安全验证：把地址交给用户在浏览器打开，完成后 login 自动继续
      scan.verifyUrl = url
      scan.message = '需要完成安全验证，请打开下方链接。'
    },
    onMfa: (info) => new Promise((resolve, reject) => {
      // 等前端把验证码或密码回传；链接过期/取消时 reject，避免 Promise 悬挂
      scan.mfa = { kind: info?.kind, maskedMobile: info?.maskedMobile, resolve }
      scan.status = 'mfa'
      scan.message = info?.kind === 'password'
        ? '该账号需要密码二次验证，请输入登录密码。'
        : `抖音要求短信验证，请输入验证码（${info?.maskedMobile || '绑定手机'}）。`
      scan.mfaReject = reject
    }),
  })
    .then((session) => {
      if (scan.cancelled) return
      scan.cookies = toCookieArray(session.cookie)
      scan.userId = session.userId
      scan.nickname = session.userData?.screen_name
      scan.status = 'success'
      scan.message = '扫码登录成功，Cookie 已填入下方文本框，请继续提交。'
    })
    .catch((error) => {
      if (scan.cancelled) return
      scan.status = 'error'
      scan.error = error?.message || '扫码登录失败。'
      // 取码阶段就失败时唤醒等待者，避免请求一直挂到超时才报错
      notifyQr(scan)
    })

  // login() 取码要打一次抖音接口（实测约 1.4s），onQr 之前 scan.qr 一直是 undefined。
  // 若此刻直接返回，前端拿到的是「没有 qr」的响应：它只在 data.qr 存在时才启动轮询，
  // 于是既不显示二维码也不报错——表现就是「按钮点了没反应」。这里短等一下把首图带上。
  const qr = await waitForQr(scan)
  return { status: scan.status, qr, message: scan.message }
}

/** 等首张二维码就绪：取到码、出错或超时都立即返回，不阻塞请求线程 */
function waitForQr(scan, timeoutMs = 8000) {
  if (scan.qr || scan.status === 'error') return Promise.resolve(scan.qr)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      scan.qrWaiters?.delete(settle)
      resolve(scan.qr)
    }, timeoutMs)
    timer.unref?.()
    const settle = () => {
      clearTimeout(timer)
      scan.qrWaiters?.delete(settle)
      resolve(scan.qr)
    }
    scan.qrWaiters ??= new Set()
    scan.qrWaiters.add(settle)
  })
}

/** onQr / 出错时唤醒所有等待首图的请求 */
function notifyQr(scan) {
  if (!scan.qrWaiters) return
  for (const settle of [...scan.qrWaiters]) settle()
}

/** 把 onQr 给的图源规范成 <img src> 可直接使用的值 */
function normalizeQrSrc(base64, url) {
  const raw = (base64 || '').trim()
  if (raw.startsWith('data:')) return raw
  if (/^https?:\/\//i.test(raw)) return raw
  if (raw) return `data:image/png;base64,${raw}`
  // 没有图片时退回扫码页地址，至少让用户有办法继续
  return /^https?:\/\//i.test(url || '') ? url : ''
}

function statusText(status) {
  const map = {
    new: '请使用抖音 App 扫码登录。',
    scanned: '已扫码，请在手机上确认登录。',
    verifying: '正在验证，请稍候...',
    verified: '验证通过，正在完成登录...',
    confirmed: '登录已确认，正在获取 Cookie...',
    expired: '二维码已过期，请点击“重新获取二维码”。',
  }
  return map[status] || String(status || '')
}

/**
 * 结束扫码会话。login() 没有中断接口，其轮询最长可持续 120s，因此这里不能 await
 * 它的 promise——否则请求处理会被挂住。只标记 cancelled 让它后续结果被忽略，
 * 并让等待输入的二次验证 Promise 立刻失败，避免悬挂。
 */
function closeScanSession(token) {
  const scan = scanSessions.get(token)
  if (!scan) return
  scanSessions.delete(token)
  scan.cancelled = true
  if (scan.mfaReject) {
    try {
      scan.mfaReject(new Error('扫码会话已结束'))
    } catch {}
    scan.mfaReject = undefined
  }
  scan.promise?.catch(() => {})
  // 唤醒仍在等首图的请求，否则取消后它要空等到超时才返回
  notifyQr(scan)
}

function sendHtml(res, status, body) {
  if (typeof res.type === 'function') return res.status(status).type('html').send(body)
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function sendJson(res, status, value) {
  if (typeof res.json === 'function') return res.status(status).json(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > 1024 * 1024) throw new Error('提交内容不能超过 1 MB')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('提交内容不是有效 JSON')
  }
}

function getSession(token) {
  const session = sessions.get(token)
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token)
    clearTimeout(session?.expiryTimer)
    void closeScanSession(token)
    return undefined
  }
  return session
}

function purgeExpiredSessions() {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token)
      clearTimeout(session.expiryTimer)
      closeScanSession(token)
    }
  }
}

async function getInitialValues(session) {
  const notification = (await getUserNotificationSettings([session.userId])).get(session.userId)
  const email = notification?.email || ''
  const successEmailEnabled = notification?.successEmailEnabled || false
  if (session.accountId === undefined) {
    return { name: '', targetNames: '', messageTemplate: '', email, successEmailEnabled, cookieRequired: true }
  }
  const account = (await listAccounts(session.userId)).find((item) => item.id === session.accountId)
  if (!account) throw new Error('账号不存在')
  return {
    name: account.name,
    targetNames: account.targetNames.join('\n'),
    messageTemplate: account.messageTemplate,
    email,
    successEmailEnabled,
    cookieRequired: false,
  }
}

async function saveWebSetup(session, body) {
  if (!body || typeof body !== 'object') throw new Error('提交内容无效')
  const name = String(body.name || '').trim()
  if (!name || name.length > 40) throw new Error('账号名称不能为空且不能超过 40 个字符')

  const targetNames = parseTargetNames(String(body.targetNames || ''))
  const messageTemplate = String(body.messageTemplate || '').trim()
  validateTemplate(messageTemplate)
  const email = String(body.email || '').trim()
  if (email && !isValidEmail(email)) throw new Error('邮箱格式不正确')
  const successEmailEnabled = body.successEmailEnabled === true || body.successEmailEnabled === 'true'
  if (successEmailEnabled && !email) throw new Error('开启成功邮件通知前，请先填写收件邮箱')

  const cookieText = String(body.cookieText || '').trim()
  let ignored = 0
  let previousAccount
  if (session.accountId !== undefined) {
    previousAccount = (await listAccounts(session.userId)).find((item) => item.id === session.accountId)
    if (!previousAccount) throw new Error('账号不存在，请重新发送修改命令')
  }
  if (session.accountId === undefined) {
    if (!cookieText) throw new Error('请粘贴 Cookie JSON 或选择 .txt 文件')
    const parsed = parseCookies(cookieText)
    ignored = parsed.ignored
    await addAccount({ userId: session.userId, name, cookies: parsed.cookies, targetNames, messageTemplate, douyinUid: String(body.douyinUid || '') })
  } else {
    const account = previousAccount
    const parsed = cookieText ? parseCookies(cookieText) : { cookies: account.cookies, ignored: 0 }
    ignored = parsed.ignored
    await updateAccount({
      id: session.accountId,
      userId: session.userId,
      name,
      cookies: parsed.cookies,
      targetNames,
      messageTemplate,
      // Cookie 或账号名变化后，旧连接不能继续复用；下次 getBot 会按新 Cookie 重建
      douyinUid: cookieText ? String(body.douyinUid || '') : undefined,
    })
  }
  await setUserEmail(session.userId, email)
  await setUserSuccessEmailEnabled(session.userId, successEmailEnabled)
  return `${session.accountId === undefined ? '账号已添加' : '账号已更新'}${ignored ? `，已忽略 ${ignored} 条无法使用的 Cookie` : ''}。现在可以关闭此页面。`
}

function renderSetupPage(token, initial, editing) {
  const data = JSON.stringify(initial).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  const title = editing ? '修改抖音账号' : '添加抖音账号'
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <link rel="icon" href="data:,">
  <title>${title}</title>
  <style>
    :root { color-scheme: light; font-family: "Microsoft YaHei", sans-serif; color: #1d2939; background: #f4f7fb; }
    body { margin: 0; padding: 32px 16px; }
    main { width: min(680px, 100%); margin: 0 auto; background: #fff; border: 1px solid #d7dee8; border-radius: 8px; box-shadow: 0 10px 30px #17203314; overflow: hidden; }
    header { padding: 24px 28px; background: #173b60; color: #fff; }
    h1 { margin: 0; font-size: 22px; font-weight: 600; }
    form { padding: 28px; display: grid; gap: 18px; }
    label { display: grid; gap: 8px; font-size: 14px; font-weight: 600; }
    input, textarea { box-sizing: border-box; width: 100%; border: 1px solid #b9c5d3; border-radius: 5px; padding: 10px 12px; font: inherit; color: #172033; background: #fff; }
    textarea { min-height: 88px; resize: vertical; line-height: 1.5; }
    input:focus, textarea:focus { outline: 2px solid #4b9edb66; border-color: #247bb7; }
    .hint { margin: 0; color: #667085; font-size: 12px; font-weight: 400; line-height: 1.5; }
    .cookie { min-height: 160px; font-family: Consolas, monospace; font-size: 12px; }
    .check { display: flex; align-items: center; gap: 8px; font-weight: 400; }
    .check input { width: 16px; height: 16px; }
    button { justify-self: start; border: 0; border-radius: 5px; padding: 11px 20px; background: #1976b7; color: #fff; font: inherit; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .65; }
    .scan { display: grid; gap: 8px; padding: 12px; border: 1px solid #d7dee8; border-radius: 5px; background: #f8fafc; }
    .scan-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .scan button { justify-self: start; }
    .qr { display: none; width: min(360px, 100%); max-height: 360px; object-fit: contain; border: 1px solid #d7dee8; background: #fff; }
    .sms { display: none; gap: 8px; grid-template-columns: minmax(0, 1fr) auto; }
    .verify { display: none; color: #1976b7; font-size: 14px; }
    .sms input { min-width: 0; }
    .picker { display: grid; gap: 8px; padding: 12px; border: 1px solid #d7dee8; border-radius: 5px; background: #f8fafc; }
    .picker-list { display: grid; gap: 6px; max-height: 260px; overflow-y: auto; }
    .picker-item { display: flex; align-items: center; gap: 8px; font-weight: 400; font-size: 14px; padding: 4px 2px; }
    .picker-item input { width: 16px; height: 16px; flex: none; }
    .picker-item .tag { flex: none; font-size: 11px; padding: 1px 6px; border-radius: 3px; background: #e3ebf3; color: #43566b; }
    .picker-item .tag.group { background: #e6f0e8; color: #35603f; }
    .picker-item .tag.nohist { background: #fbeadf; color: #8a4b21; }
    .picker-empty { color: #667085; font-size: 13px; }
    #status { margin: 0; min-height: 20px; color: #b42318; font-size: 14px; }
    #status.ok { color: #087443; }
  </style>
</head>
<body>
  <main>
    <header><h1>${title}</h1></header>
    <form id="setup-form">
      <label>账号名称<input id="name" maxlength="40" required></label>
      <label>目标会话<textarea id="targetNames" required placeholder="每行一个会话名称，也可粘贴 JSON 数组"></textarea></label>
      <div class="picker">
        <div class="scan-actions">
          <button id="loadSessions" type="button">从抖音读取好友/群列表</button>
          <button id="clearTargets" type="button" disabled>清空已选</button>
        </div>
        <span id="pickerStatus" class="hint">先填好 Cookie（扫码或粘贴）再点此按钮，可直接勾选要续火的会话，无需手打昵称。</span>
        <div id="pickerList" class="picker-list"></div>
      </div>
      <label>消息模板<textarea id="messageTemplate" placeholder="留空使用随机一言"></textarea></label>
      <label>失败通知邮箱<input id="email" type="email" placeholder="留空则不发送失败邮件"></label>
      <label class="check"><input id="successEmailEnabled" type="checkbox">续火成功时发送邮件通知</label>
      <label>Cookie 文本文件<input id="cookieFile" type="file" accept=".txt,text/plain"><span class="hint">选择后会读取到下方文本框，不会上传文件本身。</span></label>
      <div class="scan">
        <div class="scan-actions">
          <button id="scanLogin" type="button">扫码获取 Cookie</button>
          <button id="scanRefresh" type="button" disabled>重新获取二维码</button>
        </div>
        <img id="scanQr" class="qr" alt="抖音登录二维码">
        <span id="scanStatus" class="hint">也可以直接粘贴 Cookie JSON 或选择 .txt 文件。</span>
        <a id="verifyLink" class="verify" href="#" target="_blank" rel="noopener noreferrer" style="display:none">打开安全验证页面</a>
        <div id="mfaVerify" class="sms">
          <input id="mfaValue" autocomplete="one-time-code" placeholder="输入短信验证码">
          <button id="mfaSubmit" type="button">提交</button>
        </div>
      </div>
      <label>Cookie JSON<textarea id="cookieText" class="cookie" ${editing ? '' : 'required'} placeholder="${editing ? '留空则保留当前 Cookie；需要更新时粘贴或选择 .txt 文件。' : '粘贴 Cookie-Editor 导出的 JSON 数组，或先选择 .txt 文件。'}"></textarea></label>
      <p id="status"></p>
      <button id="submit" type="submit">${editing ? '保存修改' : '添加账号'}</button>
    </form>
  </main>
  <script>
    const initial = ${data};
    const form = document.querySelector('#setup-form');
    const status = document.querySelector('#status');
    const submit = document.querySelector('#submit');
    const scanLogin = document.querySelector('#scanLogin');
    const scanRefresh = document.querySelector('#scanRefresh');
    const scanQr = document.querySelector('#scanQr');
    const scanStatus = document.querySelector('#scanStatus');
    const mfaVerify = document.querySelector('#mfaVerify');
    const mfaValue = document.querySelector('#mfaValue');
    const mfaSubmit = document.querySelector('#mfaSubmit');
    const verifyLink = document.querySelector('#verifyLink');
    const loadSessions = document.querySelector('#loadSessions');
    const clearTargets = document.querySelector('#clearTargets');
    const pickerStatus = document.querySelector('#pickerStatus');
    const pickerList = document.querySelector('#pickerList');
    const targetNames = document.querySelector('#targetNames');
    let scanTimer;
    let scanUid = '';
    for (const key of ['name', 'targetNames', 'messageTemplate', 'email']) document.querySelector('#' + key).value = initial[key] || '';
    document.querySelector('#successEmailEnabled').checked = Boolean(initial.successEmailEnabled);
    document.querySelector('#cookieFile').addEventListener('change', async event => {
      const file = event.target.files[0];
      if (!file) return;
      if (!/\.txt$/i.test(file.name)) { status.textContent = '仅支持 .txt 文件。'; return; }
      if (file.size > 1024 * 1024) { status.textContent = '文件不能超过 1 MB。'; return; }
      document.querySelector('#cookieText').value = await file.text();
      scanUid = '';
      status.textContent = '';
    });
    document.querySelector('#cookieText').addEventListener('input', () => {
      // 手动修改 Cookie 后，扫码得到的 UID 不再可信，交给服务端重新解析。
      scanUid = '';
    });
    let mfaShown = '';
    // 轮询每 2 秒会重复调用本函数，已显示的同一道验证不能重置输入框，否则会把用户
    // 正在输入的验证码清掉（表现为「吞字符」）。
    function showMfa(kind, maskedMobile) {
      const key = (kind || 'sms') + '|' + (maskedMobile || '');
      if (mfaShown === key) return;
      mfaShown = key;
      mfaVerify.style.display = 'grid';
      mfaValue.value = '';
      if (kind === 'password') {
        mfaValue.type = 'password';
        mfaValue.inputMode = 'text';
        mfaValue.placeholder = '输入抖音登录密码';
      } else {
        mfaValue.type = 'text';
        mfaValue.inputMode = 'numeric';
        mfaValue.placeholder = '输入短信验证码' + (maskedMobile ? '（' + maskedMobile + '）' : '');
      }
    }
    async function requestQr(endpoint, loadingText) {
      scanLogin.disabled = true;
      scanRefresh.disabled = true;
      mfaVerify.style.display = 'none';
      mfaShown = '';
      verifyLink.style.display = 'none';
      scanQr.style.display = 'none';
      scanQr.removeAttribute('src');
      delete scanQr.dataset.qr;
      scanStatus.textContent = loadingText;
      try {
        const response = await fetch(endpoint, { method: 'POST' });
        const data = await response.json();
        if (!data.ok) throw new Error(data.message || '启动扫码登录失败');
        if (data.qr) {
          scanQr.dataset.qr = data.qr;
          scanQr.src = data.qr;
          scanQr.style.display = 'block';
        }
        scanStatus.textContent = data.message || '请使用抖音 App 扫码登录。';
        if (!data.qr) scanStatus.textContent = '正在获取二维码，请稍候…';
        scanRefresh.disabled = false;
        clearInterval(scanTimer);
        scanTimer = setInterval(async () => {
          try {
            const result = await (await fetch('${webState.prefix}/api/scan/status/${token}', { cache: 'no-store' })).json();
            if (!result.ok) throw new Error(result.message || '读取扫码状态失败');
            if (result.qr && scanQr.dataset.qr !== result.qr) {
              scanQr.dataset.qr = result.qr;
              scanQr.src = result.qr;
              scanQr.style.display = 'block';
            }
            if (result.verifyUrl) { verifyLink.href = result.verifyUrl; verifyLink.style.display = 'inline-block'; }
            if (result.message) scanStatus.textContent = result.message;
            if (result.status === 'success') {
              clearInterval(scanTimer);
              mfaVerify.style.display = 'none';
              verifyLink.style.display = 'none';
              document.querySelector('#cookieText').value = JSON.stringify(result.cookies, null, 2);
              // login() 返回的 userId 是权威身份，落库后下次续火不必再解析
              if (result.douyinUid) scanUid = String(result.douyinUid);
              scanStatus.textContent = result.message || '扫码登录成功，Cookie 已填入下方文本框，请继续提交。';
              scanLogin.disabled = false;
              scanRefresh.disabled = false;
              scanLogin.textContent = '重新扫码';
            } else if (result.status === 'mfa') {
              showMfa(result.mfa && result.mfa.kind, result.mfa && result.mfa.maskedMobile);
            } else if (result.status === 'error') {
              throw new Error(result.message || '扫码登录失败');
            }
          } catch (error) {
            clearInterval(scanTimer);
            scanStatus.textContent = error.message || '读取扫码状态失败';
            scanLogin.disabled = false;
            scanRefresh.disabled = false;
          }
        }, 2000);
      } catch (error) {
        scanStatus.textContent = error.message || '启动扫码登录失败';
        scanLogin.disabled = false;
        scanRefresh.disabled = false;
      }
    }
    scanLogin.addEventListener('click', () => requestQr('${webState.prefix}/api/scan/start/${token}', '正在获取登录二维码...'));
    scanRefresh.addEventListener('click', () => requestQr('${webState.prefix}/api/scan/start/${token}', '正在重新获取二维码...'));
    mfaSubmit.addEventListener('click', async () => {
      const value = mfaValue.value.trim();
      if (!value) { scanStatus.textContent = '请输入验证码或密码。'; return; }
      mfaSubmit.disabled = true;
      try {
        const response = await fetch('${webState.prefix}/api/scan/mfa/${token}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
        const data = await response.json();
        if (!data.ok) throw new Error(data.message || '提交二次验证失败');
        mfaVerify.style.display = 'none';
        mfaShown = '';
        scanStatus.textContent = data.message || '已提交，请等待登录结果。';
      } catch (error) {
        scanStatus.textContent = error.message || '提交二次验证失败';
      } finally {
        mfaSubmit.disabled = false;
      }
    });

    // ---- 会话选择器 ----
    // 勾选结果直接写回「目标会话」文本框，保持文本框为唯一数据源，
    // 用户仍可手工增删，提交逻辑无需改动。
    function currentTargets() {
      return targetNames.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    }
    function writeTargets(list) {
      targetNames.value = [...new Set(list)].join('\n');
      clearTargets.disabled = currentTargets().length === 0;
    }
    function renderPicker(items) {
      pickerList.innerHTML = '';
      if (!items.length) {
        const empty = document.createElement('span');
        empty.className = 'picker-empty';
        empty.textContent = '没有读到任何会话。抖音只返回「有过消息往来」的会话，请先在抖音里给对方发过消息。';
        pickerList.appendChild(empty);
        return;
      }
      const selected = new Set(currentTargets());
      for (const item of items) {
        const row = document.createElement('label');
        row.className = 'picker-item';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = selected.has(item.name);
        box.addEventListener('change', () => {
          const now = new Set(currentTargets());
          if (box.checked) now.add(item.name); else now.delete(item.name);
          writeTargets([...now]);
        });
        const tag = document.createElement('span');
        tag.className = 'tag' + (item.type === 'group' ? ' group' : '') + (item.hasHistory ? '' : ' nohist');
        tag.textContent = item.type === 'group' ? '群' : (item.hasHistory ? '好友' : '好友·无记录');
        const text = document.createElement('span');
        text.textContent = item.name;
        row.append(box, tag, text);
        pickerList.appendChild(row);
      }
      clearTargets.disabled = currentTargets().length === 0;
    }

    loadSessions.addEventListener('click', async () => {
      const cookieRaw = document.querySelector('#cookieText').value.trim();
      if (!cookieRaw && !${editing}) { pickerStatus.textContent = '请先扫码获取 Cookie 或粘贴 Cookie JSON，再读取会话列表。'; return; }
      loadSessions.disabled = true;
      pickerStatus.textContent = '正在连接抖音并读取会话列表…';
      pickerList.innerHTML = '';
      try {
        const response = await fetch('${webState.prefix}/api/sessions/${token}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies: cookieRaw, name: document.querySelector('#name').value.trim() }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.message || '读取会话列表失败');
        renderPicker(data.items || []);
        pickerStatus.textContent = '共 ' + (data.items || []).length + ' 个会话，勾选后会自动写入上方「目标会话」。';
      } catch (error) {
        pickerStatus.textContent = error.message || '读取会话列表失败';
      } finally {
        loadSessions.disabled = false;
      }
    });
    clearTargets.addEventListener('click', () => {
      writeTargets([]);
      pickerList.querySelectorAll('input[type=checkbox]').forEach(box => { box.checked = false; });
      pickerStatus.textContent = '已清空，可重新勾选。';
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      clearInterval(scanTimer);
      status.className = ''; status.textContent = ''; submit.disabled = true;
      const payload = Object.fromEntries(new FormData(form));
      payload.name = document.querySelector('#name').value;
      payload.targetNames = document.querySelector('#targetNames').value;
      payload.messageTemplate = document.querySelector('#messageTemplate').value;
      payload.email = document.querySelector('#email').value;
      payload.successEmailEnabled = document.querySelector('#successEmailEnabled').checked;
      payload.cookieText = document.querySelector('#cookieText').value;
      payload.douyinUid = scanUid;
      try {
        const response = await fetch('${webState.prefix}/api/setup/${token}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await response.json();
        if (!data.ok) throw new Error(data.message || '提交失败');
        status.className = 'ok'; status.textContent = data.message; form.querySelectorAll('input, textarea, button').forEach(item => item.disabled = true);
      } catch (error) {
        status.textContent = error.message || '提交失败，请重试。'; submit.disabled = false;
      }
    });
  </script>
</body>
</html>`
}

function renderMessagePage(message) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>抖音续火</title><body><p>${message}</p></body></html>`
}
