// 会话列表拉取：imapi get_message_by_init（protobuf，Cookie 鉴权），
// 从主收件箱（好友私信）1v1 会话的参与者中取对方 sec_uid/uid，供添加账号网页点选续火目标。
// 协议为 2026-09 抓包校正（cmd=2043），纯 API，无浏览器。
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

const GET_MESSAGE_BY_INIT_PATH = '/v1/message/get_message_by_init'
const MAX_PAGES = 10
const MAX_PROFILE_FETCH = 30
const PROFILE_CONCURRENCY = 5
const PAGE_INTERVAL_MS = 500

/** 并发池：limit 个 worker 消费 items，保持输入顺序返回结果 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await fn(items[current], current)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 从多页会话中提取「会话里出现过的人」。
 * 规则：仅保留 1v1 单聊（conversation_type=1 且 participants_count=2）；
 * 对方 = 参与者中 uid 不等于自己的那个（参与者信息里直接带 sec_uid）。
 * @param {Array} pages parseGetByUserInitResponse 返回的对象数组（多页合并）
 * @param {string} selfUid 自己的 uid；为空时无法判定对方侧，返回空列表
 * @returns {Array<{secUid: string, uid: string, conversationId: string, conversationShortId: string, ticket: string}>}
 */
export function extractPeople(pages, selfUid) {
  if (!selfUid) return []
  const people = new Map()
  for (const page of pages) {
    for (const conversation of page.conversations ?? []) {
      if (Number(conversation.conversationType) !== 1) continue
      if (Number(conversation.participantsCount || 0) !== 2) continue
      const peer = (conversation.participants ?? []).find((user) => user.uid && user.uid !== String(selfUid))
      if (!peer?.secUid) continue
      if (people.has(peer.secUid)) continue
      people.set(peer.secUid, {
        secUid: peer.secUid,
        uid: peer.uid,
        conversationId: conversation.conversationId,
        conversationShortId: conversation.conversationShortId,
        ticket: conversation.ticket,
      })
    }
  }
  return [...people.values()]
}

/**
 * 拉取账号会话列表中出现过的用户（昵称通过 profile 接口逐个补全）
 * @param {Array} cookies Cookie-Editor JSON 数组
 * @param {{ onProgress?: (msg: string) => void }} [options]
 * @returns {Promise<Array<{secUid: string, uid: string, nickname: string, conversationId: string, conversationShortId: string, ticket: string}>>}
 */
export async function listConversations(cookies, { onProgress } = {}) {
  const progress = onProgress || (() => {})
  const cookieHeader = buildCookieHeader(cookies)

  const pages = []
  let cursor = '0'
  let selfUid = ''
  for (let index = 0; index < MAX_PAGES; index += 1) {
    progress(`正在拉取会话列表（第 ${index + 1} 页）…`)
    const body = buildGetByUserInitBody({ cursor, sequenceId: 10001 + index })
    const bytes = await postImProtoRaw(GET_MESSAGE_BY_INIT_PATH, cookieHeader, body, '拉取会话列表')
    let parsed
    try {
      parsed = parseGetByUserInitResponse(bytes)
    } catch (error) {
      throw new DouyinApiError(`拉取会话列表失败：${error.message}`, { kind: 'api' })
    }
    if (parsed.selfUid) selfUid = parsed.selfUid
    pages.push(parsed)
    if (!parsed.hasMore || !parsed.nextCursor) break
    cursor = parsed.nextCursor
    if (index < MAX_PAGES - 1) await new Promise((resolve) => setTimeout(resolve, PAGE_INTERVAL_MS))
  }
  if (pages.length >= MAX_PAGES) progress(`已达 ${MAX_PAGES} 页上限，仅返回最近的部分会话`)

  if (!selfUid) selfUid = getSelfUidFromCookies(cookies)
  let people = extractPeople(pages, selfUid)
  if (people.length === 0) {
    throw new DouyinApiError('没有解析到可选择的 1v1 会话（该账号可能没有私信记录）', { kind: 'api' })
  }

  // 昵称补全：响应不含昵称，并发查 profile（默认 5 并发）；超上限的条目昵称留空（前端仅显示 ID）
  const profileFetchLimit = Number(getConfig().im?.profileFetchLimit) || MAX_PROFILE_FETCH
  progress(`已发现 ${people.length} 个会话用户，正在获取昵称（上限 ${profileFetchLimit} 人）…`)
  const webid = getCookieValue(cookies, 's_v_web_id')
  const uifid = getCookieValue(cookies, 'UIFID')
  const fetchTargets = people.slice(0, profileFetchLimit)
  await mapWithConcurrency(fetchTargets, PROFILE_CONCURRENCY, async (person) => {
    try {
      const profile = await fetchUserProfile(cookieHeader, person.secUid, { webid, uifid })
      person.nickname = profile.nickname
      if (profile.uid) person.uid = profile.uid
      if (profile.uniqueId) person.uniqueId = profile.uniqueId
      if (profile.avatar) person.avatar = profile.avatar
    } catch {
      person.nickname = ''
    }
  })
  people = people.map((person) => ({ ...person, nickname: person.nickname || '' }))
  return people
}
