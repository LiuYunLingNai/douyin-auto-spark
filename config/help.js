/**
 * 抖音续火 · 帮助页配置文件
 *
 * 改动后无需重启云崽（每次渲染会重新读取本文件）。
 * 结构参考 miao-plugin 的 help-list：helpCfg 控制标题与排版，helpList 是分组指令清单。
 *
 * 字段说明：
 *   helpCfg.title      主标题
 *   helpCfg.subTitle   副标题（英文/说明）
 *   helpCfg.colCount   每行条目数（1~3，建议 2，指令较长）
 *   helpList[].group   分组名
 *   helpList[].icon    分组图标（见 components/render.js 的 ICONS）
 *   helpList[].auth    填 'master' 时仅机器人主人可见
 *   helpList[].list[]  条目：{ icon, title, desc }
 *     icon  == 图标名，留空则不显示图标
 *     title == 指令（等宽字体显示）
 *     desc  == 说明文字
 */

export default {
  helpCfg: {
    title: '抖音续火',
    subTitle: 'DOUYIN AUTO SPARK · 自动续上你的火花',
    colCount: 2,
  },

  helpList: [
    {
      group: '账号管理',
      icon: 'account',
      list: [
        { icon: 'add', title: '#抖音添加账号', desc: '发送一次性网页链接，扫码或粘贴 Cookie 添加账号' },
        { icon: 'list', title: '#抖音账号列表', desc: '查看自己的账号别名和会话数量' },
        { icon: 'edit', title: '#抖音修改账号 账号名', desc: '私聊获取修改链接，Cookie 留空则保留原值' },
        { icon: 'delete', title: '#抖音删除账号 账号名', desc: '删除自己的指定账号' },
        { icon: 'cancel', title: '#抖音取消添加', desc: '取消当前添加流程，网页链接失效' },
      ],
    },
    {
      group: '续火执行',
      icon: 'flame',
      list: [
        { icon: 'flame', title: '#抖音续火', desc: '执行自己的全部账号' },
        { icon: 'star', title: '#抖音续火 账号名', desc: '仅执行自己的指定账号' },
        { icon: 'settings', title: '#抖音续火 帮助', desc: '查看这份命令清单' },
      ],
    },
    {
      group: '邮件通知',
      icon: 'mail',
      list: [
        { icon: 'mail', title: '#抖音设置邮箱 邮箱', desc: '私聊设置自己的失败通知收件邮箱' },
        { icon: 'bell', title: '#抖音成功邮件开启', desc: '私聊开启续火成功邮件通知' },
        { icon: 'bell', title: '#抖音成功邮件关闭', desc: '私聊关闭续火成功邮件通知' },
        { icon: 'list', title: '#抖音邮箱', desc: '私聊查看当前收件邮箱' },
        { icon: 'delete', title: '#抖音清除邮箱', desc: '私聊清除收件邮箱，此后失败不发邮件' },
      ],
    },
    {
      group: '管理维护',
      icon: 'shield',
      auth: 'master',
      list: [
        { icon: 'shield', title: '#抖音管理账号', desc: '打开管理网页，查看与管理全部账号' },
        { icon: 'update', title: '#抖音插件更新', desc: '更新抖音续火插件' },
        { icon: 'update', title: '#抖音插件强制更新', desc: '丢弃本地改动后强制更新' },
        { icon: 'list', title: '#抖音插件更新日志', desc: '查看插件更新日志' },
      ],
    },
  ],
}
