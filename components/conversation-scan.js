// 会话列表扫描：带 Cookie 打开抖音聊天页，从页面内容和网络响应中提取出现过的用户 sec_uid，
// 再通过 profile 接口补全昵称/uid。仅用于「选择续火目标」，发送消息仍走 API。
import { chromium } from 'playwright'
import { getBrowserLaunchOptions } from './config.js'
import { DouyinApiError, buildCookieHeader, fetchUserProfile, getCookieValue } from './douyin-api.js'

const SEC_UID_RE = /MS4w[\w-]{10,}/g
const MAX_SCAN_SEC_UIDS = 50
const MAX_PROFILE_FETCH = 30

/** Cookie-Editor JSON -> Playwright cookie（与旧插件 runner 一致的字段映射） */
export function toPlaywrightCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    expires: cookie.session ? -1 : (cookie.expirationDate ?? -1),
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: cookie.sameSite === 'no_restriction' ? 'None' : 'Lax',
  }
}

function collectSecUids(text, sink) {
  if (typeof text !== 'string' || !text.includes('MS4w')) return
  for (const match of text.matchAll(SEC_UID_RE)) sink.add(match[0])
}

/**
 * 扫描账号会话列表中出现过的用户
 * @param {Array} cookies Cookie-Editor JSON 数组
 * @param {{ limit?: number, onProgress?: (msg: string) => void }} [options]
 * @returns {Promise<Array<{ secUid: string, uid: string, nickname: string }>>}
 */
export async function scanConversations(cookies, { limit = MAX_PROFILE_FETCH, onProgress } = {}) {
  const progress = onProgress || (() => {})
  const secUids = new Set()

  const browser = await chromium.launch(getBrowserLaunchOptions())
  const context = await browser.newContext()
  let page
  try {
    await context.addCookies(cookies.map(toPlaywrightCookie))
    page = await context.newPage()

    // 拦截聊天页自身发起的响应，响应体里包含会话用户的 sec_uid（protobuf/JSON 均为明文 ASCII 片段）
    page.on('response', (response) => {
      if (secUids.size >= MAX_SCAN_SEC_UIDS) return
      const url = response.url()
      if (!url.includes('douyin.com')) return
      response.body()
        .then((body) => collectSecUids(body.toString('latin1'), secUids))
        .catch(() => {})
    })

    progress('正在打开抖音聊天页…')
    await page.goto('https://www.douyin.com/chat', { waitUntil: 'domcontentloaded', timeout: 30000 })

    const searchInput = page.locator('input.semi-input[placeholder="搜索"]').first()
    const loggedIn = await searchInput.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)
    if (!loggedIn) throw new DouyinApiError('聊天页加载失败，Cookie 可能已失效', { kind: 'auth' })

    // 等待会话列表渲染，并滚动加载更多会话
    progress('正在读取会话列表…')
    await page.locator('[class*="conversation"], [class*="Conversation"]').first()
      .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, 2000).catch(() => {})
      await page.waitForTimeout(1200)
    }

    // 页面渲染内容里也可能直接带 sec_uid
    collectSecUids(await page.content(), secUids)
    progress(`已发现 ${secUids.size} 个用户 ID，正在获取昵称…`)
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }

  if (secUids.size === 0) {
    throw new DouyinApiError('没有从聊天页扫描到任何用户 ID，请先确认该账号在抖音上有过私信会话', { kind: 'api' })
  }

  // 逐个补全昵称（失败保留 ID，仍可选择）
  const cookieHeader = buildCookieHeader(cookies)
  const webid = getCookieValue(cookies, 's_v_web_id')
  const uifid = getCookieValue(cookies, 'UIFID')
  const results = []
  for (const secUid of [...secUids].slice(0, limit)) {
    try {
      const profile = await fetchUserProfile(cookieHeader, secUid, { webid, uifid })
      results.push({ secUid, uid: profile.uid, nickname: profile.nickname })
    } catch {
      results.push({ secUid, uid: '', nickname: '' })
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return results
}
