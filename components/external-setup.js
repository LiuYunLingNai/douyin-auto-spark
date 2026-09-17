// 外置配置服务流程（对齐 douyin-spark-login 服务协议：HTTP start + WS listen，无密钥签名）
// 服务端见 https://github.com/wei-la-ya/douyin-spark-login
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { getConfig } from './config.js'
import {
  addAccount,
  listAccounts,
  listTargets,
  replaceTargets,
  setUserEmail,
  setUserSuccessEmailEnabled,
  updateAccount,
} from './database.js'

const START_TIMEOUT_MS = 10000
const LISTEN_TIMEOUT_MS = 600000

/** 外置配置服务地址；空串表示未启用 */
export function externalBaseUrl() {
  let raw = String(getConfig().web?.externalSetupUrl || '').trim().replace(/\/+$/, '')
  if (raw && !/^https?:\/\//.test(raw)) raw = `https://${raw}`
  return raw
}

/**
 * 外置模式配置流程：start -> 发链接 -> WS 监听 -> 写库 -> 回复结果
 * @param {{ e: object, accountId?: number, actionText: string }} options
 */
export async function externalSetupFlow({ e, accountId, actionText }) {
  const base = externalBaseUrl()
  const auth = randomBytes(16).toString('hex')  // 随机会话标识，链接不暴露用户 ID

  // 编辑模式：把现有账号数据带给外置服务做页面初始值
  const initial = {}
  if (accountId !== undefined) {
    const account = (await listAccounts(e.user_id)).find((item) => item.id === accountId)
    if (!account) {
      await e.reply('账号不存在。')
      return true
    }
    const targets = await listTargets(account.id)
    initial.name = account.name
    initial.messageTemplate = account.messageTemplate
    initial.cookieRequired = false
    initial.targets = targets.map((t) => ({ secUid: t.secUid, nickname: t.nickname, uniqueId: t.uniqueId, avatar: t.avatar }))
  }

  let pageUrl
  try {
    const response = await fetch(`${base}/dyspark/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth,
        user_id: String(e.user_id),
        bot_id: String(e.self_id || ''),
        account_id: accountId ?? null,
        initial,
      }),
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`外置服务 start 返回 HTTP ${response.status}：${(await response.text()).slice(0, 200)}`)
    await response.json()
    // 链接用插件配置的地址拼接（不信服务端 base_url，反代子路径下会丢前缀）
    pageUrl = `${base}/dyspark/i/${auth}`
  } catch (error) {
    logger.warn('[抖音续火] 外置 start 失败', error)
    await e.reply(`外置配置服务不可用：${error.message}`)
    return true
  }

  await e.reply(`请在 10 分钟内打开链接${actionText}：\n${pageUrl}`)
  logger.info(`[抖音续火] 外置配置页已发送 user=${e.user_id} url=${pageUrl}`)

  const result = await listenWs(base, auth)
  if (!result) {
    await e.reply('配置链接已过期，未完成保存。')
    return true
  }
  if (result.status !== 'success') {
    await e.reply(result.msg || '配置失败。')
    return true
  }

  try {
    await savePayload(e, accountId, result.payload || {})
  } catch (error) {
    logger.error('[抖音续火] 外置结果写库失败', error)
    await e.reply(`保存失败：${error.message}`)
    return true
  }
  const payload = result.payload || {}
  const count = (payload.targets || []).length
  await e.reply(`账号「${payload.name}」已${accountId !== undefined ? '更新' : '添加'}，保存 ${count} 个续火目标。`)
  return true
}

/** WS 监听外置服务会话状态（无密钥签名） */
function listenWs(base, auth) {
  return new Promise((resolve) => {
    const wsBase = base.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
    const ws = new WebSocket(`${wsBase}/dyspark/ws/${auth}`)
    const timeout = setTimeout(() => {
      ws.terminate()
      resolve(null)
    }, LISTEN_TIMEOUT_MS)
    timeout.unref?.()
    ws.on('message', (raw) => {
      let payload
      try { payload = JSON.parse(raw.toString()) } catch { return }
      if (['success', 'failed', 'expired'].includes(payload.status)) {
        clearTimeout(timeout)
        ws.close()
        resolve(payload)
      }
    })
    ws.on('error', (error) => {
      logger.warn('[抖音续火] 外置 WS 连接失败', error)
      clearTimeout(timeout)
      resolve({ status: 'failed', msg: `外置服务连接失败：${error.message}` })
    })
  })
}

async function savePayload(e, accountId, payload) {
  const name = String(payload.name || '').trim()
  const cookies = payload.cookies
  const messageTemplate = String(payload.message_template || '')
  const targets = payload.targets || []

  let id = accountId
  if (accountId !== undefined) {
    const account = (await listAccounts(e.user_id)).find((item) => item.id === accountId)
    if (!account) throw new Error('账号不存在')
    await updateAccount({
      id: accountId,
      userId: e.user_id,
      name,
      cookies: cookies || account.cookies,
      targetNames: account.targetNames ?? [],
      messageTemplate,
    })
  } else {
    id = await addAccount({
      userId: e.user_id,
      name,
      cookies,
      targetNames: [],
      messageTemplate,
    })
  }

  await replaceTargets(id, targets.map((t) => ({
    secUid: String(t.sec_uid),
    uid: String(t.uid || ''),
    nickname: String(t.nickname || '').slice(0, 60),
    uniqueId: String(t.unique_id || '').slice(0, 60),
    avatar: String(t.avatar || '').slice(0, 500),
    conversationId: String(t.conversation_id || ''),
    conversationShortId: String(t.conversation_short_id || ''),
    ticket: String(t.ticket || ''),
  })))
  await setUserEmail(e.user_id, String(payload.email || ''))
  await setUserSuccessEmailEnabled(e.user_id, Boolean(payload.success_email_enabled))
}
