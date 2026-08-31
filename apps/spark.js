import { runSpark } from '../components/runner.js'

export const sparkHandlers = { spark, scheduledSpark }
export { scheduledSpark }

async function spark(e) {
  const argument = String(e.msg).replace(/^#(?:抖音)?续火/, '').trim()
  if (argument === '帮助') {
    await e.reply([
      '#抖音添加账号',
      '#抖音取消添加',
      '#抖音账号列表',
      '#抖音删除账号 账号名',
      '#抖音修改账号 账号名',
      '#抖音续火',
      '#抖音续火 账号名',
      '#抖音续火 全部（仅主人）',
      '#抖音设置邮箱 邮箱',
      '#抖音成功邮件开启',
      '#抖音成功邮件关闭',
      '#抖音邮箱',
      '#抖音清除邮箱',
      '#抖音插件更新（仅主人）',
      '#抖音插件强制更新（仅主人）',
      '#抖音插件更新日志',
    ].join('\n'))
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
    await e.reply(`抖音续火完成：成功发送 ${result.sent} 条消息。`)
  } catch (error) {
    logger.error('[抖音续火]', error)
    await e.reply(`抖音续火失败：${error.message}`)
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
