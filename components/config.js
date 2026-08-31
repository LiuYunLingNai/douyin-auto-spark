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

const defaults = {
  schedule: { enabled: true, cron: '0 10 0 * * *' },
  browser: { executablePath: '', headless: true },
  message: {
    includeSource: true,
    template: '',
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
  web: { mountToTrss: true, standalonePort: 3065, baseUrl: '', linkExpiresMinutes: 10 },
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

export function getConfig() {
  ensureConfigFile()
  return merge(merge(defaults, readYaml(defaultFile)), readYaml(configFile))
}

export function getPluginRoot() {
  return pluginRoot
}

export function watchConfig(listener) {
  ensureConfigFile()
  configListeners.add(listener)
  if (!configWatcher) {
    configWatcher = fs.watch(configFile, { persistent: false }, () => {
      clearTimeout(changeTimer)
      changeTimer = setTimeout(notifyConfigChange, 150)
    })
    configWatcher.on('error', (error) => logger.error('[抖音续火] 配置文件监听失败', error))
  }
  return () => configListeners.delete(listener)
}

export function saveConfig(value) {
  ensureConfigFile()
  const document = YAML.parseDocument(fs.readFileSync(configFile, 'utf8'))
  if (!YAML.isMap(document.contents)) {
    throw new Error('配置文件根节点必须是对象')
  }

  updateYamlMap(document, [], expandDotPaths(value))
  fs.writeFileSync(configFile, document.toString(), 'utf8')
}

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
  const userDoc = YAML.parseDocument(fs.readFileSync(configFile, 'utf8'))
  const defaultDoc = YAML.parseDocument(fs.readFileSync(defaultFile, 'utf8'))
  if (!YAML.isMap(userDoc.contents) || !YAML.isMap(defaultDoc.contents)) return
  if (mergeYamlMaps(userDoc.contents, defaultDoc.contents)) {
    fs.writeFileSync(configFile, userDoc.toString(), 'utf8')
  }
}

function mergeYamlMaps(userMap, defaultMap) {
  let changed = false
  const existing = new Map(userMap.items.map((item) => [String(item.key?.value), item]))
  for (const defaultItem of defaultMap.items) {
    const key = String(defaultItem.key?.value)
    const userItem = existing.get(key)
    if (!userItem) {
      userMap.items.push(defaultItem.clone?.() ?? defaultItem)
      changed = true
    } else if (YAML.isMap(userItem.value) && YAML.isMap(defaultItem.value)) {
      changed = copyYamlComments(userItem, defaultItem) || changed
      changed = mergeYamlMaps(userItem.value, defaultItem.value) || changed
    } else {
      changed = copyYamlComments(userItem, defaultItem) || changed
    }
  }
  return changed
}

function copyYamlComments(userItem, defaultItem) {
  let changed = false
  for (const property of ['commentBefore', 'comment']) {
    if (!userItem[property] && defaultItem[property]) {
      userItem[property] = defaultItem[property]
      changed = true
    }
    if (!userItem.key?.[property] && defaultItem.key?.[property]) {
      userItem.key[property] = defaultItem.key[property]
      changed = true
    }
    if (!userItem.value?.[property] && defaultItem.value?.[property]) {
      userItem.value[property] = defaultItem.value[property]
      changed = true
    }
  }
  return changed
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
  try {
    getConfig()
  } catch (error) {
    logger.error('[抖音续火] 配置文件读取失败，已保留当前定时任务', error)
    return
  }
  for (const listener of configListeners) {
    try {
      listener()
    } catch (error) {
      logger.error('[抖音续火] 配置热重载失败', error)
    }
  }
  logger.mark('[抖音续火] 配置已热重载')
}
