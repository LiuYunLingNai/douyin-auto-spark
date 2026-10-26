import fs from 'node:fs/promises'
import path from 'node:path'
import nodemailer from 'nodemailer'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import { getConfig, getPluginRoot } from './config.js'
import { getUserEmails, getUserNotificationSettings, listAccounts, setAccountDevice, setAccountUid } from './database.js'
import { getBot, buildChatIndex, closeBot } from './douyin.js'
import { formatNameList, resolveNameTargets } from './format.js'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.locale('zh-cn')

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z]+)\s*\}\}/g
const PLACEHOLDERS = new Set(['account', 'friend', 'yiyan', 'from', 'date', 'time', 'weekday'])

/** 当前正在执行的续火；同一时间只跑一轮，避免两轮共用同一账号连接时互相关掉对方的连接 */
let running

export function isSparkRunning() {
  return Boolean(running)
}

/**
 * @param {object} [options]
 * @param {boolean} [options.wait] true 时排队等上一轮结束（定时任务用）；
 *   false 时上一轮未结束就直接报错（手动命令用，避免用户连发后重复续火）
 */
export async function runSpark({ userId, accountName, wait = false } = {}) {
  while (running) {
    if (!wait) {
      const error = new Error('上一轮续火还在执行，请稍后再试')
      error.code = 'BUSY'
      throw error
    }
    await running.catch(() => {})
  }
  const task = runSparkUnlocked({ userId, accountName })
  running = task
  try {
    return await task
  } finally {
    if (running === task) running = undefined
  }
}

