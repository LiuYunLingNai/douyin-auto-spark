import { randomBytes } from 'node:crypto'
import { getConfig, saveConfig } from './config.js'
import { parseMessageTemplate } from './message-template.js'
import { assertTemplateImages, MAX_TEMPLATE_IMAGE_BYTES, readTemplateImage, saveTemplateImage } from './template-images.js'
import { renderDefaultTemplatePage } from './template-editor.js'
import { readAccountTemplateEmojis, templateEmojiAccounts, withTemplateEmojiAccount, getTemplateEmojiCatalog } from './template-emojis.js'

const sessions = new Map()

/** 只能由主人专用命令调用；网页依赖短期随机令牌鉴权。 */
export function createTemplateSession(userId) {
  revokeTemplateSessions(userId)
  const token = randomBytes(32).toString('hex')
  const expiresMinutes = Number(getConfig().web?.linkExpiresMinutes) || 10
  const session = { userId: String(userId), expiresAt: Date.now() + expiresMinutes * 60000 }
  session.timer = setTimeout(() => sessions.delete(token), expiresMinutes * 60000)
  session.timer.unref?.()
  sessions.set(token, session)
  return { token, expiresMinutes }
}

export function revokeTemplateSessions(userId) {
  for (const [token, session] of sessions) {
    if (session.userId === String(userId)) { clearTimeout(session.timer); sessions.delete(token) }
  }
}

function send(res, status, value, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value)
  return true
}

export async function handleTemplateRequest(req, res, pathname, prefix, getSetupSession, readJsonBody, resolveSetupAccount) {
  const route = new RegExp(`^${prefix}/(?:template/([a-f0-9]{64})|api/template/(upload|image|save|emojis|accounts|emoji-catalog)/([a-f0-9]{64})(?:/([a-f0-9]{64}\\.(?:png|jpg|gif|webp)))?)$`).exec(pathname)
  if (!route) return false
  const [, pageToken, action, apiToken, id] = route
  const token = pageToken || apiToken
  const defaultSession = sessions.get(token)
  const activeDefault = defaultSession?.expiresAt > Date.now() ? defaultSession : undefined
  const session = activeDefault || getSetupSession(token)
  if (!session || ((pageToken || action === 'save') && !activeDefault)) return send(res, 403, { ok: false, message: '模板编辑链接无效或已过期，请重新获取' })
  if (req.method !== (pageToken || action === 'image' || action === 'accounts' || action === 'emoji-catalog' ? 'GET' : 'POST')) return send(res, 405, { ok: false, message: '请求方式不支持' })
  try {
    if (action === 'emoji-catalog' && !id) return send(res, 200, { ok: true, items: await getTemplateEmojiCatalog() })
    if (action === 'accounts' && !id) return send(res, 200, { ok: true, accounts: await templateEmojiAccounts(activeDefault ? undefined : session.userId) })
    if (action === 'emojis' && !id) {
      if (session.loadingEmojis) throw new Error('正在读取表情，请稍候')
      if (session.submitting) throw new Error('正在保存配置，请稍后再读取表情')
      session.loadingEmojis = true
      try {
        const body = req.body ?? await readJsonBody(req)
        const page = activeDefault ? await readAccountTemplateEmojis(body.accountId, body) : await withTemplateEmojiAccount(await resolveSetupAccount(session, body, token), body)
        if (session.expiresAt <= Date.now()) throw new Error('链接已过期，请重新获取')
        return send(res, 200, { ok: true, ...page })
      } finally { session.loadingEmojis = false }
    }
    if (pageToken) return send(res, 200, renderDefaultTemplatePage(token, prefix, getConfig().message.template || ''), 'text/html; charset=utf-8')
    if (action === 'image' && id) {
      const image = await readTemplateImage(id)
      return send(res, 200, image.bytes, image.contentType)
    }
    if (action === 'upload' && !id) {
      // 使用独立媒体类型，避免 TRSS 上游默认 express.raw() 的 100 KB 限制提前消费请求体。
      if (req.headers['content-type'] !== 'application/x-douyin-template-image') throw new Error('图片上传请求格式不正确')
      if (session.submitting) throw new Error('正在保存配置，请稍后再上传')
      if ((session.imageUploads || 0) >= 10) throw new Error('每个编辑链接最多上传 10 张图片，请重新获取链接')
      session.imageUploads = (session.imageUploads || 0) + 1
      try {
        const chunks = []; let length = 0
        for await (const chunk of req) {
          length += chunk.length
          if (length > MAX_TEMPLATE_IMAGE_BYTES) throw new Error('图片不能超过 5 MB')
          chunks.push(chunk)
        }
        if (session.expiresAt <= Date.now()) throw new Error('链接已过期，请重新获取')
        const image = await saveTemplateImage(Buffer.concat(chunks))
        return send(res, 200, { ok: true, source: image.source })
      } catch (error) { session.imageUploads -= 1; throw error }
    }
    if (action === 'save' && !id) {
      if (session.submitting) throw new Error('正在保存，请勿重复提交')
      session.submitting = true
      try {
        const body = req.body ?? await readJsonBody(req)
        if (typeof body?.template !== 'string') throw new Error('消息模板必须是文字')
        const template = body.template.trim()
        await assertTemplateImages(parseMessageTemplate(template))
        if (session.expiresAt <= Date.now()) throw new Error('链接已过期，请重新获取')
        saveConfig({ message: { template } })
        clearTimeout(session.timer); sessions.delete(token)
        return send(res, 200, { ok: true, message: '默认模板已保存，现在可以关闭此页面。' })
      } finally { session.submitting = false }
    }
    return send(res, 404, { ok: false, message: '页面不存在' })
  } catch (error) {
    return send(res, 400, { ok: false, message: error.code === 'ENOENT' ? '图片不存在，请重新上传' : error.message || '操作失败' })
  }
}
