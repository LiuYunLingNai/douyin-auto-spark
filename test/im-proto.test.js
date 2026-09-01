import test from 'node:test'
import assert from 'node:assert/strict'
import protobuf from 'protobufjs'
import {
  buildGetByUserInitBody,
  parseGetByUserInitResponse,
} from '../components/im-proto.js'

// 协议字段为 2026-09 抓包校正（get_message_by_init，cmd=2043）

test('buildGetByUserInitBody 首页请求：cmd=2043、page_flag=0、无签名凭据字段', () => {
  const body = buildGetByUserInitBody({ cursor: '0' })
  const root = protobuf.parse(`
    syntax = "proto3";
    message Outer {
      int32 cmd = 1; int32 sequence_id = 2; string sdk_version = 3;
      int32 inbox_type = 6; string build_number = 7;
      B body = 8; string device_platform = 11; string session_ttl = 14;
      int32 auth_type = 18; string biz = 21;
      string token = 4; string ts_sign = 23; string sdk_cert = 24; string request_sign = 25;
    }
    message B { Q query = 2043; }
    message Q { int64 cursor = 1; int64 page_flag = 2; }
  `, { keepCase: true }).root
  const obj = root.lookupType('Outer').toObject(root.lookupType('Outer').decode(body), { longs: String, defaults: false })
  assert.equal(obj.cmd, 2043)
  assert.equal(obj.sdk_version, '0.1.8')
  assert.equal(obj.inbox_type, 1)
  assert.equal(obj.build_number, '0d50935:feat/pc-im-group')
  assert.equal(obj.session_ttl, '360000')
  assert.equal(obj.auth_type, 1)
  assert.equal(obj.biz, 'douyin_web')
  assert.equal(obj.body.query.page_flag, '0')
  assert.equal(obj.body.query.cursor, undefined)
  // 真实协议没有签名凭据字段
  assert.equal(obj.ts_sign, undefined)
  assert.equal(obj.sdk_cert, undefined)
  assert.equal(obj.request_sign, undefined)
})

test('buildGetByUserInitBody 翻页请求：cursor + page_flag=1，sequence_id 递增', () => {
  const body = buildGetByUserInitBody({ cursor: '1642341121977990', sequenceId: 10002 })
  const root = protobuf.parse(`
    syntax = "proto3";
    message Outer { int32 sequence_id = 2; B body = 8; }
    message B { Q query = 2043; }
    message Q { int64 cursor = 1; int64 page_flag = 2; }
  `, { keepCase: true }).root
  const obj = root.lookupType('Outer').toObject(root.lookupType('Outer').decode(body), { longs: String, defaults: false })
  assert.equal(obj.sequence_id, 10002)
  assert.equal(obj.body.query.cursor, '1642341121977990')
  assert.equal(obj.body.query.page_flag, '1')
})

test('parseGetByUserInitResponse 解析会话与参与者（含 sec_uid）', () => {
  const root = protobuf.parse(`
    syntax = "proto3";
    message R {
      int32 cmd = 1; int32 error_code = 3; string status = 4;
      P data = 6; string request_id = 7; int64 user_id = 13;
    }
    message P { D data = 2043; }
    message D { repeated Blk blocks = 1; int64 has_more = 2; int64 next_cursor = 3; }
    message Blk { C info = 1; }
    message C {
      string conversation_id = 1; int64 conversation_short_id = 2; int32 conversation_type = 3;
      string ticket = 4; PL participants = 6; int32 participants_count = 7;
    }
    message PL { repeated U user = 1; }
    message U { int64 user_id = 1; string sec_uid = 5; }
  `, { keepCase: true }).root
  const R = root.lookupType('R')
  const fixture = R.encode(R.fromObject({
    cmd: 2043, error_code: 0, status: 'OK', user_id: '3870759819947227',
    data: {
      data: {
        blocks: [{
          info: {
            conversation_id: '0:1:2074154058916875:3870759819947227',
            conversation_short_id: '7637367493811569195',
            conversation_type: 1,
            ticket: 'tk-1',
            participants: {
              user: [
                { user_id: '2074154058916875', sec_uid: 'MS4wPEER' },
                { user_id: '3870759819947227', sec_uid: 'MS4wSELF' },
              ],
            },
            participants_count: 2,
          },
        }],
        has_more: '1',
        next_cursor: '1642341121977990',
      },
    },
  })).finish()
  const parsed = parseGetByUserInitResponse(Buffer.from(fixture))
  assert.equal(parsed.status, 'OK')
  assert.equal(parsed.selfUid, '3870759819947227')
  assert.equal(parsed.hasMore, true)
  assert.equal(parsed.nextCursor, '1642341121977990')
  assert.equal(parsed.conversations.length, 1)
  const conv = parsed.conversations[0]
  assert.equal(conv.conversationId, '0:1:2074154058916875:3870759819947227')
  assert.equal(conv.conversationShortId, '7637367493811569195')
  assert.equal(conv.conversationType, 1)
  assert.equal(conv.participantsCount, 2)
  assert.equal(conv.participants.length, 2)
  assert.equal(conv.participants[0].uid, '2074154058916875')
  assert.equal(conv.participants[0].secUid, 'MS4wPEER')
})

test('parseGetByUserInitResponse 对非 OK 状态抛错', () => {
  const root = protobuf.parse(`
    syntax = "proto3";
    message R { int32 error_code = 3; string status = 4; }
  `, { keepCase: true }).root
  const R = root.lookupType('R')
  const bytes = Buffer.from(R.encode(R.fromObject({ error_code: 8101, status: 'ILLEGAL_ACCESS_TOKEN' })).finish())
  assert.throws(() => parseGetByUserInitResponse(bytes), /ILLEGAL_ACCESS_TOKEN/)
})