async function runSparkUnlocked({ userId, accountName }) {
  const config = getConfig()
  const storedAccounts = await listAccounts(userId)
  const selectedAccounts = accountName
    ? storedAccounts.filter((account) => account.name === accountName)
    : storedAccounts
  if (accountName && selectedAccounts.length === 0) {
    throw new Error(`未找到名为“${accountName}”的账号`)
  }
  if (selectedAccounts.length === 0) {
    const error = new Error('尚未添加账号，请私聊机器人发送 #抖音添加账号')
    error.code = 'NO_ACCOUNTS'
    throw error
  }

  // 全局模板与一言是所有账号共用的，出错时只让依赖它们的账号失败，不中止整轮
  let defaultTemplate = ''
  let defaultTemplateError
  try {
    defaultTemplate = normalizeTemplate(config.message.template || '')
  } catch (error) {
    defaultTemplateError = `全局默认消息模板无效：${toError(error).message}`
    logger.error(`[抖音续火] ${defaultTemplateError}`)
  }
  let yiyans = []
  try {
    yiyans = await loadYiyans()
  } catch (error) {
    logger.error('[抖音续火] 读取一言失败，依赖一言的账号将失败', error)
  }

  const failures = []
  const successes = []
  let sent = 0

  for (const stored of selectedAccounts) {
    let account
    try {
      account = resolveAccount(stored, defaultTemplate, defaultTemplateError)
      const accountSent = await runAccount(account, config, yiyans)
      sent += accountSent
      successes.push({ userId: stored.userId, accountName: stored.name, sent: accountSent })
    } catch (error) {
      // 部分会话已发出时也要计入，否则汇总会少算，用户以为一条没发
      const partial = Number(error?.sent) || 0
      sent += partial
      failures.push({
        userId: stored.userId,
        accountName: stored.name,
        sent: partial,
        message: toError(error).message,
      })
    } finally {
      if (account) closeBot(account.id === undefined ? account.name : account.id)
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
    persistUid: (uid) => (account.id === undefined ? Promise.resolve() : setAccountUid(account.id, uid)),
    // 首次（或旧设备失效）由 SDK 注册的新设备落库，之后每次续火都复用它
    persistDevice: (device) => (account.id === undefined ? Promise.resolve() : setAccountDevice(account.id, device)),
  })
  const { index, ambiguous } = await buildChatIndex(bot)

  const needsYiyan = !account.messageTemplate || /\{\{\s*(yiyan|from)\s*\}\}/.test(account.messageTemplate)
  const missing = []
  const ambiguousHits = []
  const sendErrors = []
  // 同一会话一轮只发一次：目标里同时写了「A」和「A、B」时，A 不应收到两条
  const sentChats = new Set()
  let sent = 0

  for (const targetName of account.targetNames) {
    // 选择对象时可能用顿号连着写了两个好友（「A、B」），整串是匹配不到的；
    // 这里先按整串精确匹配，匹配不到再按顿号还原成多个会话。
    const targets = resolveNameTargets(targetName, index)
    if (targets.length === 0) {
      missing.push(targetName)
      continue
    }
    if (targets.length > 1) {
      logger.warn(`[${account.name}] 目标「${targetName}」未精确匹配，已按顿号识别为 ${formatNameList(targets.map((target) => target.name))}`)
    }

    for (const target of targets) {
      // 同名会话（好友与群重名、或多个同名好友）无法区分，宁可报错也不猜着发，避免发错人
      if (ambiguous.has(target.name)) {
        ambiguousHits.push(target.name)
        continue
      }
      if (sentChats.has(target.chatId)) continue
      sentChats.add(target.chatId)

      const yiyan = needsYiyan && yiyans.length ? pickRandom(yiyans) : undefined
      const message = account.messageTemplate
        ? renderTemplate(account.messageTemplate, account.name, target.name, yiyan)
        : yiyan
          ? config.message.includeSource !== false
            ? `${yiyan.hitokoto}\n——「${yiyan.from}」`
            : yiyan.hitokoto
          : ''
      if (!message) {
        throw new Error(`账号“${account.name}”没有可发送的内容：消息模板为空且未取得一言`)
      }

      // 单个会话发送失败不影响其余会话，全部发完再统一报错
      try {
        const result = await bot.msg.send(target.chatId, { type: 'text', text: message })
        if (result?.statusCode !== 0) {
          throw new Error(`${result?.statusMsg || result?.statusCode}${result?.checkCode ? `（审核码 ${result.checkCode}）` : ''}`)
        }
        sent += 1
      } catch (error) {
        sendErrors.push(`向“${target.name}”发送失败：${toError(error).message}`)
      }
    }
  }

  const problems = [...sendErrors]
  if (ambiguousHits.length > 0) {
    problems.push(`以下会话名存在同名的好友或群，无法区分，已跳过：${formatNameList(ambiguousHits)}，请改用备注名等唯一名称`)
  }
  if (missing.length > 0) {
    problems.push(`以下会话未找到：${formatNameList(missing)}，请检查会话名和 Cookie`)
  }
  if (problems.length > 0) {
    const error = new Error(`${problems.join('；')}${sent ? `（其余 ${sent} 条已发送）` : ''}`)
    error.sent = sent
    throw error
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

/** 校验并规范单个账号；出错只影响这一个账号（由调用方记为失败） */
function resolveAccount(value, defaultTemplate, defaultTemplateError) {
  if (value.invalid) throw new Error(`${value.invalid}`)
  const name = String(value.name || '').trim()
  const targetNames = Array.isArray(value.targetNames) ? value.targetNames.map((item) => String(item).trim()).filter(Boolean) : []
  if (!name || !targetNames.length || !Array.isArray(value.cookies) || !value.cookies.length) {
    throw new Error(`账号“${name || value.id}”的数据不完整，请删除后重新添加`)
  }
  if (!value.messageTemplate && defaultTemplateError) throw new Error(defaultTemplateError)
  return {
    id: value.id,
    userId: value.userId,
    name,
    targetNames,
    cookies: value.cookies,
    douyinUid: String(value.douyinUid || ''),
    douyinDevice: value.douyinDevice,
    messageTemplate: value.messageTemplate ? normalizeTemplate(value.messageTemplate) : defaultTemplate,
  }
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
