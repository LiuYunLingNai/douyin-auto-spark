import plugin from '../../../lib/plugins/plugin.js'
import schedule from 'node-schedule'
import { getConfig } from '../components/config.js'
import { watchConfig } from '../components/config.js'
import { accountHandlers } from './account.js'
import { sparkHandlers, scheduledSpark } from './spark.js'
import { registerSetupRoutes } from '../components/web-setup.js'

let scheduledJob
let scheduleConfigured = false
let scheduleTimer
let setupRoutesError

/** 时区与消息模板里的日期保持一致：服务器不在东八区时，也按北京时间的零点续火 */
const SCHEDULE_TIMEZONE = 'Asia/Shanghai'

function onConfigChange() {
  clearTimeout(scheduleTimer)
  scheduleTimer = setTimeout(refreshScheduledSpark, 150)
}

/**
 * 构造函数在每条消息上都会执行，这里不能抛错。
 * 配置暂时读不了时只记日志；监听装上后，配置修好会自动重建定时任务。
 */
function configureScheduledSpark() {
  if (scheduleConfigured) return
  try {
    watchConfig(onConfigChange)
    scheduleConfigured = true
  } catch (error) {
    logger.error('[抖音续火] 配置文件读取失败，暂未创建定时任务', error)
    return
  }
  refreshScheduledSpark()
}

function refreshScheduledSpark() {
  scheduledJob?.cancel()
  scheduledJob = undefined
  let config
  try {
    config = getConfig()
  } catch (error) {
    logger.error('[抖音续火] 配置文件读取失败，未创建定时任务', error)
    return
  }
  if (config.schedule.enabled === false) return
  const cron = normalizeCron(config.schedule.cron)
  if (!cron) {
    logger.error('[抖音续火] Cron 表达式格式无效，未创建定时任务')
    return
  }
  const job = schedule.scheduleJob({ rule: cron, tz: SCHEDULE_TIMEZONE }, scheduledSpark)
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

export class DouyinAutoSpark extends plugin {
  constructor() {
    super({
      name: '抖音续火',
      dsc: '多人独立管理抖音续火账号',
      event: 'message',
      priority: -5000,
      rule: [
        { reg: '^#抖音管理账号$', fnc: 'manageAccounts', permission: 'master' },
        { reg: '^#抖音添加账号$', fnc: 'startAddAccount', permission: 'all' },
        { reg: '^#抖音取消添加$', fnc: 'cancelAddAccount', permission: 'all' },
        { reg: '^#抖音账号列表$', fnc: 'accountList', permission: 'all' },
        { reg: '^#抖音删除账号\\s+.+$', fnc: 'removeAccount', permission: 'all' },
        { reg: '^#抖音修改账号\\s+.+$', fnc: 'editAccount', permission: 'all' },
        { reg: '^#抖音设置邮箱\\s+\\S+$', fnc: 'setEmail', permission: 'all' },
        { reg: '^#抖音成功邮件开启$', fnc: 'enableSuccessEmail', permission: 'all' },
        { reg: '^#抖音成功邮件关闭$', fnc: 'disableSuccessEmail', permission: 'all' },
        { reg: '^#抖音清除邮箱$', fnc: 'clearEmail', permission: 'all' },
        { reg: '^#抖音邮箱$', fnc: 'showEmail', permission: 'all' },
        { reg: '^#(?:抖音)?续火(?:\\s*(?:帮助|.+))?$', fnc: 'spark', permission: 'all' },
      ],
      task: [],
    })
    configureScheduledSpark()
    try {
      registerSetupRoutes()
    } catch (error) {
      // 同一原因只记一次，避免每条消息刷屏；用户发命令时会拿到具体报错
      if (setupRoutesError !== error.message) {
        setupRoutesError = error.message
        logger.error('[抖音续火] 网页服务注册失败', error)
      }
    }
  }
}

Object.assign(DouyinAutoSpark.prototype, accountHandlers, sparkHandlers)
