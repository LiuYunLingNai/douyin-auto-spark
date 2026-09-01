# douyin-id-spark 纯 API 化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把会话扫描和扫码登录从 Playwright 换成纯 API（imapi get_by_user_init + sso get_qrcode/check_qrconnect），在添加账号网页里点选会话中的人作为续火目标，并移除 playwright 依赖。

**Architecture:** 三个新/改组件——`qr-login.js`（passport 扫码登录状态机）、`conversation-api.js`（imapi 会话列表分页拉取+解析）、`im-proto.js` 扩展（get_by_user_init 的 proto 编解码，沿用"decode 模板 → patch → encode"套路，模板复用现有 TEXT_MESSAGE_TEMPLATE 的 envelope）；`web-setup.js` 重构接上三个新端点语义并新增网页选人 UI；最后删除 conversation-scan.js 与全部浏览器配置。

**Tech Stack:** Node 25 ESM、protobufjs（已有）、node:test（内建）、无新增依赖。

**规格：** `docs/superpowers/specs/2026-09-01-pure-api-conversations-and-qr-login-design.md`

**工作目录：** `E:\code\Yunzai\plugins\douyin-id-spark`（已是独立 git 仓库，master 分支）

**测试命令：** `node --test test/`（在插件根目录执行）

---

## 关键背景（执行者必读）

1. **模板 patch 套路**：抖音 imapi 请求的外层 envelope（cmd/sequence_id/sdk_version/token/ts_sign/sdk_cert/headers…）是设备级长效凭据。现有 `components/im-templates.js` 的 `TEXT_MESSAGE_TEMPLATE` 就是一份真实抓包的 envelope（sdk_version 1.1.3、biz douyin_web、auth_type 4）。get_by_user_init 是同一个 Web SDK 发出的请求，envelope 通用——所以内置"get_by_user_init 模板"不需要新抓包，直接 decode TEXT_MESSAGE_TEMPLATE，patch `cmd=203`、`sequence_id`（随机）、body 换成 cursor 查询即可。用户配置 `im.getByUserInitTemplateB64` 可整体覆盖。
2. **字段号不确定性**：请求 body 内 query 的字段号（本计划用 203，与响应 data 对称）和响应内部字段号（messages=1/conversations=2/per_user_cursor=3/next_cursor=4/has_more=5）来自公开逆向样本的推断，未经真实接口验证。protobufjs decode 对未知字段会跳过不报错；因此运行时做**有效性检查**：decode 后 conversations 和 messages 都为空 → 抛"模板/协议可能失效"错误（kind='api'），提示抓包更新 `im.getByUserInitTemplateB64`。README 写抓包指引。若真实接口字段号不同，只需改 `im-proto.js` 里的 proto 定义重跑测试。
3. **sec_sender 陷阱**：会话最新一条消息若是自己发的，`sec_sender` 是自己的 sec_uid，不能当对方 ID 用。解析时只取"对方发来的消息"（sender !== selfUid）里最新的一条。
4. **单测不碰网络**：所有真实 HTTP 都在 `postImProto`/`fetchUserProfile`/qr-login 的 fetch 里；单测只测纯函数（proto 往返、extractPeople、状态机——fetch 用 `t.mock.method(globalThis, 'fetch', ...)` 打桩）。
5. **现有代码锚点**（改前先读这些文件）：`components/im-proto.js`（191 行）、`components/douyin-api.js`（278 行，`postImProto` 在 85-123 行）、`components/database.js`（`addAccount` 136-153、`replaceTargets` 338-352）、`components/web-setup.js`（829 行）、`components/conversation-scan.js`（101 行，将整体删除）。

---

### Task 1: im-proto.js 扩展 —— get_by_user_init proto 编解码

**Files:**
- Modify: `components/im-proto.js`
- Test: `test/im-proto.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/im-proto.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import protobuf from 'protobufjs'
import {
  buildGetByUserInitBody,
  parseGetByUserInitResponse,
} from '../components/im-proto.js'
import { TEXT_MESSAGE_TEMPLATE } from '../components/im-templates.js'

test('buildGetByUserInitBody 基于现有模板 patch 出 cmd=203 与分页参数', () => {
  const body = buildGetByUserInitBody({ cursor: '0', count: 20 })
  const root = protobuf.parse(`
    syntax = "proto3";
    message Outer {
      int32 cmd = 1; int32 sequence_id = 2;
      SendMessageBody send_message_body = 8;
      string biz = 21;
    }
    message SendMessageBody { GetByUserInitQuery q = 203; }
    message GetByUserInitQuery { int64 cursor = 1; int64 count = 2; }
  `, { keepCase: true }).root
  const obj = root.lookupType('Outer').toObject(root.lookupType('Outer').decode(body), { longs: String, defaults: false })
  assert.equal(obj.cmd, 203)
  assert.ok(Number(obj.sequence_id) > 0)
  assert.equal(obj.biz, 'douyin_web')
  assert.equal(obj.send_message_body.q.cursor, '0')
  assert.equal(obj.send_message_body.q.count, '20')
})

test('buildGetByUserInitBody 保留 envelope 长效凭据字段', () => {
  const body = buildGetByUserInitBody({ cursor: '123', count: 20 })
  const root = protobuf.parse(`
    syntax = "proto3";
    message Outer { string token = 4; string ts_sign = 23; string sdk_cert = 24; }
  `, { keepCase: true }).root
  const T = root.lookupType('Outer')
  const obj = T.toObject(T.decode(body), { longs: String, defaults: false })
  assert.ok(obj.token.length > 10)
  assert.ok(obj.ts_sign.length > 10)
  assert.ok(obj.sdk_cert.length > 10)
})

test('parseGetByUserInitResponse 解析会话与消息并保留对方 sec_uid', () => {
  // 自己构造一个响应 fixture：1 个 1v1 会话 + 2 条消息（对方发的一条带 sec_sender）
  const root = protobuf.parse(`
    syntax = "proto3";
    message R {
      int32 code = 1; int32 error_code = 3; string status = 4;
      B data = 6; string trace_id = 7; int64 user_id = 13;
    }
    message B {
      repeated M messages = 1; repeated C conversations = 2;
      int64 per_user_cursor = 3; int64 next_cursor = 4; bool has_more = 5;
    }
    message M {
      string conversation_id = 1; int32 conversation_type = 2; int64 server_message_id = 3;
      int64 create_time = 4; int64 conversation_short_id = 5; int32 message_type = 6;
      int64 sender = 7; string content = 8; string sec_sender = 9;
    }
    message C {
      string conversation_id = 1; int64 conversation_short_id = 2; int32 conversation_type = 3;
      string ticket = 4; int32 participants_count = 5; bool is_participant = 6;
    }
  `, { keepCase: true }).root
  const R = root.lookupType('R')
  const fixture = R.encode(R.fromObject({
    code: 203, error_code: 0, status: 'OK', user_id: '111',
    data: {
      conversations: [{ conversation_id: '0:1:111:222', conversation_short_id: '7547914245434769966', conversation_type: 1, ticket: 'tk-1', participants_count: 2, is_participant: true }],
      messages: [
        { conversation_id: '0:1:111:222', conversation_type: 1, server_message_id: '1', create_time: '1000', conversation_short_id: '7547914245434769966', message_type: 7, sender: '111', content: '{"text":"hi"}', sec_sender: 'MS4wSELF' },
        { conversation_id: '0:1:111:222', conversation_type: 1, server_message_id: '2', create_time: '2000', conversation_short_id: '7547914245434769966', message_type: 7, sender: '222', content: '{"text":"yo"}', sec_sender: 'MS4wPEER' },
      ],
      per_user_cursor: '3000', next_cursor: '10', has_more: false,
    },
  })).finish()
  const parsed = parseGetByUserInitResponse(Buffer.from(fixture))
  assert.equal(parsed.status, 'OK')
  assert.equal(parsed.selfUid, '111')
  assert.equal(parsed.data.conversations.length, 1)
  assert.equal(parsed.data.conversations[0].ticket, 'tk-1')
  assert.equal(parsed.data.messages.length, 2)
  assert.equal(parsed.data.messages.find((m) => m.serverMessageId === '2').secSender, 'MS4wPEER')
  assert.equal(parsed.data.hasMore, false)
  assert.equal(parsed.data.perUserCursor, '3000')
})

test('parseGetByUserInitResponse 对非 OK 状态抛错', () => {
  const root = protobuf.parse(`
    syntax = "proto3";
    message R { int32 error_code = 3; string status = 4; B data = 6; }
    message B {}
  `, { keepCase: true }).root
  const R = root.lookupType('R')
  const bytes = Buffer.from(R.encode(R.fromObject({ error_code: 8101, status: 'ILLEGAL_ACCESS_TOKEN' })).finish())
  assert.throws(() => parseGetByUserInitResponse(bytes), /ILLEGAL_ACCESS_TOKEN/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/im-proto.test.js`
