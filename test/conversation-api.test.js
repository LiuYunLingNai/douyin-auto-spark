import test from 'node:test'
import assert from 'node:assert/strict'
import { extractPeople } from '../components/conversation-api.js'

const page = (over) => ({
  conversations: [
    {
      conversationId: '0:1:111:222', conversationShortId: '100', conversationType: 1, ticket: 'tk1', participantsCount: 2,
      participants: [{ uid: '111', secUid: 'MS4wSELF' }, { uid: '222', secUid: 'MS4wPEER_A' }],
    },
    {
      conversationId: '0:1:111:333', conversationShortId: '101', conversationType: 1, ticket: 'tk2', participantsCount: 2,
      participants: [{ uid: '111', secUid: 'MS4wSELF' }, { uid: '333', secUid: 'MS4wPEER_B' }],
    },
    {
      conversationId: 'grp:9:111:333:444', conversationShortId: '102', conversationType: 9, ticket: '', participantsCount: 4,
      participants: [{ uid: '111', secUid: 'MS4wSELF' }, { uid: '333', secUid: 'MS4wPEER_B' }],
    },
    {
      // 参与者里没有对方（异常数据）→ 剔除
      conversationId: '0:1:111:444', conversationShortId: '103', conversationType: 1, ticket: 'tk3', participantsCount: 2,
      participants: [{ uid: '111', secUid: 'MS4wSELF' }],
    },
  ],
  hasMore: false,
  nextCursor: '6000',
  ...over,
})

test('extractPeople 过滤群聊与异常会话，从参与者中取对方 sec_uid/uid', () => {
  const people = extractPeople([page()], '111')
  assert.equal(people.length, 2)
  const a = people.find((p) => p.conversationId === '0:1:111:222')
  const b = people.find((p) => p.conversationId === '0:1:111:333')
  assert.equal(a.uid, '222')
  assert.equal(a.secUid, 'MS4wPEER_A')
  assert.equal(a.conversationShortId, '100')
  assert.equal(a.ticket, 'tk1')
  assert.equal(b.uid, '333')
  assert.equal(b.secUid, 'MS4wPEER_B')
})

test('extractPeople 支持跨页合并与按 sec_uid 去重', () => {
  const secondPage = page({
    conversations: [
      {
        conversationId: '0:1:111:222', conversationShortId: '100', conversationType: 1, ticket: 'tk1-new', participantsCount: 2,
        participants: [{ uid: '111', secUid: 'MS4wSELF' }, { uid: '222', secUid: 'MS4wPEER_A' }],
      },
    ],
  })
  const people = extractPeople([page(), secondPage], '111')
  assert.equal(people.length, 2)
  assert.equal(people.filter((p) => p.secUid === 'MS4wPEER_A').length, 1)
})

test('extractPeople 在 selfUid 未知时返回空列表', () => {
  const people = extractPeople([page()], '')
  assert.equal(people.length, 0)
})
