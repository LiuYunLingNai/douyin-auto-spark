/**
 * 本地渲染预览：模拟 TRSS 渲染链路，把模板用假数据渲染并截图
 * 运行：node render-preview.mjs（在插件目录下）
 */
import template from 'art-template'
import puppeteer from 'puppeteer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 插件运行时的全局 logger，本地预览时兜底
globalThis.logger = globalThis.logger || console

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const resPath = `file://${path.resolve(root, 'resources').replace(/\\/g, '/')}/`
const outDir = path.resolve(root, '.preview')
await fs.mkdir(outDir, { recursive: true })

// 真实走组件的构建函数（帮助页数据来自 config/help.js）
const { buildHelpData, buildAccountListData, buildSparkResultData } = await import('./components/render.js')

const helpData = await buildHelpData({
  e: { isMaster: true },
  version: '1.0.0',
  accountCount: 2,
  targetCount: 5,
  scheduleDesc: '每天 00:10',
})
const helpDataGuest = await buildHelpData({
  e: { isMaster: false },
  version: '1.0.0',
  accountCount: 0,
  targetCount: 0,
  scheduleDesc: '每天 00:10',
})

const accountData = buildAccountListData([
  { name: '大号', targetNames: ['张三', '李四', '家人群'], messageTemplate: '你好', douyinUid: '123' },
  { name: '小号', targetNames: ['王五', '赵六'], messageTemplate: '', douyinUid: '456' },
  { name: '工作号备用机', targetNames: ['同事A', '同事B'], messageTemplate: '', douyinUid: '' },
])
const emptyData = buildAccountListData([])

const resultData = buildSparkResultData({
  sent: 5,
  successes: [{ accountName: '大号', sent: 3 }, { accountName: '小号', sent: 2 }],
  failures: [{ accountName: '工作号备用机', message: '以下会话未找到：同事B，请检查会话名和 Cookie' }],
})

const pages = [
  ['help', helpData],
  ['help-guest', helpDataGuest],
  ['account-list', accountData],
  ['account-list-empty', emptyData],
  ['spark-result', resultData],
]

const browser = await puppeteer.launch()
const page = await browser.newPage()
await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 })

for (const [name, data] of pages) {
  const dir = name.startsWith('help') ? 'help' : name.replace('-empty', '').replace('-guest', '')
  const tplFile = path.resolve(root, 'resources/render', dir, 'index.html')
  const html = template.render(await fs.readFile(tplFile, 'utf8'), {
    ...data, _res_path: resPath,
  })
  const file = path.resolve(outDir, `${name}.html`)
  await fs.writeFile(file, html, 'utf8')
  await page.goto(`file://${file.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' })
  await page.$('#container')
  const box = await (await page.$('#container')).boundingBox()
  await page.setViewport({ width: 900, height: Math.ceil(box.height), deviceScaleFactor: 2 })
  await page.goto(`file://${file.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' })
  const container = await page.$('#container')
  await container.screenshot({ path: path.resolve(outDir, `${name}.png`) })
  console.log(`✓ ${name}.png`)
}

await browser.close()
console.log(`预览输出目录: ${outDir}`)