Expected: FAIL —— `buildGetByUserInitBody`/`parseGetByUserInitResponse` 不是函数（SyntaxError: The requested module does not provide an export）

- [ ] **Step 3: 实现**

在 `components/im-proto.js` 的 `PROTO` 模板字符串中、`message DySendMsgResponse` 之前追加：

```proto
message GetByUserInitQuery {
  int64 cursor = 1;
  int64 count = 2;
}

message MessagesPerUserInitV2Body {
  repeated InitMessage messages = 1;
  repeated InitConversation conversations = 2;
  int64 per_user_cursor = 3;
  int64 next_cursor = 4;
  bool has_more = 5;
}

message InitMessage {
  string conversation_id = 1;
  int32 conversation_type = 2;
  int64 server_message_id = 3;
  int64 create_time = 4;
  int64 conversation_short_id = 5;
  int32 message_type = 6;
  int64 sender = 7;
  string content = 8;
  string sec_sender = 9;
}

message InitConversation {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;
  string ticket = 4;
  int32 participants_count = 5;
  bool is_participant = 6;
}

message GetByUserInitResponse {
  int32 code = 1;
  int32 sub_code = 2;
  int32 error_code = 3;
  string status = 4;
  int32 version = 5;
  MessagesPerUserInitV2Body data = 6;
  string trace_id = 7;
  int64 timestamp = 10;
  int64 server_time = 11;
  int64 user_id = 13;
}
```

在 `SendMessageBody` 定义里追加一行字段（放在 `create_session_request = 609;` 之后）：

```proto
  GetByUserInitQuery get_by_user_init_query = 203;
```

在文件顶部 import 里加入 `GET_BY_USER_INIT` 用到的模板（import 行已有 TEXT_MESSAGE_TEMPLATE，保持不变即可）。

在 `root.lookupType` 两行之后追加：

```js
const GetByUserInitResponse = root.lookupType('GetByUserInitResponse')
```

在文件末尾（`parseImResponse` 之后）追加两个导出函数：

```js
/**
 * 构造拉取会话列表（get_by_user_init）的 protobuf 请求体。
 * envelope 复用 message/send 抓包模板（同一 Web SDK 的长效设备凭据），仅 patch cmd/body。
 * @param {object} options
 * @param {string|number} options.cursor 分页游标（int64 字符串），首页 '0'
 * @param {number} [options.count=20] 每页数量
 * @param {string} [options.templateB64] 可选自定义 envelope 模板（config.im.getByUserInitTemplateB64）
 * @returns {Buffer}
 */
export function buildGetByUserInitBody({ cursor, count = 20, templateB64 }) {
  const request = decodeTemplate(templateB64 || TEXT_MESSAGE_TEMPLATE)
  request.cmd = 203
  request.sequence_id = 10000 + Math.floor(Math.random() * 50000)
  const body = request.send_message_body ?? {}
  body.get_by_user_init_query = { cursor: String(cursor ?? '0'), count: Number(count) || 20 }
  request.send_message_body = body
  return encodeRequest(request)
}

/**
 * 解析 get_by_user_init 响应。
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ status: string, errorCode: number, selfUid: string, hasMore: boolean, perUserCursor: string,
 *   conversations: Array<{conversationId: string, conversationShortId: string, conversationType: number, ticket: string, participantsCount: number}>,
 *   messages: Array<{conversationId: string, sender: string, secSender: string, createTime: string, serverMessageId: string}> }}
 */
export function parseGetByUserInitResponse(bytes) {
  const response = GetByUserInitResponse.toObject(GetByUserInitResponse.decode(bytes), {
    longs: String,
    defaults: false,
  })
  const status = response.status ?? ''
  if (status !== 'OK') {
    throw new Error(status || `状态码 ${response.error_code ?? '未知'}`)
  }
  const data = response.data ?? {}
  return {
    status,
    errorCode: Number(response.error_code ?? 0),
    selfUid: response.user_id ?? '',
    hasMore: Boolean(data.has_more),
    perUserCursor: data.per_user_cursor ?? '',
    conversations: (data.conversations ?? []).map((item) => ({
      conversationId: String(item.conversation_id ?? ''),
      conversationShortId: String(item.conversation_short_id ?? ''),
      conversationType: Number(item.conversation_type ?? 0),
      ticket: String(item.ticket ?? ''),
      participantsCount: Number(item.participants_count ?? 0),
    })),
    messages: (data.messages ?? []).map((item) => ({
      conversationId: String(item.conversation_id ?? ''),
      sender: String(item.sender ?? ''),
      secSender: String(item.sec_sender ?? ''),
      createTime: String(item.create_time ?? '0'),
      serverMessageId: String(item.server_message_id ?? ''),
    })),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/im-proto.test.js`
Expected: 4 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add components/im-proto.js test/im-proto.test.js
git commit -m "feat: im-proto 新增 get_by_user_init 请求构造与响应解析"
```

---

### Task 2: douyin-api 导出 postImProto + database 两处修改

**Files:**
- Modify: `components/douyin-api.js:85`（postImProto 加 export）
- Modify: `components/database.js`（addAccount 返回 id；replaceTargets 写入会话字段）
- Test: `test/database.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/database.test.js`（用临时目录隔离，不碰 data/data.db——database.js 的 dataDir 固定在插件 data/ 下，测试前后快照该文件；更简单的做法：测试直接接受写入插件 data/，因为 .gitignore 已排除且现有库为空）：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addAccount,
  listTargets,
  replaceTargets,
  deleteAccount,
} from '../components/database.js'

test('addAccount 返回新账号 id，replaceTargets 保留会话字段', async () => {
  const userId = `test-user-${Date.now()}`
  const id = await addAccount({ userId, name: `t-${Date.now()}`, cookies: [{ name: 'sessionid', value: 'x', domain: '.douyin.com' }], targetNames: [], messageTemplate: '' })
  assert.equal(typeof id, 'number', 'addAccount 应返回数字 id')
  await replaceTargets(id, [
    { secUid: 'MS4wA', uid: '222', nickname: '-peer-', conversationId: '0:1:111:222', conversationShortId: '7547', ticket: 'tk' },
  ])
  const targets = await listTargets(id)
  assert.equal(targets.length, 1)
  assert.equal(targets[0].secUid, 'MS4wA')
  assert.equal(targets[0].conversationId, '0:1:111:222')
  assert.equal(targets[0].conversationShortId, '7547')
  assert.equal(targets[0].ticket, 'tk')
  await deleteAccount(userId, (await import('../components/database.js')).name ? '' : '')
  // deleteAccount 按 name 删除；重新查出 name 再删，保持 data 干净
  const { listAccounts } = await import('../components/database.js')
  const account = (await listAccounts(userId))[0]
  if (account) await deleteAccount(userId, account.name)
})
```

