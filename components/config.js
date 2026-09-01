import { execSync } from 'node:child_process'
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
  browser: { preferSystem: true, channel: '', executablePath: '', headless: true },
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
    baseUrl: '',
    linkExpiresMinutes: 10,
    recallSetupMessageOnComplete: false,
    setupMessageRecallSeconds: 0,
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

export function getConfig() {
  ensureConfigFile()
  return merge(merge(defaults, readYaml(defaultFile)), readYaml(configFile))
}

const systemBrowserCandidates = {
  commands: ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  win32: [
    '\\Microsoft\\Edge\\Application\\msedge.exe',
    '\\Google\\Chrome\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ],
  linux: [
    '/opt/microsoft/msedge/msedge',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
}

let detectedSystemBrowser

function windowsPrefixes() {
  return [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.HOMEDRIVE && `${process.env.HOMEDRIVE}\\Program Files`,
    process.env.HOMEDRIVE && `${process.env.HOMEDRIVE}\\Program Files (x86)`,
  ].filter(Boolean)
}

export function detectSystemBrowser() {
  if (detectedSystemBrowser !== undefined) return detectedSystemBrowser

  detectedSystemBrowser = ''
  if (['linux', 'android'].includes(process.platform)) {
    for (const command of systemBrowserCandidates.commands) {
      try {
        const found = execSync(`command -v ${command}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        if (found && fs.existsSync(found)) {
          detectedSystemBrowser = found
          break
        }
      } catch {}
    }
  }

  if (!detectedSystemBrowser) {
    const suffixes = systemBrowserCandidates[process.platform] ?? []
    const prefixes = process.platform === 'win32' ? windowsPrefixes() : ['']
    for (const suffix of suffixes) {
      const found = prefixes.map((prefix) => path.join(prefix, suffix)).find((file) => fs.existsSync(file))
      if (found) {
        detectedSystemBrowser = found
        break
      }
    }
  }

  if (detectedSystemBrowser) {
    globalThis.logger?.mark?.(`[抖音续火] 已复用系统浏览器：${detectedSystemBrowser}`)
  }
  return detectedSystemBrowser
}

export function getBrowserLaunchOptions(config = getConfig()) {
  const browser = config.browser ?? {}
  const options = { headless: browser.headless !== false }
  if (browser.executablePath) {
    options.executablePath = browser.executablePath
    return options
  }
  if (browser.channel) {
    options.channel = browser.channel
    return options
  }
  if (browser.preferSystem !== false) {
    const detected = detectSystemBrowser()
    if (detected) options.executablePath = detected
  }
  return options
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
