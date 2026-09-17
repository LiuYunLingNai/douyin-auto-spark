import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { getConfig } from './config.js'
import { addAccount, getUserNotificationSettings, listAccounts, listTargets, replaceTargets, setUserEmail, setUserSuccessEmailEnabled, updateAccount } from './database.js'
import { isValidEmail, parseCookies, validateTemplate } from './account-setup.js'
import { listConversations } from './conversation-api.js'
import { QrLoginSession } from './qr-login.js'

const mountedRoutePrefix = '/douyin-id-spark'
const standaloneRoutePrefix = '/douyin-id-spark'
const sessions = new Map()
const scanSessions = new Map()
let routesRegistered = false
let webState
let standaloneServer
let standaloneError

export async function createSetupLink({ userId, accountId }) {
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
    url: joinUrl(await getBaseUrl(config), `${webState.prefix}/setup/${token}`),
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

const PUBLIC_IP_SOURCES = [
  'https://api.ipify.org/?format=json',
  'https://httpbin.org/ip',
  'https://icanhazip.com',
]
let publicIpCache = ''

/** 探测本机公网 IP（多源容错，参考 NTEUID 的做法），结果进程内缓存 */
async function getPublicIp() {
  if (publicIpCache) return publicIpCache
  for (const url of PUBLIC_IP_SOURCES) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      let text = (await response.text()).trim()
      if (url.includes('ipify')) text = JSON.parse(text).ip
      else if (url.includes('httpbin')) text = JSON.parse(text).origin
      const ip = text.split(',')[0].trim()
      if (/^[\d.]+$/.test(ip)) {
        publicIpCache = ip
        return ip
      }
    } catch { /* 尝试下一个源 */ }
  }
  throw new Error('无法探测公网 IP，请在锅巴面板填写「网页服务对外地址」(web.baseUrl)')
}

function isLanHost(host) {
  return ['0.0.0.0', '::', 'localhost', '127.0.0.1'].includes(host)
    || host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')
}

/** 拼接 base 与 path（保留 base 的子路径，修复穿透域名带子路径时被吞的问题） */
function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function getBaseUrl(config) {
  if (standaloneError) throw new Error(`独立网页服务启动失败：${standaloneError.message}`)
  // 三级回落（对齐 Core 版/NTEUID 设计）：web.baseUrl > Bot.url / 独立端口 > 局域网时自动探测公网 IP
  let value = String(config.web?.baseUrl || '').trim()
  if (!value) {
    value = webState.mode === 'mounted'
      ? String(globalThis.Bot?.url || '').trim()
      : `http://127.0.0.1:${webState.port}`
    if (value) {
      try {
        const parsed = new URL(value.endsWith('/') ? value : `${value}/`)
        if (isLanHost(parsed.hostname)) parsed.hostname = await getPublicIp()
        return joinUrl(parsed.toString(), '')
      } catch (error) {
        if (error.message.includes('无法探测公网 IP')) throw error
        throw new Error(`网页服务地址无效：${value}`)
      }
    }
    throw new Error('请先在插件配置中填写 web.baseUrl（网页服务对外地址）')
  }
  if (!/^https?:\/\//.test(value)) value = `https://${value}`
  try {
    return new URL(value.endsWith('/') ? value : `${value}/`).toString()
  } catch {
    throw new Error('web.baseUrl 不是有效的网址')
  }
}

function getWebState(config) {
  const mode = config.web?.mountToTrss === false ? 'standalone' : 'mounted'
  const port = Number(config.web?.standalonePort) || 3066
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
  app.post(`${webState.prefix}/api/conversations/:token`, (req, res) => handleConversationScan(req.params.token, req.body, res))
  app.post(`${webState.prefix}/api/scan/start/:token`, (req, res) => handleScanStart(req.params.token, res))
  app.post(`${webState.prefix}/api/scan/refresh/:token`, (req, res) => handleScanRefresh(req.params.token, res))
  app.post(`${webState.prefix}/api/scan/sms/:token`, (req, res) => handleScanSms(req.params.token, req.body, res))
  app.get(`${webState.prefix}/api/scan/status/:token`, (req, res) => handleScanStatus(req.params.token, res))
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
  const convs = new RegExp(`^${webState.prefix}/api/conversations/([a-f0-9]{64})$`).exec(url.pathname)
  const scanStart = new RegExp(`^${webState.prefix}/api/scan/start/([a-f0-9]{64})$`).exec(url.pathname)
  const scanRefresh = new RegExp(`^${webState.prefix}/api/scan/refresh/([a-f0-9]{64})$`).exec(url.pathname)
  const scanSms = new RegExp(`^${webState.prefix}/api/scan/sms/([a-f0-9]{64})$`).exec(url.pathname)
  const scanStatus = new RegExp(`^${webState.prefix}/api/scan/status/([a-f0-9]{64})$`).exec(url.pathname)
  if (req.method === 'GET' && page) return handleSetupPage(page[1], res)
  if (req.method === 'POST' && api) return handleSetupSubmit(api[1], await readJsonBody(req), res)
  if (req.method === 'POST' && convs) return handleConversationScan(convs[1], await readJsonBody(req), res)
  if (req.method === 'POST' && scanStart) return handleScanStart(scanStart[1], res)
  if (req.method === 'POST' && scanRefresh) return handleScanRefresh(scanRefresh[1], res)
  if (req.method === 'POST' && scanSms) return handleScanSms(scanSms[1], await readJsonBody(req), res)
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
    await closeScanSession(token)
    sendJson(res, 200, { ok: true, message })
  } catch (error) {
    session.submitting = false
    sendJson(res, 400, { ok: false, message: error.message || '提交失败，请检查输入。' })
  }
}