> 注意：上面测试末尾的清理写法冗余了，实现时直接用 `listAccounts` 查出 name 后 `deleteAccount` 即可（提交前把多余的 `await deleteAccount(userId, '')` 两行删掉，保留 listAccounts 清理段）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/database.test.js`
Expected: FAIL —— addAccount 返回 undefined，`assert.equal(typeof id, 'number')` 失败

- [ ] **Step 3: 实现**

`components/douyin-api.js` 85 行，函数声明改为：

```js
export async function postImProto(path, cookieHeader, body, action, { signed = true, templateB64 } = {}) {
```

（仅去掉 `async` 前面加 `export`，函数体不动。）

`components/database.js` 的 `addAccount`（当前 136-153 行）改为返回新 id：

```js
export async function addAccount({ userId, name, cookies, targetNames, messageTemplate }) {
  return run((database) => {
    const now = new Date().toISOString()
    const normalizedUserId = String(userId)
    database.run('INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)', [normalizedUserId, now])
    try {
      database.run(
        'INSERT INTO accounts (user_id, name, cookies, target_names, message_template, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [normalizedUserId, name, JSON.stringify(cookies), JSON.stringify(targetNames), messageTemplate, now],
      )
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new Error(`已存在名为“${name}”的账号，请换一个名称或先删除旧账号`)
      }
      throw error
    }
    const [row] = rows(database, 'SELECT last_insert_rowid() AS id')
    return Number(row.id)
  }, true)
}
```

`components/database.js` 的 `replaceTargets`（当前 338-352 行）INSERT 改为写入会话字段：

```js
/** 整体替换账号的目标列表（网页配置保存时调用），保留会话信息避免续火时重建会话 */
export async function replaceTargets(accountId, targets) {
  return run((database) => {
    database.run('DELETE FROM targets WHERE account_id = ?', [Number(accountId)])
    const now = new Date().toISOString()
    for (const target of targets) {
      database.run(
        `INSERT INTO targets (account_id, sec_uid, uid, nickname, conversation_id, conversation_short_id, ticket, nickname_updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Number(accountId), String(target.secUid), String(target.uid || ''), String(target.nickname || ''),
          String(target.conversationId || ''), String(target.conversationShortId || ''), String(target.ticket || ''),
          target.nickname ? now : null, now],
      )
    }
    return targets.length
  }, true)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/database.test.js`
Expected: PASS

- [ ] **Step 5: 回归 im-proto 测试并提交**

Run: `node --test test/`
Expected: 全部 PASS

```bash
git add components/douyin-api.js components/database.js test/database.test.js
git commit -m "feat: postImProto 导出；addAccount 返回 id；replaceTargets 保留会话字段"
```

---

### Task 3: conversation-api.js —— 会话列表纯函数解析 + 拉取

**Files:**
- Create: `components/conversation-api.js`
- Test: `test/conversation-api.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/conversation-api.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractPeople } from '../components/conversation-api.js'

const page = (over) => ({
  conversations: [
    { conversationId: '0:1:111:222', conversationShortId: '100', conversationType: 1, ticket: 'tk1', participantsCount: 2 },
    { conversationId: '0:1:111:333', conversationShortId: '101', conversationType: 1, ticket: 'tk2', participantsCount: 2 },
    { conversationId: 'grp:9:111:333:444', conversationShortId: '102', conversationType: 9, ticket: '', participantsCount: 4 },
    { conversationId: '0:1:111:444', conversationShortId: '103', conversationType: 1, ticket: 'tk3', participantsCount: 2 },
  ],
  messages: [
    // 会话 A：最新一条是自己发的（sec_sender 是自己），前一条是对方发的
    { conversationId: '0:1:111:222', sender: '111', secSender: 'MS4wSELF', createTime: '3000', serverMessageId: '3' },
    { conversationId: '0:1:111:222', sender: '222', secSender: 'MS4wPEER_A', createTime: '2000', serverMessageId: '2' },
    // 会话 B：只有对方发的
    { conversationId: '0:1:111:333', sender: '333', secSender: 'MS4wPEER_B', createTime: '5000', serverMessageId: '5' },
    // 会话 D：只有自己发的（对方从未回复）→ 无对方 sec_uid，剔除
    { conversationId: '0:1:111:444', sender: '111', secSender: 'MS4wSELF', createTime: '4000', serverMessageId: '4' },
    // 群会话的消息 → 随会话一起被过滤
    { conversationId: 'grp:9:111:333:444', sender: '333', secSender: 'MS4wPEER_B', createTime: '6000', serverMessageId: '6' },
  ],
  hasMore: false,
  perUserCursor: '6000',
  ...over,
})

test('extractPeople 过滤群聊/无对方消息，反查对方 uid，取对方消息的 sec_sender，按时间降序', () => {
  const people = extractPeople([page()], '111')
  assert.equal(people.length, 2)
  // B 最晚（5000）在前，A（3000）在后
  assert.equal(people[0].uid, '333')
  assert.equal(people[0].secUid, 'MS4wPEER_B')
  assert.equal(people[0].conversationId, '0:1:111:333')
  assert.equal(people[0].ticket, 'tk2')
  assert.equal(people[1].uid, '222')
  assert.equal(people[1].secUid, 'MS4wPEER_A', '最新一条是自己发时应回退到对方发的消息取 sec_sender')
  assert.equal(people[1].lastMessageTime, '3000')
})

test('extractPeople 支持跨页合并与去重', () => {
  const secondPage = page({
    conversations: [
      { conversationId: '0:1:111:222', conversationShortId: '100', conversationType: 1, ticket: 'tk1-new', participantsCount: 2 },
    ],
    messages: [
      { conversationId: '0:1:111:222', sender: '222', secSender: 'MS4wPEER_A2', createTime: '9000', serverMessageId: '9' },
    ],
  })
  const people = extractPeople([page(), secondPage], '111')
  const a = people.find((p) => p.conversationId === '0:1:111:222')
  assert.equal(a.secUid, 'MS4wPEER_A2', '取跨页中最新一条对方消息')
  assert.equal(a.ticket, 'tk1-new', '后页会话信息覆盖前页')
  assert.equal(a.lastMessageTime, '9000')
})

test('extractPeople 在 selfUid 未知时不剔除自己 uid 侧（跳过该会话避免错选）', () => {
  const people = extractPeople([page()], '')
  // selfUid 为空 → 无法判定哪侧是对方 → 全部剔除，返回空列表
  assert.equal(people.length, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/conversation-api.test.js`
Expected: FAIL —— Cannot find module '../components/conversation-api.js'

- [ ] **Step 3: 实现**

创建 `components/conversation-api.js`：

```js
// 会话列表拉取：imapi get_by_user_init（protobuf，Cookie 鉴权），从 1v1 会话与消息中
// 反查对方 sec_uid/uid，供添加账号网页点选续火目标。纯 API，无浏览器。
import { getConfig } from './config.js'
import {
  DouyinApiError,
  buildCookieHeader,
  fetchUserProfile,
  getCookieValue,
  getSelfUidFromCookies,
  postImProto,
} from './douyin-api.js'
import { buildGetByUserInitBody, parseGetByUserInitResponse } from './im-proto.js'

const GET_BY_USER_INIT_PATH = '/v2/message/get_by_user_init'
const MAX_PAGES = 10
const PAGE_SIZE = 20
const MAX_PROFILE_FETCH = 30
const PAGE_INTERVAL_MS = 500
const PROFILE_INTERVAL_MS = 400

/**
 * 从多页解析结果中提取"会话里出现过的人"。
 * 规则：仅保留 1v1 会话（conversation_type=1 且 participants_count=2）；
 * 对方 sec_uid 取该会话中对方发来的最新一条消息的 sec_sender；
 * 对方 uid 从 conversation_id（0:1:uidA:uidB）中排除自己后取另一侧。
 * @param {Array} pages parseGetByUserInitResponse 返回的 data 数组（多页合并）
 * @param {string} selfUid 自己的 uid；为空时无法判定对方侧，返回空列表
 * @returns {Array<{secUid: string, uid: string, conversationId: string, conversationShortId: string, ticket: string, lastMessageTime: string}>}
 */
export function extractPeople(pages, selfUid) {
  if (!selfUid) return []
  const conversations = new Map()
  const latestByConversation = new Map() // 任意最新消息（取时间）
  const latestByPeer = new Map() // 对方发来的最新消息（取 sec_sender）
  for (const page of pages) {
    for (const conversation of page.conversations ?? []) {
      if (Number(conversation.conversationType) !== 1) continue
      if (Number(conversation.participantsCount || 0) !== 2) continue
      conversations.set(conversation.conversationId, conversation)
    }
    for (const message of page.messages ?? []) {
      const prevAny = latestByConversation.get(message.conversationId)
      if (!prevAny || Number(message.createTime) >= Number(prevAny.createTime)) {
        latestByConversation.set(message.conversationId, message)
      }
      if (String(message.sender) === String(selfUid)) continue
      const prevPeer = latestByPeer.get(message.conversationId)
      if (!prevPeer || Number(message.createTime) >= Number(prevPeer.createTime)) {
        latestByPeer.set(message.conversationId, message)
      }
    }
  }

  const people = []
  for (const [conversationId, conversation] of conversations) {
    const peerMessage = latestByPeer.get(conversationId)
    if (!peerMessage?.secSender) continue // 对方从未发过消息，拿不到 sec_uid
    const segments = String(conversationId).split(':')
    if (segments.length < 4) continue
    const peerUid = segments.slice(2).find((uid) => uid && uid !== String(selfUid))
    if (!peerUid) continue
    people.push({
      secUid: peerMessage.secSender,
      uid: peerUid,
      conversationId,
      conversationShortId: String(conversation.conversationShortId),
      ticket: String(conversation.ticket || ''),
      lastMessageTime: String(latestByConversation.get(conversationId)?.createTime || peerMessage.createTime),
    })
  }
  people.sort((a, b) => Number(b.lastMessageTime) - Number(a.lastMessageTime))
  return people
}

/**
 * 拉取账号会话列表中出现过的用户（昵称通过 profile 接口逐个补全）
 * @param {Array} cookies Cookie-Editor JSON 数组
 * @param {{ onProgress?: (msg: string) => void }} [options]
 * @returns {Promise<Array<{secUid: string, uid: string, nickname: string, conversationId: string, conversationShortId: string, ticket: string, lastMessageTime: string}>>}
 */
export async function listConversations(cookies, { onProgress } = {}) {
  const progress = onProgress || (() => {})
  const cookieHeader = buildCookieHeader(cookies)
  const templateB64 = getConfig().im?.getByUserInitTemplateB64 || undefined

  const pages = []
  let cursor = '0'
  for (let index = 0; index < MAX_PAGES; index += 1) {
    progress(`正在拉取会话列表（第 ${index + 1} 页）…`)
    const body = buildGetByUserInitBody({ cursor, count: PAGE_SIZE, templateB64 })
    let parsed
    try {
      parsed = await postImProto(GET_BY_USER_INIT_PATH, cookieHeader, body, '拉取会话列表', { signed: false })
    } catch (error) {
      throw error
    }
    // postImProto 返回的是 parseImResponse 的产物（针对 message/send 结构），
    // get_by_user_init 需要重新按本接口结构解析原始字节 —— 因此这里走独立解析：
    // 见下方 listConversationsRaw。
    pages.push(parsed)
    throw new Error('UNREACHABLE —— 由 listConversationsRaw 实现，本函数体在 Step 4 重写')
  }
}
```

**这个初版是刻意留的失败态**：postImProto 内部用 `parseImResponse` 解析并校验，而 get_by_user_init 响应结构不同——直接复用会在 `statusMessage !== 'OK'` 判断上碰巧兼容（同外层 status 字段），但拿不到 conversations/messages。正确做法是 Step 4：给 postImProto 增加一个"返回原始字节"的模式，或新写一个 `postImProtoRaw`。**执行 Step 4 时把上面的 `listConversations` 整个函数体重写为下述最终版**（extractPeople 保持不变）：

在 `components/douyin-api.js` 中、`postImProto` 之后追加（复用 imHeaders/assertHttpOk）：

```js
/**
 * 发送 imapi protobuf 请求并返回原始字节（调用方按各自接口结构解析）。
 * 与 postImProto 的区别：不做 message/send 语义的响应解析。
 * @returns {Promise<Buffer>}
 */
export async function postImProtoRaw(path, cookieHeader, body, action, { signed = false } = {}) {
  let url = `${IMAPI_BASE}${path}`
  if (signed) {
    const msToken = genMsToken()
    const fp = genVerifyFp()
    const query = `msToken=${encodeURIComponent(msToken)}&verifyFp=${encodeURIComponent(fp)}&fp=${encodeURIComponent(fp)}`
    url += `?${query}&a_bogus=${encodeURIComponent(signABogus(query, USER_AGENT))}`
  }
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: imHeaders(cookieHeader),
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new DouyinApiError(`${action}：网络请求异常（${error.message}）`, { kind: 'network' })
  }
  assertHttpOk(response, action)
  return Buffer.from(await response.arrayBuffer())
}
```

`components/conversation-api.js` 的 `listConversations` 最终版（替换初版函数体；import 增加 `postImProtoRaw`，删除 `postImProto`）：

```js
export async function listConversations(cookies, { onProgress } = {}) {
  const progress = onProgress || (() => {})
  const cookieHeader = buildCookieHeader(cookies)
  const templateB64 = getConfig().im?.getByUserInitTemplateB64 || undefined

  const pages = []
  let cursor = '0'
  for (let index = 0; index < MAX_PAGES; index += 1) {
    progress(`正在拉取会话列表（第 ${index + 1} 页）…`)
    const body = buildGetByUserInitBody({ cursor, count: PAGE_SIZE, templateB64 })
    const bytes = await postImProtoRaw(GET_BY_USER_INIT_PATH, cookieHeader, body, '拉取会话列表')
    let parsed
    try {
      parsed = parseGetByUserInitResponse(bytes)
    } catch (error) {
      throw new DouyinApiError(
        `拉取会话列表失败：${error.message}。若持续失败，会话列表协议可能已更新，请按 README 抓包更新 im.getByUserInitTemplateB64`,
        { kind: 'api' },
      )
    }
    if ((parsed.conversations.length === 0) && (parsed.messages.length === 0) && index === 0) {
      throw new DouyinApiError('会话列表响应为空，协议字段可能已变更，请按 README 抓包更新 im.getByUserInitTemplateB64', { kind: 'api' })
    }
    pages.push(parsed)
    if (!parsed.hasMore || !parsed.perUserCursor) break
    cursor = parsed.perUserCursor
    if (index < MAX_PAGES - 1) await new Promise((resolve) => setTimeout(resolve, PAGE_INTERVAL_MS))
  }
  if (pages.length >= MAX_PAGES) progress(`已达 ${MAX_PAGES} 页上限，仅返回最近的部分会话`)

  const selfUid = pages.find((page) => page.selfUid)?.selfUid || getSelfUidFromCookies(cookies)
  let people = extractPeople(pages, selfUid)
  if (people.length === 0) {
    throw new DouyinApiError('没有解析到可选择的会话（该账号可能无私信记录，或协议字段已变更）', { kind: 'api' })
  }

  // 昵称补全：响应不含昵称，逐个查 profile；超上限的条目昵称留空（前端显示 ID 短版）
  progress(`已发现 ${people.length} 个会话用户，正在获取昵称…`)
  const webid = getCookieValue(cookies, 's_v_web_id')
  const uifid = getCookieValue(cookies, 'UIFID')
  for (const [index, person] of people.entries()) {
    if (index >= MAX_PROFILE_FETCH) break
    try {
      const profile = await fetchUserProfile(cookieHeader, person.secUid, { webid, uifid })
      person.nickname = profile.nickname
      if (profile.uid) person.uid = profile.uid
    } catch {
      person.nickname = ''
    }
    await new Promise((resolve) => setTimeout(resolve, PROFILE_INTERVAL_MS))
  }
  people = people.map((person) => ({ ...person, nickname: person.nickname || '' }))
  return people
}
```

注意 `parseGetByUserInitResponse` 返回结构：`selfUid/hasMore/perUserCursor/conversations/messages` 都在顶层（Task 1 的返回形状），`pages.push(parsed)` 推入的就是完整对象，`extractPeople(pages, selfUid)` 消费其 `conversations/messages` 字段——与 Task 3 测试里 `page()` fixture 的字段名一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/conversation-api.test.js`
Expected: 3 pass

- [ ] **Step 5: 回归并提交**

Run: `node --test test/`
Expected: 全部 PASS

```bash
git add components/conversation-api.js components/douyin-api.js test/conversation-api.test.js
git commit -m "feat: 会话列表纯 API 拉取（get_by_user_init 分页解析）"
```

---

### Task 4: qr-login.js —— 纯 API 扫码登录

**Files:**
- Create: `components/qr-login.js`
- Test: `test/qr-login.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/qr-login.test.js`（用 `t.mock.method(globalThis, 'fetch', ...)` 打桩全局 fetch；qr-login.js 必须使用全局 `fetch` 而非任何 HTTP 库）：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createQrLoginSession,
  pollQrLogin,
  toCookieEditorArray,
} from '../components/qr-login.js'

function jsonResponse(body, setCookies = []) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    getSetCookie: () => setCookies,
    json: async () => body,
  }
}

test('createQrLoginSession 预热取 ttwid 并请求 get_qrcode', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url))
    if (String(url).startsWith('https://www.douyin.com/')) {
      return jsonResponse({}, ['ttwid=abc123; Domain=.douyin.com; Path=/'])
    }
    return jsonResponse({ data: { token: 'qr-token-1', qrcode: 'data:image/png;base64,AAAA' } })
  })
  const session = await createQrLoginSession()
  assert.equal(session.token, 'qr-token-1')
  assert.equal(session.qr, 'data:image/png;base64,AAAA')
  assert.equal(session.jar.get('ttwid')?.value, 'abc123')
  assert.ok(calls[0].startsWith('https://www.douyin.com/'))
  assert.ok(calls[1].includes('sso.douyin.com/get_qrcode'))
})

test('pollQrLogin 映射扫码状态：1 待扫 / 2 已扫', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ data: { status: 1 } }))
  const waiting = await pollQrLogin({ jar: new Map(), token: 't', lastPollAt: 0, cached: undefined })
  assert.equal(waiting.status, 'waiting')
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ data: { status: 2 } }))
  const scanned = await pollQrLogin({ jar: new Map(), token: 't', lastPollAt: 0, cached: undefined })
  assert.equal(scanned.status, 'scanned')
})

test('pollQrLogin 确认后换 Cookie：ticket → callback → sessionid', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url)
    if (u.includes('check_qrconnect')) {
      return jsonResponse({ data: { status: 3, redirect_url: 'https://sso.douyin.com/passport/sso/login/callback/?token=x&ticket=ST-123' } })
    }
    if (u.includes('passport/sso/login/callback')) {
      assert.ok(u.includes('ticket=ST-123'), 'callback URL 应带提取的 ticket')
      return jsonResponse({}, ['sessionid=sess-1; Domain=.douyin.com; Path=/', 'sid_tt=sess-1; Domain=.douyin.com; Path=/'])
    }
    throw new Error(`unexpected fetch: ${u}`)
  })
  const session = { jar: new Map([['ttwid', { name: 'ttwid', value: 'x', domain: '.douyin.com' }]]), token: 't', lastPollAt: 0, cached: undefined }
  const result = await pollQrLogin(session)
  assert.equal(result.status, 'success')
  const sessionid = result.cookies.find((cookie) => cookie.name === 'sessionid')
  assert.equal(sessionid.value, 'sess-1')
  assert.equal(sessionid.domain, '.douyin.com')
})

test('pollQrLogin 过期与取消为终态', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ data: { status: 5 } }))
  const expired = await pollQrLogin({ jar: new Map(), token: 't', lastPollAt: 0, cached: undefined })
  assert.equal(expired.status, 'expired')
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ data: { status: 4 } }))
  const canceled = await pollQrLogin({ jar: new Map(), token: 't', lastPollAt: 0, cached: undefined })
  assert.equal(canceled.status, 'canceled')
})

test('pollQrLogin 节流：间隔内直接返回缓存状态不再请求', async (t) => {
  let fetchCount = 0
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1
    return jsonResponse({ data: { status: 1 } })
  })
  const session = { jar: new Map(), token: 't', lastPollAt: Date.now(), cached: { status: 'waiting' } }
  const result = await pollQrLogin(session)
  assert.equal(result.status, 'waiting')
  assert.equal(fetchCount, 0)
})

test('pollQrLogin 确认后无 sessionid 报二次验证错误', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url)
    if (u.includes('check_qrconnect')) {
      return jsonResponse({ data: { status: 3, redirect_url: 'https://sso.douyin.com/x?ticket=ST-9' } })
    }
    return jsonResponse({}, ['ttwid=1; Domain=.douyin.com; Path=/'])
  })
  const session = { jar: new Map(), token: 't', lastPollAt: 0, cached: undefined }
  const result = await pollQrLogin(session)
  assert.equal(result.status, 'error')
  assert.match(result.message, /安全验证|Cookie/)
})

test('toCookieEditorArray 输出 parseCookies 兼容的 Cookie-Editor 形状', () => {
  const jar = new Map([
    ['douyin.com:sessionid', { name: 'sessionid', value: 's', domain: '.douyin.com', path: '/', httpOnly: true, secure: true }],
    ['douyin.com:x', { name: 'x', value: '1', domain: 'www.douyin.com' }],
    ['other.com:y', { name: 'y', value: '2', domain: 'other.com' }],
  ])
  const cookies = toCookieEditorArray(jar)
  assert.equal(cookies.length, 2, '只输出 douyin.com 域')
  assert.deepEqual(Object.keys(cookies[0]).sort(), ['domain', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'session', 'value'])
  assert.equal(cookies[0].sameSite, 'Lax')
  assert.equal(cookies[0].session, true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/qr-login.test.js`
Expected: FAIL —— Cannot find module '../components/qr-login.js'

- [ ] **Step 3: 实现**

创建 `components/qr-login.js`：

```js
// 抖音扫码登录（纯 API）：
// GET sso.douyin.com/get_qrcode 拿二维码 token → 轮询 check_qrconnect →
// 确认后从 redirect_url 提取 ticket → GET www.douyin.com/passport/sso/login/callback 换登录 Cookie。
// 参考 yijianguanzhu/douyin-qrcode-login；无法处理扫码后的短信/滑块二次验证（报错引导 Cookie 粘贴）。
import { DouyinApiError, USER_AGENT } from './douyin-api.js'

const SSO_BASE = 'https://sso.douyin.com'
const CALLBACK_URL = 'https://www.douyin.com/passport/sso/login/callback/'
const SSO_PARAMS = {
  service: 'www.douyin.com',
  aid: '6383',
  account_sdk_source: 'sso',
  sdk_version: '2.2.5-beta.6',
  language: 'zh',
}
const POLL_MIN_INTERVAL_MS = 1500
const MAX_REDIRECT_HOPS = 5

function buildQuery(extra) {
  return new URLSearchParams({ ...SSO_PARAMS, ...extra }).toString()
}

async function fetchWithJar(url, jar, { method = 'GET', redirect = 'manual' } = {}) {
  const cookieHeader = [...jar.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  let response
  try {
    response = await fetch(url, {
      method,
      redirect,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json, text/plain, */*',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    throw new DouyinApiError(`扫码登录：网络请求异常（${error.message}）`, { kind: 'network' })
  }
  mergeSetCookies(response, jar)
  return response
}

function mergeSetCookies(response, jar) {
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  for (const raw of setCookies) {
    const [pair, ...attributes] = raw.split(';')
    const equals = pair.indexOf('=')
    if (equals <= 0) continue
    const name = pair.slice(0, equals).trim()
    const value = pair.slice(equals + 1).trim()
    let domain = ''
    for (const attribute of attributes) {
      const [key, val] = attribute.split('=').map((part) => part.trim())
      if (key.toLowerCase() === 'domain') domain = val || ''
    }
    if (!domain || !domain.includes('douyin.com')) continue
    jar.set(`${domain}:${name}`, { name, value, domain, path: '/' })
  }
}

async function readJson(response, action) {
  let json
  try {
    json = await response.json()
  } catch {
    throw new DouyinApiError(`${action}：响应不是有效 JSON，可能触发风控验证`, { kind: 'risk' })
  }
  if (json?.data?.error_code && json.data.error_code !== 0) {
    throw new DouyinApiError(`${action}：${json.data.description || `错误码 ${json.data.error_code}`}`, { kind: 'api' })
  }
  return json
}

/**
 * 创建扫码登录会话：先访问 douyin.com 预热 Cookie（ttwid 等），再请求二维码。
 * @returns {Promise<{ jar: Map, token: string, qr: string, status: string, lastPollAt: number, cached: object|undefined }>}
 */
export async function createQrLoginSession() {
  const jar = new Map()
  await fetchWithJar('https://www.douyin.com/', jar, { redirect: 'follow' }).catch(() => null)
  const response = await fetchWithJar(`${SSO_BASE}/get_qrcode/?${buildQuery({ need_logo: 'true', token: '' })}`, jar)
  if (response.status !== 200) {
    throw new DouyinApiError(`获取登录二维码失败（HTTP ${response.status}），请稍后重试或改用 Cookie 粘贴方式`, { kind: 'risk', statusCode: response.status })
  }
  const json = await readJson(response, '获取登录二维码')
  const data = json?.data
  if (!data?.token || !data?.qrcode) {
    throw new DouyinApiError('获取登录二维码失败：响应缺少 token 或二维码数据', { kind: 'api' })
  }
  return { jar, token: String(data.token), qr: String(data.qrcode), status: 'waiting', lastPollAt: 0, cached: undefined }
}

/**
 * 轮询扫码状态（幂等，带 1.5s 节流；前端每次调 status 端点触发一次）。
 * @returns {Promise<{status: 'waiting'|'scanned'|'success'|'expired'|'canceled'|'error', message?: string, cookies?: Array}>}
 */
export async function pollQrLogin(session) {
  if (session.terminal) return session.cached
  if (Date.now() - session.lastPollAt < POLL_MIN_INTERVAL_MS) {
    return session.cached ?? { status: 'waiting' }
  }
  session.lastPollAt = Date.now()

  const response = await fetchWithJar(`${SSO_BASE}/check_qrconnect/?${buildQuery({ token: session.token })}`, session.jar)
  if (response.status !== 200) {
    throw new DouyinApiError(`读取扫码状态失败（HTTP ${response.status}）`, { kind: 'risk', statusCode: response.status })
  }
  const json = await readJson(response, '读取扫码状态')
  const status = Number(json?.data?.status ?? 0)

  if (status === 1) return (session.cached = { status: 'waiting' })
  if (status === 2) return (session.cached = { status: 'scanned', message: '已扫码，请在手机上确认登录。' })

  if (status === 3) {
    const redirectUrl = String(json.data.redirect_url || '')
    const ticket = new URL(redirectUrl).searchParams.get('ticket') || ''
    if (!ticket) {
      session.terminal = true
      return (session.cached = { status: 'error', message: '登录回调缺少 ticket，请重新获取二维码。' })
    }
    try {
      await collectLoginCookies(`${CALLBACK_URL}?${buildQuery({})}&next=https://www.douyin.com&ticket=${encodeURIComponent(ticket)}`, session.jar)
    } catch (error) {
      session.terminal = true
      return (session.cached = { status: 'error', message: error.message })
    }
    const sessionCookie = [...session.jar.values()].find((cookie) => cookie.name === 'sessionid')
    if (!sessionCookie) {
      session.terminal = true
      return (session.cached = {
        status: 'error',
        message: '该账号扫码登录触发安全验证，请改用粘贴 Cookie 方式（浏览器登录 douyin.com 后用 Cookie-Editor 导出）。',
      })
    }
    session.terminal = true
    return (session.cached = { status: 'success', cookies: toCookieEditorArray(session.jar) })
  }

  if (status === 4) {
    session.terminal = true
    return (session.cached = { status: 'canceled', message: '已在手机上取消登录，请重新获取二维码。' })
  }
  if (status === 5) {
    session.terminal = true
    return (session.cached = { status: 'expired', message: '二维码已过期，请点击刷新二维码。' })
  }
  return (session.cached = { status: 'waiting' })
}

/** 逐跳跟随登录回调（302），把每一跳的 Set-Cookie 都收进 jar */
async function collectLoginCookies(url, jar) {
  let current = url
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    const response = await fetchWithJar(current, jar)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return
      current = location.startsWith('http') ? location : new URL(location, current).toString()
      continue
    }
    return
  }
}

