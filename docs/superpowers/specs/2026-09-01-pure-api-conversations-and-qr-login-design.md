# douyin-id-spark 纯 API 化：会话列表选目标 + 扫码登录

日期：2026-09-01
状态：已确认（用户已批准方案 A + C 组合）

## 背景与目标

发消息链路已走 imapi.douyin.com protobuf API。剩余三处仍依赖 Playwright，需要全部替换为纯 API：

1. **会话扫描**（`components/conversation-scan.js`）：带 Cookie 开浏览器抓 sec_uid → 改为直接调 imapi 会话列表接口
2. **扫码登录**（`components/web-setup.js` 内）：开浏览器截图二维码 → 改为 passport get_qrcode/check_qrconnect 接口
3. **网页选目标**：后端 `/api/conversations/:token` 端点已存在，但无前端交互 → 添加账号网页里点选会话中出现过的人，一键入库

最终移除 playwright 依赖（package.json、guoba depends、browser 配置、config.js 浏览器探测）。

## 接口调研结论

- 会话列表：`POST https://imapi.douyin.com/v2/message/get_by_user_init`（cmd=203，protobuf，Cookie 鉴权，无 a_bogus）。响应含 `conversations[]`（conversation_id / conversation_short_id / ticket / participants_count）与 `messages[]`（conversation_id / sec_sender / sender / content / create_time）。1v1 会话的 conversation_id 形如 `0:1:uidA:uidB`，可反查对方 uid；sec_uid 取该会话最新消息的 `sec_sender`
- 扫码登录：`GET https://sso.douyin.com/get_qrcode/?need_logo=true&service=www.douyin.com&aid=6383&...` → `{data:{qrcode, token}}`；轮询 `GET https://sso.douyin.com/check_qrconnect/?token=...&service=www.douyin.com&aid=6383&...` → status 1=待扫码 2=已扫待确认 3=确认 4=取消 5=过期；status=3 时 `redirect_url` 含 ticket 参数；`GET https://www.douyin.com/passport/sso/login/callback/?next=https://www.douyin.com&ticket=...` 响应 Set-Cookie 写入 sessionid 等完整登录态。参考实现 yijianguanzhu/douyin-qrcode-login（2022 年仍可用形态，参数需按现网补全 service/aid）
- 两个 imapi 接口外层 envelope（cmd/sequence_id/sdk_version/token/refer/inbox_type/build_number/body/device_id/device_platform/headers/auth_type/biz/access/ts_sign/sdk_cert）与现有 `im-templates.js` 同源，沿用 decode-template → patch → encode 套路

## 架构

```
网页（添加/修改账号页，renderSetupPage）
  ├─ 「扫码获取 Cookie」→ POST /api/scan/start|refresh/:token
  │     → qr-login.js createQrLoginSession()（get_qrcode）
  │     → 网页轮询 GET /api/scan/status/:token → pollQrLogin()
  │         status=3 → ticket → login/callback → Cookie 数组填入表单
  ├─ 「从会话列表选择目标」→ POST /api/conversations/:token
  │     → conversation-api.js listConversations(cookies)
  │         postImProto('/v2/message/get_by_user_init', 模板 patch 分页)
  │         → [{secUid, uid, nickname, conversationId, conversationShortId, ticket, lastMessageTime}]
  │     → 网页渲染人名卡片，点选加入集合，随表单提交
  └─ POST /api/setup/:token → saveWebSetup() 收 targets[] → replaceTargets()
```

发送链路（runner.js / douyin-api.js / im-proto.js）不动。

## 新组件

### components/qr-login.js（新）

- `createQrLoginSession({ onLog })`：
  1. GET `https://www.douyin.com/`（ UA 用现有 USER_AGENT）收集初始 Cookie（ttwid 等），存 jar
  2. 带 jar GET get_qrcode，返回 `{ token, qrDataUrl }`（qrDataUrl 即响应 data.qrcode，本身是 data URL 或 URL；URL 则直接给 img.src）
- `pollQrLogin(session)`：幂等；带 jar 轮询 check_qrconnect，映射 status：
  - 1 → `{status:'waiting'}`
  - 2 → `{status:'scanned'}`（网页显示"请在手机上确认"）
  - 3 → 提取 redirect_url 的 ticket → GET login/callback（redirect:'manual'，手动收 Set-Cookie 合并 jar；回调可能多次 302，逐跳收集）→ 校验含 sessionid → 转成 Cookie-Editor 格式数组 → `{status:'success', cookies}`
  - 4 → `{status:'canceled'}`（终止，需重新获取二维码）
  - 5 → `{status:'expired'}`（终止，提示刷新）
  - 轮询节流：服务端最多 1 次/2s（前端轮询 status 端点驱动，服务端加最小间隔防止外层高频）
