/** 模板字符串仍是唯一存储格式；媒体指令在替换昵称等变量之前解析。 */
export const TEMPLATE_FIELDS = {
  account: '账号别名', friend: '会话名称', yiyan: '随机一言', from: '一言出处',
  date: '日期', time: '时间', weekday: '星期',
}

export function validateImageSource(source) {
  if (/^local:[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(source)) return source
  try {
    const url = new URL(source)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\s{}]/.test(source)) return source
  } catch {}
  throw new Error('图片需使用完整 http/https 图链，或在编辑页上传本地图片')
}

/** 贴纸仅允许 IM 表情资源，避免把 tos-cn 表态图当成仅自己可见的表情发送。 */
export function validateEmojiValue(value, kind) {
  if (kind === 'small' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)) return value
  if (kind === 'sticker') {
    if (/^[a-zA-Z0-9_-]{1,200}$/.test(value)) return value
    try {
      const url = new URL(value)
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && /\/(im-resource|im-emoticon)\//.test(url.pathname) && !/[\s{}]/.test(value)) return value
    } catch {}
  }
  throw new Error('表情引用无效，请从表情列表重新选择；贴纸需使用 im-resource 或 im-emoticon 资源')
}

export function parseEmojiPayload(payload) {
  let data
  try { data = JSON.parse(decodeURIComponent(payload)) } catch { throw new Error('表情指令格式不正确，请从表情列表重新选择') }
  if (!data || typeof data !== 'object' || typeof data.value !== 'string' || typeof data.url !== 'string' || typeof data.name !== 'string' || data.name.length > 200 || payload.length > 8000) throw new Error('表情数据无效，请重新选择')
  validateEmojiValue(data.value, data.kind)
  validateImageSource(data.url)
  if (data.url.startsWith('local:')) throw new Error('表情预览需使用资源图片链接')
  return { type: 'emoji', emoji: data.value, preview: data.url, name: data.name, kind: data.kind }
}

export function emojiTemplate(item) {
  const payload = encodeURIComponent(JSON.stringify({ value: item.value ?? item.emoji, url: item.url ?? item.preview, name: item.name, kind: item.kind }))
  parseEmojiPayload(payload)
  return `{{emoji:${payload}}}`
}

export function parseMessageTemplate(value) {
  const template = String(value || '').replace(/\\n/g, '\n')
  const parts = []
  const pattern = /\{\{\s*(image|emoji):([^{}]*?)\s*\}\}/g
  let offset = 0
  for (const match of template.matchAll(pattern)) {
    if (match.index > offset) parts.push({ type: 'text', text: template.slice(offset, match.index) })
    parts.push(match[1] === 'image' ? { type: 'image', source: validateImageSource(match[2].trim()) } : parseEmojiPayload(match[2].trim()))
    offset = match.index + match[0].length
  }
  if (offset < template.length) parts.push({ type: 'text', text: template.slice(offset) })
  for (const part of parts) {
    if (part.type !== 'text') continue
    if (/\{\{\s*image\s*:/i.test(part.text)) throw new Error('图片指令格式不正确，请使用 {{image:图片地址}}')
    if (/\{\{\s*emoji\s*:/i.test(part.text)) throw new Error('表情指令格式不正确，请从表情列表重新选择')
    const unknown = [...part.text.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)].map(match => match[1]).filter(name => !Object.hasOwn(TEMPLATE_FIELDS, name))
    if (unknown.length) throw new Error(`存在未识别占位符：${[...new Set(unknown)].join('、')}`)
  }
  if (parts.filter(part => part.type === 'image').length > 10) throw new Error('每份模板最多添加 10 张图片')
  if (parts.filter(part => part.type === 'emoji').length > 20) throw new Error('每份模板最多添加 20 个表情')
  if (template.length > 64000) throw new Error('消息模板不能超过 64000 个字符')
  return parts
}

export function renderMessageParts(template, values) {
  return parseMessageTemplate(template).map(part => part.type !== 'text'
    ? part
    : { type: 'text', text: part.text.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, name) => values[name] ?? '') })
    .filter(part => part.type !== 'text' || part.text.trim())
}
