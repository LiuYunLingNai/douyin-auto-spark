// 续火目标（好友）管理：分享链接解析 sec_uid，前台展示昵称，后台按 ID 寻址
import {
  addTarget,
  deleteTarget,
  listAccounts,
  listTargets,
  updateTargetNickname,
} from '../components/database.js'
import {
  DouyinApiError,
  buildCookieHeader,
  fetchUserProfile,
  getCookieValue,
  resolveShareLink,
} from '../components/douyin-api.js'

export const targetHandlers = {
  addTargetByLink,
  targetList,
  removeTarget,
  refreshNicknames,
}

function shortId(secUid) {
  return secUid.length > 16 ? `${secUid.slice(0, 12)}…${secUid.slice(-4)}` : secUid
}

async function findAccount(e, name) {
  const accounts = await listAccounts(e.user_id)
  if (accounts.length === 0) {
    await e.reply('你还没有添加账号，请私聊机器人发送 #抖音ID添加账号。')
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

/** #抖音ID添加好友 [账号名] <分享口令或链接> */
async function addTargetByLink(e) {
  const rest = String(e.msg).replace(/^#抖音ID添加好友\s*/, '').trim()
  if (!rest) {
    await e.reply('用法：#抖音ID添加好友 [账号名] <分享口令或主页链接>\n例如：#抖音ID添加好友 主号 4.64 复制打开抖音… https://v.douyin.com/xxxx/')
    return true
  }

  const accounts = await listAccounts(e.user_id)
  if (accounts.length === 0) {
    await e.reply('你还没有添加账号，请私聊机器人发送 #抖音ID添加账号。')
    return true
  }

  // 第一个词若能匹配账号名则视为账号名，否则使用唯一账号
  let account
  let linkText = rest
  const [firstToken, ...restTokens] = rest.split(/\s+/)
  if (accounts.some((item) => item.name === firstToken)) {
    account = accounts.find((item) => item.name === firstToken)
    linkText = restTokens.join(' ')
  } else if (accounts.length === 1) {
    account = accounts[0]
  } else {
    await e.reply(`你有多个账号，请先指定账号名：\n#抖音ID添加好友 账号名 <分享链接>\n可用账号：${accounts.map((item) => item.name).join('、')}`)
    return true
  }
  if (!linkText) {
    await e.reply('请同时提供对方的分享口令或主页链接。')
    return true
  }

  try {
    await e.reply('正在解析分享链接…')
    const secUid = await resolveShareLink(linkText)
    const cookieHeader = buildCookieHeader(account.cookies)
    const profile = await fetchUserProfile(cookieHeader, secUid, {
      webid: getCookieValue(account.cookies, 's_v_web_id'),
      uifid: getCookieValue(account.cookies, 'UIFID'),
    })
    await addTarget({
      accountId: account.id,
      secUid,
      uid: profile.uid,
      nickname: profile.nickname,
    })
    await e.reply(`已添加续火目标：${profile.nickname || '（未获取到昵称）'}（ID: ${shortId(secUid)}）\n账号“${account.name}”后续续火将按 ID 发送，对方改名不影响送达。`)
  } catch (error) {
    if (error instanceof DouyinApiError && error.kind === 'auth') {
      await e.reply(`添加失败：${error.message}\n请通过 #抖音ID修改账号 更新 Cookie 后重试。`)
    } else {
      await e.reply(`添加失败：${error.message}`)
    }
  }
  return true
}

/** #抖音ID好友列表 [账号名]：展示映射并现场刷新昵称 */
async function targetList(e) {
  const name = String(e.msg).replace(/^#抖音ID好友列表\s*/, '').trim()
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
      lines.push('  （空，发送 #抖音ID添加好友 添加）')
      continue
    }
    const cookieHeader = buildCookieHeader(account.cookies)
    const webid = getCookieValue(account.cookies, 's_v_web_id')
    const uifid = getCookieValue(account.cookies, 'UIFID')
    for (const [index, target] of targets.entries()) {
      let display = target.nickname || '（未获取昵称）'
      let suffix = ''
      try {
        const profile = await fetchUserProfile(cookieHeader, target.secUid, { webid, uifid })
        if (profile.nickname && profile.nickname !== target.nickname) {
          suffix = `（已改名：${target.nickname || '未知'} → ${profile.nickname}）`
          display = profile.nickname
          await updateTargetNickname(target.id, profile.nickname)
        }
      } catch {
        suffix = '（昵称刷新失败）'
      }
      lines.push(`  ${index + 1}. ${display}（ID: ${shortId(target.secUid)}）${suffix}`)
    }
  }
  await e.reply(lines.join('\n'))
  return true
}

/** #抖音ID删除好友 [账号名] <序号> */
async function removeTarget(e) {
  const rest = String(e.msg).replace(/^#抖音ID删除好友\s*/, '').trim()
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
    await e.reply('用法：#抖音ID删除好友 [账号名] <序号>\n序号可通过 #抖音ID好友列表 查看。')
    return true
  }
  const targets = await listTargets(account.id)
  const target = targets[index - 1]
  if (!target) {
    await e.reply(`序号 ${index} 不存在，该账号共 ${targets.length} 个续火目标。`)
    return true
  }
  await deleteTarget(account.id, target.id)
  await e.reply(`已删除续火目标：${target.nickname || '（未知昵称）'}（ID: ${shortId(target.secUid)}）`)
  return true
}

/** #抖音ID刷新昵称 [账号名]：批量刷新 ID->昵称 映射 */
async function refreshNicknames(e) {
  const name = String(e.msg).replace(/^#抖音ID刷新昵称\s*/, '').trim()
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
        await updateTargetNickname(target.id, profile.nickname)
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
