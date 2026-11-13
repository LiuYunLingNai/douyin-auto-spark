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

export function validateEmojiValue(value) {
  if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)) return value
  throw new Error('小表情格式不正确，请使用 {{emoji:weixiao}} 或从列表重新选择')
}

export function emojiTemplate(item) {
  return `{{emoji:${validateEmojiValue(item.value ?? item.emoji)}}}`
}

export function parseMessageTemplate(value) {
  const template = String(value || '').replace(/\\n/g, '\n')
  const parts = []
  const pattern = /\{\{\s*(image|emoji):([^{}]*?)\s*\}\}/g
  let offset = 0
  for (const match of template.matchAll(pattern)) {
    if (match.index > offset) parts.push({ type: 'text', text: template.slice(offset, match.index) })
    parts.push(match[1] === 'image' ? { type: 'image', source: validateImageSource(match[2].trim()) } : { type: 'emoji', emoji: validateEmojiValue(match[2].trim()) })
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
}

/** 小表情属于文字消息；只有图片会分隔消息，分组前保留所有换行与空格。 */
export function groupMessageParts(parts) {
  const groups = []
  let inline = []
  const flush = () => {
    if (inline.some(part => part.type === 'emoji' || part.text.trim())) groups.push({ type: 'text', parts: inline })
    inline = []
  }
  for (const part of parts) {
    if (part.type === 'image') { flush(); groups.push(part) }
    else inline.push(part)
  }
  flush()
  return groups
}
