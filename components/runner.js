// 续火执行器（API 版）：通过抖音 Web 私信接口按 sec_uid 寻址发送，昵称变更自动检测更新
import fs from 'node:fs/promises'
import path from 'node:path'
import nodemailer from 'nodemailer'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import { getConfig, getPluginRoot } from './config.js'
import {
  getUserEmails,
  getUserNotificationSettings,
  listAccounts,
  listTargets,
  updateAccountSelfUid,
  updateTargetConversation,
  updateTargetProfile,
} from './database.js'
import {
  DouyinApiError,
  buildCookieHeader,
  createConversation,
  fetchUserProfile,
  getCookieValue,
  getSelfUidFromCookies,
  randomDelay,
  sendTextMessage,
} from './douyin-api.js'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.locale('zh-cn')

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z]+)\s*\}\}/g
const PLACEHOLDERS = new Set(['account', 'friend', 'yiyan', 'from', 'date', 'time', 'weekday'])

export async function runSpark({ userId, accountName } = {}) {
  const config = getConfig()
  const storedAccounts = await listAccounts(userId)
  const selectedAccounts = accountName
    ? storedAccounts.filter((account) => account.name === accountName)
    : storedAccounts
  if (accountName && selectedAccounts.length === 0) {
    throw new Error(`未找到名为“${accountName}”的账号`)
  }
  const accounts = resolveAccounts(selectedAccounts, config.message.template)
  if (accounts.length === 0) {
    throw new Error('尚未添加账号，请私聊机器人发送 #抖音添加账号')
  }

  const yiyans = await loadYiyans()
  const failures = []
  const successes = []
  let sent = 0

  for (const account of accounts) {
    try {
      const { sent: accountSent, renames } = await runAccount(account, config, yiyans)
      sent += accountSent
      successes.push({ userId: account.userId, accountName: account.name, sent: accountSent, renames })
    } catch (error) {
      failures.push({
        userId: account.userId,
        accountName: account.name,
        message: toError(error).message,
      })
    }
  }

  await sendSuccessEmails(config.smtp, successes)

  if (failures.length > 0) {
    await sendFailureEmails(config.smtp, failures)
    const error = new Error(failures.map(formatFailure).join('\n'))
    error.result = { sent, successes, failures }
    throw error
  }
  return { sent, successes, failures: [] }
}

