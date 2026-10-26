import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultFile = path.join(pluginRoot, 'config', 'default_config.yaml')
const configFile = path.join(pluginRoot, 'config', 'config.yaml')
const configListeners = new Set()
let configWatcher
let changeTimer
let cachedConfig

const defaults = {
  schedule: { enabled: true, cron: '0 10 0 * * *' },
  message: {
    includeSource: true,
    template: '{{friend}}，今天的火花到账啦🔥\\n{{yiyan}}\\n——「{{from}}」\\n{{date}} {{weekday}}',
  },
  smtp: {
    enabled: false,
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    username: '',
    password: '',
    from: '',
  },
  web: {
    mountToTrss: true,
    standalonePort: 3065,
    standaloneHost: '',
    baseUrl: '',
    linkExpiresMinutes: 10,
    recallSetupMessageOnComplete: false,
    setupMessageRecallSeconds: 0,
  },
  render: {
    // 关闭后帮助 / 账号列表 / 续火结果回退为纯文字输出
    enabled: true,
  },
}

function merge(base, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? base
  const result = { ...base }
  for (const [key, item] of Object.entries(value)) {
    result[key] = item == null
      ? base?.[key]
      : typeof item === 'object' && !Array.isArray(item)
        ? merge(base?.[key] ?? {}, item)
        : item
  }
  return result
}

function readYaml(file) {
  if (!fs.existsSync(file)) return {}
  try {
    return expandDotPaths(YAML.parse(fs.readFileSync(file, 'utf8')) ?? {})
  } catch (error) {
    throw new Error(`配置文件解析失败：${file}`, { cause: error })
  }
}

function expandDotPaths(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    const target = key.split('.')
    let current = result
    for (const segment of target.slice(0, -1)) current = current[segment] ||= {}
    const last = target.at(-1)
    current[last] = expandDotPaths(item)
  }
  return result
}

function loadConfig() {
  ensureConfigFile()
  return merge(merge(defaults, readYaml(defaultFile)), readYaml(configFile))
}

/**
 * 调用点很多（每条消息都会走到），所以缓存解析结果，文件变化时才重读。
 * 返回副本，调用方改动不会污染缓存。
 * 监听不可用时退回每次读取，保证不会拿着旧配置不放。
 */
export function getConfig() {
  if (!cachedConfig || !ensureWatcher()) {
    cachedConfig = loadConfig()
  }
  return structuredClone(cachedConfig)
}

export function getPluginRoot() {
  return pluginRoot
}

export function watchConfig(listener) {
  ensureConfigFile()
  configListeners.add(listener)
  ensureWatcher()
  return () => configListeners.delete(listener)
}

/**
 * 监听目录而不是文件：编辑器「写临时文件再改名」式保存会让文件句柄失效，
 * 直接监听文件会从此收不到变化。
 */
function ensureWatcher() {
  if (configWatcher) return true
  try {
    configWatcher = fs.watch(path.dirname(configFile), { persistent: false }, (_event, filename) => {
      if (filename && filename !== path.basename(configFile)) return
      clearTimeout(changeTimer)
      changeTimer = setTimeout(notifyConfigChange, 150)
    })
  } catch (error) {
    logger.error('[抖音续火] 配置文件监听失败，改为每次读取', error)
    return false
  }
  configWatcher.on('error', (error) => {
    logger.error('[抖音续火] 配置文件监听失败，改为每次读取', error)
    configWatcher?.close()
    configWatcher = undefined
    cachedConfig = undefined
  })
  return true
}

export function saveConfig(value) {
  ensureConfigFile()
  const document = YAML.parseDocument(fs.readFileSync(configFile, 'utf8'))
  if (!YAML.isMap(document.contents)) {
    throw new Error('配置文件根节点必须是对象')
  }

  updateYamlMap(document, [], expandDotPaths(value))
  fs.writeFileSync(configFile, document.toString(), 'utf8')
  // 直接通知，不等文件监听：中间若有 getConfig 先刷新了缓存，监听回调会以为没有变化
  notifyConfigChange()
}

export { expandDotPaths }

