// 抖音 Web API 核心接口封装
// 参考实现：Rockedw/douyin-web-api-sdk（Java）/ ShilongLee-Crawler（签名）
// 注意：所有接口均为逆向所得，抖音风控升级后可能需要更新签名文件或请求模板
import { genMsToken, genVerifyFp, signABogus } from './abogus.js'
import { buildCreateConversationBody, buildTextMessageBody, parseImResponse } from './im-proto.js'

// 与 IM 请求模板内嵌指纹保持一致的 UA（模板 headers 里的 user_agent 也是它）
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

const IMAPI_BASE = 'https://imapi.douyin.com'
const PROFILE_API = 'https://www.douyin.com/aweme/v1/web/user/profile/other/'
const REQUEST_TIMEOUT_MS = 20000

export class DouyinApiError extends Error {
  constructor(message, { kind = 'unknown', statusCode, statusMsg } = {}) {
    super(message)
    this.name = 'DouyinApiError'
    this.kind = kind // 'auth' | 'risk' | 'network' | 'api' | 'parse'
    this.statusCode = statusCode
    this.statusMsg = statusMsg
  }
}

/** Cookie-Editor JSON 数组 -> douyin.com 域名的 cookie 字符串 */
export function buildCookieHeader(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new DouyinApiError('Cookie 数据为空', { kind: 'auth' })
  }
  const pairs = []
  for (const cookie of cookies) {
    if (!cookie?.name || cookie.value === undefined) continue
    const domain = String(cookie.domain || '')
    if (!domain.includes('douyin.com')) continue
    pairs.push(`${cookie.name}=${cookie.value}`)
  }
  if (!pairs.length) throw new DouyinApiError('Cookie 中没有 douyin.com 域名的条目', { kind: 'auth' })
  return pairs.join('; ')
}

/** 从 Cookie 中取指定 name 的值 */
export function getCookieValue(cookies, name) {
  const found = cookies.find((cookie) => cookie?.name === name)
  return found ? String(found.value) : ''
}

// 注意：Cookie 里的 uid_tt 不是 uid 的十六进制（实测转换结果是乱码数字），
// 自己的 uid 只能从 get_message_by_init 响应（field 13）或会话 ID 推断，见 conversation-api.js

function imHeaders(cookieHeader) {
  return {
    cookie: cookieHeader,
    accept: 'application/x-protobuf',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cache-control': 'no-cache',
    origin: 'https://www.douyin.com',
    'content-type': 'application/x-protobuf',
    pragma: 'no-cache',
    referer: 'https://www.douyin.com/',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': USER_AGENT,
  }
}

function assertHttpOk(response, action) {
  if (response.status === 401 || response.status === 403) {
    throw new DouyinApiError(`${action}：认证失败（HTTP ${response.status}），Cookie 可能已失效`, { kind: 'auth', statusCode: response.status })
  }
  if (response.status === 429) {
    throw new DouyinApiError(`${action}：请求频率超限（HTTP 429），请稍后重试`, { kind: 'risk', statusCode: 429 })
  }
  if (!response.ok) {
    throw new DouyinApiError(`${action}：HTTP 请求失败，状态码 ${response.status}`, { kind: 'network', statusCode: response.status })
  }
}

export async function postImProto(path, cookieHeader, body, action, { signed = true } = {}) {
  const bytes = await postImProtoRaw(path, cookieHeader, body, action, { signed })
  let parsed
  try {
    parsed = parseImResponse(bytes)
  } catch (error) {
    throw new DouyinApiError(`${action}：响应解析失败（${error.message}）`, { kind: 'parse' })
  }
  if (parsed.statusMessage !== 'OK') {
    const extraCode = parsed.extraInfo?.status_code
    const detail = parsed.extraInfo?.status_message || parsed.statusMessage || '未知错误'
    // 8101/7174 在参考实现中被视为可容忍状态
    const tolerated = [8101, 7174].includes(Number(extraCode))
    if (!tolerated) {
      const kind = /登录|登录态|session/i.test(detail) ? 'auth' : 'api'
      throw new DouyinApiError(`${action}：${detail}${extraCode !== undefined ? `（状态码 ${extraCode}）` : ''}`, { kind, statusCode: extraCode, statusMsg: detail })
    }
  }
  return parsed
}

