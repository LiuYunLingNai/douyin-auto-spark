import plugin from '../../../lib/plugins/plugin.js'
import schedule from 'node-schedule'
import { getConfig } from '../components/config.js'
import { watchConfig } from '../components/config.js'
import { accountHandlers } from './account.js'
import { targetHandlers } from './target.js'
import { sparkHandlers, scheduledSpark } from './spark.js'
import { registerSetupRoutes } from '../components/web-setup.js'

let scheduledJob
let scheduleConfigured = false
let scheduleTimer

function configureScheduledSpark() {
  if (scheduleConfigured) return
  scheduleConfigured = true
  refreshScheduledSpark()
  watchConfig(() => {
    clearTimeout(scheduleTimer)
    scheduleTimer = setTimeout(refreshScheduledSpark, 150)
  })
}

function refreshScheduledSpark() {
  scheduledJob?.cancel()
  scheduledJob = undefined
  const config = getConfig()
  if (config.schedule.enabled === false) return
  const cron = normalizeCron(config.schedule.cron)
  if (!cron) {
    logger.error('[抖音续火] Cron 表达式格式无效，未创建定时任务')
    return
  }
  const job = schedule.scheduleJob(cron, scheduledSpark)
  if (!job) {
    logger.error(`[抖音续火] Cron 表达式无效，未创建定时任务：${cron || '空'}`)
    return
  }
  scheduledJob = job
}

function normalizeCron(value) {
  let fields = String(value || '').trim().split(/\s+/).filter(Boolean)
  if (fields.length === 5) fields = ['0', ...fields]
  if (fields.length === 7) fields = fields.slice(0, 6)
  if (fields.length !== 6) return ''
  return fields.map((field) => field === '?' ? '*' : field).join(' ')
}

export class DouyinIdSpark extends plugin {
  constructor() {
    super({
      name: '抖音ID续火',
      dsc: '基于抖音私信 API、按用户 ID 寻址的续火插件',
      event: 'message',
      priority: -5000,
      rule: [
        { reg: '^#抖音添加账号$', fnc: 'startAddAccount', permission: 'all' },
        { reg: '^#抖音取消添加$', fnc: 'cancelAddAccount', permission: 'all' },
        { reg: '^#抖音账号列表$', fnc: 'accountList', permission: 'all' },
        { reg: '^#抖音删除账号\\s+.+$', fnc: 'removeAccount', permission: 'all' },
        { reg: '^#抖音修改账号\\s+.+$', fnc: 'editAccount', permission: 'all' },
        { reg: '^#抖音添加好友(?:\\s+.+)?$', fnc: 'addTargetViaWeb', permission: 'all' },
        { reg: '^#抖音好友列表(?:\\s+.+)?$', fnc: 'targetList', permission: 'all' },
        { reg: '^#抖音删除好友(?:\\s+.+)?$', fnc: 'removeTarget', permission: 'all' },
        { reg: '^#抖音刷新昵称(?:\\s+.+)?$', fnc: 'refreshNicknames', permission: 'all' },
        { reg: '^#抖音设置邮箱\\s+\\S+$', fnc: 'setEmail', permission: 'all' },
        { reg: '^#抖音成功邮件开启$', fnc: 'enableSuccessEmail', permission: 'all' },
        { reg: '^#抖音成功邮件关闭$', fnc: 'disableSuccessEmail', permission: 'all' },
        { reg: '^#抖音清除邮箱$', fnc: 'clearEmail', permission: 'all' },
        { reg: '^#抖音邮箱$', fnc: 'showEmail', permission: 'all' },
        { reg: '^#(?:抖音)?续火(?:\\s*(?:帮助|.+))?$', fnc: 'spark', permission: 'all' },
        { event: 'message.private', reg: '.*', fnc: 'setupFile', permission: 'all', log: false },
        { reg: '^(?!#)[\\s\\S]+$', fnc: 'setupInput', permission: 'all', log: false },
      ],
      task: [],
    })
    configureScheduledSpark()
    registerSetupRoutes()
  }
}

Object.assign(DouyinIdSpark.prototype, accountHandlers, targetHandlers, sparkHandlers)
