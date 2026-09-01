# 抖音续火 Yunzai 插件

一个自动给抖音续火的 TRSS-Yunzai 插件，每位 QQ 用户可通过机器人添加自己的多个抖音账号并配置续火内容。插件使用 Playwright 打开抖音聊天页并向指定会话发送随机一言或自定义消息。

## 安装

在 Yunzai 根目录执行：

```bash
git clone -b yunzai-plugin --single-branch https://github.com/LiuYunLingNai/douyin-auto-spark.git plugins/douyin-auto-spark
pnpm install
```

插件默认开启 `browser.preferSystem`，启动时会自动探测并复用系统已安装的 Edge、Chrome 或 Chromium，无需额外下载浏览器。若日志中出现「已复用系统浏览器」，说明探测成功。

仅当系统没有安装任何浏览器时，才需要额外下载 Playwright 自带的 Chromium：

```bash
pnpm --dir plugins/douyin-auto-spark exec playwright install chromium
```

首次启动会自动创建 `plugins/douyin-auto-spark/config/config.yaml`，可在 Guoba 或该文件配置浏览器、默认消息、定时任务和 SMTP。浏览器解析优先级为：`browser.executablePath` 手填路径 > `browser.channel` 渠道 > `browser.preferSystem` 自动探测 > Playwright 自带 Chromium。

## 账号配置

向机器人发送 `#抖音添加账号`，机器人会发送一次性网页链接。该命令可在群聊或私聊使用；修改已有账号必须私聊发送 `#抖音修改账号 账号名`。网页内填写：

1. 本账号的别名。
2. 点击“扫码获取 Cookie”，打开抖音聊天页中的登录二维码，用抖音 App 扫码；登录成功后 Cookie 会自动填入。若抖音要求身份验证，插件会自动点击“接收短信验证码”，你只需把收到的验证码填入网页。若二维码过期或扫码后状态没有刷新，点击“刷新二维码”重新获取。若抖音触发其他安全验证，可改用 Cookie-Editor 导出的完整 Cookie JSON 数组，直接粘贴或选择 `.txt` 文件。
3. 需要续火的会话名，可逐行输入或粘贴 JSON 数组。
4. 自定义消息模板和失败通知收件邮箱。

链接默认 10 分钟有效，提交成功后即失效。发送 `#抖音修改账号 账号名` 可修改会话、模板和邮箱；Cookie 留空会保留原值，重新粘贴或上传 `.txt` 可更新过期 Cookie。流程中可随时发送 `#抖音取消添加` 使链接失效。

## 网页访问地址（web.baseUrl）

`web.baseUrl` 决定机器人发链接的地址。它只影响链接文本，不影响页面实际监听在哪里，所以填错的表现是「链接点开打不开」，而不是「插件没启动」。

### 两种运行模式

| 配置 | 页面由谁提供 | 实际地址 |
| --- | --- | --- |
| `web.mountToTrss: true`（默认） | 挂载到云崽自带的 HTTP 服务 | 云崽端口 + `/douyin-auto-spark` |
| `web.mountToTrss: false` | 插件专属 HTTP 服务 | `web.standalonePort`（默认 3065） |

改成独立端口后需要重启云崽才会生效。

### 留空时的回落规则

`web.baseUrl` 留空时插件会自动推断：

- 挂载模式下取云崽配置里的对外地址。
- 独立模式下取 `http://127.0.0.1:<standalonePort>`。
- 两者都取不到时报错「请先在插件配置中填写 web.baseUrl」。

独立模式的回落值是 `127.0.0.1`，只有机器人所在的那台机器自己能访问，手机上点开必定失败。所以只要你不是在同一台机器上点链接，就应当显式填写。

### 该填什么

填**你点链接的那台设备**能访问到的完整地址，端口要和上表里的实际端口一致：

```yaml
web:
  # 同一局域网内手机访问：填机器人所在电脑的内网 IP
  baseUrl: "http://192.168.1.10:2536"
  # 有公网 IP 或域名：填公网地址
  # baseUrl: "https://bot.example.com"
```

注意：

- 末尾斜杠可有可无，插件会自动补全。
- 必须带协议头（`http://` 或 `https://`），否则报错「web.baseUrl 不是有效的网址」。
- 反向代理场景下填代理暴露的地址，代理需要把 `/douyin-auto-spark` 转发到云崽端口。
- Docker 部署时 `127.0.0.1` 指容器内部，要填宿主机 IP 加映射出来的端口。

### 安全提示

挂载模式下插件会把 `/douyin-auto-spark` 加入云崽的 `skip_auth`，即该路径不走云崽的鉴权。页面靠链接里的一次性 token 保护：token 用过一次即失效，超过 `web.linkExpiresMinutes`（默认 10 分钟）自动过期。因此如果 `baseUrl` 指向公网地址，请把有效期调短，并且不要把链接转发给他人——拿到链接的人可以在有效期内直接填写账号数据。

