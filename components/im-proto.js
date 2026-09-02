// 抖音 IM protobuf 编解码
// 协议字段参考 Rockedw/douyin-web-api-sdk 的 DySendMsgRequest.proto / SendMessageResponse.java
// 做法：用 protobufjs decode 抓包模板 -> patch 业务字段 -> encode，
// 模板中的 token/ts_sign/sdk_cert/request_sign 等长效设备凭据原样保留。
import protobuf from 'protobufjs'
import { CREATE_CONVERSATION_TEMPLATE, TEXT_MESSAGE_TEMPLATE } from './im-templates.js'

const PROTO = `
syntax = "proto3";

message DySendMsgRequest {
  int32 cmd = 1;
  int32 sequence_id = 2;
  string sdk_version = 3;
  string token = 4;
  int32 refer = 5;
  int32 inbox_type = 6;
  string build_number = 7;
  SendMessageBody send_message_body = 8;
  string device_id = 9;
  string device_platform = 11;
  repeated HeaderField headers = 15;
  int32 auth_type = 18;
  string biz = 21;
  string access = 22;
  string ts_sign = 23;
  string sdk_cert = 24;
  string request_sign = 25;
}

message SendMessageBody {
  SendMessageContent send_message_content = 100;
  CreateSessionRequest create_session_request = 609;
  GetByUserInitQuery get_by_user_init_query = 203;
}

message CreateSessionRequest {
  int32 session_type = 1;
  repeated int64 user = 2;
}

message SendMessageContent {
  string conversation_id = 1;
  int32 conversation_type = 2;
  int64 conversation_short_id = 3;
  string content = 4;
  repeated ExtField ext_fields = 5;
  int32 message_type = 6;
  string ticket = 7;
  string client_message_id = 8;
}

message ExtField {
  string key = 1;
  string value = 2;
}

message HeaderField {
  string field_name = 1;
  string field_value = 2;
}

message GetByUserInitQuery {
  int64 cursor = 1;
  int64 count = 2;
}

// ===== get_message_by_init（会话列表）真实协议，2026-09 抓包自 douyin.com/chat =====
// 请求信封：cmd=2043、sdk_version="0.1.8"、build_number="0d50935:feat/pc-im-group"、
// auth_type=1、field14="360000"、token 为空，无 ts_sign/sdk_cert/request_sign
message DyInitRequest {
  int32 cmd = 1;                    // 2043
  int32 sequence_id = 2;            // 10001 起递增
  string sdk_version = 3;           // "0.1.8"
  string token = 4;                 // 空
  int32 refer = 5;                  // 3
  int32 inbox_type = 6;             // 1
  string build_number = 7;          // "0d50935:feat/pc-im-group"
  InitBody body = 8;
  string device_id = 9;             // "0"
  string device_platform = 11;      // "douyin_pc"
  string session_ttl = 14;          // "360000"
  repeated HeaderField headers = 15;
  int32 auth_type = 18;             // 1
  string biz = 21;                  // "douyin_web"
  string access = 22;               // "web_sdk"
}

message InitBody {
  InitQuery query = 2043;
}

message InitQuery {
  int64 cursor = 1;      // 翻页时为响应里的 next_cursor
  int64 page_flag = 2;   // 首页 0，翻页 1
}

message DyInitResponse {
  int32 cmd = 1;
  int32 sequence_id = 2;
  int32 error_code = 3;
  string status = 4;               // "OK"
  int32 version = 5;
  InitPayload data = 6;
  string request_id = 7;
  int64 timestamp = 10;
  int64 server_time = 11;
  int64 user_id = 13;              // 自己的 uid
}

message InitPayload {
  InitData data = 2043;
}

message InitData {
  repeated ConvBlock blocks = 1;
  int64 has_more = 2;              // 1=还有下一页
  int64 next_cursor = 3;           // 翻页游标
}

message ConvBlock {
  ConvInfo info = 1;
  repeated ConvMessage messages = 2;  // 该会话最近的消息
}

message ConvMessage {
  string conversation_id = 1;
  int32 conversation_type = 2;
  int64 server_message_id = 3;
  int64 create_time = 4;              // 内部纪元（勿用）
  int64 conversation_short_id = 5;
  int32 message_type = 6;             // 7=文本
  int64 sender = 7;                   // 发送者 uid
  string content = 8;
  int64 client_create_time = 10;      // 毫秒时间戳（真实时间）
}

message ConvInfo {
  string conversation_id = 1;      // "0:1:uidA:uidB"
  int64 conversation_short_id = 2;
  int32 conversation_type = 3;     // 1=单聊
  string ticket = 4;
  ParticipantList participants = 6;
  int32 participants_count = 7;
}

message ParticipantList {
  repeated Participant user = 1;
}

message Participant {
  int64 user_id = 1;
  string sec_uid = 5;
}

message DySendMsgResponse {
  int32 status_code = 1;
  int32 data_size = 2;
  int32 error_code = 3;
  string status_message = 4;
  int32 extra_status = 5;
  MessageData message_data = 6;
  string request_id = 7;
  int64 server_timestamp_1 = 10;
  int64 server_timestamp_2 = 11;
  int64 user_id = 13;
}

message MessageData {
  MessageInfo message_info = 100;
  CreateInfo create_info = 609;
}

message CreateInfo {
  ConversationInfo info = 1;
}

message ConversationInfo {
  string conversation_id = 1;
  int64 conversation_short_id = 2;
}

message MessageInfo {
  int64 message_id = 1;
  int32 message_status = 3;
  string client_message_id = 4;
  int32 message_type = 5;
  string extra_info = 6;
}
`