/**
 * jar → Cookie-Editor JSON 数组（与 account-setup.parseCookies 的校验兼容）
 * @param {Map} jar
 * @returns {Array<{name, value, domain, path, httpOnly, secure, sameSite, session}>}
 */
export function toCookieEditorArray(jar) {
  const cookies = []
  for (const cookie of jar.values()) {
    cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
      session: true,
    })
  }
  return cookies
}
```

> `get_qrcode` 的 `need_logo` 之外参数与参考实现对齐；若真实接口对参数有更严格要求（返回非 JSON），会走 `readJson` 的 kind='risk' 报错，文案引导 Cookie 粘贴——这是设计文档规定的兜底行为。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/qr-login.test.js`
Expected: 7 pass

- [ ] **Step 5: 回归并提交**

Run: `node --test test/`
Expected: 全部 PASS

```bash
git add components/qr-login.js test/qr-login.test.js
git commit -m "feat: 纯 API 扫码登录（get_qrcode/check_qrconnect/ticket 换 Cookie）"
```

---

### Task 5: web-setup.js 后端重构 —— 接新组件、收 targets

**Files:**
- Modify: `components/web-setup.js`

这是重构任务（无单测，端到端在 Task 9 手测）。改动按函数列，执行时逐块对照删除/替换。

- [ ] **Step 1: 替换 import 与 scanSessions 语义**