/**
 * 发送 imapi protobuf 请求并返回原始字节（调用方按各自接口结构解析）。
 * 与 postImProto 的区别：不做 message/send 语义的响应解析。
 * @returns {Promise<Buffer>}
 */
export async function postImProtoRaw(path, cookieHeader, body, action, { signed = false } = {}) {
  let url = `${IMAPI_BASE}${path}`
  if (signed) {
    const msToken = genMsToken()
    const fp = genVerifyFp()
    const query = `msToken=${encodeURIComponent(msToken)}&verifyFp=${encodeURIComponent(fp)}&fp=${encodeURIComponent(fp)}`
    url += `?${query}&a_bogus=${encodeURIComponent(signABogus(query, USER_AGENT))}`
  }
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: imHeaders(cookieHeader),
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new DouyinApiError(`${action}：网络请求异常（${error.message}）`, { kind: 'network' })
  }
  assertHttpOk(response, action)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * 从分享文本/链接中解析用户 sec_uid
 * 支持：分享口令中的 v.douyin.com 短链、douyin.com/user/MS4w... 直链、iesdouyin.com/share/user 链接
 * @param {string} text
 * @returns {Promise<string>} sec_uid
 */
export async function resolveShareLink(text) {
  const input = String(text || '').trim()
  // 直接是完整链接的情况
  const direct = input.match(/(?:www\.douyin\.com|www\.iesdouyin\.com)\/(?:share\/)?user\/(MS4w[\w-]+)/)
    || input.match(/[?&]sec_uid=(MS4w[\w-]+)/)
  if (direct) return direct[1]

  const shortMatch = input.match(/https?:\/\/v\.douyin\.com\/[\w-]+\/?/i)
  if (!shortMatch) {
    throw new DouyinApiError('未识别到有效的抖音链接，请发送包含 v.douyin.com 短链的分享口令或用户主页链接', { kind: 'parse' })
  }

  // 手动跟随重定向链，逐跳检查 sec_uid
  let url = shortMatch[0]
  for (let hop = 0; hop < 5; hop += 1) {
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new DouyinApiError(`解析分享链接失败：网络异常（${error.message}）`, { kind: 'network' })
    }
    const location = response.headers.get('location')
    if (!location) break
    const next = location.startsWith('http') ? location : new URL(location, url).toString()
    const found = next.match(/\/user\/(MS4w[\w-]+)/) || next.match(/[?&]sec_uid=(MS4w[\w-]+)/)
    if (found) return found[1]
    url = next
  }
  throw new DouyinApiError('未能从分享链接解析出用户 ID（sec_uid），该链接可能不是用户主页分享', { kind: 'parse' })
}

/**
 * 通过 sec_uid 获取用户信息（uid / 昵称）
 * @param {string} cookieHeader
 * @param {string} secUid
 * @param {{ webid?: string, uifid?: string }} [extra]
 * @returns {Promise<{ uid: string, secUid: string, nickname: string, uniqueId: string, avatar: string }>}
 */
