import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addAccount,
  listAccounts,
  listTargets,
  replaceTargets,
  deleteAccount,
} from '../components/database.js'

test('addAccount 返回新账号 id，replaceTargets 保留会话字段', async () => {
  const userId = `test-user-${Date.now()}`
  const name = `t-${Date.now()}`
  const id = await addAccount({ userId, name, cookies: [{ name: 'sessionid', value: 'x', domain: '.douyin.com' }], targetNames: [], messageTemplate: '' })
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
  // 清理测试数据
  const account = (await listAccounts(userId))[0]
  if (account) await deleteAccount(userId, account.name)
})