- 会话对象存 web-setup.js 的 scanSessions（token → state），生命周期沿用现有链接过期清理
- 二次验证（扫码后抖音要求短信/滑块）：纯 API 无法处理，login/callback 后若无 sessionid → 报错文案"该账号扫码登录触发安全验证，请改用粘贴 Cookie 方式"，Cookie 粘贴路径保留
- Cookie-Editor 数组生成：jar 里的 cookie 按 domain 分组输出 `{name, value, domain, path:'/', httpOnly, secure, sameSite:'Lax', session:无过期}`，与 parseCookies 的 isUsableCookie 校验兼容

### components/conversation-api.js（新）

- `listConversations(cookies, { onProgress })`：
  1. `getByUserInitTemplate()`：内置 base64 模板（抓包样本），可被 `config.im.getByUserInitTemplateB64` 覆盖；模板缺失/不可解码时抛 DouyinApiError kind='api'，提示抓包指引
  2. decode → patch（cursor=0, count=20, inbox_type=1, cmd/sequence_id 沿用模板）→ encode → `postImProto('/v2/message/get_by_user_init', cookieHeader, body, '拉取会话列表')`（postImProto 从 douyin-api.js 导出复用，需要 signed:false —— 该接口无 a_bogus）
  3. 分页：响应 body.messages_per_user_init_v2_body 的 `has_more` + `per_user_cursor` 作为下一页 cursor，循环 ≤10 页，页间 500ms
  4. 解析：conversations[]（按 participants_count==2 且 conversation_type==1 过滤 1v1）+ messages[] 按 conversation_id 归组取最新一条的 sec_sender 与 sender（int64→string）
  5. selfUid：优先响应外层 user_id 字段，其次 uid_tt cookie hex 解码（现有 getSelfUidFromCookies）；从 `0:1:uidA:uidB` 取非 selfUid 一侧为对方 uid
  6. sec_uid 缺失的会话：逐个 `fetchUserProfile`（现有）补昵称与 uid，单个失败保留条目（昵称空），400ms 间隔
  7. 返回 `[{secUid, uid, nickname, conversationId, conversationShortId, ticket, lastMessageTime}]`，按 lastMessageTime 降序

### components/im-proto.js（扩展）

新增 proto 定义（不破坏现有）：

```proto
message GetByUserInitRequest { /* envelope 同 DySendMsgRequest，body 字段 203 */ }
message GetByUserInitBody { MessagesPerUserInitV2Body field_203 = 203; }
message MessagesPerUserInitV2Body {
  int64 cursor = 1; int64 count = 2;
  // 响应：repeated Conversation conversations = 3; repeated Message messages = 4; bool has_more = 5; int64 per_user_cursor = 6;（字段号以实际抓包为准，实现时校正）
}
message ConversationCore { string conversation_id = 1; int64 conversation_short_id = 2; int32 conversation_type = 3; string ticket = 4; int32 participants_count = 5; }
```

> 注：具体字段号在实现阶段用真实抓包样本 decode 校正；文档中的字段号是初稿。内置模板 base64 同样以真实抓包为准；先用创作者后台公开样本占位，README 写抓包替换指引。

导出 `buildGetByUserInitBody({cursor, count, templateB64})` 与 `parseGetByUserInitResponse(bytes)`。

### components/douyin-api.js（小改）

- 导出 `postImProto`（现为模块私有）
- 无其他改动

### components/web-setup.js（重构）

- 删除：Playwright import、scanSessions 里浏览器句柄/截图逻辑、captureDouyinQr、maybeRequestSmsVerification、submitScanSmsCode、clickSmsSubmit、saveScanScreenshot、looksLoggedInPage、closeScanBrowser、handleScanSms、handleScanScreenshot 端点、短信相关路由
- 保留/改造：
  - `scanSessions` 语义改为 qr-login 会话状态（无浏览器资源，只有轮询节流时间戳与缓存的状态）
  - `/api/scan/start|refresh/:token` → `createQrLoginSession()`；`/api/scan/status/:token` → `pollQrLogin()`
  - `/api/conversations/:token` → `listConversations()`（现有 handler 改调用新组件，返回 `{ok, list}`）
  - `saveWebSetup()` 接收 `body.targets: [{secUid, uid, nickname, conversationId, conversationShortId, ticket}]`：新账号路径先 addAccount 再 replaceTargets；修改路径 updateAccount 后 replaceTargets（整体替换，网页预勾选已存目标）
  - `getInitialValues()` 修改模式返回的 targets 补全 conversationId/shortId（预勾选用）
