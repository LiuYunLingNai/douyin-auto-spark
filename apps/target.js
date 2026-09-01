// 续火目标（好友）管理：查看 ID↔昵称 映射、删除、刷新昵称
// 目标的添加在添加/修改账号的网页中完成（拉取会话列表点选）
import {
  deleteTarget,
  listAccounts,
  listTargets,
  updateTargetProfile,
} from '../components/database.js'
import {
  buildCookieHeader,
  fetchUserProfile,
  getCookieValue,
} from '../components/douyin-api.js'

import {
  bindSetupMessage,
  createSetupLink,
} from '../components/web-setup.js'

export const targetHandlers = {
  targetList,
  removeTarget,
  refreshNicknames,
  addTargetViaWeb,
}

/** #抖音添加好友 [账号名]：发送一次性网页链接，重新拉取会话列表勾选新增目标（Cookie 有效无需重扫） */
async function addTargetViaWeb(e) {
  const name = String(e.msg).replace(/^#抖音添加好友\s*/, '').trim()
  const account = await findAccount(e, name)
  if (!account) return true
  try {
    const { token, url, expiresMinutes } = createSetupLink({ userId: e.user_id, accountId: account.id })
    const sent = await e.reply([
      `请在 ${expiresMinutes} 分钟内打开链接为账号“${account.name}”增删续火目标：`,
      url,
      '打开后点击「拉取会话列表」，勾选新人后提交即可；已勾选的目标保持不变，Cookie 未过期无需重新扫码。',
    ].join('\n'))
    bindSetupMessage(token, e, sent?.message_id)
  } catch (error) {
    logger.error('[抖音续火] 创建好友添加链接失败', error)
    await e.reply(`创建网页链接失败：${error.message}`)
  }
  return true
}

function shortId(secUid) {
  return secUid.length > 16 ? `${secUid.slice(0, 12)}…${secUid.slice(-4)}` : secUid
}

/** 前台展示用：昵称 + 抖音号（若有）；sec_uid 为内部寻址字段，不对用户展示 */
function displayTarget(target) {
  const name = target.nickname || '（未获取昵称）'
  return target.uniqueId ? `${name}（抖音号: ${target.uniqueId}）` : name
}

async function findAccount(e, name) {
  const accounts = await listAccounts(e.user_id)
  if (accounts.length === 0) {
    await e.reply('你还没有添加账号，请私聊机器人发送 #抖音添加账号。')
    return undefined
  }
  const account = name ? accounts.find((item) => item.name === name) : accounts[0]
  if (!account) {
    await e.reply(`未找到名为“${name}”的账号，可用账号：${accounts.map((item) => item.name).join('、')}`)
    return undefined
  }
  if (!name && accounts.length > 1) {
    await e.reply(`你有多个账号，请指定账号名：${accounts.map((item) => item.name).join('、')}`)
    return undefined
  }
  return account
}

/** #抖音好友列表 [账号名]：展示映射并现场刷新昵称 */
async function targetList(e) {
  const name = String(e.msg).replace(/^#抖音好友列表\s*/, '').trim()
  const accounts = await listAccounts(e.user_id)
  const selected = name ? accounts.filter((item) => item.name === name) : accounts
  if (selected.length === 0) {
    await e.reply(name ? `未找到名为“${name}”的账号。` : '你还没有添加账号。')
    return true
  }

  const lines = []
  for (const account of selected) {
    const targets = await listTargets(account.id)
    lines.push(`【${account.name}】共 ${targets.length} 个续火目标`)
    if (targets.length === 0) {
      lines.push('  （空，发送 #抖音修改账号 在网页中拉取会话列表选择）')
      continue
    }
    const cookieHeader = buildCookieHeader(account.cookies)
    const webid = getCookieValue(account.cookies, 's_v_web_id')
    const uifid = getCookieValue(account.cookies, 'UIFID')
    for (const [index, target] of targets.entries()) {
      let shown = { ...target }
      let suffix = ''
      try {
        const profile = await fetchUserProfile(cookieHeader, target.secUid, { webid, uifid })
        if (profile.nickname && profile.nickname !== target.nickname) {
          suffix = `（已改名：${target.nickname || '未知'} → ${profile.nickname}）`
        }
        if ((profile.nickname && profile.nickname !== target.nickname) || (profile.uniqueId && profile.uniqueId !== target.uniqueId)) {
          await updateTargetProfile(target.id, {
            nickname: profile.nickname || target.nickname,
            uniqueId: profile.uniqueId || target.uniqueId,
          })
        }
        shown = { ...target, nickname: profile.nickname || target.nickname, uniqueId: profile.uniqueId || target.uniqueId }
      } catch {
        suffix = '（昵称刷新失败）'
      }
      lines.push(`  ${index + 1}. ${displayTarget(shown)}${suffix}`)
    }
  }
  await e.reply(lines.join('\n'))
  return true
}

/** #抖音删除好友 [账号名] <序号> */
async function removeTarget(e) {
  const rest = String(e.msg).replace(/^#抖音删除好友\s*/, '').trim()
  const tokens = rest.split(/\s+/).filter(Boolean)
  let name = ''
  let indexText = tokens[0] || ''
  const accounts = await listAccounts(e.user_id)
  if (tokens.length >= 2 && accounts.some((item) => item.name === tokens[0])) {
    name = tokens[0]
    indexText = tokens[1]
  }
  const account = await findAccount(e, name)
  if (!account) return true

  const index = Number(indexText)
  if (!Number.isInteger(index) || index < 1) {
    await e.reply('用法：#抖音删除好友 [账号名] <序号>\n序号可通过 #抖音好友列表 查看。')
    return true
  }
  const targets = await listTargets(account.id)
  const target = targets[index - 1]
  if (!target) {
    await e.reply(`序号 ${index} 不存在，该账号共 ${targets.length} 个续火目标。`)
    return true
  }
  await deleteTarget(account.id, target.id)
  await e.reply(`已删除续火目标：${displayTarget(target)}`)
  return true
}

/** #抖音刷新昵称 [账号名]：批量刷新 ID->昵称 映射 */
async function refreshNicknames(e) {
  const name = String(e.msg).replace(/^#抖音刷新昵称\s*/, '').trim()
  const account = await findAccount(e, name)
  if (!account) return true

  const targets = await listTargets(account.id)
  if (targets.length === 0) {
    await e.reply(`账号“${account.name}”还没有续火目标。`)
    return true
  }
  await e.reply(`正在刷新 ${targets.length} 个目标的昵称…`)
  const cookieHeader = buildCookieHeader(account.cookies)
  const webid = getCookieValue(account.cookies, 's_v_web_id')
  const uifid = getCookieValue(account.cookies, 'UIFID')
  const changes = []
  const failures = []
  for (const target of targets) {
    try {
      const profile = await fetchUserProfile(cookieHeader, target.secUid, { webid, uifid })
      if (profile.nickname && profile.nickname !== target.nickname) {
        await updateTargetProfile(target.id, { nickname: profile.nickname, uniqueId: profile.uniqueId })
        changes.push(`${target.nickname || '（未知）'} → ${profile.nickname}`)
      }
    } catch (error) {
      failures.push(`${target.nickname || shortId(target.secUid)}：${error.message}`)
    }
  }
  const lines = [`昵称刷新完成：共 ${targets.length} 个目标，变更 ${changes.length} 个，失败 ${failures.length} 个。`]
  if (changes.length) lines.push('变更明细：', ...changes.map((item) => `- ${item}`))
  if (failures.length) lines.push('失败明细：', ...failures.map((item) => `- ${item}`))
  await e.reply(lines.join('\n'))
  return true
}
