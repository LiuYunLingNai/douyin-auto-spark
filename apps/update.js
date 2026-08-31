import plugin from '../../../lib/plugins/plugin.js'
import { update as Update } from '../../other/update.js'

const PLUGIN_NAME = 'douyin-auto-spark'

export class DouyinAutoSparkUpdate extends plugin {
  constructor() {
    super({
      name: '抖音续火更新',
      dsc: '更新抖音续火 Yunzai 插件',
      event: 'message',
      priority: 10,
      rule: [
        {
          reg: '^#抖音插件更新$',
          fnc: 'update',
          log: false,
        },
        {
          reg: '^#抖音插件强制更新$',
          fnc: 'update',
          log: false,
        },
        {
          reg: '^#抖音插件更新日志$',
          fnc: 'updateLog',
          log: false,
        },
      ],
    })
  }

  async update(e = this.e) {
    if (!e?.isMaster) return this.reply('只有主人可以更新抖音续火插件')
    e.msg = `#${e.msg?.includes('强制') ? '强制' : ''}更新${PLUGIN_NAME}`
    const updater = new Update(e)
    updater.e = e
    return updater.update()
  }

  async updateLog(e = this.e) {
    const updater = new Update()
    updater.e = e
    if (await updater.getPlugin(PLUGIN_NAME)) return this.reply(await updater.getLog(PLUGIN_NAME))
    return this.reply('未找到抖音续火插件 Git 仓库')
  }
}
