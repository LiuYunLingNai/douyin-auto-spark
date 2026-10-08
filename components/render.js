/**
 * UI 渲染层 —— 把插件的文字输出升级为「图片卡片 + QQBot 按钮」
 *
 * 视觉规范：douyin-ui-spec（深色 #161823 / 洋红 #FE2C55 / 青 #25F4EE / 900px 画布）
 * 渲染链路：e.runtime.render('douyin-auto-spark', 'render/<page>/index', data, { retType:'base64' })
 *           → TRSS 渲染器写 temp/html 并用 Puppeteer 截 #container
 * 按钮链路：globalThis.segment.button(...rows)（QQBot-Plugin 公开 API，不修改其任何文件）；
 *           平台 callback 通道受限，统一用 input + enter:true（自动填入并发送指令）。
 *
 * 降级策略：config.render.enabled === false、无 segment.button（非 QQBot 适配器）
 *           或渲染抛错时，自动回退原有纯文字回复 —— 功能逻辑零改动。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getConfig } from './config.js'

const PLUGIN_NAME = 'douyin-auto-spark'
const COMPONENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HELP_FILE = path.join(COMPONENT_ROOT, 'config', 'help.js')

/* ---------------- 图标（douyin-ui-spec §2，原创绘制，24×24 / 2px 描边） ---------------- */

const ICONS = {
  account: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>`,
  add: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18 10a2.8 2.8 0 0 0-4-4L4 16v4z"/></svg>`,
  delete: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>`,
  cancel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  flame: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c0 4-5 6-5 10.5a5 5 0 0 0 10 0C17 8 14 6.5 12 2z"/><path d="M12 22a3 3 0 0 1-3-3c0-2 2-2.5 3-4 1 1.5 3 2 3 4a3 3 0 0 1-3 3z"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>`,
  star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8z"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.2"/><circle cx="15" cy="17" r="2.2"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></svg>`,
  update: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 3v5h-5"/></svg>`,
}

/* ---------------- 数据构建 ---------------- */

/** 内置默认指令清单：config/help.js 缺失时兜底 */
const DEFAULT_HELP = {
  helpCfg: { title: '抖音续火', subTitle: 'DOUYIN AUTO SPARK · 自动续上你的火花', colCount: 2 },
  helpList: [
    {
      group: '账号管理', icon: 'account',
      list: [
        { icon: 'add', title: '#抖音添加账号', desc: '发送一次性网页链接，扫码或粘贴 Cookie 添加账号' },
        { icon: 'list', title: '#抖音账号列表', desc: '查看自己的账号别名和会话数量' },
        { icon: 'edit', title: '#抖音修改账号 账号名', desc: '私聊获取修改链接，Cookie 留空则保留原值' },
        { icon: 'delete', title: '#抖音删除账号 账号名', desc: '删除自己的指定账号' },
        { icon: 'cancel', title: '#抖音取消添加', desc: '取消当前添加流程，网页链接失效' },
      ],
    },
    {
      group: '续火执行', icon: 'flame',
      list: [
        { icon: 'flame', title: '#抖音续火', desc: '执行自己的全部账号' },
        { icon: 'star', title: '#抖音续火 账号名', desc: '仅执行自己的指定账号' },
        { icon: 'settings', title: '#抖音续火 帮助', desc: '查看这份命令清单' },
      ],
    },
    {
      group: '邮件通知', icon: 'mail',
      list: [
        { icon: 'mail', title: '#抖音设置邮箱 邮箱', desc: '私聊设置自己的失败通知收件邮箱' },
        { icon: 'bell', title: '#抖音成功邮件开启', desc: '私聊开启续火成功邮件通知' },
        { icon: 'bell', title: '#抖音成功邮件关闭', desc: '私聊关闭续火成功邮件通知' },
        { icon: 'list', title: '#抖音邮箱', desc: '私聊查看当前收件邮箱' },
        { icon: 'delete', title: '#抖音清除邮箱', desc: '私聊清除收件邮箱，此后失败不发邮件' },
      ],
    },
    {
      group: '管理维护', icon: 'shield', auth: 'master',
      list: [
        { icon: 'shield', title: '#抖音管理账号', desc: '打开管理网页，查看与管理全部账号' },
        { icon: 'update', title: '#抖音插件更新', desc: '更新抖音续火插件' },
        { icon: 'update', title: '#抖音插件强制更新', desc: '丢弃本地改动后强制更新' },
        { icon: 'list', title: '#抖音插件更新日志', desc: '查看插件更新日志' },
      ],
    },
  ],
}

/** 读取 config/help.js（带时间戳导入，改动后无需重启） */
async function loadHelpFile() {
  if (!fs.existsSync(HELP_FILE)) return DEFAULT_HELP
  try {
    const mod = await import(`file://${HELP_FILE.replace(/\\/g, '/')}?t=${Date.now()}`)
    const cfg = mod.default || mod
    if (!Array.isArray(cfg.helpList)) return DEFAULT_HELP
    return cfg
  } catch (error) {
    logger.error('[抖音续火] config/help.js 读取失败，已使用内置指令清单', error)
    return DEFAULT_HELP
  }
}

/**
 * 构建帮助页数据
 * 布局结构（参考 miao-plugin Help）：横幅 helpCfg + 分组 helpGroup（条目 icon/title/desc）
 * @param {object} [opt]
 * @param {object} [opt.e] 事件对象，用于过滤 master 分组
 */
