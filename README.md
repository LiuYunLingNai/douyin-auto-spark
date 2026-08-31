# 抖音续火 Yunzai 插件

TRSS-Yunzai 插件。每位 QQ 用户可私聊机器人添加自己的多个抖音账号；账号 Cookie 保存在本地 SQLite 数据库 `data/data.db`，不会显示在 Guoba 面板或群聊消息中。插件使用 Playwright 打开抖音聊天页并向指定会话发送随机一言或自定义消息。

## 安装

将仓库放入 Yunzai 的 `plugins/douyin-auto-spark`，在 Yunzai 根目录执行：

```bash
pnpm --dir plugins/douyin-auto-spark install --prod
pnpm --dir plugins/douyin-auto-spark exec playwright install chromium
```

复制 `config/default_config.yaml` 为 `config/config.yaml`，可配置浏览器、默认消息、定时任务和 SMTP。该配置不包含用户账号或 Cookie。

## 私聊账号配置

私聊机器人发送 `#抖音添加账号`，机器人会发送一次性网页链接。网页内填写：

1. 本账号的别名。
2. Cookie-Editor 导出的完整 Cookie JSON 数组，可直接粘贴或选择 `.txt` 文件。
3. 需要续火的会话名，可逐行输入或粘贴 JSON 数组。
4. 自定义消息模板和失败通知收件邮箱。

链接默认 10 分钟有效，提交成功后即失效。网页默认挂载到 TRSS 的 `/douyin-auto-spark`；将 `web.mountToTrss` 设为 `false` 后，插件使用 `web.standalonePort`（默认 3065）独立提供页面。手机访问时，在 Guoba 的“网页账号配置”或 `config/config.yaml` 中设置 `web.baseUrl` 为手机可访问的地址。发送 `#抖音修改账号 账号名` 可修改会话、模板和邮箱；Cookie 留空会保留原值，重新粘贴或上传 `.txt` 可更新过期 Cookie。流程中可随时发送 `#抖音取消添加` 使链接失效。

## 命令

- `#抖音添加账号`：私聊分步添加一个账号。
- `#抖音取消添加`：取消当前添加流程。
- `#抖音账号列表`：查看自己添加的账号别名和会话数量。
- `#抖音删除账号 账号名`：删除自己的指定账号。
- `#抖音修改账号 账号名`：私聊获取指定账号的一次性修改链接。
- `#抖音设置邮箱 your@example.com`：私聊设置自己的失败通知收件邮箱。
- `#抖音成功邮件开启`：私聊开启自己的续火成功邮件通知。
- `#抖音成功邮件关闭`：私聊关闭自己的续火成功邮件通知。
- `#抖音邮箱`：私聊查看当前收件邮箱。
- `#抖音清除邮箱`：私聊清除收件邮箱，此后失败不发邮件。
- `#抖音续火`：执行自己全部账号。
- `#抖音续火 账号名`：仅执行自己的指定账号。
- `#抖音续火 全部`：仅机器人主人可用，执行所有用户账号。
- `#抖音续火帮助`：显示简要帮助。

定时任务默认每天 0 点执行数据库内全部账号；可在 Guoba 或 `config/config.yaml` 修改 `schedule.cron`，设置 `schedule.enabled: false` 后重启 Yunzai 可关闭定时任务。

## SMTP 失败通知

```yaml
smtp:
  enabled: true
  host: smtp.qq.com
  port: 465
  secure: true
  username: your@qq.com
  password: 邮箱授权码
  from: your@qq.com
```

SMTP 主机、端口、发件人和授权码由管理员全局配置。每位用户需设置自己的收件邮箱才会接收邮件；失败邮件默认发送，成功邮件由用户在网页中勾选或私聊发送 `#抖音成功邮件开启` 后发送。失败时只会发送该用户账号的错误和截图，不会包含其他用户信息。

## 消息模板

全局 `message.template` 与每个账号的自定义模板均支持：`{{account}}`、`{{friend}}`、`{{yiyan}}`、`{{from}}`、`{{date}}`、`{{time}}`、`{{weekday}}`。模板留空时发送随机一言，并按 `message.includeSource` 决定是否附带出处。

`data/data.db` 包含可复用的登录 Cookie，应限制服务器文件访问权限并纳入备份策略。