/** 解析本次会话可用的 Cookie：优先表单新粘贴的，修改模式下回落到已保存的 */
async function resolveSessionCookies(session, cookieText) {
  const text = String(cookieText || '').trim()
  if (text) return parseCookies(text).cookies
  if (session.accountId !== undefined) {
    const account = (await listAccounts(session.userId)).find((item) => item.id === session.accountId)
    if (account) return account.cookies
  }
  throw new Error('请先粘贴 Cookie JSON 或完成扫码登录，再拉取会话列表')
}

async function handleConversationScan(token, body, res) {
  const session = getSession(token)
  if (!session) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  try {
    const cookies = await resolveSessionCookies(session, body?.cookieText)
    const list = await listConversations(cookies, {
      onProgress: (message) => logger.info(`[抖音续火] 会话拉取：${message}`),
    })
    sendJson(res, 200, { ok: true, list })
  } catch (error) {
    logger.error('[抖音续火] 拉取会话列表失败', error)
    sendJson(res, 400, { ok: false, message: error.message || '拉取会话列表失败。' })
  }
}

async function handleScanStart(token, res) {
  const session = getSession(token)
  if (!session) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  try {
    const result = await startScanSession(token)
    sendJson(res, 200, { ok: true, ...result })
  } catch (error) {
    logger.error('[抖音续火] 启动扫码登录失败', error)
    sendJson(res, 400, { ok: false, message: error.message || '启动扫码登录失败。' })
  }
}

async function handleScanRefresh(token, res) {
  const session = getSession(token)
  if (!session) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  try {
    const result = await startScanSession(token, { force: true })
    sendJson(res, 200, { ok: true, ...result })
  } catch (error) {
    logger.error('[抖音续火] 刷新扫码二维码失败', error)
    sendJson(res, 400, { ok: false, message: error.message || '刷新二维码失败。' })
  }
}

async function handleScanSms(token, body, res) {
  if (!getSession(token)) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  try {
    const scan = scanSessions.get(token)
    if (!scan) throw new Error('扫码会话不存在，请重新获取二维码。')
    const code = String(body?.code || '').trim()
    if (!/^\d{4,8}$/.test(code)) throw new Error('短信验证码应为 4 到 8 位数字。')
    submitScanSmsCode(scan, code)
    sendJson(res, 200, { ok: true, message: '验证码已提交，请等待登录结果。' })
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message || '提交短信验证码失败。' })
  }
}

