import { getConfig, saveConfig } from '../components/config.js'

const schemas = [
  {
    field: 'schedule.enabled',
    label: '启用定时续火',
    bottomHelpMessage: '关闭后不会按计划自动执行，仍可手动发送 #抖音续火。保存后立即生效。',
    component: 'Switch',
    defaultValue: true,
  },
  {
    field: 'schedule.cron',
    label: 'Cron 表达式',
    bottomHelpMessage: '使用 6 段（秒 分 时 日 月 周），例如每天 08:10：0 10 8 * * *。保存后会自动重新安排定时任务。',
    component: 'EasyCron',
    required: false,
    componentProps: { placeholder: '0 10 8 * * *' },
  },
  {
    field: 'browser.executablePath',
    label: '浏览器路径',
    bottomHelpMessage: '指定本机 Chrome 或 Edge 的可执行文件路径；留空则使用 Playwright 安装的浏览器。',
    component: 'Input',
    placeholder: '留空使用 Playwright 浏览器',
  },
  {
    field: 'browser.headless',
    label: '无头模式',
    bottomHelpMessage: '开启后浏览器在后台运行，不显示窗口；排查页面问题时可关闭。',
    component: 'Switch',
    defaultValue: true,
  },
  {
    field: 'message.includeSource',
    label: '一言附带出处',
    bottomHelpMessage: '未设置账号专属消息模板时，是否在随机一言后附带出处。',
    component: 'Switch',
    defaultValue: true,
  },
  {
    field: 'message.template',
    label: '默认消息模板',
    bottomHelpMessage: '留空则发送随机一言。可用 {{account}}、{{friend}}、{{yiyan}}、{{from}}、{{date}}、{{time}}、{{weekday}}。',
    component: 'Textarea',
    rows: 3,
    placeholder: '{{friend}}，今天来续火啦\\n{{yiyan}}',
  },
  { component: 'Divider', label: '网页账号配置' },
  {
    field: 'web.mountToTrss',
    label: '挂载到 TRSS 网页服务',
    bottomHelpMessage: '开启时页面路径为 /douyin-auto-spark；关闭后插件使用独立端口。私聊添加或修改账号可获取一次性网页链接。',
    component: 'Switch',
    defaultValue: true,
  },
  {
    field: 'web.standalonePort',
    label: '独立网页端口',
    bottomHelpMessage: '仅在未挂载到 TRSS 时使用。端口需未被其他程序占用；修改端口后需重启云崽。',
    component: 'InputNumber',
    min: 1,
    max: 65535,
    defaultValue: 3065,
  },
  {
    field: 'web.baseUrl',
    label: '网页访问地址',
    bottomHelpMessage: '填写手机或 QQ 内浏览器能访问到的完整地址，例如 http://192.168.1.10:2536；留空时自动使用机器人地址。',
    component: 'Input',
    placeholder: 'http://192.168.1.10:2536',
  },
  {
    field: 'web.linkExpiresMinutes',
    label: '链接有效分钟数',
    bottomHelpMessage: '添加或修改账号时生成的网页链接有效时长，过期后需要重新向机器人发送命令。',
    component: 'InputNumber',
    min: 1,
    max: 60,
    defaultValue: 10,
  },
  { component: 'Divider', label: 'SMTP 邮件通知' },
  {
    field: 'smtp.enabled',
    label: '启用邮件通知',
    bottomHelpMessage: '开启后可向用户发送续火失败邮件；用户开启成功通知时也会使用此邮件配置。',
    component: 'Switch',
    defaultValue: false,
  },
  {
    field: 'smtp.host',
    label: 'SMTP 主机',
    bottomHelpMessage: '邮件服务商的 SMTP 服务器地址，例如 QQ 邮箱为 smtp.qq.com。',
    component: 'Input',
  },
  {
    field: 'smtp.port',
    label: 'SMTP 端口',
    bottomHelpMessage: '常用 SSL 端口为 465；非 SSL 服务通常使用 25、587 等端口。',
    component: 'InputNumber',
    min: 1,
    max: 65535,
    defaultValue: 465,
  },
  {
    field: 'smtp.secure',
    label: '启用 SSL',
    bottomHelpMessage: '端口为 465 时通常需要开启；请以邮件服务商的说明为准。',
    component: 'Switch',
    defaultValue: true,
  },
  {
    field: 'smtp.username',
    label: 'SMTP 用户名',
    bottomHelpMessage: '用于登录 SMTP 服务，通常填写完整邮箱地址。',
    component: 'Input',
  },
  {
    field: 'smtp.password',
    label: 'SMTP 授权码',
    bottomHelpMessage: '填写邮件服务商生成的 SMTP 授权码，不是邮箱登录密码。',
    component: 'Input',
  },
  {
    field: 'smtp.from',
    label: '发件人',
    bottomHelpMessage: '邮件中显示的发件人地址；留空时使用 SMTP 用户名。',
    component: 'Input',
  },
]

export default {
  schemas,
  getConfigData: () => getConfig(),
  setConfigData(data, { Result }) {
    saveConfig(data)
    return Result.ok({}, '保存成功')
  },
}