export async function fetchUserProfile(cookieHeader, secUid, { webid = '', uifid = '' } = {}) {
  if (!secUid || secUid.length < 10 || secUid.length > 100) {
    throw new DouyinApiError('sec_uid 格式无效', { kind: 'parse' })
  }
  const msToken = genMsToken()
  const fp = genVerifyFp()
  // 参数顺序固定，签名对顺序敏感（a_bogus 计算的是这个字符串本身，顺序一致即可）
  const pairs = [
    ['device_platform', 'webapp'], ['aid', '6383'], ['channel', 'channel_pc_web'],
    ['publish_video_strategy_type', '2'], ['source', 'channel_pc_web'],
    ['sec_user_id', secUid], ['personal_center_strategy', '1'], ['profile_other_record_enable', '1'],
    ['land_to', '1'], ['update_version_code', '170400'], ['pc_client_type', '1'],
    ['pc_libra_divert', 'Mac'], ['support_h265', '1'], ['support_dash', '1'],
    ['cpu_core_num', '8'], ['version_code', '170400'], ['version_name', '17.4.0'],
    ['cookie_enabled', 'true'], ['screen_width', '3440'], ['screen_height', '1440'],
    ['browser_language', 'zh-CN'], ['browser_platform', 'MacIntel'], ['browser_name', 'Chrome'],
    ['browser_version', '139.0.0.0'], ['browser_online', 'true'], ['engine_name', 'Blink'],
    ['engine_version', '139.0.0.0'], ['os_name', 'Mac OS'], ['os_version', '10.15.7'],
    ['device_memory', '8'], ['platform', 'PC'], ['downlink', '10'],
    ['effective_type', '4g'], ['round_trip_time', '50'],
  ]
  if (webid) pairs.push(['webid', webid])
  if (uifid) pairs.push(['uifid', uifid])
  pairs.push(['verifyFp', fp], ['fp', fp], ['msToken', msToken])
  const query = pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  const url = `${PROFILE_API}?${query}&a_bogus=${encodeURIComponent(signABogus(query, USER_AGENT))}`

  let response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        cookie: cookieHeader,
        referer: `https://www.douyin.com/user/${secUid}?from_tab_name=main`,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new DouyinApiError(`获取用户信息：网络请求异常（${error.message}）`, { kind: 'network' })
  }
  assertHttpOk(response, '获取用户信息')
  let json
  try {
    json = await response.json()
  } catch {
    throw new DouyinApiError('获取用户信息：响应不是有效 JSON，可能触发风控验证', { kind: 'risk' })
  }
  if (json.status_code !== 0) {
    const msg = json.status_msg || `状态码 ${json.status_code}`
    const kind = /登录|登录态/.test(msg) ? 'auth' : 'api'
    throw new DouyinApiError(`获取用户信息失败：${msg}`, { kind, statusCode: json.status_code, statusMsg: msg })
  }
  const user = json.user
  if (!user?.uid) throw new DouyinApiError('获取用户信息失败：响应中没有用户数据', { kind: 'api' })
  return {
    uid: String(user.uid),
    secUid,
    nickname: String(user.nickname || ''),
    // 抖音号（用户可见的短 ID，如 douyin123）；未设置时回落 short_id
    uniqueId: String(user.unique_id || user.short_id || ''),
    avatar: String(user.avatar_larger?.url_list?.[0] || user.avatar_thumb?.url_list?.[0] || ''),
  }
}

/**
 * 创建/获取与对方的私信会话
 * @param {string} cookieHeader
 * @param {{ receiverUid: string, senderUid?: string, templateB64?: string }} options
 * @returns {Promise<{ conversationId: string, conversationShortId: string, selfUid: string }>}
 */
export async function createConversation(cookieHeader, { receiverUid, senderUid, templateB64 } = {}) {
  const body = buildCreateConversationBody({ receiverUid, senderUid, templateB64 })
  // 参考实现创建会话时不带签名参数
  const parsed = await postImProto('/v2/conversation/create', cookieHeader, body, '创建会话', { signed: false })
  if (!parsed.conversationId) {
    throw new DouyinApiError('创建会话失败：响应中没有会话 ID', { kind: 'api' })
  }
  return {
    conversationId: parsed.conversationId,
    conversationShortId: parsed.conversationShortId,
    selfUid: parsed.selfUid,
  }
}

/**
 * 发送文本私信
 * @param {string} cookieHeader
 * @param {{ conversationId: string, conversationShortId: string, text: string, templateB64?: string }} options
 * @returns {Promise<{ requestId: string }>}
 */
export async function sendTextMessage(cookieHeader, { conversationId, conversationShortId, text, templateB64 } = {}) {
  const clientMessageId = crypto.randomUUID()
  const body = buildTextMessageBody({ conversationId, conversationShortId, text, clientMessageId, templateB64 })
  const parsed = await postImProto('/v1/message/send', cookieHeader, body, '发送私信')
  return { requestId: parsed.requestId }
}

/** 账号间/目标间随机延时（秒） */
export function randomDelay(minSec, maxSec) {
  const ms = (minSec + Math.random() * Math.max(0, maxSec - minSec)) * 1000
  return new Promise((resolve) => setTimeout(resolve, ms))
}