async function handleScanStatus(token, res) {
  if (!getSession(token)) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  try {
    const result = await getScanStatus(token)
    sendJson(res, 200, { ok: true, ...result })
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message || '读取扫码状态失败。' })
  }
}

// ===== 扫码登录（纯 API，无浏览器）：移植自 jumpbyte-bot 的抖音 PC 客户端 passport 流程 =====

async function startScanSession(token, { force = false } = {}) {
  const current = scanSessions.get(token)
  if (!force && current && ['waiting', 'scanned', 'sms'].includes(current.status) && current.qr) {
    return { status: current.status, qr: current.qr, message: current.message }
  }
  await closeScanSession(token)
  const scan = new QrLoginSession()
  scan.status = 'waiting'
  scanSessions.set(token, scan)
  try {
    // start() 后台运行：ttwidCheck -> 取二维码 -> 轮询 check_qrconnect
    const qrPromise = (async () => {
      await scan.ttwidCheck()
      const qr = await scan.call('/passport/web/get_qrcode/', { next: 'https://www.douyin.com', need_logo: 'false', need_short_url: 'false' }, null)
      const data = qr?.data ?? {}
      if (!data.qrcode || Number(data.error_code) !== 0) {
        throw new Error(`获取二维码失败：${data.description || qr?.message || '未知错误'}`)
      }
      scan.qr = `data:image/png;base64,${data.qrcode}`
      scan.token = String(data.token)
      scan.expireAt = Number(data.expire_time) ? Number(data.expire_time) * 1000 : Date.now() + 180000
    })()
    await qrPromise
    scan.runLoop().catch((error) => {
      scan.status = 'error'
      scan.error = error.message || '扫码登录失败'
    })
    logger.info('[抖音续火] 扫码登录二维码已通过 API 获取')
    return { status: 'waiting', qr: scan.qr }
  } catch (error) {
    scan.status = 'error'
    scan.error = error.message
    await closeScanSession(token)
    throw error
  }
}

async function getScanStatus(token) {
  const scan = scanSessions.get(token)
  if (!scan) return { status: 'idle' }
  if (scan.status === 'error') {
    const message = scan.error || '扫码登录失败。'
    await closeScanSession(token)
    return { status: 'error', message }
  }
  if (scan.status === 'success') return { status: 'success', cookies: scan.cookies }
  if (scan.status === 'sms') return { status: 'sms', message: scan.message || '请输入短信验证码。' }
  if (scan.status === 'scanned') return { status: 'waiting', message: scan.message || '已扫码，请在抖音 App 上确认。' }
  return { status: 'waiting', message: scan.message || '' }
}

function submitScanSmsCode(scan, code) {
  if (!scan || typeof scan.submitSmsCode !== 'function') throw new Error('扫码会话不存在，请重新获取二维码。')
  if (scan.status !== 'sms') throw new Error('当前不在短信验证环节。')
  scan.submitSmsCode(String(code))
  logger.info('[抖音续火] 已提交短信验证码')
}

async function closeScanSession(token) {
  const scan = scanSessions.get(token)
  if (!scan) return
  scanSessions.delete(token)
  scan.cancel?.()
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
    return { name: '', messageTemplate: '', email, successEmailEnabled, cookieRequired: true, targets: [] }
  }
  const account = (await listAccounts(session.userId)).find((item) => item.id === session.accountId)
  if (!account) throw new Error('账号不存在')
  const targets = (await listTargets(account.id)).map((target) => ({
    secUid: target.secUid,
    nickname: target.nickname,
    uniqueId: target.uniqueId,
    avatar: target.avatar,
  }))
  return {
    name: account.name,
    messageTemplate: account.messageTemplate,
    email,
    successEmailEnabled,
    cookieRequired: false,
    targets,
  }
}

