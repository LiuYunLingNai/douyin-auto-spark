import { imageInput } from './template-images.js'

/** 每个账号本轮共用上传结果；不同账号不复用媒体资产。逐条确认并统计已提交消息。 */
export async function sendTemplateMessages(bot, chatId, parts, imageCache = new Map(), onSent = () => {}) {
  for (const part of parts) {
    let body
    if (part.type === 'image') {
      if (!imageCache.has(part.source)) {
        const upload = imageInput(part.source).then(input => bot.media.image(input))
        imageCache.set(part.source, upload)
        upload.catch(() => { if (imageCache.get(part.source) === upload) imageCache.delete(part.source) })
      }
      body = { type: 'image', image: await imageCache.get(part.source) }
    } else {
      body = { type: 'text', text: part.text }
    }
    const result = await bot.msg.send(chatId, body)
    if (result?.statusCode !== 0) throw new Error(`${result?.statusMsg || result?.statusCode || '发送未返回成功状态'}${result?.checkCode ? `（审核码 ${result.checkCode}）` : ''}`)
    onSent()
  }
}
