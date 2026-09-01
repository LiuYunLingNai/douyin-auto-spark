# douyin-id-spark（抖音ID续火）

基于 Yunzai-Bot 的抖音续火插件（API 版）。直接调用抖音 Web 私信接口（HTTP + protobuf），**全程以用户 ID（sec_uid / uid）寻址发送**，对方改昵称不影响送达；前台展示时自动把 ID 映射为昵称，昵称变更时自动检测并更新。

与 `douyin-auto-spark`（浏览器自动化版）相互独立，可同时安装；命令前缀不同，互不冲突。

## 特性

- 多账号管理，Cookie 支持扫码登录或手动粘贴（Cookie-Editor JSON）
- 续火目标按 **sec_uid** 存储与发送，昵称仅作前台展示映射，改名自动更新
- 发送通道为抖音 Web 私信 API（`imapi.douyin.com`），无需启动浏览器发消息
- 内置 a_bogus 签名与 protobuf 请求模板；目标间随机延时降低风控
- 定时任务（cron）+ 手动触发；成功/失败邮件通知；锅巴面板配置

## 安装

```bash
# 在 Yunzai/plugins 目录下
cd douyin-id-spark
pnpm install   # 或 npm install
```

重启云崽后生效。浏览器仅用于扫码登录获取 Cookie；若不需要扫码功能（只粘贴 Cookie），可不安装 Playwright 浏览器。

## 使用流程

1. `#抖音ID添加账号` —— 私聊机器人，打开一次性网页链接，扫码登录或粘贴 Cookie
2. `#抖音ID添加好友 [账号名] <分享口令或主页链接>` —— 粘贴对方抖音主页的分享口令（含 `v.douyin.com` 短链）或主页链接，插件自动解析 sec_uid 并记录昵称
3. `#抖音ID好友列表` —— 查看 ID↔昵称 映射（会现场刷新昵称并标注改名）
4. `#ID续火` —— 手动执行；定时任务默认每天 00:10（可在锅巴或 config.yaml 修改）

## 命令一览

| 命令 | 说明 |
|---|---|
| `#抖音ID添加账号` / `#抖音ID取消添加` | 添加账号（网页链接） |
| `#抖音ID账号列表` / `#抖音ID删除账号 账号名` / `#抖音ID修改账号 账号名` | 账号管理 |
| `#抖音ID添加好友 [账号名] <口令/链接>` | 添加续火目标（按 ID） |
| `#抖音ID好友列表 [账号名]` | 查看目标，自动刷新昵称 |
| `#抖音ID删除好友 [账号名] 序号` | 删除目标 |
| `#抖音ID刷新昵称 [账号名]` | 批量刷新昵称映射 |
| `#ID续火 [账号名\|全部]` | 手动续火（“全部”仅主人） |
| `#抖音ID设置邮箱` / `#抖音ID成功邮件开启/关闭` / `#抖音ID邮箱` / `#抖音ID清除邮箱` | 邮件通知 |
| `#抖音ID插件更新` 等 | 插件自更新（需 Git 仓库） |

## 工作原理

```
分享链接(v.douyin.com) --302--> sec_uid
        |
        v
aweme/v1/web/user/profile/other/ (a_bogus 签名) --> uid + 昵称（昵称变更检测）
        |
        v
imapi.douyin.com/v2/conversation/create (protobuf) --> conversation_id + short_id
        |
        v
imapi.douyin.com/v1/message/send (protobuf, sessionid 鉴权) --> 送达
```

- 签名实现：内置纯算法 a_bogus（源自 ShilongLee/Crawler 的 `lib/js/douyin.js`，MediaCrawler 同源），文件位于 `components/abogus-src.js`
- 消息体：protobuf 模板 patch（协议参考 Rockedw/douyin-web-api-sdk），模板位于 `components/im-templates.js`

## 风险与限制（重要）

- 本插件使用的接口为**逆向所得的非公开接口**，仅供学习交流。抖音升级风控（SDK 版本、模板字段失效）后可能发送失败：
  - 签名失效 → 用 ShilongLee/Crawler 最新 `lib/js/douyin.js` 替换 `components/abogus-src.js`（保留文件末尾 export 行，且 sign 函数第三个参数名不能为 `arguments`）
  - 请求模板失效 → 浏览器登录 douyin.com/chat，F12 抓取一次真实 `message/send` 请求体（二进制）转 Base64，填入配置 `im.templateB64` 或锅巴面板「自定义 IM 请求模板」
- 陌生人/高频私信可能触发验证码或账号处罚，请控制目标数量与频率（默认目标间随机 3~8 秒）
- `data/data.db` 明文存储 Cookie，请保护服务器文件权限
- 端到端发送链路依赖真实 Cookie 验证，请首次使用后用 `#ID续火` 手动验证一次

## 目录结构

```
apps/        命令处理（账号 / 目标 / 续火 / 更新）
components/  配置、数据库(sql.js)、API 封装、签名、protobuf、执行器、扫码登录
config/      default_config.yaml（首次启动复制为 config.yaml）
guoba/       锅巴面板
assets/      一言语料
data/        运行时数据库（勿泄露）
artifacts/   扫码截图等运行时产物
```