async function saveWebSetup(session, body) {
  if (!body || typeof body !== 'object') throw new Error('提交内容无效')
  const name = String(body.name || '').trim()
  if (!name || name.length > 40) throw new Error('账号名称不能为空且不能超过 40 个字符')

  const messageTemplate = String(body.messageTemplate || '').trim()
  validateTemplate(messageTemplate)
  const email = String(body.email || '').trim()
  if (email && !isValidEmail(email)) throw new Error('邮箱格式不正确')
  const successEmailEnabled = body.successEmailEnabled === true || body.successEmailEnabled === 'true'
  if (successEmailEnabled && !email) throw new Error('开启成功邮件通知前，请先填写收件邮箱')

  const cookieText = String(body.cookieText || '').trim()
  // 续火目标（网页点选）：{secUid, uid, nickname, conversationId, conversationShortId, ticket} 数组；非数组则视为未改动目标选择，不触碰现有目标
  const hasTargets = Array.isArray(body.targets)
  const targets = hasTargets
    ? body.targets
        .filter((item) => item && typeof item.secUid === 'string' && /^MS4w[\w-]{10,}$/.test(item.secUid))
        .map((item) => ({
          secUid: String(item.secUid),
          uid: String(item.uid || ''),
          nickname: String(item.nickname || '').slice(0, 60),
          uniqueId: String(item.uniqueId || '').slice(0, 60),
          avatar: String(item.avatar || '').slice(0, 500),
          conversationId: String(item.conversationId || ''),
          conversationShortId: String(item.conversationShortId || ''),
          ticket: String(item.ticket || ''),
        }))
    : []
  void targets
  let ignored = 0
  let accountId = session.accountId
  if (session.accountId === undefined) {
    if (!cookieText) throw new Error('请粘贴 Cookie JSON 或选择 .txt 文件')
    const parsed = parseCookies(cookieText)
    ignored = parsed.ignored
    accountId = await addAccount({ userId: session.userId, name, cookies: parsed.cookies, targetNames: [], messageTemplate })
  } else {
    const account = (await listAccounts(session.userId)).find((item) => item.id === session.accountId)
    if (!account) throw new Error('账号不存在，请重新发送修改命令')
    const parsed = cookieText ? parseCookies(cookieText) : { cookies: account.cookies, ignored: 0 }
    ignored = parsed.ignored
    await updateAccount({
      id: session.accountId,
      userId: session.userId,
      name,
      cookies: parsed.cookies,
      targetNames: account.targetNames ?? [],
      messageTemplate,
    })
  }
  if (hasTargets) await replaceTargets(accountId, targets)
  await setUserEmail(session.userId, email)
  await setUserSuccessEmailEnabled(session.userId, successEmailEnabled)
  return `${session.accountId === undefined ? '账号已添加' : '账号已更新'}${ignored ? `，已忽略 ${ignored} 条无法使用的 Cookie` : ''}${hasTargets ? `，已保存 ${targets.length} 个续火目标` : ''}。现在可以关闭此页面。`
}