export async function buildHelpData({ e, version, accountCount, targetCount, scheduleDesc } = {}) {
  const { helpCfg = {}, helpList = [] } = await loadHelpFile()
  const isMaster = !!e?.isMaster
  const colCount = Math.min(3, Math.max(parseInt(helpCfg.colCount) || 2, 1))

  const helpGroup = []
  for (const group of helpList) {
    if (group.auth === 'master' && !isMaster) continue
    helpGroup.push({
      group: group.group || '未分组',
      icon: ICONS[group.icon] || ICONS.list,
      auth: group.auth || '',
      list: (group.list || []).map((item) => ({
        icon: ICONS[item.icon] || '',
        title: item.title || '',
        desc: item.desc || '',
      })),
    })
  }

  return {
    helpCfg: {
      title: helpCfg.title || '抖音续火',
      subTitle: helpCfg.subTitle || 'DOUYIN AUTO SPARK',
    },
    helpGroup,
    colCount,
    version: version || '1.0.0',
    accountCount: accountCount ?? 0,
    targetCount: targetCount ?? 0,
    scheduleDesc: scheduleDesc || '未启用',
  }
}

export function buildAccountListData(accounts = []) {
  const count = accounts.length
  const targetCount = accounts.reduce((total, account) => total + (account.targetNames?.length || 0), 0)
  const customTplCount = accounts.filter((account) => account.messageTemplate).length
  return {
    hasAccount: count > 0,
    count,
    targetCount,
    customTplCount,
    accounts: accounts.map((account, index) => ({
      index: index + 1,
      name: account.name,
      targetCount: account.targetNames?.length || 0,
      targets: (account.targetNames || []).join('、') || '未配置会话',
      hasTemplate: !!account.messageTemplate,
      douyinUid: !!account.douyinUid,
    })),
  }
}

export function buildSparkResultData(result = {}, { trigger = '手动执行' } = {}) {
  const successes = result.successes || []
  const failures = result.failures || []
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return {
    time: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    trigger,
    sent: result.sent ?? successes.reduce((total, item) => total + (item.sent || 0), 0),
    okCount: successes.length,
    failCount: failures.length,
    successes,
    failures,
  }
}

/* ---------------- QQBot 按钮编排（douyin-ui-spec §07） ---------------- */

/** 构造单个指令按钮：input + enter:true（callback 通道已受限，不使用） */
function btn(text, input, opt = {}) {
  const clip = String(text).slice(0, 6)
  return {
    text: clip,
    input,
    enter: opt.enter ?? true,
    ...(opt.style != null ? { style: opt.style } : {}),
    ...(opt.clicked_text ? { clicked_text: opt.clicked_text } : {}),
    ...(opt.permission ? { permission: opt.permission } : {}),
  }
}

/** 账号名按钮文案：超长截断显示，input 保持完整指令 */
function accountBtn(name) {
  const short = String(name).length > 3 ? `${String(name).slice(0, 3)}…` : String(name)
  return btn(`续火 ${short}`.slice(0, 6), `#抖音续火 ${name}`, { style: 1 })
}

export function helpRows({ isMaster = false } = {}) {
  const row = [
    btn('立即续火', '#抖音续火', { style: 4 }),
    btn('账号列表', '#抖音账号列表', { style: 1 }),
    btn('添加账号', '#抖音添加账号'),
  ]
  // 管理网页仅主人可用：按钮层再加一道权限限制
  if (isMaster) row.push(btn('管理账号', '#抖音管理账号', { permission: 'admin' }))
  return [row]
}

export function accountListRows(accounts = []) {
  const rows = [[
    btn('立即续火', '#抖音续火', { style: 4 }),
    btn('添加账号', '#抖音添加账号', { style: 1 }),
    btn('帮助', '#抖音续火帮助'),
  ]]
  if (accounts.length > 0) {
    rows.push(accounts.slice(0, 4).map((account) => accountBtn(account.name)))
  }
  return rows
}

export function sparkResultRows(result = {}) {
  const failures = result.failures || []
  if (failures.length === 0) {
    return [[
      btn('账号列表', '#抖音账号列表', { style: 1 }),
      btn('帮助', '#抖音续火帮助'),
    ]]
  }
  return [
    [btn('重试全部', '#抖音续火', { style: 4 })],
    failures.slice(0, 3).map((failure) => accountBtn(failure.accountName)),
  ]
}

/* ---------------- 渲染入口 ---------------- */

export function renderEnabled() {
  return getConfig().render?.enabled !== false
}

/**
 * 输出一张规范卡片（带按钮时图 + 按钮合并成一条消息）
 *
 * @param {object} e        Yunzai 事件对象
 * @param {string} page     模板页名：help / account-list / spark-result
 * @param {object} data     模板数据
 * @param {object} [opt]
 * @param {Array<Array<object>>} [opt.buttons] 按钮行数组（QQBot-Plugin segment.button 规范）
 * @param {string} [opt.fallback] 渲染失败 / 已关闭渲染时的纯文字回退
 * @returns {Promise<boolean>} 图片是否成功发出
 */
export async function renderCard(e, page, data = {}, { buttons = null, fallback = '' } = {}) {
  if (!renderEnabled()) {
    if (fallback) await e.reply(fallback)
    return false
  }

  const seg = globalThis.segment
  const rows = buttons?.filter((row) => Array.isArray(row) && row.length).slice(0, 5)
  const tplPath = `render/${page}/index`
  const saveId = `douyin-spark-${page}-${Date.now()}`

  try {
    if (rows?.length && seg?.button) {
      const img = await e.runtime.render(PLUGIN_NAME, tplPath, { saveId, ...data }, { retType: 'base64' })
      if (img) {
        await e.reply([img, seg.button(...rows)])
        return true
      }
      logger.warn('[抖音续火] 渲染返回空结果，回退文字输出')
    } else {
      await e.runtime.render(PLUGIN_NAME, tplPath, { saveId, ...data })
      return true
    }
  } catch (error) {
    logger.error('[抖音续火] 渲染图片失败，已回退文字输出', error)
  }

  if (fallback) await e.reply(fallback)
  return false
}
