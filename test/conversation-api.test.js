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

test('extractPeople 在 selfUid 未知时返回空列表', () => {
  const people = extractPeople([page()], '')
  assert.equal(people.length, 0)
})
