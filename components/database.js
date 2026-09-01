import fs from 'node:fs/promises'
import path from 'node:path'
import initSqlJs from 'sql.js'
import { getPluginRoot } from './config.js'

const dataDir = path.join(getPluginRoot(), 'data')
const databaseFile = path.join(dataDir, 'data.db')
let databasePromise
let queue = Promise.resolve()

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = (async () => {
      await fs.mkdir(dataDir, { recursive: true })
      const SQL = await initSqlJs({
        locateFile: (file) => path.join(getPluginRoot(), 'node_modules', 'sql.js', 'dist', file),
      })
      const bytes = await fs.readFile(databaseFile).catch((error) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      const database = bytes ? new SQL.Database(bytes) : new SQL.Database()
      database.run('PRAGMA foreign_keys = ON')
      database.run(`
        CREATE TABLE IF NOT EXISTS users (
          user_id TEXT PRIMARY KEY,
          email TEXT NOT NULL DEFAULT '',
          success_email_enabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          cookies TEXT NOT NULL,
          target_names TEXT NOT NULL,
          message_template TEXT NOT NULL DEFAULT '',
          self_uid TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          UNIQUE(user_id, name),
          FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS setup_sessions (
          user_id TEXT PRIMARY KEY,
          step TEXT NOT NULL,
          draft TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS targets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL,
          sec_uid TEXT NOT NULL,
          uid TEXT NOT NULL DEFAULT '',
          nickname TEXT NOT NULL DEFAULT '',
          conversation_id TEXT NOT NULL DEFAULT '',
          conversation_short_id TEXT NOT NULL DEFAULT '',
          ticket TEXT NOT NULL DEFAULT '',
          nickname_updated_at TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(account_id, sec_uid),
          FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );
      `)
      const userColumns = rows(database, 'PRAGMA table_info(users)')
      if (!userColumns.some((column) => column.name === 'email')) {
        database.run("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''")
      }
      if (!userColumns.some((column) => column.name === 'success_email_enabled')) {
        database.run('ALTER TABLE users ADD COLUMN success_email_enabled INTEGER NOT NULL DEFAULT 0')
      }
      const accountColumns = rows(database, 'PRAGMA table_info(accounts)')
      if (!accountColumns.some((column) => column.name === 'self_uid')) {
        database.run("ALTER TABLE accounts ADD COLUMN self_uid TEXT NOT NULL DEFAULT ''")
      }
      await persist(database)
      return database
    })()
  }
  return databasePromise
}

async function persist(database) {
  await fs.writeFile(databaseFile, database.export())
  // sql.js 的 export() 会重建底层连接，导致 PRAGMA foreign_keys 被重置，必须重新开启
  database.run('PRAGMA foreign_keys = ON')
}

function run(operation, writes = false) {
  const task = queue.then(async () => {
    const database = await getDatabase()
    const result = await operation(database)
    if (writes) await persist(database)
    return result
  })
  queue = task.catch(() => {})
  return task
}

function rows(database, sql, parameters = []) {
  const statement = database.prepare(sql)
  statement.bind(parameters)
  const result = []
  while (statement.step()) result.push(statement.getAsObject())
  statement.free()
  return result
}

function parseJson(value, description) {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`数据库中的 ${description} 已损坏，请删除后重新添加账号`)
  }
}

function toAccount(row) {
  return {
    id: Number(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    cookies: parseJson(row.cookies, 'Cookie 数据'),
    targetNames: parseJson(row.target_names, '目标会话数据'),
    messageTemplate: String(row.message_template || ''),
    selfUid: String(row.self_uid || ''),
  }
}

export async function listAccounts(userId) {
  return run((database) => {
    const parameters = userId === undefined ? [] : [String(userId)]
    const where = userId === undefined ? '' : 'WHERE user_id = ?'
    return rows(database, `SELECT * FROM accounts ${where} ORDER BY user_id, id`, parameters).map(toAccount)
  })
}

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
  }, true)
}