- 网页（renderSetupPage）：
  - 扫码区去掉短信验证码输入框；status 增示 scanned 文案
  - 新增「续火目标」区块：按钮「从会话列表选择」→ 调 conversations 端点 → 卡片列表（昵称 + ID 前 12 位 + 最后消息时间）点选切换 → 已选数随提交；列表加载态/错误态文案
  - 修改模式：已存目标预勾选；提交整体替换

### 删除

- `components/conversation-scan.js` 整个文件
- `package.json` 的 `playwright` 依赖
- `guoba/pluginInfo.js` 的 `depends: ['playwright']`
- `guoba/configInfo.js` 的 `browser.preferSystem / channel / executablePath / headless` 四项
- `config/default_config.yaml` + `config.js` defaults 的 `browser` 段与 `detectSystemBrowser/getBrowserLaunchOptions`；`config.yaml` 已生成的 browser 段由 ensureConfigFile 的合并逻辑自然保留（无害），不主动清理用户文件

### 顺带修正

- `#抖音ID添加好友` 命令保留（网页选人是主路径，命令是备用路径），帮助文案改为提示网页内选择为主
- README 更新：安装不再需要 Playwright；新增 get_by_user_init 模板失效时的抓包指引

## 数据流（选人入库）

```
网页点选 targets[] ──POST /api/setup──▶ saveWebSetup
  ├─ parseCookies / 复用已存 Cookie
  ├─ addAccount | updateAccount
  ├─ replaceTargets(accountId, targets)   // conversation_id/short_id/ticket 一并入库
  └─ runner.js 续火时 target.conversationId 已存在 → 跳过 createConversation 直接发送
```

## 错误处理

| 场景 | 行为 |
|---|---|
| get_qrcode/check_qrconnect 返回非 JSON 或风控页 | DouyinApiError kind='risk'；网页提示"扫码服务暂不可用，请粘贴 Cookie" |
| 扫码确认后无 sessionid（触发二次验证） | status='error'，文案"该账号扫码登录触发安全验证，请改用粘贴 Cookie 方式" |
| 二维码过期/取消 | expired/canceled 状态文案，引导点「刷新二维码」 |
| get_by_user_init 模板失效（status_code≠0 或 decode 失败） | 提示"会话列表模板失效，请抓包更新 im.getByUserInitTemplateB64"（附 README 指引） |
| 会话列表为空 | "该账号没有私信会话记录" |
| Cookie 失效（401/403） | 现有 kind='auth' 文案链路 |
| 分页超过 10 页 | 停止并返回已收集条目，onProgress 记日志 |

## 测试

- 单测（node:test，`test/` 目录，不依赖网络）：
  - im-proto：GET_BY_USER_INIT fixture b64 → decode → patch cursor/count → encode → re-decode 断言字段；parseGetByUserInitResponse 用响应 fixture 断言 conversations/messages/has_more
  - conversation-api：fixture 响应 → 断言 1v1 过滤、selfUid 排除、uid 反查、按时间排序、sec_uid 缺失标记（fetchUserProfile 打桩）
  - qr-login：stub fetch 断言 5 种 status 映射、ticket 提取、Set-Cookie 合并、Cookie-Editor 数组形状、无 sessionid 报错文案
- 手测清单（需真实账号）：
  1. `#抖音ID添加账号` → 网页扫码 → Cookie 填入
  2. 网页点「从会话列表选择」→ 出现会话人列表 → 点选 2 人 → 提交
  3. `#抖音ID好友列表` 显示所选 2 人（昵称正确）
  4. `#ID续火` 发送成功（复用入库的 conversationId，无需创建会话）
  5. 修改账号页重新拉会话，已存目标预勾选
  6. 二维码过期场景（等待）→ 刷新可用

## 明确不做

- 不做网页外（机器人命令）的会话选人交互
- 不做陌生人箱 `/v1/stranger/get_conversation_list`（get_by_user_init 已覆盖好友+近期会话）
- 不处理扫码后的短信二次验证（报错引导 Cookie 粘贴）
- 不动发送链路、邮件、锅巴其余配置
