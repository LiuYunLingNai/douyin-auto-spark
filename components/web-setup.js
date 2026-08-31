import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { getConfig } from './config.js'
import { addAccount, getUserNotificationSettings, listAccounts, setUserEmail, setUserSuccessEmailEnabled, updateAccount } from './database.js'
import { isValidEmail, parseCookies, parseTargetNames, validateTemplate } from './account-setup.js'

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
    expiresMinutes: minutes,
    url: new URL(`${webState.prefix}/setup/${token}`, getBaseUrl(config)).toString(),
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
  const scanStart = new RegExp(`^${webState.prefix}/api/scan/start/([a-f0-9]{64})$`).exec(url.pathname)
  const scanStatus = new RegExp(`^${webState.prefix}/api/scan/status/([a-f0-9]{64})$`).exec(url.pathname)
  if (req.method === 'GET' && page) return handleSetupPage(page[1], res)
  if (req.method === 'POST' && api) return handleSetupSubmit(api[1], await readJsonBody(req), res)
  if (req.method === 'POST' && scanStart) return handleScanStart(scanStart[1], res)
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
    sessions.delete(token)
    clearTimeout(session.expiryTimer)
    await closeScanSession(token)
    sendJson(res, 200, { ok: true, message })
  } catch (error) {
    session.submitting = false
    sendJson(res, 400, { ok: false, message: error.message || '提交失败，请检查输入。' })
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

async function handleScanStatus(token, res) {
  if (!getSession(token)) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  try {
    const result = await getScanStatus(token)
    sendJson(res, 200, { ok: true, ...result })
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message || '读取扫码状态失败。' })
  }
}

async function startScanSession(token) {
  const current = scanSessions.get(token)
  if (current?.status === 'waiting' && current.qr) return { status: current.status, qr: current.qr }

  await closeScanSession(token)
  const config = getConfig()
  let browser
  let context
  let page
  try {
    browser = await chromium.launch({
      headless: config.browser?.headless !== false,
      ...(config.browser?.executablePath ? { executablePath: config.browser.executablePath } : {}),
    })
    context = await browser.newContext()
    page = await context.newPage()
  } catch (error) {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    throw error
  }
  const scan = { browser, context, page, status: 'waiting', qr: '', cookies: undefined, error: undefined, startedAt: Date.now() }
  scanSessions.set(token, scan)
  try {
    await page.goto('https://www.douyin.com/chat', { waitUntil: 'domcontentloaded', timeout: 30000 })
    scan.qr = await captureDouyinQr(page)
    return { status: scan.status, qr: scan.qr }
  } catch (error) {
    scan.status = 'error'
    scan.error = error.message
    await closeScanSession(token)
    throw error
  }
}

async function captureDouyinQr(page) {
  // 聊天页未登录时会直接显示扫码登录弹窗，二维码通常以内联 data URL 提供。
  const qr = page.locator('img[aria-label="二维码"], img[alt="二维码"], img[src^="data:image"]')
  let count = 0
  for (let attempt = 0; attempt < 30; attempt += 1) {
    count = await qr.count()
    if (count > 0) break
    await page.waitForTimeout(500)
  }
  if (count === 0) {
    const bodyText = await page.locator('body').innerText({ timeoutMs: 5000 }).catch(() => '')
    if (/验证码|安全验证|访问验证/.test(bodyText)) {
      throw new Error('抖音当前要求完成安全验证，暂时无法获取登录二维码。请稍后重试或使用 Cookie 文本文件。')
    }
    throw new Error('未找到抖音登录二维码，请确认浏览器可以正常访问 www.douyin.com/chat。')
  }

  const info = await qr.first().evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      src: element.currentSrc || element.getAttribute('src') || '',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  })
  if (info.src.startsWith('data:image/')) return info.src

  const margin = 16
  const clip = {
    x: Math.max(0, info.rect.x - margin),
    y: Math.max(0, info.rect.y - margin),
    width: info.rect.width + margin * 2,
    height: info.rect.height + margin * 2,
  }
  const image = await page.screenshot({ type: 'png', clip })
  return `data:image/png;base64,${image.toString('base64')}`
}

async function getScanStatus(token) {
  const scan = scanSessions.get(token)
  if (!scan) return { status: 'idle' }
  if (scan.status === 'waiting') {
    try {
      const cookies = await scan.context.cookies('https://www.douyin.com')
      // 未登录页面也可能存在 csrf 或空 session Cookie，只把真实的非空会话 Cookie 视为登录成功。
      const loggedIn = cookies.some((cookie) =>
        ['sessionid', 'sessionid_ss'].includes(cookie.name)
        && typeof cookie.value === 'string'
        && cookie.value.trim().length >= 8,
      )
      if (loggedIn) {
        scan.cookies = cookies
        scan.status = 'success'
        await closeScanBrowser(scan)
      }
    } catch (error) {
      scan.status = 'error'
      scan.error = error.message || '读取登录状态失败。'
    }
  }
  if (scan.status === 'error') {
    const message = scan.error || '扫码登录失败。'
    await closeScanSession(token)
    return { status: 'error', message }
  }
  if (scan.status === 'success') return { status: 'success', cookies: scan.cookies }
  return { status: 'waiting' }
}