export async function deleteAccount(userId, name) {
  return run((database) => {
    database.run('DELETE FROM accounts WHERE user_id = ? AND name = ?', [String(userId), name])
    return database.getRowsModified() > 0
  }, true)
}

export async function updateAccount({ id, userId, name, cookies, targetNames, messageTemplate }) {
  return run((database) => {
    try {
      database.run(
        'UPDATE accounts SET name = ?, cookies = ?, target_names = ?, message_template = ? WHERE id = ? AND user_id = ?',
        [name, JSON.stringify(cookies), JSON.stringify(targetNames), messageTemplate, Number(id), String(userId)],
      )
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new Error(`已存在名为“${name}”的账号，请换一个名称`)
      }
      throw error
    }
    if (database.getRowsModified() === 0) throw new Error('账号不存在或不属于当前用户')
  }, true)
}

/** 缓存账号自身 uid（从 uid_tt Cookie 或会话创建响应中解析） */
export async function updateAccountSelfUid(accountId, selfUid) {
  return run((database) => {
    database.run('UPDATE accounts SET self_uid = ? WHERE id = ?', [String(selfUid), Number(accountId)])
    return database.getRowsModified() > 0
  }, true)
}

export async function setUserEmail(userId, email) {
  return run((database) => {
    const normalizedUserId = String(userId)
    database.run(
      'INSERT OR IGNORE INTO users (user_id, email, created_at) VALUES (?, ?, ?)',
      [normalizedUserId, '', new Date().toISOString()],
    )
    database.run('UPDATE users SET email = ? WHERE user_id = ?', [email, normalizedUserId])
  }, true)
}

export async function setUserSuccessEmailEnabled(userId, enabled) {
  return run((database) => {
    const normalizedUserId = String(userId)
    database.run(
      'INSERT OR IGNORE INTO users (user_id, email, created_at) VALUES (?, ?, ?)',
      [normalizedUserId, '', new Date().toISOString()],
    )
    database.run('UPDATE users SET success_email_enabled = ? WHERE user_id = ?', [enabled ? 1 : 0, normalizedUserId])
  }, true)
}

export async function getUserEmails(userIds) {
  if (userIds.length === 0) return new Map()
  return run((database) => {
    const normalizedIds = [...new Set(userIds.map(String))]
    const placeholders = normalizedIds.map(() => '?').join(', ')
    const result = new Map()
    for (const row of rows(database, `SELECT user_id, email FROM users WHERE user_id IN (${placeholders})`, normalizedIds)) {
      result.set(String(row.user_id), String(row.email || ''))
    }
    return result
  })
}

export async function getUserNotificationSettings(userIds) {
  if (userIds.length === 0) return new Map()
  return run((database) => {
    const normalizedIds = [...new Set(userIds.map(String))]
    const placeholders = normalizedIds.map(() => '?').join(', ')
    const result = new Map()
    for (const row of rows(database, `SELECT user_id, email, success_email_enabled FROM users WHERE user_id IN (${placeholders})`, normalizedIds)) {
      result.set(String(row.user_id), {
        email: String(row.email || ''),
        successEmailEnabled: Boolean(row.success_email_enabled),
      })
    }
    return result
  })
}

export async function getSetupSession(userId) {
  return run((database) => {
    const [session] = rows(database, 'SELECT * FROM setup_sessions WHERE user_id = ?', [String(userId)])
    if (!session) return undefined
    return { step: String(session.step), draft: parseJson(session.draft, '配置会话数据') }
  })
}

export async function saveSetupSession(userId, step, draft) {
  return run((database) => {
    database.run(
      `INSERT INTO setup_sessions (user_id, step, draft, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET step = excluded.step, draft = excluded.draft, updated_at = excluded.updated_at`,
      [String(userId), step, JSON.stringify(draft), new Date().toISOString()],
    )
  }, true)
}

