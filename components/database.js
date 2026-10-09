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
      `)
      const userColumns = rows(database, 'PRAGMA table_info(users)')
      if (!userColumns.some((column) => column.name === 'email')) {
        database.run("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''")
      }
      if (!userColumns.some((column) => column.name === 'success_email_enabled')) {
        database.run('ALTER TABLE users ADD COLUMN success_email_enabled INTEGER NOT NULL DEFAULT 0')
      }
      // 抖音数字 uid。douyin.ts 的 start() 会先用 device_id=0 请求 imdesktop 自举 uid，
      // 该请求必然返回「用户未登录」，因此在 Bot 构造时显式传入 uid 才能连上。
      const accountColumns = rows(database, 'PRAGMA table_info(accounts)')
      if (!accountColumns.some((column) => column.name === 'douyin_uid')) {
        database.run("ALTER TABLE accounts ADD COLUMN douyin_uid TEXT NOT NULL DEFAULT ''")
      }
      // 桌面设备身份 { guid, deviceId, installId }（douyin.ts 0.6.5+）。
      // 不落库的话每次 Bot.start() 都会重新 device_register 签发新设备，
      // 身份不稳定容易触发 MFA；存下来下次直接注入复用。
      if (!accountColumns.some((column) => column.name === 'douyin_device')) {
        database.run("ALTER TABLE accounts ADD COLUMN douyin_device TEXT NOT NULL DEFAULT ''")
      }
      await persist(database)
      return database
    })()
  }
  return databasePromise
}

async function persist(database) {
  await fs.writeFile(databaseFile, database.export())
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
    douyinUid: String(row.douyin_uid || ''),
    douyinDevice: normalizeDevice(row.douyin_device),
  }
}

/**
 * 设备身份规范化：只认 deviceId 为非零数字串的完整三元组，其余一律视为没有。
 * 设备只是免注册的优化项，损坏时退回让 SDK 重新注册即可，不必报错。
 */
export function normalizeDevice(value) {
  let device = value
  if (typeof device === 'string') {
    if (!device.trim()) return undefined
    try {
      device = JSON.parse(device)
    } catch {
      return undefined
    }
  }
  if (!device || typeof device !== 'object') return undefined
  const deviceId = String(device.deviceId ?? '')
  const installId = String(device.installId ?? '')
  const guid = String(device.guid ?? '')
  if (!/^\d+$/.test(deviceId) || deviceId === '0' || !installId || !guid) return undefined
  return { guid, deviceId, installId }
}

function serializeDevice(value) {
  const device = normalizeDevice(value)
  return device ? JSON.stringify(device) : ''
}

export async function listAccounts(userId) {
  return run((database) => {
    const parameters = userId === undefined ? [] : [String(userId)]
    const where = userId === undefined ? '' : 'WHERE user_id = ?'
    return rows(database, `SELECT * FROM accounts ${where} ORDER BY user_id, id`, parameters).map(toAccount)
  })
}

export async function addAccount({ userId, name, cookies, targetNames, messageTemplate, douyinUid = '', douyinDevice }) {
  return run((database) => {
    const now = new Date().toISOString()
    const normalizedUserId = String(userId)
    database.run('INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)', [normalizedUserId, now])
    try {
      database.run(
        'INSERT INTO accounts (user_id, name, cookies, target_names, message_template, douyin_uid, douyin_device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [normalizedUserId, name, JSON.stringify(cookies), JSON.stringify(targetNames), messageTemplate, String(douyinUid || ''), serializeDevice(douyinDevice), now],
      )
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new Error(`已存在名为“${name}”的账号，请换一个名称或先删除旧账号`)
      }
      throw error
    }
  }, true)
}

/** 记录账号的抖音数字 uid（扫码登录成功后写入） */
export async function setAccountUid(userId, name, douyinUid) {
  return run((database) => {
    database.run('UPDATE accounts SET douyin_uid = ? WHERE user_id = ? AND name = ?', [
      String(douyinUid || ''),
      String(userId),
      name,
    ])
  }, true)
}

/** 记录账号的设备身份（SDK 首次注册新设备后写入，下次启动直接复用） */
export async function setAccountDevice(userId, name, douyinDevice) {
  return run((database) => {
    database.run('UPDATE accounts SET douyin_device = ? WHERE user_id = ? AND name = ?', [
      serializeDevice(douyinDevice),
      String(userId),
      name,
    ])
  }, true)
}

/** 管理列表不读取 Cookie 原文。 */
export async function listAccountSummaries() {
  return run((database) => rows(database, `SELECT id, user_id, name, douyin_uid, target_names, created_at, CASE WHEN cookies != '[]' AND cookies != '' THEN 1 ELSE 0 END AS has_cookie FROM accounts ORDER BY user_id, id`).map((row) => ({
    id: Number(row.id), userId: String(row.user_id), name: String(row.name),
    douyinUid: String(row.douyin_uid || ''), targetCount: parseJson(row.target_names, '目标会话数据').length,
    createdAt: String(row.created_at), hasCookie: Boolean(row.has_cookie),
  })))
}

export async function deleteAccountById(id) {
  return run((database) => {
    database.run('DELETE FROM accounts WHERE id = ?', [Number(id)])
    return database.getRowsModified() > 0
  }, true)
}

export async function deleteAccount(userId, name) {
  return run((database) => {
    database.run('DELETE FROM accounts WHERE user_id = ? AND name = ?', [String(userId), name])
    return database.getRowsModified() > 0
  }, true)
}

export async function updateAccount({ id, userId, name, cookies, targetNames, messageTemplate, douyinUid, douyinDevice }) {
  return run((database) => {
    try {
      // douyinUid 允许不传：老调用方（如定时任务改目标）不改 Cookie 时不必重解析身份
      if (douyinUid === undefined) {
        database.run(
          'UPDATE accounts SET name = ?, cookies = ?, target_names = ?, message_template = ? WHERE id = ? AND user_id = ?',
          [name, JSON.stringify(cookies), JSON.stringify(targetNames), messageTemplate, Number(id), String(userId)],
        )
      } else {
        // 换 Cookie 时设备随身份一起换：设备是随扫码会话签发的，粘贴的新 Cookie 不应沿用旧设备
        database.run(
          'UPDATE accounts SET name = ?, cookies = ?, target_names = ?, message_template = ?, douyin_uid = ?, douyin_device = ? WHERE id = ? AND user_id = ?',
          [name, JSON.stringify(cookies), JSON.stringify(targetNames), messageTemplate, String(douyinUid), serializeDevice(douyinDevice), Number(id), String(userId)],
        )
      }
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new Error(`已存在名为“${name}”的账号，请换一个名称`)
      }
      throw error
    }
    if (database.getRowsModified() === 0) throw new Error('账号不存在或不属于当前用户')
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
