import { listAccounts } from './database.js'
import { getBot, closeBot, formatSdkError } from './douyin.js'
import { validateEmojiValue, validateImageSource } from './message-template.js'
import { randomBytes } from 'node:crypto'

const readingAccounts = new Set()

export function emojiQuery(input = {}) {
  const kind = input.kind || 'small'
  const cursor = Number(input.cursor || 0)
  if (kind !== 'small' || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('目前仅支持读取小表情')
  return { kind, cursor }
}

export function normalizeEmojiPage(page, kind, cursor = 0) {
  const items = [], seen = new Set()
  let skipped = 0
  for (const row of page) {
    const images = [{ urls: row.urls }]
    let value, url
    for (const image of images) {
      for (const candidate of image.urls || []) {
        try {
          validateImageSource(candidate)
          if (candidate.startsWith('local:')) continue
          value = row.id
          validateEmojiValue(value, 'small')
          url = candidate
          break
        } catch {}
      }
      if (url) break
    }
    // 没有对应图片的条目不进入选择器，避免用户只看到资源 ID。
    if (!url) { skipped += 1; continue }
    if (seen.has(value)) continue
    seen.add(value)
    items.push({ value, url, name: String(row.name || row.id).slice(0, 200), kind: 'small' })
  }
  return { items, cursor, nextCursor: 0, done: true, skipped }
}

export async function fetchTemplateEmojis(bot, options) {
  const { kind, cursor } = emojiQuery(options)
  const page = await bot.media.emojiList()
  return normalizeEmojiPage(page, kind, cursor)
}

/** 模板管理员选择已保存账号读取资源；不向浏览器下发 Cookie。 */
export async function templateEmojiAccounts(userId) {
  return (await listAccounts(userId)).filter(account => !account.invalid && account.cookies?.length).map(account => ({ id: account.id, name: account.name }))
}

export async function withTemplateEmojiAccount(account, options) {
  emojiQuery(options)
  const id = `template-emoji:${randomBytes(12).toString('hex')}`
  try { return await fetchTemplateEmojis(await getBot({ ...account, id }), options) }
  catch (error) {
    throw new Error(`读取抖音小表情失败：${formatSdkError(error)}`, { cause: error })
  }
  finally { closeBot(id) }
}

export async function readAccountTemplateEmojis(accountId, options, userId) {
  emojiQuery(options)
  const account = (await listAccounts(userId)).find(item => item.id === Number(accountId))
  if (!account || account.invalid) throw new Error('请先选择一个可用的抖音账号')
  if (readingAccounts.has(account.id)) throw new Error('这个账号正在读取表情，请稍候')
  readingAccounts.add(account.id)
  try { return await withTemplateEmojiAccount(account, options) }
  finally { readingAccounts.delete(account.id) }
}
