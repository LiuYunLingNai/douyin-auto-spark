import { runSpark } from '../components/runner.js'

export const sparkHandlers = { spark, scheduledSpark }
export { scheduledSpark }

async function spark(e) {
  const argument = String(e.msg).replace(/^#(?:抖音)?续火/, '').trim()
  if (argument === '帮助') {
    await e.reply([
      '抖音续火命令一览',
      '#抖音添加账号：发送一次性网页链接，添加账号并在网页中点选续火目标。',
      '#抖音取消添加：取消当前添加流程。',
      '#抖音账号列表：查看自己添加的账号别名和续火目标数量。',
      '#抖音删除账号 账号名：删除自己的指定账号及其续火目标。',
      '#抖音修改账号 账号名：私聊获取修改链接，可更新 Cookie 或重选续火目标。',
      '#抖音添加好友 [账号名]：发链接拉取会话列表勾选新增目标（Cookie 有效无需重扫）。',
      '#抖音好友列表 [账号名]：查看续火目标的 ID↔昵称 映射（自动刷新昵称）。',
      '#抖音删除好友 [账号名] 序号：删除指定续火目标。',
      '#抖音刷新昵称 [账号名]：批量刷新目标昵称，报告改名情况。',
      '#抖音续火：执行自己全部账号。',
      '#抖音续火 账号名：仅执行自己的指定账号。',
      '#抖音续火 全部（仅主人）：执行所有用户账号。',
      '#抖音设置邮箱 邮箱：私聊设置自己的失败通知收件邮箱。',
      '#抖音成功邮件开启：私聊开启自己的续火成功邮件通知。',
      '#抖音成功邮件关闭：私聊关闭自己的续火成功邮件通知。',
      '#抖音邮箱：私聊查看当前收件邮箱。',
      '#抖音清除邮箱：私聊清除收件邮箱，此后失败不发邮件。',
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
    const renameLines = result.successes.flatMap((item) => (item.renames ?? []).map((name) => `昵称变更：${name}`))
    const lines = [`抖音续火完成：成功发送 ${result.sent} 条消息。`]
    if (renameLines.length) lines.push(...renameLines)
    await e.reply(lines.join('\n'))
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
      const renames = userResults.successes.flatMap((item) => item.renames ?? [])
      if (renames.length) lines.push(...renames.map((item) => `昵称变更：${item}`))
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
