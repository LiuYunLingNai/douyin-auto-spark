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
const GetByUserInitResponse = root.lookupType('GetByUserInitResponse')

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
  // 抓包模板是 message/send 流量，body 里残留的 send_message_content / create_session_request
  // 属于别的接口的业务字段（还带固定 client_message_id），发出前剔除，避免风控指纹
  delete body.send_message_content
  delete body.create_session_request
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