## 手动获取Cookie教程
1. 使用 Chrome/Edge 打开 [Cookie-Editor 插件页面](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)，安装 Cookie-Editor。 [（Edge点我）](https://microsoftedge.microsoft.com/addons/detail/cookieeditor/neaplmfkghagebokkhpjpoebhdledlfi)

2. 打开 [抖音聊天页](https://www.douyin.com/chat)，并登录你的抖音账号。

3. 登录成功后，点击浏览器右上角的 Cookie-Editor 插件图标。

4. 点击 `Export`，选择 `JSON`，复制导出的完整数组内容。

   ![cookie](https://github.com/bling-yshs/douyin-auto-spark/blob/main/assets/readme/cookie.png?raw=true)

导出的内容大概长这样：

```json
[
  {
    "domain": ".douyin.com",
    "expirationDate": 1800175766.87008,
    "hostOnly": false,
    "httpOnly": false,
    "name": "UIFID",
    "path": "/",
    "sameSite": "no_restriction",
    "secure": true,
    "session": false,
    "storeId": null,
    "value": "xxx"
  }
]
```


## 命令

发送 `#抖音续火帮助` 可随时在聊天中查看下面这份常用命令清单：

- `#抖音添加账号`：发送一次性网页链接，添加一个账号。
- `#抖音取消添加`：取消当前添加流程。
- `#抖音账号列表`：查看自己添加的账号别名和会话数量。
- `#抖音删除账号 账号名`：删除自己的指定账号。
- `#抖音修改账号 账号名`：私聊获取指定账号的一次性修改链接。
- `#抖音续火`：执行自己全部账号。
- `#抖音续火 账号名`：仅执行自己的指定账号。
- `#抖音续火 全部`（仅主人）：执行所有用户账号。
- `#抖音设置邮箱 邮箱`：私聊设置自己的失败通知收件邮箱。
- `#抖音成功邮件开启`：私聊开启自己的续火成功邮件通知。
- `#抖音成功邮件关闭`：私聊关闭自己的续火成功邮件通知。
- `#抖音邮箱`：私聊查看当前收件邮箱。
- `#抖音清除邮箱`：私聊清除收件邮箱，此后失败不发邮件。
- `#抖音插件更新`（仅主人）：更新抖音续火插件。
- `#抖音插件强制更新`（仅主人）：丢弃本地插件改动后强制更新。
- `#抖音插件更新日志`：查看抖音续火插件更新日志。

定时任务默认每天 00:10 执行数据库内全部账号；可在 Guoba 或 `config/config.yaml` 修改 `schedule.cron`，设置 `schedule.enabled: false` 后会自动关闭定时任务。

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

模板分两级：Guoba 或 `config/config.yaml` 里的全局 `message.template`，以及每个账号在网页中填写的自定义模板。账号模板留空时自动回落到全局模板；两者都留空时发送随机一言，并按 `message.includeSource` 决定是否在后面附带 `——「出处」`。

### 可用占位符

| 占位符 | 含义 | 示例值 |
| --- | --- | --- |
| `{{account}}` | 当前账号的别名 | `小号` |
| `{{friend}}` | 当前正在续火的会话名 | `张三` |
| `{{yiyan}}` | 随机一言正文 | `愿你成为自己的太阳` |
| `{{from}}` | 该条一言的出处 | `《夏目友人帐》` |
| `{{date}}` | 日期，`YYYY-MM-DD` | `2026-09-01` |
| `{{time}}` | 时间，`HH:mm` | `09:30` |
| `{{weekday}}` | 中文星期 | `星期二` |

占位符大小写敏感，只能用上表这七个；写错会在启动时直接报错「消息模板存在未识别占位符」，不会带着错误模板去发消息。占位符两侧可以有空格，`{{ friend }}` 和 `{{friend}}` 等价。

多个会话共用一个模板时，`{{friend}}` 会在每个会话各自替换，所以一份模板就能给所有好友发出带对方名字的消息。`{{yiyan}}` 和 `{{from}}` 每个会话都会重新随机抽取，不会所有人收到同一句。若模板里没有用到这两个占位符，插件会跳过抽取一言这一步。

日期时间统一按东八区（`Asia/Shanghai`）计算，与服务器所在时区无关。

### 换行写法

模板里用 `\n` 表示换行。插件会在读取时把字面的 `\n` 转成真正的换行符，所以在 Guoba 输入框、网页表单和 YAML 里都直接写 `\n` 即可。

### 示例

```yaml
message:
  template: '{{friend}}，今天的火花到账啦🔥\n{{yiyan}}\n——「{{from}}」\n{{date}} {{weekday}}'
```

上面这份模板实际发出的消息是：

```
张三，今天的火花到账啦🔥
愿你成为自己的太阳
——「《夏目友人帐》」
2026-09-01 星期二
```

YAML 里推荐用单引号包裹，这样 `\n` 会原样保留、交给插件转换。若改用双引号，YAML 自己就会把 `\n` 解析成真换行，最终效果相同，两种写法都可以。

`data/data.db` 包含可复用的登录 Cookie，应限制服务器文件访问权限并纳入备份策略。