function renderSetupPage(token, initial, editing) {
  const data = JSON.stringify(initial).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  const title = editing ? '修改抖音账号' : '添加抖音账号'
  return `<!doctype html>
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
    .targets { display: grid; gap: 8px; padding: 12px; border: 1px solid #d7dee8; border-radius: 5px; background: #f8fafc; font-size: 14px; }
    .conv-list { display: grid; gap: 4px; max-height: 280px; overflow-y: auto; }
    .conv-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid #e4eaf1; border-radius: 4px; background: #fff; font-weight: 400; }
    .conv-item input { width: 16px; height: 16px; }
    .conv-item .uid { color: #98a2b3; font-size: 11px; margin-left: auto; }
    .conv-item .avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: #e4eaf1; flex: none; }
    .scan-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .scan button { justify-self: start; }
    .qr { display: none; width: min(360px, 100%); max-height: 360px; object-fit: contain; border: 1px solid #d7dee8; background: #fff; }
    .sms { display: none; gap: 8px; grid-template-columns: minmax(0, 1fr) auto; }
    .sms input { min-width: 0; }
    #status { margin: 0; min-height: 20px; color: #b42318; font-size: 14px; }
    #status.ok { color: #087443; }
  </style>
</head>
<body>
  <main>
    <header><h1>${title}</h1></header>
    <form id="setup-form">
      <label>账号名称<input id="name" maxlength="40" required></label>
      <label>消息模板<textarea id="messageTemplate" placeholder="留空使用随机一言"></textarea></label>
      <div class="targets">
        <span class="hint">续火目标：点击下方按钮，通过接口读取私信会话里出现过的人，勾选后保存（按用户 ID 发送，对方改名不影响送达）。</span>
        <div class="scan-actions">
          <button id="loadConvs" type="button">拉取会话列表</button>
        </div>
        <span id="convStatus" class="hint">拉取需要 10 到 60 秒（含昵称查询），请耐心等待。</span>
        <div id="convList" class="conv-list"></div>
      </div>
      <label>失败通知邮箱<input id="email" type="email" placeholder="留空则不发送失败邮件"></label>
      <label class="check"><input id="successEmailEnabled" type="checkbox">续火成功时发送邮件通知</label>
      <label>Cookie 文本文件<input id="cookieFile" type="file" accept=".txt,text/plain"><span class="hint">选择后会读取到下方文本框，不会上传文件本身。</span></label>
      <div class="scan">
        <div class="scan-actions">
          <button id="scanLogin" type="button">扫码获取 Cookie</button>
          <button id="scanRefresh" type="button" disabled>刷新二维码</button>
        </div>
        <img id="scanQr" class="qr" alt="抖音登录二维码">
        <span id="scanStatus" class="hint">也可以直接粘贴 Cookie JSON 或选择 .txt 文件。</span>
        <div id="smsVerify" class="sms">
          <input id="smsCode" inputmode="numeric" autocomplete="one-time-code" placeholder="输入短信验证码">
          <button id="smsSubmit" type="button">提交验证码</button>
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
    const smsVerify = document.querySelector('#smsVerify');
    const smsCode = document.querySelector('#smsCode');
    const smsSubmit = document.querySelector('#smsSubmit');
    let scanTimer;
    for (const key of ['name', 'messageTemplate', 'email']) document.querySelector('#' + key).value = initial[key] || '';
    document.querySelector('#successEmailEnabled').checked = Boolean(initial.successEmailEnabled);

    // ===== 续火目标选择 =====
    const loadConvs = document.querySelector('#loadConvs');
    const convStatus = document.querySelector('#convStatus');
    const convList = document.querySelector('#convList');
    const knownTargets = new Map(); // secUid -> {secUid, uid, nickname, conversationId, conversationShortId, ticket, checked}
    function renderTargets() {
      convList.innerHTML = '';
      for (const target of knownTargets.values()) {
        const item = document.createElement('label');
        item.className = 'conv-item';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = target.checked;
        box.addEventListener('change', () => { target.checked = box.checked; });
        if (target.avatar) {
          const img = document.createElement('img');
          img.className = 'avatar';
          img.src = target.avatar;
          img.alt = '';
          img.loading = 'lazy';
          img.addEventListener('error', () => { img.style.display = 'none' });
          item.append(img);
        }
        const name = document.createElement('span');
        name.textContent = target.nickname || '（昵称未获取）';
        item.append(box, name);
        if (target.uniqueId) {
          const uid = document.createElement('span');
          uid.className = 'uid';
          uid.textContent = '抖音号: ' + target.uniqueId;
          item.append(uid);
        }
        convList.append(item);
      }
      const total = knownTargets.size;
      const chosen = [...knownTargets.values()].filter(item => item.checked).length;
      if (total > 0) convStatus.textContent = '共 ' + total + ' 人，已勾选 ' + chosen + ' 人；保存后生效。';
    }
    for (const target of initial.targets || []) {
      knownTargets.set(target.secUid, { ...target, checked: true });
    }
    renderTargets();
    loadConvs.addEventListener('click', async () => {
      loadConvs.disabled = true;
      convStatus.textContent = '正在通过接口拉取会话列表，可能需要 10 到 60 秒…';
      try {
        const response = await fetch('${webState.prefix}/api/conversations/${token}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookieText: document.querySelector('#cookieText').value }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.message || '拉取会话列表失败');
        let added = 0;
        for (const person of data.list || []) {
          if (!knownTargets.has(person.secUid)) {
            knownTargets.set(person.secUid, { ...person, checked: false });
            added += 1;
          }
        }
        renderTargets();
        convStatus.textContent = '拉取完成：会话共 ' + ((data.list || []).length) + ' 人，新增 ' + added + ' 人待勾选（已勾选的保持不变）。';
      } catch (error) {
        convStatus.textContent = error.message || '拉取会话列表失败';
      } finally {
        loadConvs.disabled = false;
      }
    });

    document.querySelector('#cookieFile').addEventListener('change', async event => {
      const file = event.target.files[0];
      if (!file) return;
      if (!/\\.txt$/i.test(file.name)) { status.textContent = '仅支持 .txt 文件。'; return; }
      if (file.size > 1024 * 1024) { status.textContent = '文件不能超过 1 MB。'; return; }
      document.querySelector('#cookieText').value = await file.text();
      status.textContent = '';
    });
    async function requestQr(endpoint, loadingText) {
      scanLogin.disabled = true;
      scanRefresh.disabled = true;
      smsVerify.style.display = 'none';
      smsCode.value = '';
      scanStatus.textContent = loadingText;
      try {
        const response = await fetch(endpoint, { method: 'POST' });
        const data = await response.json();
        if (!data.ok) throw new Error(data.message || '启动扫码登录失败');
        if (data.qr) { scanQr.src = data.qr; scanQr.style.display = 'block'; }
        scanStatus.textContent = '请使用抖音 App 扫码登录，二维码有效期以页面为准。';
        scanRefresh.disabled = false;
        clearInterval(scanTimer);
        scanTimer = setInterval(async () => {
          try {
            const result = await (await fetch('${webState.prefix}/api/scan/status/${token}', { cache: 'no-store' })).json();
            if (!result.ok) throw new Error(result.message || '读取扫码状态失败');
            if (result.status === 'success') {
              clearInterval(scanTimer);
              smsVerify.style.display = 'none';
              document.querySelector('#cookieText').value = JSON.stringify(result.cookies, null, 2);
              scanStatus.textContent = '扫码登录成功，Cookie 已填入下方文本框，请继续提交。';
              scanLogin.disabled = false;
              scanRefresh.disabled = false;
              scanLogin.textContent = '重新扫码';
            } else if (result.status === 'sms') {
              smsVerify.style.display = 'grid';
              scanStatus.textContent = result.message || '请输入短信验证码。';
            } else if (result.status === 'error') {
              throw new Error(result.message || '扫码登录失败');
            } else if (result.message) {
              scanStatus.textContent = result.message;
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
    scanLogin.addEventListener('click', () => requestQr('${webState.prefix}/api/scan/start/${token}', '正在打开抖音登录页...'));
    scanRefresh.addEventListener('click', () => requestQr('${webState.prefix}/api/scan/refresh/${token}', '正在刷新二维码...'));
    smsSubmit.addEventListener('click', async () => {
      const code = smsCode.value.trim();
      if (!/^\\d{4,8}$/.test(code)) { scanStatus.textContent = '请输入 4 到 8 位短信验证码。'; return; }
      smsSubmit.disabled = true;
      try {
        const response = await fetch('${webState.prefix}/api/scan/sms/${token}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
        const data = await response.json();
        if (!data.ok) throw new Error(data.message || '提交短信验证码失败');
        scanStatus.textContent = data.message || '验证码已提交，请等待登录结果。';
      } catch (error) {
        scanStatus.textContent = error.message || '提交短信验证码失败';
      } finally {
        smsSubmit.disabled = false;
      }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      clearInterval(scanTimer);
      status.className = ''; status.textContent = ''; submit.disabled = true;
      const payload = Object.fromEntries(new FormData(form));
      payload.name = document.querySelector('#name').value;
      payload.messageTemplate = document.querySelector('#messageTemplate').value;
      payload.targets = [...knownTargets.values()].filter(item => item.checked).map(({ checked, ...target }) => target);
      payload.email = document.querySelector('#email').value;
      payload.successEmailEnabled = document.querySelector('#successEmailEnabled').checked;
      payload.cookieText = document.querySelector('#cookieText').value;
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