删除（第 5-9 行区域）：

```js
import { chromium } from 'playwright'
import { getBrowserLaunchOptions, getConfig, getPluginRoot } from './config.js'
import { addAccount, getUserNotificationSettings, listAccounts, listTargets, replaceTargets, setUserEmail, setUserSuccessEmailEnabled, updateAccount } from './database.js'
import { isValidEmail, parseCookies, validateTemplate } from './account-setup.js'
import { scanConversations } from './conversation-scan.js'
```

替换为：

```js
import fs from 'node:fs/promises'   // 若不再使用也一并删除（见 Step 4 截图函数删除后 fs/path 不再需要）
import { getConfig } from './config.js'
import { addAccount, getUserNotificationSettings, listAccounts, listTargets, replaceTargets, setUserEmail, setUserSuccessEmailEnabled, updateAccount } from './database.js'
import { isValidEmail, parseCookies, validateTemplate } from './account-setup.js'
import { listConversations } from './conversation-api.js'
import { createQrLoginSession, pollQrLogin } from './qr-login.js'
```

（`randomBytes/createServer` 等既有 import 保持；`fs`、`path` 在删除截图函数后若无引用则删除。）

- [ ] **Step 2: 改写 scan 相关 handler**

整块删除以下函数（原 292-543 行区域）：`startScanSession`、`captureDouyinQr`、`getScanStatus`、`maybeRequestSmsVerification`、`submitScanSmsCode`、`clickSmsSubmit`、`hasDouyinSessionCookie`、`saveScanScreenshot`、`looksLoggedInPage`、`closeScanSession`、`closeScanBrowser`。