const root = protobuf.parse(PROTO, { keepCase: true }).root
const SendMsgRequest = root.lookupType('DySendMsgRequest')
const SendMsgResponse = root.lookupType('DySendMsgResponse')
const InitRequest = root.lookupType('DyInitRequest')
const InitResponse = root.lookupType('DyInitResponse')

function decodeTemplate(templateB64) {
  return SendMsgRequest.toObject(SendMsgRequest.decode(Buffer.from(templateB64, 'base64')), {
    longs: String,
    defaults: false,
  })
}

function encodeRequest(obj) {
  // fromObject 会把 int64 的十进制字符串转成 Long（protobufjs 自带 long 依赖），无需 verify 预检
  return Buffer.from(SendMsgRequest.encode(SendMsgRequest.fromObject(obj)).finish())
}

/**
 * 构造发送文本消息的 protobuf 请求体
 * @param {object} options
 * @param {string} options.conversationId 会话 ID，格式 0:1:uidA:uidB
 * @param {string|number} options.conversationShortId 会话短 ID（int64，字符串避免精度丢失）
 * @param {string} options.text 文本内容
 * @param {string} options.clientMessageId UUID
 * @param {string} [options.templateB64] 可选自定义模板（config.im.templateB64）
 * @returns {Buffer}
 */
export function buildTextMessageBody({ conversationId, conversationShortId, text, clientMessageId, templateB64 }) {
  const request = decodeTemplate(templateB64 || TEXT_MESSAGE_TEMPLATE)
  const body = request.send_message_body ?? {}
  const content = body.send_message_content ?? {}

  content.conversation_id = conversationId
  content.conversation_short_id = String(conversationShortId)
  content.conversation_type = 1
  content.message_type = 7
  content.content = JSON.stringify({ mention_users: [], aweType: 700, richTextInfos: [], text })
  content.client_message_id = clientMessageId

  const stime = `${Date.now()}.${Math.floor(Math.random() * 10000)}`
  content.ext_fields = (content.ext_fields ?? []).map((field) => {
    if (field.key === 's:client_message_id') return { ...field, value: clientMessageId }
    if (field.key === 's:stime') return { ...field, value: stime }
    return field
  })

  body.send_message_content = content
  request.send_message_body = body
  return encodeRequest(request)
}

/**
 * 构造创建会话的 protobuf 请求体
 * @param {object} options
 * @param {string|number} options.receiverUid 对方 uid（int64 字符串）
 * @param {string|number} [options.senderUid] 自己的 uid；缺省时只放对方 uid，由服务端按 session 推断
 * @param {string} [options.templateB64]
 * @returns {Buffer}
 */
export function buildCreateConversationBody({ receiverUid, senderUid, templateB64 }) {
  const request = decodeTemplate(templateB64 || CREATE_CONVERSATION_TEMPLATE)
  const body = request.send_message_body ?? {}
  const create = body.create_session_request ?? { session_type: 1 }

  const users = senderUid ? [String(receiverUid), String(senderUid)] : [String(receiverUid)]
  create.user = users
  body.create_session_request = create
  request.send_message_body = body
  return encodeRequest(request)
}

/**
 * 解析 imapi 响应（message/send 与 conversation/create 共用同一外层结构）
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ statusMessage: string, requestId: string, selfUid: string, conversationId: string, conversationShortId: string, extraInfo: object|null }}
 */
