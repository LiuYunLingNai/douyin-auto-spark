import { imageInput } from './template-images.js'
import { groupMessageParts } from './message-template.js'

/** 每个账号本轮共用上传结果；不同账号不复用媒体资产。逐条确认并统计已提交消息。 */
export async function sendTemplateMessages(bot, chatId, parts, imageCache = new Map(), onSent = () => {}) {
  const groups = groupMessageParts(parts)
  if (!groups.length) throw new Error('消息模板没有可发送的内容')
  for (const part of groups) {
    let body
    if (part.type === 'image') {
      if (!imageCache.has(part.source)) {
        const upload = imageInput(part.source).then(input => bot.media.image(input))
        imageCache.set(part.source, upload)
        upload.catch(() => { if (imageCache.get(part.source) === upload) imageCache.delete(part.source) })
      }
      body = { type: 'image', image: await imageCache.get(part.source) }
    } else {
      let catalog
      if (part.parts.some(item => item.type === 'emoji')) {
        const key = 'small-emoji-catalog'
        if (!imageCache.has(key)) {
          const promise = bot.media.emojiList()
          imageCache.set(key, promise)
          promise.catch(() => { if (imageCache.get(key) === promise) imageCache.delete(key) })
        }
        catalog = await imageCache.get(key)
      }
      const text = part.parts.map(item => {
        if (item.type === 'text') return item.text
        const emoji = catalog.find(emoji => emoji.id === item.emoji)
        if (!emoji?.name) throw new Error(`未找到小表情“${item.emoji}”，请从表情列表重新选择`)
        return emoji.name
      }).join('')
      body = { type: 'text', text }
    }
    const result = await bot.msg.send(chatId, body)
    if (result?.statusCode !== 0) throw new Error(`${result?.statusMsg || result?.statusCode || '发送未返回成功状态'}${result?.checkCode ? `（审核码 ${result.checkCode}）` : ''}`)
    onSent()
  }
}