async function closeScanSession(token) {
  const scan = scanSessions.get(token)
  if (!scan) return
  scanSessions.delete(token)
  await closeScanBrowser(scan)
}

async function closeScanBrowser(scan) {
  const context = scan.context
  const browser = scan.browser
  scan.context = undefined
  scan.browser = undefined
  scan.page = undefined
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
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
  if (session.accountId === undefined) {
    if (!cookieText) throw new Error('请粘贴 Cookie JSON 或选择 .txt 文件')
    const parsed = parseCookies(cookieText)
    ignored = parsed.ignored
    await addAccount({ userId: session.userId, name, cookies: parsed.cookies, targetNames, messageTemplate })
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
      targetNames,
      messageTemplate,
    })
  }
  await setUserEmail(session.userId, email)
  await setUserSuccessEmailEnabled(session.userId, successEmailEnabled)
  return `${session.accountId === undefined ? '账号已添加' : '账号已更新'}${ignored ? `，已忽略 ${ignored} 条无法使用的 Cookie` : ''}。现在可以关闭此页面。`
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
    .scan button { justify-self: start; }
    .qr { display: none; width: min(360px, 100%); max-height: 360px; object-fit: contain; border: 1px solid #d7dee8; background: #fff; }
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
      <label>消息模板<textarea id="messageTemplate" placeholder="留空使用随机一言"></textarea></label>
      <label>失败通知邮箱<input id="email" type="email" placeholder="留空则不发送失败邮件"></label>
      <label class="check"><input id="successEmailEnabled" type="checkbox">续火成功时发送邮件通知</label>
      <label>Cookie 文本文件<input id="cookieFile" type="file" accept=".txt,text/plain"><span class="hint">选择后会读取到下方文本框，不会上传文件本身。</span></label>
      <div class="scan">
        <button id="scanLogin" type="button">扫码获取 Cookie</button>
        <img id="scanQr" class="qr" alt="抖音登录二维码">
        <span id="scanStatus" class="hint">也可以直接粘贴 Cookie JSON 或选择 .txt 文件。</span>
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
    const scanQr = document.querySelector('#scanQr');
    const scanStatus = document.querySelector('#scanStatus');
    let scanTimer;
    for (const key of ['name', 'targetNames', 'messageTemplate', 'email']) document.querySelector('#' + key).value = initial[key] || '';
    document.querySelector('#successEmailEnabled').checked = Boolean(initial.successEmailEnabled);
    document.querySelector('#cookieFile').addEventListener('change', async event => {
      const file = event.target.files[0];
      if (!file) return;
      if (!/\\.txt$/i.test(file.name)) { status.textContent = '仅支持 .txt 文件。'; return; }
      if (file.size > 1024 * 1024) { status.textContent = '文件不能超过 1 MB。'; return; }
      document.querySelector('#cookieText').value = await file.text();
      status.textContent = '';
    });
    scanLogin.addEventListener('click', async () => {
      scanLogin.disabled = true;
      scanStatus.textContent = '正在打开抖音登录页...';
      try {
        const response = await fetch('${webState.prefix}/api/scan/start/${token}', { method: 'POST' });
        const data = await response.json();
        if (!data.ok) throw new Error(data.message || '启动扫码登录失败');
        if (data.qr) { scanQr.src = data.qr; scanQr.style.display = 'block'; }
        scanStatus.textContent = '请使用抖音 App 扫码登录，二维码有效期以页面为准。';
        clearInterval(scanTimer);
        scanTimer = setInterval(async () => {
          try {
            const result = await (await fetch('${webState.prefix}/api/scan/status/${token}', { cache: 'no-store' })).json();
            if (!result.ok) throw new Error(result.message || '读取扫码状态失败');
            if (result.status === 'success') {
              clearInterval(scanTimer);
              document.querySelector('#cookieText').value = JSON.stringify(result.cookies, null, 2);
              scanStatus.textContent = '扫码登录成功，Cookie 已填入下方文本框，请继续提交。';
              scanLogin.disabled = false;
              scanLogin.textContent = '重新扫码';
            } else if (result.status === 'error') {
              throw new Error(result.message || '扫码登录失败');
            }
          } catch (error) {
            clearInterval(scanTimer);
            scanStatus.textContent = error.message || '读取扫码状态失败';
            scanLogin.disabled = false;
          }
        }, 2000);
      } catch (error) {
        scanStatus.textContent = error.message || '启动扫码登录失败';
        scanLogin.disabled = false;
      }
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
