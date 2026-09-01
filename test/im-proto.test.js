import test from 'node:test'
import assert from 'node:assert/strict'
import protobuf from 'protobufjs'
import {
  buildGetByUserInitBody,
  parseGetByUserInitResponse,
} from '../components/im-proto.js'

test('buildGetByUserInitBody 基于现有模板 patch 出 cmd=203 与分页参数', () => {
  const body = buildGetByUserInitBody({ cursor: '0', count: 20 })
  const root = protobuf.parse(`
    syntax = "proto3";
    message Outer {
      int32 cmd = 1; int32 sequence_id = 2;
      SendMessageBody send_message_body = 8;
      string biz = 21;
    }
    message SendMessageBody {
      bytes send_message_content = 100;
      bytes create_session_request = 609;
      GetByUserInitQuery q = 203;
    }
    message GetByUserInitQuery { int64 cursor = 1; int64 count = 2; }
  `, { keepCase: true }).root
  const obj = root.lookupType('Outer').toObject(root.lookupType('Outer').decode(body), { longs: String, defaults: false })
  assert.equal(obj.cmd, 203)
  assert.ok(Number(obj.sequence_id) > 0)
  assert.equal(obj.biz, 'douyin_web')
  assert.equal(obj.send_message_body.q.cursor, '0')
  assert.equal(obj.send_message_body.q.count, '20')
  // 抓包模板里的 message/send 业务字段不应残留进 get_by_user_init 请求
  assert.equal(obj.send_message_body.send_message_content, undefined)
  assert.equal(obj.send_message_body.create_session_request, undefined)
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
  assert.equal(parsed.conversations.length, 1)
  assert.equal(parsed.conversations[0].ticket, 'tk-1')
  assert.equal(parsed.messages.length, 2)
  assert.equal(parsed.messages.find((m) => m.serverMessageId === '2').secSender, 'MS4wPEER')
  assert.equal(parsed.hasMore, false)
  assert.equal(parsed.perUserCursor, '3000')
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