export function parseImResponse(bytes) {
  const response = SendMsgResponse.toObject(SendMsgResponse.decode(bytes), {
    longs: String,
    defaults: false,
  })
  let extraInfo = null
  const rawExtra = response.message_data?.message_info?.extra_info
  if (rawExtra) {
    try { extraInfo = JSON.parse(rawExtra) } catch { extraInfo = { raw: rawExtra } }
  }
  return {
    statusMessage: response.status_message ?? '',
    requestId: response.request_id ?? '',
    selfUid: response.user_id ?? '',
    conversationId: response.message_data?.create_info?.info?.conversation_id ?? '',
    conversationShortId: response.message_data?.create_info?.info?.conversation_short_id ?? '',
    extraInfo,
  }
}

/**
 * 构造拉取会话列表（get_message_by_init）的 protobuf 请求体。
 * 协议为 2026-09 抓包所得，字段简单（无签名凭据），直接从零构造，不依赖抓包模板。
 * @param {object} options
 * @param {string|number} options.cursor 分页游标（首页 '0'，翻页用响应的 next_cursor）
 * @param {string|number} [options.sequenceId=10001] 请求序号
 * @returns {Buffer}
 */
export function buildGetByUserInitBody({ cursor, sequenceId = 10001 } = {}) {
  const isFirstPage = !cursor || String(cursor) === '0'
  const request = {
    cmd: 2043,
    sequence_id: Number(sequenceId),
    sdk_version: '0.1.8',
    token: '',
    refer: 3,
    inbox_type: 1,
    build_number: '0d50935:feat/pc-im-group',
    body: {
      query: isFirstPage
        ? { page_flag: '0' }
        : { cursor: String(cursor), page_flag: '1' },
    },
    device_id: '0',
    device_platform: 'douyin_pc',
    session_ttl: '360000',
    headers: buildInitHeaders(),
    auth_type: 1,
    biz: 'douyin_web',
    access: 'web_sdk',
  }
  return Buffer.from(InitRequest.encode(InitRequest.fromObject(request)).finish())
}

// 与抓包一致的 header 指纹（user_agent 与 HTTP 头、签名 UA 保持一致）
function buildInitHeaders() {
  const pairs = [
    ['session_aid', '6383'],
    ['session_did', '0'],
    ['app_name', 'douyin_pc'],
    ['priority_region', 'cn'],
    ['user_agent', IM_USER_AGENT],
    ['cookie_enabled', 'true'],
    ['browser_language', 'zh-CN'],
    ['browser_platform', 'MacIntel'],
    ['browser_name', 'Mozilla'],
    ['browser_version', `5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36`],
    ['browser_online', 'true'],
    ['screen_width', '3440'],
    ['screen_height', '1440'],
    ['referer', ''],
    ['timezone_name', 'Asia/Shanghai'],
    ['deviceId', '0'],
    ['is-retry', '0'],
  ]
  return pairs.map(([key, value]) => ({ field_name: key, field_value: value }))
}

// 与 douyin-api.js 的 USER_AGENT 保持一致（IM 请求内嵌指纹）
const IM_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

/**
 * 解析 get_message_by_init 响应。
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ status: string, errorCode: number, selfUid: string, hasMore: boolean, nextCursor: string,
 *   conversations: Array<{conversationId: string, conversationShortId: string, conversationType: number,
 *   ticket: string, participantsCount: number, participants: Array<{uid: string, secUid: string}>}> }}
 */
export function parseGetByUserInitResponse(bytes) {
  const response = InitResponse.toObject(InitResponse.decode(bytes), {
    longs: String,
    defaults: false,
  })
  const status = response.status ?? ''
  if (status !== 'OK') {
    throw new Error(status || `状态码 ${response.error_code ?? '未知'}`)
  }
  const data = response.data?.data ?? {}
  const conversations = []
  for (const block of data.blocks ?? []) {
    const info = block.info
    if (!info?.conversation_id) continue
    conversations.push({
      conversationId: String(info.conversation_id),
      conversationShortId: String(info.conversation_short_id ?? ''),
      conversationType: Number(info.conversation_type ?? 0),
      ticket: String(info.ticket ?? ''),
      participantsCount: Number(info.participants_count ?? 0),
      participants: (info.participants?.user ?? []).map((user) => ({
        uid: String(user.user_id ?? ''),
        secUid: String(user.sec_uid ?? ''),
      })),
      // 该会话最近消息（用于「今天已续过」判断），按时间升序返回
      messages: (block.messages ?? []).map((message) => ({
        sender: String(message.sender ?? ''),
        clientCreateTime: String(message.client_create_time ?? '0'),
        messageType: Number(message.message_type ?? 0),
      })),
    })
  }
  return {
    status,
    errorCode: Number(response.error_code ?? 0),
    selfUid: String(response.user_id ?? ''),
    hasMore: Number(data.has_more ?? 0) === 1,
    nextCursor: String(data.next_cursor ?? ''),
    conversations,
  }
}
