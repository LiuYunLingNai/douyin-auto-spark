export function isPrivate(e) {
  return !e.isGroup && !e.group_id
}

export function parseCookies(input) {
  let values
  try {
    values = JSON.parse(input)
  } catch {
    throw new Error('Cookie 必须是有效的 JSON 数组')
  }
  if (!Array.isArray(values) || values.length === 0) throw new Error('Cookie 必须是非空数组')

  const cookies = values.filter(isUsableCookie)
  if (cookies.length === 0) throw new Error('没有可用的 Cookie，请确认导出的是 Cookie-Editor 的 JSON 数组')
  return { cookies, ignored: values.length - cookies.length }
}

export async function readCookieTextFile(e) {
  const file = e.file
  const name = String(file?.name || file?.filename || '')
  if (!/\.txt$/i.test(name)) throw new Error('仅支持 .txt 文件')
  if (Number(file?.size) > 1024 * 1024) throw new Error('文件不能超过 1 MB')

  const fileId = file?.file_id || file?.id || file?.fid
  const url = file?.url || (fileId && await e.friend?.getFileUrl?.(fileId))
  if (!url) throw new Error('无法获取文件下载地址，请重新上传')

  const uploaded = await Bot.fileType({ name, file: url })
  if (!Buffer.isBuffer(uploaded.buffer)) throw new Error('读取文件失败，请重新上传')
  return uploaded.buffer.toString('utf8').replace(/^\uFEFF/, '').trim()
}

export function parseTargetNames(input) {
  let values
  if (input.startsWith('[')) {
    try {
      values = JSON.parse(input)
    } catch {
      throw new Error('目标会话 JSON 格式不正确')
    }
  } else {
    values = input.split(/[,，\n]/)
  }
  if (!Array.isArray(values)) throw new Error('目标会话必须是数组或逗号分隔的名称')
  const names = values.map((value) => String(value).trim()).filter(Boolean)
  if (names.length === 0) throw new Error('至少需要一个目标会话名称')
  return [...new Set(names)]
}

export function validateTemplate(template) {
  const allowed = new Set(['account', 'friend', 'yiyan', 'from', 'date', 'time', 'weekday'])
  const unknown = [...template.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)]
    .map((match) => match[1])
    .filter((name) => !allowed.has(name))
  if (unknown.length > 0) throw new Error(`存在未识别占位符：${[...new Set(unknown)].join('、')}`)
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function isUsableCookie(cookie) {
  return cookie
    && typeof cookie === 'object'
    && typeof cookie.name === 'string'
    && cookie.name.trim()
    && typeof cookie.value === 'string'
    && typeof cookie.domain === 'string'
    && cookie.domain.trim()
}
