import { runSpark } from '../components/runner.js'
import { getConfig } from '../components/config.js'
import { listAccounts } from '../components/database.js'
import Version from '../components/Version.js'
import {
  buildHelpData,
  buildSparkResultData,
  helpRows,
  sparkResultRows,
  renderCard,
} from '../components/render.js'

export const sparkHandlers = { spark, scheduledSpark }
export { scheduledSpark }

/** 把 cron（秒 分 时 日 月 周）转成可读描述，解析不了就显示原文 */
function describeCron(cron) {
  const fields = String(cron || '').trim().split(/\s+/)
  if (fields.length >= 5 && fields[0] === '0' && /^\d+$/.test(fields[1]) && /^\d+$/.test(fields[2]) && fields.slice(3).every((f) => f === '*')) {
    return `每天 ${fields[2].padStart(2, '0')}:${fields[1].padStart(2, '0')}`
  }
  return cron || '未启用'
}

/** 帮助：渲染帮助卡（config/help.js 可配置指令清单），失败回退纯文字 */
async function replyHelp(e) {
  const accounts = await listAccounts(e.user_id).catch(() => [])
  const config = getConfig()
  const fallback = [
    '抖音续火命令一览',
    '#抖音添加账号：发送一次性网页链接，添加一个账号。',
    '#抖音取消添加：取消当前添加流程。',
    '#抖音管理账号（仅主人）：私聊获取所有账号管理网页。',
    '#抖音账号列表：查看自己添加的账号别名和会话数量。',
    '#抖音删除账号 账号名：删除自己的指定账号。',
    '#抖音修改账号 账号名：私聊获取指定账号的一次性修改链接。',
    '#抖音续火：执行自己全部账号。',
    '#抖音续火 账号名：仅执行自己的指定账号。',
    '#抖音续火 全部（仅主人）：执行所有用户账号。',
    '#抖音设置邮箱 邮箱：私聊设置自己的失败通知收件邮箱。',
    '#抖音成功邮件开启：私聊开启自己的续火成功邮件通知。',
    '#抖音成功邮件关闭：私聊关闭自己的续火成功邮件通知。',
    '#抖音邮箱：私聊查看当前收件邮箱。',
    '#抖音清除邮箱：私聊清除收件邮箱，此后失败不发邮件。',
  ].join('\n')
  await renderCard(e, 'help', await buildHelpData({
    e,
    version: Version.ver,
    accountCount: accounts.length,
    targetCount: accounts.reduce((total, account) => total + (account.targetNames?.length || 0), 0),
    scheduleDesc: config.schedule?.enabled === false ? '未启用' : describeCron(config.schedule?.cron),
  }), { buttons: helpRows({ isMaster: e.isMaster }), fallback })
}

/** 执行结果：渲染结果卡，失败明细完整保留在回退文案里 */
async function replySparkResult(e, result) {
  const failures = result.failures || []
  const fallback = [
    `抖音续火完成：成功发送 ${result.sent} 条消息。`,
    ...failures.map((item) => `失败：${item.accountName}（${item.message}）`),
  ].join('\n')
  await renderCard(e, 'spark-result', buildSparkResultData(result), {
    buttons: sparkResultRows(result),
    fallback,
  })
}

async function spark(e) {
  const argument = String(e.msg).replace(/^#(?:抖音)?续火/, '').trim()
  if (argument === '帮助') {
    await replyHelp(e)
    return true
  }

  const allUsers = argument === '全部'
  if (allUsers && !e.isMaster) {
    await e.reply('“全部”仅限机器人主人使用。')
    return true
  }

  await e.reply('正在启动抖音续火，请稍候...')
  try {
    const result = await runSpark(allUsers ? {} : { userId: e.user_id, accountName: argument || undefined })
    await replySparkResult(e, result)
  } catch (error) {
    logger.error('[抖音续火]', error)
    if (error.result) {
      await replySparkResult(e, error.result)
    } else {
      await e.reply(`抖音续火失败：${error.message}`)
    }
  }
  return true
}

async function scheduledSpark() {
  let result
  try {
    result = await runSpark()
    logger.mark(`[抖音续火] 定时任务完成，发送 ${result.sent} 条消息`)
  } catch (error) {
    logger.error('[抖音续火] 定时任务失败', error)
    result = error.result
  }
  if (result) {
    await sendScheduledResults(result)
    await sendScheduledSummaryToMasters(result)
  }
}

async function sendScheduledResults({ successes = [], failures = [] }) {
  const resultsByUser = new Map()
  for (const result of successes) {
    const userResults = resultsByUser.get(result.userId) ?? { successes: [], failures: [] }
    userResults.successes.push(result)
    resultsByUser.set(result.userId, userResults)
  }
  for (const result of failures) {
    const userResults = resultsByUser.get(result.userId) ?? { successes: [], failures: [] }
    userResults.failures.push(result)
    resultsByUser.set(result.userId, userResults)
  }

  for (const [userId, userResults] of resultsByUser) {
    const lines = ['抖音自动续火结果']
    if (userResults.successes.length) {
      const sent = userResults.successes.reduce((total, item) => total + item.sent, 0)
      lines.push(`成功发送：${sent} 条`)
      lines.push(...userResults.successes.map((item) => `成功：${item.accountName}（${item.sent} 条）`))
    }
    if (userResults.failures.length) {
      lines.push(...userResults.failures.map((item) => `失败：${item.accountName}（${item.message}）`))
    }
    try {
      const recipient = globalThis.Bot?.pickFriend?.(normalizeUserId(userId))
      if (!recipient?.sendMsg) throw new Error('当前适配器不支持发送私聊消息')
      await recipient.sendMsg(lines.join('\n'))
    } catch (error) {
      logger.warn(`[抖音续火] 向用户 ${userId} 发送定时结果失败`, error)
    }
  }
}

function normalizeUserId(userId) {
  const value = Number(userId)
  return Number.isSafeInteger(value) ? value : String(userId)
}

async function sendScheduledSummaryToMasters({ sent = 0, successes = [], failures = [] }) {
  if (typeof globalThis.Bot?.sendMasterMsg !== 'function') return
  const lines = [
    '抖音自动续火汇总',
    `总发送：${sent} 条`,
    `成功账号：${successes.length} 个`,
    `失败账号：${failures.length} 个`,
  ]
  if (successes.length) {
    lines.push('成功明细：')
    lines.push(...successes.map((item) => `- [${item.userId}] ${item.accountName}：${item.sent} 条`))
  }
  if (failures.length) {
    lines.push('失败明细：')
    lines.push(...failures.map((item) => `- [${item.userId}] ${item.accountName}：${item.message}`))
  }
  try {
    await globalThis.Bot.sendMasterMsg(lines.join('\n'), undefined, 0)
  } catch (error) {
    logger.warn('[抖音续火] 向主人发送定时汇总失败', error)
  }
}