async function runAccount(account, config, yiyans) {
  const cookieHeader = buildCookieHeader(account.rawCookies)
  if (!getCookieValue(account.rawCookies, 'sessionid')) {
    throw new Error('Cookie 中缺少 sessionid，请重新导出完整 Cookie 并修改账号')
  }

  // 解析/补全账号自身 uid（会话创建需要）
  let selfUid = account.selfUid || getSelfUidFromCookies(account.rawCookies)
  if (selfUid && selfUid !== account.selfUid) {
    await updateAccountSelfUid(account.id, selfUid).catch(() => {})
  }

  const webid = getCookieValue(account.rawCookies, 's_v_web_id')
  const uifid = getCookieValue(account.rawCookies, 'UIFID')
  const templateB64 = config.im?.templateB64 || undefined
  const targets = await listTargets(account.id)
  if (targets.length === 0) {
    throw new Error('该账号尚未添加续火目标，请发送 #抖音好友列表 <分享链接>')
  }

  const needsYiyan = !account.messageTemplate || /\{\{\s*(yiyan|from)\s*\}\}/.test(account.messageTemplate)
  const targetErrors = []
  const renames = []
  let sent = 0
  let firstTarget = true

  for (const target of targets) {
    // 目标间随机延时，降低风控概率
    if (firstTarget) firstTarget = false
    else await randomDelay(Number(config.send?.minIntervalSec) || 3, Number(config.send?.maxIntervalSec) || 8)

    try {
      // 1. 刷新昵称（前台展示用 ID->昵称 映射，变更自动更新）
      const profile = await fetchUserProfile(cookieHeader, target.secUid, { webid, uifid })
      if (profile.nickname && profile.nickname !== target.nickname) {
        const oldName = target.nickname || '（未知）'
        await updateTargetProfile(target.id, { nickname: profile.nickname, uniqueId: profile.uniqueId })
        renames.push(`${oldName} 已改名为 ${profile.nickname}`)
        target.nickname = profile.nickname
        logger.info(`[${account.name}] 目标昵称变更：${oldName} -> ${profile.nickname}`)
      }

      // 2. 补全会话信息（conversation_id 缺失时创建）
      if (!target.conversationId) {
        const created = await createConversation(cookieHeader, {
          receiverUid: profile.uid,
          senderUid: selfUid || undefined,
          templateB64,
        })
        if (!selfUid) {
          selfUid = inferSelfUid(created.conversationId, profile.uid) || created.selfUid
          if (selfUid) await updateAccountSelfUid(account.id, selfUid).catch(() => {})
        }
        await updateTargetConversation(target.id, {
          uid: profile.uid,
          conversationId: created.conversationId,
          conversationShortId: created.conversationShortId,
        })
        target.conversationId = created.conversationId
        target.conversationShortId = created.conversationShortId
        logger.info(`[${account.name}] 已创建会话：${target.nickname}（${target.secUid.slice(0, 12)}…）`)
      }

      // 3. 发送消息（后台全程按 ID 寻址，与昵称无关）
      const yiyan = needsYiyan ? pickRandom(yiyans) : undefined
      const message = account.messageTemplate
        ? renderTemplate(account.messageTemplate, account.name, target.nickname || target.secUid, yiyan)
        : config.message.includeSource !== false
          ? `${yiyan.hitokoto}\n——「${yiyan.from}」`
          : yiyan.hitokoto
      await sendTextMessage(cookieHeader, {
        conversationId: target.conversationId,
        conversationShortId: target.conversationShortId,
        text: message,
        templateB64,
      })
      sent += 1
      logger.info(`[${account.name}] 已发送消息：${target.nickname}（ID: ${target.secUid.slice(0, 12)}…）`)
    } catch (error) {
      const err = toError(error)
      targetErrors.push(`${target.nickname || target.secUid.slice(0, 12)}：${err.message}`)
      logger.warn(`[${account.name}] 目标 ${target.secUid.slice(0, 12)}… 发送失败`, err)
    }
  }

  if (sent === 0 && targetErrors.length > 0) {
    throw new Error(targetErrors.join('\n'))
  }
  if (targetErrors.length > 0) {
    logger.warn(`[${account.name}] 部分目标发送失败：\n${targetErrors.join('\n')}`)
  }
  return { sent, renames }
}

/** 从 conversation_id（0:1:uidA:uidB）中推断自己的 uid */
function inferSelfUid(conversationId, peerUid) {
  const segments = String(conversationId).split(':')
  const candidates = segments.slice(2).filter(Boolean)
  return candidates.find((uid) => uid !== String(peerUid)) || ''
}

async function sendSuccessEmails(smtp, successes) {
  if (!smtp?.enabled || successes.length === 0) return
  const settings = await getUserNotificationSettings(successes.map((success) => success.userId))
  const successesByUser = new Map()
  for (const success of successes) {
    const userSuccesses = successesByUser.get(success.userId) ?? []
    userSuccesses.push(success)
    successesByUser.set(success.userId, userSuccesses)
  }
  const deliveries = [...successesByUser].filter(([userId]) => {
    const setting = settings.get(String(userId))
    return setting?.email && setting.successEmailEnabled
  })
  if (deliveries.length === 0) return
  if (!smtp.host || !smtp.username || !smtp.password) {
    logger.warn('[抖音续火] SMTP 已开启但配置不完整，跳过成功邮件')
    return
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port) || 465,
      secure: smtp.secure !== false,
      auth: { user: smtp.username, pass: smtp.password },
    })
    for (const [userId, userSuccesses] of deliveries) {
      const recipient = settings.get(String(userId)).email
      try {
        const sent = userSuccesses.reduce((total, success) => total + success.sent, 0)
        const renameLines = userSuccesses.flatMap((success) => (success.renames ?? []).map((item) => `昵称变更：${item}`))
        await transporter.sendMail({
          from: smtp.from || smtp.username,
          to: recipient,
          subject: '抖音续火任务成功',
          text: `抖音续火任务已完成，成功发送 ${sent} 条消息。\n\n${userSuccesses.map((success) => `- ${success.accountName}：${success.sent} 条`).join('\n')}${renameLines.length ? `\n\n${renameLines.join('\n')}` : ''}`,
        })
        logger.mark(`[抖音续火] 已向用户 ${userId} 发送成功邮件`)
      } catch (error) {
        logger.error(`[抖音续火] 向用户 ${userId} 发送成功邮件失败`, error)
      }
    }
  } catch (error) {
    logger.error('[抖音续火] 发送成功邮件失败', error)
  }
}

