import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import nodemailer from 'nodemailer'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import { getBrowserLaunchOptions, getConfig, getPluginRoot } from './config.js'
import { getUserEmails, getUserNotificationSettings, listAccounts } from './database.js'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.locale('zh-cn')

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z]+)\s*\}\}/g
const PLACEHOLDERS = new Set(['account', 'friend', 'yiyan', 'from', 'date', 'time', 'weekday'])
const screenshotDir = path.join(getPluginRoot(), 'artifacts')

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
  const browser = await chromium.launch(getBrowserLaunchOptions(config))
  const failures = []
  const successes = []
  const screenshots = []
  let sent = 0

  try {
    for (const account of accounts) {
      try {
        const accountSent = await runAccount(browser, account, config, yiyans, screenshots)
        sent += accountSent
        successes.push({ userId: account.userId, accountName: account.name, sent: accountSent })
      } catch (error) {
        failures.push({
          userId: account.userId,
          accountName: account.name,
          message: toError(error).message,
        })
      }
    }
  } finally {
    await browser.close()
  }

  await sendSuccessEmails(config.smtp, successes)

  if (failures.length > 0) {
    await sendFailureEmails(config.smtp, failures, screenshots)
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

async function runAccount(browser, account, config, yiyans, screenshots) {
  const context = await browser.newContext()
  let page
  let sent = 0
  try {
    await context.addCookies(account.cookies)
    page = await context.newPage()
    await page.goto('https://www.douyin.com/chat', { waitUntil: 'domcontentloaded' })

    const searchInput = page.locator('input.semi-input[placeholder="搜索"]').first()
    const ready = await searchInput.waitFor({ state: 'visible', timeout: 30000 })
      .then(() => true).catch(() => false)
    if (!ready) throw new Error('聊天页搜索框未出现，Cookie 可能已经失效')

    await page.locator('[class*="conversation"], [class*="Conversation"]').first()
      .waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

    const needsYiyan = !account.messageTemplate || /\{\{\s*(yiyan|from)\s*\}\}/.test(account.messageTemplate)
    const missing = []
    for (const targetName of account.targetNames) {
      logger.info(`[${account.name}] 开始搜索会话：${targetName}`)
      const result = await searchConversation(page, searchInput, targetName)
      if (!result) {
        missing.push(targetName)
        await captureFailureScreenshot(page, `${account.name}-${targetName}`, account.userId, screenshots)
        continue
      }

      await result.getByText(/^(发消息|发私信)$/).click({ timeout: 5000 })
      const editor = page.locator('.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]').first()
      await editor.waitFor({ state: 'visible', timeout: 10000 })
      await editor.click()
      logger.info(`[${account.name}] 已打开私信：${targetName}`)

      const yiyan = needsYiyan ? pickRandom(yiyans) : undefined
      const message = account.messageTemplate
        ? renderTemplate(account.messageTemplate, account.name, targetName, yiyan)
        : config.message.includeSource !== false
          ? `${yiyan.hitokoto}\n——「${yiyan.from}」`
          : yiyan.hitokoto
      await page.keyboard.insertText(message)
      await page.keyboard.press('Enter')
      sent += 1
      logger.info(`[${account.name}] 已发送消息：${targetName}`)
      await page.waitForTimeout(1000)
    }
    if (missing.length > 0) {
      throw new Error(`以下会话未找到：${missing.join('、')}，请检查备注名和 Cookie`)
    }
    return sent
  } catch (error) {
    await captureFailureScreenshot(page, account.name, account.userId, screenshots)
    throw error
  } finally {
    await context.close()
  }
}

async function searchConversation(page, searchInput, targetName) {
  const result = page.locator('.SearchPanelitembox').filter({ has: page.getByText(targetName, { exact: true }) }).first()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await searchInput.fill('')
    await page.locator('.SearchPanelitembox').first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
    await searchInput.fill(targetName)
    if (await result.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) return result
    if (attempt < 2) await page.waitForTimeout(2000)
  }
  return undefined
}

async function captureFailureScreenshot(page, name, userId, screenshots) {
  if (!page || page.isClosed()) return
  try {
    await fs.mkdir(screenshotDir, { recursive: true })
    const safe = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-').replace(/^-+|-+$/g, '') || 'account'
    const file = path.join(screenshotDir, `failure-${safe}-${Date.now()}.png`)
    await page.screenshot({ path: file, fullPage: true })
    screenshots.push({ userId, file })
  } catch (error) {
    logger.warn('[抖音续火] 保存失败截图失败', error)
  }
}

async function sendFailureEmails(smtp, failures, screenshots) {
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
        const attachments = screenshots
          .filter((screenshot) => screenshot.userId === userId)
          .map((screenshot) => ({ filename: path.basename(screenshot.file), path: screenshot.file }))
        await transporter.sendMail({
          from: smtp.from || smtp.username,
          to: recipient,
          subject: '抖音续火任务失败',
          text: `抖音续火任务执行失败：\n\n${userFailures.map(formatFailure).join('\n')}`,
          attachments,
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
      userId: value.userId,
      name,
      targetNames,
      cookies: value.cookies.map(toPlaywrightCookie),
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
function toPlaywrightCookie(cookie) {
  return { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path || '/', expires: cookie.session ? -1 : (cookie.expirationDate ?? -1), httpOnly: Boolean(cookie.httpOnly), secure: Boolean(cookie.secure), sameSite: cookie.sameSite === 'no_restriction' ? 'None' : 'Lax' }
}
function toError(error) { return error instanceof Error ? error : new Error(String(error)) }