删除 `handleScanSms`、`handleScanScreenshot` 两个 handler 及路由注册里的 `api/scan/sms/:token`、`api/scan/screenshot/:token` 两行（mounted 注册在 134-135 行，standalone 正则在 162-163、170-171 行，同步删除）。

替换后的新实现（放在原 scan handler 区域）：

```js
async function handleScanStart(token, res) {
  const session = getSession(token)
  if (!session) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  try {
    const qrSession = await createQrLoginSession()
    qrSessions.set(token, qrSession)
    sendJson(res, 200, { ok: true, status: 'waiting', qr: qrSession.qr })
  } catch (error) {
    logger.error('[抖音ID续火] 启动扫码登录失败', error)
    sendJson(res, 400, { ok: false, message: error.message || '启动扫码登录失败。' })
  }
}

async function handleScanRefresh(token, res) {
  qrSessions.delete(token)
  return handleScanStart(token, res)
}

async function handleScanStatus(token, res) {
  if (!getSession(token)) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  const qrSession = qrSessions.get(token)
  if (!qrSession) return sendJson(res, 200, { ok: true, status: 'idle' })
  try {
    const result = await pollQrLogin(qrSession)
    if (['success', 'error', 'expired', 'canceled'].includes(result.status)) qrSessions.delete(token)
    sendJson(res, 200, { ok: true, ...result })
  } catch (error) {
    qrSessions.delete(token)
    sendJson(res, 400, { ok: false, message: error.message || '读取扫码状态失败。' })
  }
}
```

顶部 `const scanSessions = new Map()` 改名为：

```js
const qrSessions = new Map()
```

全文搜索 `closeScanSession`（出现在 session 过期清理 `purgeExpiredSessions`/`getSession`/`revokeSetupLinks`/`handleSetupSubmit` 里）——全部替换为 `qrSessions.delete(token)`（qr 会话无外部资源，直接删即可）。具体四处：

```js
// createSetupLink 的 expiryTimer 回调
sessions.delete(token)
qrSessions.delete(token)

// revokeSetupLinks
sessions.delete(token)
clearTimeout(session.expiryTimer)
qrSessions.delete(token)

// getSession 过期分支
sessions.delete(token)
clearTimeout(session?.expiryTimer)
qrSessions.delete(token)

// handleSetupSubmit 成功分支
sessions.delete(token)
clearTimeout(session.expiryTimer)
qrSessions.delete(token)
```

- [ ] **Step 3: 改 conversations handler**

`handleConversationScan`（原 217-230 行）整函数替换为：

```js
async function handleConversationScan(token, body, res) {
  const session = getSession(token)
  if (!session) return sendJson(res, 404, { ok: false, message: '链接无效或已过期，请重新发送命令。' })
  session.scanning = session.scanning ?? false
  if (session.scanning) return sendJson(res, 409, { ok: false, message: '正在拉取会话列表，请稍候。' })
  session.scanning = true
  try {
    const cookies = await resolveSessionCookies(session, body?.cookieText)
    const list = await listConversations(cookies, {
      onProgress: (message) => logger.info(`[抖音续火] 会话扫描：${message}`),
    })
    sendJson(res, 200, { ok: true, list })
  } catch (error) {
    logger.error('[抖音续火] 拉取会话列表失败', error)
    sendJson(res, 400, { ok: false, message: error.message || '拉取会话列表失败。' })
  } finally {
    session.scanning = false
  }
}
```

- [ ] **Step 4: saveWebSetup 收 targets、getInitialValues 补全**

`getInitialValues`（原 593-614 行）修改模式返回的 targets 映射补字段：

