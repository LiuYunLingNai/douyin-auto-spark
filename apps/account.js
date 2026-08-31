import {
  addAccount,
  clearSetupSession,
  deleteAccount,
  getSetupSession,
  getUserNotificationSettings,
  listAccounts,
  saveSetupSession,
  setUserEmail,
  setUserSuccessEmailEnabled,
} from '../components/database.js'
import {
  isPrivate,
  isValidEmail,
  parseCookies,
  parseTargetNames,
  readCookieTextFile,
  validateTemplate,
} from '../components/account-setup.js'
import { createSetupLink, revokeSetupLinks } from '../components/web-setup.js'

export const accountHandlers = {
  startAddAccount,
  cancelAddAccount,
  setupInput,
  setupFile,
  accountList,
  removeAccount,
  editAccount,
  setEmail,
  enableSuccessEmail,
  disableSuccessEmail,
  clearEmail,
  showEmail,
}

async function startAddAccount(e) {
  try {
    await clearSetupSession(e.user_id)
    const { url, expiresMinutes } = createSetupLink({ userId: e.user_id })
    await e.reply(`请在 ${expiresMinutes} 分钟内打开链接添加账号：\n${url}`)
  } catch (error) {
    logger.error('[抖音续火] 创建账号配置链接失败', error)
    await e.reply(`创建网页链接失败：${error.message}`)
  }
  return true
}

async function cancelAddAccount(e) {
  await clearSetupSession(e.user_id)
  revokeSetupLinks(e.user_id)
  await e.reply('已取消添加账号，网页链接已失效。')
  return true
}

async function setupInput(e) {
  if (!isPrivate(e)) return false
  const session = await getSetupSession(e.user_id)
  if (!session) return false

  const input = String(e.msg || '').trim()
  try {
    if (session.step === 'name') {
      if (!input) return false
      if (input.length > 40) throw new Error('账号名称不能超过 40 个字符')
      const accounts = await listAccounts(e.user_id)
      if (accounts.some((account) => account.name === input)) {
        throw new Error(`已存在名为“${input}”的账号，请换一个名称`)
      }
      await saveSetupSession(e.user_id, 'cookie', { name: input })
      await e.reply('第 2/4 步：请上传包含完整 Cookie JSON 数组的 .txt 文件，也可直接粘贴。')
    } else if (session.step === 'cookie') {
      if (!input) {
        await e.reply('请上传包含完整 Cookie JSON 数组的 .txt 文件，也可直接粘贴。')
        return true
      }
      await saveCookies(e, session, input)
    } else if (session.step === 'targetNames') {
      if (!input) return false
      const targetNames = parseTargetNames(input)
      await saveSetupSession(e.user_id, 'messageTemplate', { ...session.draft, targetNames })
      await e.reply('第 4/4 步：发送消息模板；回复“默认”使用全局默认消息。支持 {{friend}}、{{yiyan}} 等占位符。')
    } else if (session.step === 'messageTemplate') {
      if (!input) return false
      const messageTemplate = ['默认', '跳过', '-'].includes(input) ? '' : input
      validateTemplate(messageTemplate)
      await addAccount({
        userId: e.user_id,
        name: session.draft.name,
        cookies: session.draft.cookies,
        targetNames: session.draft.targetNames,
        messageTemplate,
      })
      await clearSetupSession(e.user_id)
      await e.reply(`账号“${session.draft.name}”已添加。发送 #抖音续火 可执行你的全部账号。`)
    } else {
      await clearSetupSession(e.user_id)
      await e.reply('配置会话已失效，请重新发送 #抖音添加账号。')
    }
  } catch (error) {
    await e.reply(`输入无效：${error.message}\n请重新发送当前步骤内容，或发送 #抖音取消添加。`)
  }
  return true
}

async function setupFile(e) {
  if (!isPrivate(e) || !e.file) return false
  const session = await getSetupSession(e.user_id)
  if (session?.step !== 'cookie') return false

  try {
    await saveCookies(e, session, await readCookieTextFile(e))
  } catch (error) {
    await e.reply(`文件无效：${error.message}\n请重新上传当前步骤的 .txt 文件，或发送 #抖音取消添加。`)
  }
  return true
}

