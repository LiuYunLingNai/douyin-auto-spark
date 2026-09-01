# douyin-id-spark（抖音续火 · API 版）

基于 Yunzai-Bot 的抖音续火插件。直接调用抖音 Web 私信接口（HTTP + protobuf），**全程以用户 ID（sec_uid / uid）寻址发送**，对方改昵称不影响送达；前台展示时自动把 ID 映射为昵称，昵称变更时自动检测并更新。

命令与浏览器自动化版 `douyin-auto-spark` 一致（`#抖音添加账号`、`#抖音续火` 等），作为其替代实现；**两者不要同时启用**（命令会冲突）。

## 特性

- 多账号管理，Cookie 支持扫码登录或手动粘贴（Cookie-Editor JSON）
- 续火目标在添加/修改账号的网页中**一键拉取私信会话列表、点击勾选**（纯接口拉取，无需手动找 ID）
- 目标按 **sec_uid** 存储与发送，昵称仅作前台展示映射，改名自动更新
- 发送通道为抖音 Web 私信 API（`imapi.douyin.com`），发消息无需启动浏览器
- 内置 a_bogus 签名与 protobuf 请求模板；目标间随机延时降低风控
- 定时任务（cron）+ 手动触发；成功/失败邮件通知；锅巴面板配置

## 安装

在 Yunzai 根目录执行：

```bash
git clone -b api --single-branch https://github.com/LiuYunLingNai/douyin-auto-spark.git plugins/douyin-id-spark
pnpm install
```

插件默认开启 `browser.preferSystem`，扫码登录时会自动探测并复用系统已安装的 Edge、Chrome 或 Chromium，无需额外下载浏览器。仅当系统没有安装任何浏览器时，才需要额外下载 Playwright 自带的 Chromium（不扫码、只粘贴 Cookie 的话可以不装）：

```bash
pnpm --dir plugins/douyin-id-spark exec playwright install chromium
```

首次启动会自动创建 `plugins/douyin-id-spark/config/config.yaml`，可在锅巴或该文件配置定时任务、默认消息、发送间隔、SMTP 和网页服务。

**浏览器（Playwright）仅用于扫码登录这一步**——经实测，抖音现行登录（login.douyin.com）的二维码获取可以纯 API 完成，但扫码状态轮询（check_qrconnect）强制要求 mssdk 加密设备证明（JSVMP 保护），纯 API 无法复现，因此扫码登录保留无头浏览器一次性完成。发消息、拉会话列表、查昵称均为纯 API。若不需要扫码功能（只粘贴 Cookie JSON），可不安装 Playwright 浏览器。

## 使用流程

1. `#抖音添加账号` —— 打开一次性网页链接，扫码登录或粘贴 Cookie
2. 在同一网页点击 **「拉取会话列表」** —— 插件通过接口读取私信会话里出现过的人（含昵称和用户 ID），**勾选**要续火的人
3. 提交保存 —— 目标按用户 ID 入库
4. `#抖音续火` —— 手动执行；定时任务默认每天 00:10（可在锅巴或 config.yaml 修改）

之后想增删目标：`#抖音修改账号 账号名` 打开网页重新拉取并勾选；或用 `#抖音删除好友` 删除单个目标。

## 命令一览

| 命令 | 说明 |
|---|---|
| `#抖音添加账号` / `#抖音取消添加` | 添加账号（网页链接，含目标点选） |
| `#抖音账号列表` / `#抖音删除账号 账号名` / `#抖音修改账号 账号名` | 账号管理 |
| `#抖音好友列表 [账号名]` | 查看 ID↔昵称 映射（自动刷新昵称） |
| `#抖音添加好友 [账号名]` | 发链接拉取会话列表勾选新增目标（无需重扫） |
| `#抖音删除好友 [账号名] 序号` | 删除单个目标 |
| `#抖音刷新昵称 [账号名]` | 批量刷新昵称映射 |
| `#抖音续火 [账号名\|全部]` | 手动续火（“全部”仅主人） |
| `#抖音设置邮箱` / `#抖音成功邮件开启/关闭` / `#抖音邮箱` / `#抖音清除邮箱` | 邮件通知 |
| `#抖音插件更新` 等 | 插件自更新（需 Git 仓库） |

## 工作原理

```
imapi get_message_by_init (protobuf, cmd=2043) --> 主收件箱 1v1 会话参与者 sec_uid/uid（网页点选）
        |
aweme/v1/web/user/profile/other/ (a_bogus 签名) --> 昵称（变更检测与映射更新）
        |
imapi v2/conversation/create (protobuf) --> conversation_id + short_id
        |
imapi v1/message/send (protobuf, sessionid 鉴权) --> 送达
```

- 签名实现：内置纯算法 a_bogus（源自 ShilongLee/Crawler 的 `lib/js/douyin.js`，MediaCrawler 同源），文件位于 `components/abogus-src.js`
- 消息体：protobuf 模板 patch（协议参考 Rockedw/douyin-web-api-sdk），模板位于 `components/im-templates.js`

## 风险与限制（重要）

- 本插件使用的接口为**逆向所得的非公开接口**，仅供学习交流。抖音升级风控后可能失败：
  - 签名失效 → 用 ShilongLee/Crawler 最新 `lib/js/douyin.js` 替换 `components/abogus-src.js`（保留文件末尾 export 行，且 sign 函数第三个参数名不能为 `arguments`）
  - 发送模板失效 → F12 抓真实 `message/send` 请求体转 Base64，填入配置 `im.templateB64`
  - 会话列表协议变更 → 会话列表请求为代码内从零构造（cmd=2043，2026-09 抓包校正，无签名凭据），协议变更时需更新 `components/im-proto.js` 中 `buildGetByUserInitBody` / `parseGetByUserInitResponse` 的字段定义
- 高频/陌生人私信可能触发验证码或账号处罚，请控制目标数量与频率（默认目标间随机 3~8 秒）
- `data/data.db` 明文存储 Cookie，请保护服务器文件权限
- 端到端链路依赖真实 Cookie 验证，首次使用请手动 `#抖音续火` 验证一次

## 目录结构

```
apps/        命令处理（账号 / 目标 / 续火 / 更新）
components/  配置、数据库(sql.js)、API 封装、会话列表、签名、protobuf、执行器、扫码登录
config/      default_config.yaml（首次启动复制为 config.yaml）
guoba/       锅巴面板
assets/      一言语料
data/        运行时数据库（勿泄露）
artifacts/   扫码截图等运行时产物
```