export async function clearSetupSession(userId) {
  return run((database) => {
    database.run('DELETE FROM setup_sessions WHERE user_id = ?', [String(userId)])
  }, true)
}

// ===================== targets（续火目标：sec_uid -> 昵称映射） =====================

function toTarget(row) {
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    secUid: String(row.sec_uid),
    uid: String(row.uid || ''),
    nickname: String(row.nickname || ''),
    conversationId: String(row.conversation_id || ''),
    conversationShortId: String(row.conversation_short_id || ''),
    ticket: String(row.ticket || ''),
    nicknameUpdatedAt: row.nickname_updated_at ? String(row.nickname_updated_at) : '',
  }
}

/** 列出账号的全部续火目标；accountId 缺省时列出全部账号的目标 */
export async function listTargets(accountId) {
  return run((database) => {
    const parameters = accountId === undefined ? [] : [Number(accountId)]
    const where = accountId === undefined ? '' : 'WHERE account_id = ?'
    return rows(database, `SELECT * FROM targets ${where} ORDER BY id`, parameters).map(toTarget)
  })
}

/** 添加续火目标；已存在同 sec_uid 的目标时报错 */
export async function addTarget({ accountId, secUid, uid = '', nickname = '', conversationId = '', conversationShortId = '', ticket = '' }) {
  return run((database) => {
    try {
      database.run(
        `INSERT INTO targets (account_id, sec_uid, uid, nickname, conversation_id, conversation_short_id, ticket, nickname_updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Number(accountId), secUid, uid, nickname, conversationId, conversationShortId, ticket,
          nickname ? new Date().toISOString() : null, new Date().toISOString()],
      )
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new Error('该用户已在当前账号的续火列表中')
      }
      throw error
    }
    return database.getRowsModified() > 0
  }, true)
}

/** 删除目标（按目标 id） */
export async function deleteTarget(accountId, targetId) {
  return run((database) => {
    database.run('DELETE FROM targets WHERE account_id = ? AND id = ?', [Number(accountId), Number(targetId)])
    return database.getRowsModified() > 0
  }, true)
}

/** 更新目标的会话信息（uid / conversation 等） */
export async function updateTargetConversation(targetId, { uid, conversationId, conversationShortId, ticket }) {
  return run((database) => {
    database.run(
      'UPDATE targets SET uid = ?, conversation_id = ?, conversation_short_id = ?, ticket = ? WHERE id = ?',
      [uid ?? '', conversationId ?? '', conversationShortId ?? '', ticket ?? '', Number(targetId)],
    )
    return database.getRowsModified() > 0
  }, true)
}

/** 昵称变更时更新映射；返回是否有变动 */
export async function updateTargetNickname(targetId, nickname) {
  return run((database) => {
    database.run(
      'UPDATE targets SET nickname = ?, nickname_updated_at = ? WHERE id = ? AND nickname != ?',
      [nickname, new Date().toISOString(), Number(targetId), nickname],
    )
    return database.getRowsModified() > 0
  }, true)
}

/** 整体替换账号的目标列表（网页配置保存时调用） */
export async function replaceTargets(accountId, targets) {
  return run((database) => {
    database.run('DELETE FROM targets WHERE account_id = ?', [Number(accountId)])
    const now = new Date().toISOString()
    for (const target of targets) {
      database.run(
        `INSERT INTO targets (account_id, sec_uid, uid, nickname, conversation_id, conversation_short_id, ticket, nickname_updated_at, created_at)
         VALUES (?, ?, ?, ?, '', '', '', ?, ?)`,
        [Number(accountId), String(target.secUid), String(target.uid || ''), String(target.nickname || ''),
          target.nickname ? now : null, now],
      )
    }
    return targets.length
  }, true)
}

/** 按 id 取单个目标 */
export async function getTarget(targetId) {
  return run((database) => {
    const [row] = rows(database, 'SELECT * FROM targets WHERE id = ?', [Number(targetId)])
    return row ? toTarget(row) : undefined
  })
}