async function sendFailureEmails(smtp, failures) {
  if (!smtp?.enabled) return
  const emails = await getUserEmails(failures.map((failure) => failure.userId))
  const failuresByUser = new Map()
  for (const failure of failures) {
    const userFailures = failuresByUser.get(failure.userId) ?? []
    userFailures.push(failure)
    failuresByUser.set(failure.userId, userFailures)
  }
  const deliveries = [...failuresByUser].filter(([userId]) => emails.get(userId))
  if (deliveries.length === 0) return
  if (!smtp.host || !smtp.username || !smtp.password) {
    logger.warn('[抖音续火] SMTP 已开启但配置不完整，跳过失败邮件')
    return
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port) || 465,
      secure: smtp.secure !== false,
      auth: { user: smtp.username, pass: smtp.password },
    })
    for (const [userId, userFailures] of deliveries) {
      const recipient = emails.get(userId)
      try {
        await transporter.sendMail({
          from: smtp.from || smtp.username,
          to: recipient,
          subject: '抖音续火任务失败',
          text: `抖音续火任务执行失败：\n\n${userFailures.map(formatFailure).join('\n')}`,
        })
        logger.mark(`[抖音续火] 已向用户 ${userId} 发送失败邮件`)
      } catch (error) {
        logger.error(`[抖音续火] 向用户 ${userId} 发送失败邮件失败`, error)
      }
    }
  } catch (error) {
    logger.error('[抖音续火] 发送失败邮件失败', error)
  }
}

function resolveAccounts(values, defaultTemplate) {
  return values.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`accounts[${index}] 必须是对象`)
    const name = String(value.name || '').trim()
    if (!name || !Array.isArray(value.cookies) || !value.cookies.length) {
      throw new Error(`账号“${name || index + 1}”的数据不完整，请删除后重新添加`)
    }
    return {
      id: value.id,
      userId: value.userId,
      name,
      rawCookies: value.cookies,
      selfUid: value.selfUid,
      messageTemplate: normalizeTemplate(value.messageTemplate || defaultTemplate || ''),
    }
  })
}

function formatFailure(failure) {
  return `[${failure.accountName}] ${failure.message}`
}

function normalizeTemplate(template) {
  if (!template) return ''
  const unknown = [...template.matchAll(PLACEHOLDER_RE)].map((match) => match[1]).filter((name) => !PLACEHOLDERS.has(name))
  if (unknown.length) throw new Error(`消息模板存在未识别占位符：${[...new Set(unknown)].join('、')}`)
  return template.replace(/\\n/g, '\n')
}

function renderTemplate(template, account, friend, yiyan) {
  const now = dayjs().tz('Asia/Shanghai')
  const values = { account, friend, yiyan: yiyan?.hitokoto || '', from: yiyan?.from || '', date: now.format('YYYY-MM-DD'), time: now.format('HH:mm'), weekday: now.format('dddd') }
  return template.replace(PLACEHOLDER_RE, (_match, name) => values[name] ?? '')
}

async function loadYiyans() {
  const file = path.join(getPluginRoot(), 'assets', 'yiyan.json')
  const values = JSON.parse(await fs.readFile(file, 'utf8'))
  if (!Array.isArray(values) || !values.length) throw new Error('assets/yiyan.json 为空')
  return values
}

function pickRandom(values) { return values[Math.floor(Math.random() * values.length)] }
function toError(error) { return error instanceof Error ? error : new Error(String(error)) }

export { DouyinApiError }
