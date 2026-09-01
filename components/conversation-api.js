// 会话列表拉取：imapi get_by_user_init（protobuf，Cookie 鉴权），从 1v1 会话与消息中
// 反查对方 sec_uid/uid，供添加账号网页点选续火目标。纯 API，无浏览器。
import { getConfig } from './config.js'
import {
  DouyinApiError,
  buildCookieHeader,
  fetchUserProfile,
  getCookieValue,
  getSelfUidFromCookies,
  postImProtoRaw,
} from './douyin-api.js'
import { buildGetByUserInitBody, parseGetByUserInitResponse } from './im-proto.js'

const GET_BY_USER_INIT_PATH = '/v2/message/get_by_user_init'
const MAX_PAGES = 10
const PAGE_SIZE = 20
const MAX_PROFILE_FETCH = 30
const PAGE_INTERVAL_MS = 500
const PROFILE_INTERVAL_MS = 400

/**
 * 从多页解析结果中提取"会话里出现过的人"。
 * 规则：仅保留 1v1 会话（conversation_type=1 且 participants_count=2）；
 * 对方 sec_uid 取该会话中对方发来的最新一条消息的 sec_sender；
 * 对方 uid 从 conversation_id（0:1:uidA:uidB）中排除自己后取另一侧。
 * @param {Array} pages parseGetByUserInitResponse 返回的对象数组（多页合并）
 * @param {string} selfUid 自己的 uid；为空时无法判定对方侧，返回空列表
 * @returns {Array<{secUid: string, uid: string, conversationId: string, conversationShortId: string, ticket: string, lastMessageTime: string}>}
 */
export function extractPeople(pages, selfUid) {
  if (!selfUid) return []
  const conversations = new Map()
  const latestByConversation = new Map() // 任意最新消息（取时间）
  const latestByPeer = new Map() // 对方发来的最新消息（取 sec_sender）
  for (const page of pages) {
    for (const conversation of page.conversations ?? []) {
      if (Number(conversation.conversationType) !== 1) continue
      if (Number(conversation.participantsCount || 0) !== 2) continue
      conversations.set(conversation.conversationId, conversation)
    }
    for (const message of page.messages ?? []) {
      const prevAny = latestByConversation.get(message.conversationId)
      if (!prevAny || Number(message.createTime) >= Number(prevAny.createTime)) {
        latestByConversation.set(message.conversationId, message)
      }
      if (String(message.sender) === String(selfUid)) continue
      const prevPeer = latestByPeer.get(message.conversationId)
      if (!prevPeer || Number(message.createTime) >= Number(prevPeer.createTime)) {
        latestByPeer.set(message.conversationId, message)
      }
    }
  }

  const people = []
  for (const [conversationId, conversation] of conversations) {
    const peerMessage = latestByPeer.get(conversationId)
    if (!peerMessage?.secSender) continue // 对方从未发过消息，拿不到 sec_uid
    const segments = String(conversationId).split(':')
    if (segments.length < 4) continue
    const peerUid = segments.slice(2).find((uid) => uid && uid !== String(selfUid))
    if (!peerUid) continue
    people.push({
      secUid: peerMessage.secSender,
      uid: peerUid,
      conversationId,
      conversationShortId: String(conversation.conversationShortId),
      ticket: String(conversation.ticket || ''),
      lastMessageTime: String(latestByConversation.get(conversationId)?.createTime || peerMessage.createTime),
    })
  }
  people.sort((a, b) => Number(b.lastMessageTime) - Number(a.lastMessageTime))
  return people
}

/**
 * 拉取账号会话列表中出现过的用户（昵称通过 profile 接口逐个补全）
 * @param {Array} cookies Cookie-Editor JSON 数组
 * @param {{ onProgress?: (msg: string) => void }} [options]
 * @returns {Promise<Array<{secUid: string, uid: string, nickname: string, conversationId: string, conversationShortId: string, ticket: string, lastMessageTime: string}>>}
 */
export async function listConversations(cookies, { onProgress } = {}) {
  const progress = onProgress || (() => {})
  const cookieHeader = buildCookieHeader(cookies)
  const templateB64 = getConfig().im?.getByUserInitTemplateB64 || undefined

  const pages = []
  let cursor = '0'
  for (let index = 0; index < MAX_PAGES; index += 1) {
    progress(`正在拉取会话列表（第 ${index + 1} 页）…`)
    const body = buildGetByUserInitBody({ cursor, count: PAGE_SIZE, templateB64 })
    const bytes = await postImProtoRaw(GET_BY_USER_INIT_PATH, cookieHeader, body, '拉取会话列表')
    let parsed
    try {
      parsed = parseGetByUserInitResponse(bytes)
    } catch (error) {
      throw new DouyinApiError(
        `拉取会话列表失败：${error.message}。若持续失败，会话列表协议可能已更新，请按 README 抓包更新 im.getByUserInitTemplateB64`,
        { kind: 'api' },
      )
    }
    if ((parsed.conversations.length === 0) && (parsed.messages.length === 0) && index === 0) {
      throw new DouyinApiError('会话列表响应为空，协议字段可能已变更，请按 README 抓包更新 im.getByUserInitTemplateB64', { kind: 'api' })
    }
    pages.push(parsed)
    if (!parsed.hasMore || !parsed.perUserCursor) break
    cursor = parsed.perUserCursor
    if (index < MAX_PAGES - 1) await new Promise((resolve) => setTimeout(resolve, PAGE_INTERVAL_MS))
  }
  if (pages.length >= MAX_PAGES) progress(`已达 ${MAX_PAGES} 页上限，仅返回最近的部分会话`)

  const selfUid = pages.find((page) => page.selfUid)?.selfUid || getSelfUidFromCookies(cookies)
  let people = extractPeople(pages, selfUid)
  if (people.length === 0) {
    throw new DouyinApiError('没有解析到可选择的会话（该账号可能无私信记录，或协议字段已变更）', { kind: 'api' })
  }

  // 昵称补全：响应不含昵称，逐个查 profile；超上限的条目昵称留空（前端显示 ID 短版）
  progress(`已发现 ${people.length} 个会话用户，正在获取昵称…`)
  const webid = getCookieValue(cookies, 's_v_web_id')
  const uifid = getCookieValue(cookies, 'UIFID')
  for (const [index, person] of people.entries()) {
    if (index >= MAX_PROFILE_FETCH) break
    try {
      const profile = await fetchUserProfile(cookieHeader, person.secUid, { webid, uifid })
      person.nickname = profile.nickname
      if (profile.uid) person.uid = profile.uid
    } catch {
      person.nickname = ''
    }
    await new Promise((resolve) => setTimeout(resolve, PROFILE_INTERVAL_MS))
  }
  people = people.map((person) => ({ ...person, nickname: person.nickname || '' }))
  return people
}