```js
  const targets = (await listTargets(account.id)).map((target) => ({
    secUid: target.secUid,
    uid: target.uid,
    nickname: target.nickname,
    conversationId: target.conversationId,
    conversationShortId: target.conversationShortId,
    ticket: target.ticket,
  }))
```

`saveWebSetup`（原 616-652 行）在 `const cookieText = ...` 之前插入 targets 解析，并在两个账号写入分支之后统一执行 replaceTargets：

```js
async function saveWebSetup(session, body) {
  if (!body || typeof body !== 'object') throw new Error('提交内容无效')
  const name = String(body.name || '').trim()
  if (!name || name.length > 40) throw new Error('账号名称不能为空且不能超过 40 个字符')

  const messageTemplate = String(body.messageTemplate || '').trim()
  validateTemplate(messageTemplate)
  const email = String(body.email || '').trim()
  if (email && !isValidEmail(email)) throw new Error('邮箱格式不正确')
  const successEmailEnabled = body.successEmailEnabled === true || body.successEmailEnabled === 'true'
  if (successEmailEnabled && !email) throw new Error('开启成功邮件通知前，请先填写收件邮箱')

  const targets = normalizeWebTargets(body.targets)

  const cookieText = String(body.cookieText || '').trim()
  let ignored = 0
  let accountId
  if (session.accountId === undefined) {
    if (!cookieText) throw new Error('请粘贴 Cookie JSON、选择 .txt 文件或扫码登录')
    const parsed = parseCookies(cookieText)
    ignored = parsed.ignored
    accountId = await addAccount({ userId: session.userId, name, cookies: parsed.cookies, targetNames: [], messageTemplate })
  } else {
    const account = (await listAccounts(session.userId)).find((item) => item.id === session.accountId)
    if (!account) throw new Error('账号不存在，请重新发送修改命令')
    accountId = account.id
    const parsed = cookieText ? parseCookies(cookieText) : { cookies: account.cookies, ignored: 0 }
    ignored = parsed.ignored
    await updateAccount({
      id: session.accountId,
      userId: session.userId,
      name,
      cookies: parsed.cookies,
      targetNames: account.targetNames ?? [],
      messageTemplate,
    })
  }
  await replaceTargets(accountId, targets)
  await setUserEmail(session.userId, email)
  await setUserSuccessEmailEnabled(session.userId, successEmailEnabled)
  return `${session.accountId === undefined ? '账号已添加' : '账号已更新'}${ignored ? `，已忽略 ${ignored} 条无法使用的 Cookie` : ''}，共 ${targets.length} 个续火目标。现在可以关闭此页面。`
}

/** 校验并规范化网页提交的续火目标列表 */
function normalizeWebTargets(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('续火目标数据无效')
  const seen = new Set()
  const targets = []
  for (const item of value) {
    const secUid = String(item?.secUid || '').trim()
    if (!secUid) throw new Error('存在缺少用户 ID 的续火目标，请重新选择')
    if (seen.has(secUid)) continue
    seen.add(secUid)
    targets.push({
      secUid,
      uid: String(item.uid || ''),
      nickname: String(item.nickname || ''),
      conversationId: String(item.conversationId || ''),
      conversationShortId: String(item.conversationShortId || ''),
      ticket: String(item.ticket || ''),
    })
  }
  if (targets.length > 100) throw new Error('续火目标一次最多保存 100 个')
  return targets
}
```

- [ ] **Step 5: 语法与启动自检**

Run: `node --check components/web-setup.js && node --test test/`
Expected: 语法 OK，既有测试全 PASS（web-setup 未被单测覆盖，此处防语法/引用错误）

再跑一次模块加载自检（config.js 依赖 logger 全局，需 stub）：

```bash
node --input-type=module -e "globalThis.logger = { info(){}, warn(){}, error(){}, mark(){} }; await import('./components/web-setup.js'); console.log('web-setup loads OK')"
```

Expected: 输出 `web-setup loads OK`（registerSetupRoutes 会在 mounted 模式因无 Bot.express 抛错——若报错是"Yunzai HTTP 服务尚未就绪"则属预期，改为验证 import 不抛其他错即可：`try { await import(...) } catch (e) { if (!/HTTP 服务尚未就绪/.test(e.message)) throw e; console.log('web-setup loads OK (routes deferred)') }`）

- [ ] **Step 6: Commit**

```bash
git add components/web-setup.js
git commit -m "refactor: web-setup 扫码/会话接口接入纯 API 组件，支持网页提交续火目标"
```

---

### Task 6: 网页 UI —— 扫码区去短信 + 目标选人区块

**Files:**
- Modify: `components/web-setup.js`（`renderSetupPage` 函数）

- [ ] **Step 1: HTML 改动**

在 `<style>` 块末尾（`#status.ok` 规则后）追加：

```css
    .targets { display: grid; gap: 8px; }
    .targets-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .target-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; max-height: 320px; overflow-y: auto; padding: 2px; }
    .target-card { display: grid; gap: 2px; border: 1px solid #d7dee8; border-radius: 5px; padding: 10px; cursor: pointer; background: #fff; }
    .target-card:hover { border-color: #247bb7; }
    .target-card.selected { border-color: #1976b7; background: #eaf3fb; box-shadow: inset 0 0 0 1px #1976b7; }
    .target-card .nick { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .target-card .meta { color: #667085; font-size: 11px; }
```

删除扫码区的短信 DOM（`<div id="smsVerify" class="sms">` 整块，原 708-712 行）和 `.sms` CSS 规则。

在 `</div>`（`.scan` 区块结束）与 Cookie label 之间插入目标区块：

```html
      <div class="targets">
        <div class="targets-actions">
          <button id="loadTargets" type="button">从会话列表选择目标</button>
          <span id="targetsStatus" class="hint">添加或扫码填入 Cookie 后可拉取会话里出现过的人。</span>
        </div>
        <div id="targetList" class="target-list"></div>
      </div>
```

- [ ] **Step 2: JS 改动**

删除 `<script>` 里所有 sms 相关：`smsVerify/smsCode/smsSubmit` 的 querySelector、`smsSubmit.addEventListener` 整块。

`requestQr` 轮询回调里 `result.status === 'sms'` 分支删除；新增 `scanned` 分支：

```js
            } else if (result.status === 'scanned') {
              scanStatus.textContent = result.message || '已扫码，请在手机上确认登录。';
```

在 `const initial = ${data};` 之后、cookieFile 监听之前，追加目标选人逻辑：

```js
    const loadTargets = document.querySelector('#loadTargets');
    const targetsStatus = document.querySelector('#targetsStatus');
    const targetList = document.querySelector('#targetList');
    const selected = new Map(); // secUid -> 条目
    function renderTargetCards() {
      targetList.querySelectorAll('.target-card').forEach((card) => {
        card.classList.toggle('selected', selected.has(card.dataset.secUid));
      });
      targetsStatus.textContent = selected.size ? `已选 ${selected.size} 个目标，提交后生效。` : '点击卡片选择/取消续火目标。';
    }
    function addTargetCard(item) {
      const card = document.createElement('div');
      card.className = 'target-card';
      card.dataset.secUid = item.secUid;
      card.dataset.entry = JSON.stringify(item);
      const nick = document.createElement('div');
      nick.className = 'nick';
      nick.textContent = item.nickname || item.secUid.slice(0, 16);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = item.lastMessageTime ? new Date(Number(item.lastMessageTime)).toLocaleString() : '';
      card.append(nick, meta);
      card.addEventListener('click', () => {
        if (selected.has(item.secUid)) selected.delete(item.secUid);
        else selected.set(item.secUid, item);
        renderTargetCards();
      });
      targetList.append(card);
    }
    for (const item of initial.targets || []) {
      if (!item.secUid) continue;
      selected.set(item.secUid, item);
      addTargetCard(item);
    }
    renderTargetCards();
    loadTargets.addEventListener('click', async () => {
      loadTargets.disabled = true;
      targetsStatus.textContent = '正在拉取会话列表，可能需要几十秒…';
      try {
        const response = await fetch('${webState.prefix}/api/conversations/${token}', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookieText: document.querySelector('#cookieText').value.trim() }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.message || '拉取会话列表失败');
        targetList.innerHTML = '';
        for (const item of data.list) {
          if (selected.has(item.secUid)) addTargetCard({ ...item, nickname: item.nickname || selected.get(item.secUid).nickname });
          else addTargetCard(item);
        }
        if (!data.list.length) targetsStatus.textContent = '没有拉到会话，请确认 Cookie 有效且账号有私信记录。';
        else { renderTargetCards(); targetsStatus.textContent = `共 ${data.list.length} 个会话用户，已选 ${selected.size} 个。`; }
      } catch (error) {
        targetsStatus.textContent = error.message || '拉取会话列表失败。';
      } finally {
        loadTargets.disabled = false;
      }
    });
```

