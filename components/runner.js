import fs from 'node:fs/promises'
import path from 'node:path'
import nodemailer from 'nodemailer'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import { getConfig, getPluginRoot } from './config.js'
import { getUserEmails, getUserNotificationSettings, listAccounts, setAccountUid } from './database.js'
import { getBot, buildChatIndex, closeBot } from './douyin.js'

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
      const accountSent = await runAccount(account, config, yiyans)
      sent += accountSent
      successes.push({ userId: account.userId, accountName: account.name, sent: accountSent })
    } catch (error) {
      failures.push({
        userId: account.userId,
        accountName: account.name,
        message: toError(error).message,
      })
    } finally {
      closeBot(account.id === undefined ? account.name : account.id)
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
        await transporter.sendMail({
          from: smtp.from || smtp.username,
          to: recipient,
          subject: '抖音续火任务成功',
          text: `抖音续火任务已完成，成功发送 ${sent} 条消息。\n\n${userSuccesses.map((success) => `- ${success.accountName}：${success.sent} 条`).join('\n')}`,
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

async function runAccount(account, config, yiyans) {
  // uid 一旦解析出来就落库，后续续火不必再打一次资料接口
  const bot = await getBot(account, {
    persistUid: (uid) => (account.id === undefined ? Promise.resolve() : setAccountUid(account.userId, account.name, uid)),
  })
  const { index, ambiguous } = await buildChatIndex(bot)

  const needsYiyan = !account.messageTemplate || /\{\{\s*(yiyan|from)\s*\}\}/.test(account.messageTemplate)
  const missing = []
  const ambiguousHits = []
  let sent = 0

  for (const targetName of account.targetNames) {
    const chatId = index.get(targetName)
    if (!chatId) {
      missing.push(targetName)
      continue
    }
    // 同名会话（好友与群重名、或多个同名好友）无法区分，提示用户改用更精确的名字
    if (ambiguous.has(targetName)) ambiguousHits.push(targetName)

    const yiyan = needsYiyan ? pickRandom(yiyans) : undefined
    const message = account.messageTemplate
      ? renderTemplate(account.messageTemplate, account.name, targetName, yiyan)
      : yiyan
        ? config.message.includeSource !== false
          ? `${yiyan.hitokoto}\n——「${yiyan.from}」`
          : yiyan.hitokoto
        : ''
    if (!message) {
      throw new Error(`账号“${account.name}”没有可发送的内容：消息模板为空且未取得一言`)
    }

    const result = await bot.msg.send(chatId, { type: 'text', text: message })
    if (result?.statusCode !== 0) {
      throw new Error(`向“${targetName}”发送失败：${result?.statusMsg || result?.statusCode}${result?.checkCode ? `（审核码 ${result.checkCode}）` : ''}`)
    }
    sent += 1
  }

  if (ambiguousHits.length > 0) {
    logger.warn(`[${account.name}] 以下会话名存在同名条目，已按首个匹配发送：${[...new Set(ambiguousHits)].join('、')}`)
  }
  if (missing.length > 0) {
    throw new Error(`以下会话未找到：${missing.join('、')}，请检查会话名和 Cookie`)
  }
  return sent
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
    const targetNames = Array.isArray(value.targetNames) ? value.targetNames.map((item) => String(item).trim()).filter(Boolean) : []
    if (!name || !targetNames.length || !Array.isArray(value.cookies) || !value.cookies.length) {
      throw new Error(`账号“${name || index + 1}”的数据不完整，请删除后重新添加`)
    }
    return {
      id: value.id,
      userId: value.userId,
      name,
      targetNames,
      cookies: value.cookies,
      douyinUid: String(value.douyinUid || ''),
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