function ensureConfigFile() {
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  if (!fs.existsSync(configFile)) {
    if (fs.existsSync(defaultFile)) {
      fs.copyFileSync(defaultFile, configFile)
    } else {
      fs.writeFileSync(configFile, YAML.stringify(defaults), 'utf8')
    }
    return
  }

  const raw = YAML.parse(fs.readFileSync(configFile, 'utf8')) ?? {}
  if (hasDotPaths(raw)) {
    fs.writeFileSync(configFile, YAML.stringify(expandDotPaths(raw)), 'utf8')
  }

  if (!fs.existsSync(defaultFile)) return
  const before = fs.readFileSync(configFile, 'utf8')
  const userDoc = YAML.parseDocument(before)
  const defaultDoc = YAML.parseDocument(fs.readFileSync(defaultFile, 'utf8'))
  if (!YAML.isMap(userDoc.contents) || !YAML.isMap(defaultDoc.contents)) return
  mergeYamlMaps(userDoc.contents, defaultDoc.contents)
  const after = userDoc.toString()
  if (after !== before) {
    fs.writeFileSync(configFile, after, 'utf8')
  }
}

function mergeYamlMaps(userMap, defaultMap) {
  const existing = new Map(userMap.items.map((item, index) => [String(item.key?.value), { item, index }]))
  for (const [defaultIndex, defaultItem] of defaultMap.items.entries()) {
    const key = String(defaultItem.key?.value)
    const found = existing.get(key)
    if (!found) {
      userMap.items.push(defaultItem.clone?.() ?? defaultItem)
      continue
    }
    copyLeadingComment(userMap, found.index, defaultMap, defaultIndex)
    copyInlineComment(found.item, defaultItem)
    if (YAML.isMap(found.item.value) && YAML.isMap(defaultItem.value)) {
      mergeYamlMaps(found.item.value, defaultItem.value)
    }
  }
}

function readLeadingComment(map, index) {
  return index === 0 ? map.commentBefore : map.items[index]?.key?.commentBefore
}

function writeLeadingComment(map, index, comment) {
  if (index === 0) {
    map.commentBefore = comment
    return
  }
  const target = map.items[index]?.key
  if (target) target.commentBefore = comment
}

function copyLeadingComment(userMap, userIndex, defaultMap, defaultIndex) {
  if (readLeadingComment(userMap, userIndex)) return
  const comment = readLeadingComment(defaultMap, defaultIndex)
  if (comment) writeLeadingComment(userMap, userIndex, comment)
}

function copyInlineComment(userItem, defaultItem) {
  if (!userItem.key?.comment && defaultItem.key?.comment) {
    userItem.key.comment = defaultItem.key.comment
  }
  const userValue = userItem.value
  const defaultValue = defaultItem.value
  if (!userValue || !defaultValue) return
  if (YAML.isMap(userValue) || YAML.isSeq(userValue)) return
  if (!userValue.comment && defaultValue.comment) {
    userValue.comment = defaultValue.comment
  }
}

function updateYamlMap(document, path, value) {
  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...path, key]
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const current = document.getIn(nextPath, true)
      if (YAML.isMap(current)) {
        updateYamlMap(document, nextPath, item)
      } else {
        document.setIn(nextPath, {})
        updateYamlMap(document, nextPath, item)
      }
    } else {
      document.setIn(nextPath, item)
    }
  }
}

function hasDotPaths(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).some(([key, item]) => key.includes('.') || hasDotPaths(item))
}

function notifyConfigChange() {
  let next
  try {
    next = loadConfig()
  } catch (error) {
    // 改坏的配置不替换缓存：插件继续按上一份可用配置运行
    logger.error('[抖音续火] 配置文件读取失败，继续使用上一份有效配置', error)
    return
  }
  const changed = !cachedConfig || JSON.stringify(next) !== JSON.stringify(cachedConfig)
  cachedConfig = next
  // ensureConfigFile 回写注释、或保存内容没变时也会触发监听，此时无需重排定时任务
  if (!changed) return
  for (const listener of configListeners) {
    try {
      listener()
    } catch (error) {
      logger.error('[抖音续火] 配置热重载失败', error)
    }
  }
  logger.mark('[抖音续火] 配置已热重载')
}
