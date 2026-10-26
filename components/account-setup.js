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