表单 submit 回调里 `payload.cookieText = ...` 之后追加：

```js
      payload.targets = [...selected.values()];
```

- [ ] **Step 3: 语法自检与提交**

Run: `node --check components/web-setup.js`
Expected: 无输出（语法 OK）

```bash
git add components/web-setup.js
git commit -m "feat: 添加账号网页支持从会话列表点选续火目标，扫码区移除短信验证"
```

---

### Task 7: 删除 Playwright 与浏览器配置

**Files:**
- Delete: `components/conversation-scan.js`
- Modify: `package.json`、`guoba/pluginInfo.js`、`guoba/configInfo.js`、`components/config.js`、`config/default_config.yaml`、`components/web-setup.js`（残留 import）

- [ ] **Step 1: 删文件与依赖**

```bash
rm components/conversation-scan.js
```

`package.json` dependencies 删一行：

```diff
-    "playwright": "1.61.0",
```

`guoba/pluginInfo.js` 第 9 行改为：

```js
  depends: [],
```

`guoba/configInfo.js` 删除 `browser.preferSystem / browser.channel / browser.executablePath / browser.headless` 四个 schema 项（20-52 行区域）。

`components/config.js`：defaults 里删 `browser: { preferSystem: true, channel: '', executablePath: '', headless: true },`（16 行）；删 `systemBrowserCandidates` 常量（82-99 行）、`windowsPrefixes`（101-111 行）、`detectSystemBrowser`（113-145 行）、`getBrowserLaunchOptions`（147-163 行）、`let detectedSystemBrowser`（101 行）。

`config/default_config.yaml` 删 browser 整段（含注释，4-13 行）。用户已生成的 `config/config.yaml` 里的 browser 段保留不动（ensureConfigFile 合并只增不删，无害）。

- [ ] **Step 2: 清残留引用并自检**

Run: `grep -rn "playwright\|getBrowserLaunchOptions\|detectSystemBrowser\|scanConversations\|conversation-scan" components/ apps/ guoba/ config/ index.js guoba.support.js || echo CLEAN`
Expected: `CLEAN`（config/config.yaml 里的 browser 段除外——该文件被 grep 覆盖时注释行匹配到 "browser" 不匹配以上关键词；若 `config/config.yaml` 命中请人工确认后不改，它是用户运行时文件且已 gitignore）

Run: `node --input-type=module -e "globalThis.logger={info(){},warn(){},error(){},mark(){}}; for (const m of ['./components/config.js','./components/web-setup.js','./components/qr-login.js','./components/conversation-api.js']) { try { await import(m) } catch (e) { if (!/HTTP 服务尚未就绪/.test(e.message)) throw e } } console.log('imports OK')"`
Expected: `imports OK`

Run: `node --test test/`
Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: 移除 Playwright 依赖与浏览器配置（扫码/会话扫描已纯 API 化）"
```

---

### Task 8: README 与帮助文案更新

**Files:**
- Modify: `README.md`、`components/web-setup.js`（setup 页提示文案）、`apps/account.js:95`（添加完成后的引导文案）

- [ ] **Step 1: README 改动**

- 「安装」段：删除“若不需要扫码功能（只粘贴 Cookie），可不安装 Playwright 浏览器”及 pnpm install 后的浏览器说明，改为一句：`依赖仅 protobufjs/sql.js 等纯 JS 库，无浏览器要求。`
- 「使用流程」第 2 步改为：`打开添加账号网页 → 扫码或粘贴 Cookie → 点「从会话列表选择目标」→ 点选会话中的人 → 提交`；命令方式标注为备用。
- 「工作原理」图更新为：

```
sso.douyin.com/get_qrcode → check_qrconnect → login/callback → Cookie
        |
        v
imapi.douyin.com/v2/message/get_by_user_init (protobuf) → 会话用户 sec_uid/uid
        |
        v
aweme/v1/web/user/profile/other/ (a_bogus) → uid + 昵称
        |
        v
imapi.douyin.com/v2/conversation/create / v1/message/send (protobuf) → 送达
```

- 「风险与限制」追加一条：`会话列表协议字段号来自公开逆向样本，若「从会话列表选择」持续报协议失效：浏览器登录 www.douyin.com/chat → F12 Network 过滤 get_by_user_init → 复制请求体（binary）转 Base64 → 填入 config.yaml 的 im.getByUserInitTemplateB64`
- 「目录结构」components 描述更新（qr-login.js、conversation-api.js）。

- [ ] **Step 2: 引导文案**

`components/web-setup.js` 网页表单里消息模板的 hint（原 697 行）：

```js
<span class="hint">续火目标优先在上方「从会话列表选择」添加；也可用命令 #抖音ID添加好友 按分享链接添加。</span>
```

`apps/account.js` 第 95 行添加成功提示改为：

```js
await e.reply(`账号“${session.draft.name}”已添加。\n发送 #抖音ID修改账号 账号名 可打开网页，从会话列表点选续火目标；发送 #ID续火 可执行你的全部账号。`)
```

- [ ] **Step 3: 自检与提交**

Run: `node --check components/web-setup.js && node --check apps/account.js`
Expected: 无输出

```bash
git add README.md components/web-setup.js apps/account.js
git commit -m "docs: README 与引导文案更新为纯 API 流程"
```

---

### Task 9: 手测清单（需真实账号，用户参与）

无代码。执行者与用户协同验证，全部通过后收尾。

- [ ] **Step 1: 启动云崽，发送 `#抖音ID添加账号`，打开网页**
  - 预期：页面正常渲染，扫码区无短信输入框，有「从会话列表选择目标」按钮

- [ ] **Step 2: 点「扫码获取 Cookie」**
  - 预期：二维码显示；手机扫码后状态变"已扫码，请在手机上确认"；确认后 Cookie JSON 自动填入文本框
  - 若失败（风控/参数不匹配）：错误文案清晰；Cookie 粘贴路径可用（回归兜底）

- [ ] **Step 3: 点「从会话列表选择目标」**
  - 预期：几十秒内出现会话用户卡片（昵称 + 时间）；点选 2 人后提交
  - 若报协议失效：按 README 抓包指引更新 im.getByUserInitTemplateB64 重试（并把真实字段号反馈回 im-proto.js 修正）

- [ ] **Step 4: 发送 `#抖音ID好友列表`**
  - 预期：显示所选 2 人，昵称正确，ID 为 sec_uid 短版

- [ ] **Step 5: 发送 `#ID续火`**
  - 预期：发送成功日志显示"已发送消息"，且无"已创建会话"日志（复用入库的 conversationId）

- [ ] **Step 6: 修改模式回归**
  - `#抖音ID修改账号 账号名` → 网页已存目标预勾选 → 重新拉会话不丢已选 → 提交后 `#抖音ID好友列表` 一致

- [ ] **Step 7: 记录结果并提交（如有 im-proto 字段号修正）**

```bash
git add -A && git commit -m "fix: 按真实接口校正 get_by_user_init 字段号（手测反馈）"
```

---

## Self-Review 记录

- **Spec 覆盖**：qr-login（Task 4）、conversation-api（Task 3）、im-proto 扩展（Task 1）、postImProto 导出（Task 2，实现改为更合理的 postImProtoRaw——spec 说"导出 postImProto"，实现中发现 get_by_user_init 响应结构不同需原始字节，改导出 postImProtoRaw 属设计意图内的等价物）、database 两处（Task 2）、web-setup 后端（Task 5）、网页 UI（Task 6）、删除清单（Task 7）、README/文案（Task 8）、手测（Task 9）✓
- **占位符**：Task 3 Step 3 的初版 `listConversations` 刻意标 UNREACHABLE 并在同任务 Step 3 内给出最终版重写——执行者须以最终版为准，两段代码都完整可抄 ✓
- **类型一致性**：`parseGetByUserInitResponse` 返回 `{conversations:[{conversationId,...}], messages:[{sender, secSender, createTime,...}]}`（camelCase）与 Task 3 测试 fixture、extractPeople 消费字段一致；`pollQrLogin` 返回 `{status, message?, cookies?}` 与 Task 5 handler、Task 6 前端分支一致；`replaceTargets(accountId, targets)` targets 字段（secUid/uid/nickname/conversationId/conversationShortId/ticket）在 Task 2 实现、Task 5 normalizeWebTargets、Task 6 dataset.entry 三处一致 ✓