async function accountList(e) {
  const accounts = await listAccounts(e.user_id)
  if (accounts.length === 0) {
    await e.reply('你还没有添加账号，请私聊机器人发送 #抖音添加账号。')
    return true
  }
  await e.reply(`你的抖音账号：\n${accounts.map((account) => `- ${account.name}（${account.targetNames.length} 个会话）`).join('\n')}`)
  return true
}

async function removeAccount(e) {
  const name = String(e.msg).replace(/^#抖音删除账号\s+/, '').trim()
  const removed = await deleteAccount(e.user_id, name)
  await e.reply(removed ? `账号“${name}”已删除。` : `未找到名为“${name}”的账号。`)
  return true
}

async function editAccount(e) {
  if (!isPrivate(e)) {
    await e.reply('为保护 Cookie，请私聊机器人发送 #抖音修改账号 账号名。')
    return true
  }
  const name = String(e.msg).replace(/^#抖音修改账号\s+/, '').trim()
  const account = (await listAccounts(e.user_id)).find((item) => item.name === name)
  if (!account) {
    await e.reply(`未找到名为“${name}”的账号。`)
    return true
  }
  try {
    const { url, expiresMinutes } = createSetupLink({ userId: e.user_id, accountId: account.id })
    await e.reply(`请在 ${expiresMinutes} 分钟内打开链接修改账号“${name}”：\n${url}`)
  } catch (error) {
    logger.error('[抖音续火] 创建账号修改链接失败', error)
    await e.reply(`创建网页链接失败：${error.message}`)
  }
  return true
}

async function setEmail(e) {
  if (!isPrivate(e)) {
    await e.reply('为保护邮箱隐私，请私聊机器人设置收件邮箱。')
    return true
  }
  const email = String(e.msg).replace(/^#抖音设置邮箱\s+/, '').trim()
  if (!isValidEmail(email)) {
    await e.reply('邮箱格式不正确，请重新发送 #抖音设置邮箱 your@example.com。')
    return true
  }
  await setUserEmail(e.user_id, email)
  await e.reply(`失败通知收件邮箱已设置为：${email}`)
  return true
}

async function clearEmail(e) {
  if (!isPrivate(e)) {
    await e.reply('请私聊机器人清除收件邮箱。')
    return true
  }
  await setUserEmail(e.user_id, '')
  await setUserSuccessEmailEnabled(e.user_id, false)
  await e.reply('已清除收件邮箱。你的任务失败时将不会发送邮件。')
  return true
}

async function showEmail(e) {
  if (!isPrivate(e)) {
    await e.reply('请私聊机器人查看收件邮箱。')
    return true
  }
  const notification = (await getUserNotificationSettings([e.user_id])).get(String(e.user_id))
  if (!notification?.email) {
    await e.reply('尚未设置收件邮箱，任务成功或失败时都不会发送邮件。')
    return true
  }
  await e.reply(`当前收件邮箱：${notification.email}\n成功邮件通知：${notification.successEmailEnabled ? '已开启' : '已关闭'}\n失败邮件通知：已开启`)
  return true
}

async function enableSuccessEmail(e) {
  if (!isPrivate(e)) {
    await e.reply('请私聊机器人开启成功邮件通知。')
    return true
  }
  const notification = (await getUserNotificationSettings([e.user_id])).get(String(e.user_id))
  if (!notification?.email) {
    await e.reply('请先发送 #抖音设置邮箱 your@example.com，再开启成功邮件通知。')
    return true
  }
  await setUserSuccessEmailEnabled(e.user_id, true)
  await e.reply('已开启续火成功邮件通知。')
  return true
}

async function disableSuccessEmail(e) {
  if (!isPrivate(e)) {
    await e.reply('请私聊机器人关闭成功邮件通知。')
    return true
  }
  await setUserSuccessEmailEnabled(e.user_id, false)
  await e.reply('已关闭续火成功邮件通知。')
  return true
}

async function saveCookies(e, session, cookieText) {
  const { cookies, ignored } = parseCookies(cookieText)
  await saveSetupSession(e.user_id, 'targetNames', { ...session.draft, cookies })
  const skipped = ignored ? `已忽略 ${ignored} 条无法使用的 Cookie。\n` : ''
  await e.reply(`${skipped}第 3/4 步：请发送目标会话名称。可发送 JSON 数组，例如 ["好友A","好友B"]，也可用逗号分隔。`)
}
