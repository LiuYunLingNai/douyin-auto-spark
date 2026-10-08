/**
 * 网页预览：把「打开链接后的两个网页」渲染出来截图看效果
 * 运行：node web-preview.mjs（在插件目录下）
 * 输出：.preview/web-setup-add.png / web-setup-edit.png / web-admin.png / web-admin-mobile.png / web-expired.png
 */
import puppeteer from 'puppeteer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

globalThis.logger = globalThis.logger || console

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.resolve(root, '.preview')
await fs.mkdir(outDir, { recursive: true })

const { renderSetupPage } = await import('./components/web-setup.js')
const { renderAdminPage } = await import('./components/admin-web.js')
const { MESSAGE_CSS, heroHtml } = await import('./components/web-theme.js')

// 提示页（链接过期 / 404）：与 admin-web 的 renderNotice 同一结构
const noticePage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>抖音续火</title><style>${MESSAGE_CSS}</style></head>
<body><div class="msg-card">${heroHtml({ title: '链接无效或已过期，请重新向机器人发送添加或修改命令。', subTitle: 'One-time Link' })}<p>这是一次性配置链接，为保护账号安全会在生成后自动过期。</p><span class="chip">回到机器人私聊重新获取链接</span></div></body></html>`

const initial = {
  name: '我的抖音小号',
  targetNames: ['张三', '李四', '家人群'],
  messageTemplate: '今天也要开开心心呀',
  email: 'user@example.com',
  successEmailEnabled: true,
}

const pages = [
  { file: 'web-setup-add', html: renderSetupPage('TOKEN', initial, false, '/douyin-auto-spark'), width: 760 },
  { file: 'web-setup-edit', html: renderSetupPage('TOKEN', initial, true, '/douyin-auto-spark'), width: 760 },
  { file: 'web-admin', html: renderAdminPage('TOKEN', '/douyin-auto-spark'), width: 1180 },
  { file: 'web-admin-mobile', html: renderAdminPage('TOKEN', '/douyin-auto-spark'), width: 390 },
  { file: 'web-setup-mobile', html: renderSetupPage('TOKEN', initial, false, '/douyin-auto-spark'), width: 390 },
  { file: 'web-expired', html: noticePage, width: 760 },
]

const browser = await puppeteer.launch()
const page = await browser.newPage()

for (const { file, html, width } of pages) {
  const file2 = path.resolve(outDir, `${file}.html`)
  await fs.writeFile(file2, html, 'utf8')
  await page.setViewport({ width, height: 900, deviceScaleFactor: 2 })
  await page.goto(`file://${file2.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' })

  // 注入假数据，让表格/统计条有内容可看
  if (file.startsWith('web-admin')) {
    await page.evaluate(() => {
      document.querySelector('#statTotal').textContent = '3'
      document.querySelector('#statCookie').textContent = '2'
      document.querySelector('#statMissing').textContent = '1'
      const rows = document.querySelector('#rows')
      const data = [
        ['10001', '大号', '1234567890', '3', '已保存'],
        ['10001', '工作号备用机', '9876543210', '2', '缺失'],
        ['10002', '另一个用户的号', '5521987460', '1', '已保存'],
      ]
      for (const item of data) {
        const tr = document.createElement('tr')
        for (const [i, v] of item.entries()) {
          const td = document.createElement('td')
          td.textContent = v
          if (i === 1) td.className = 'name'
          tr.appendChild(td)
        }
        const td = document.createElement('td')
        const wrap = document.createElement('div')
        wrap.className = 'actions'
        const edit = document.createElement('button')
        edit.textContent = '编辑'
        const del = document.createElement('button')
        del.className = 'danger'
        del.textContent = '删除'
        wrap.append(edit, del)
        td.appendChild(wrap)
        tr.appendChild(td)
        rows.appendChild(tr)
      }
      document.querySelector('#pageInfo').textContent = '第 1 / 1 页 · 3 个账号'
      document.querySelector('#status').textContent = '共 3 个账号'
    })
  }

  // 配置页：展示扫码面板与会话勾选面板展开后的样子
  if (file.startsWith('web-setup')) {
    await page.evaluate(() => {
      const list = document.querySelector('#pickerList')
      const sessions = [
        ['张三', ''], ['李四', 'group'], ['家人群', 'group'], ['同事 A', 'nohist'], ['大学室友', ''],
      ]
      for (const [name, tag] of sessions) {
        const row = document.createElement('label')
        row.className = 'picker-item'
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = true
        row.appendChild(box)
        const txt = document.createElement('span')
        txt.textContent = name
        row.appendChild(txt)
        if (tag) {
          const t = document.createElement('span')
          t.className = `tag ${tag}`
          t.textContent = tag === 'group' ? '群聊' : '无火花记录'
          row.appendChild(t)
        }
        list.appendChild(row)
      }
      document.querySelector('#scanStatus').textContent = '二维码已刷新，请用抖音 App 扫码（10 分钟内有效）'
      // 二维码占位：用白底方块模拟，确保该区域在深色背景上可读
      const qr = document.querySelector('#scanQr')
      qr.style.display = 'block'
      qr.src = 'data:image/svg+xml;base64,' + btoa(
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#fff"/><g fill="#111">${
          Array.from({ length: 64 }, (_, i) => {
            const x = (i % 8) * 36 + 6
            const y = Math.floor(i / 8) * 36 + 6
            return (i * 7 + 3) % 5 < 3 ? `<rect x="${x}" y="${y}" width="30" height="30"/>` : ''
          }).join('')
        }<rect x="6" y="6" width="84" height="84" fill="#fff"/><rect x="12" y="12" width="72" height="72" fill="none" stroke="#111" stroke-width="12"/><rect x="36" y="36" width="24" height="24"/><rect x="210" y="6" width="84" height="84" fill="#fff"/><rect x="216" y="12" width="72" height="72" fill="none" stroke="#111" stroke-width="12"/><rect x="240" y="36" width="24" height="24"/></g></svg>`,
      )
    })
  }

  await new Promise((r) => setTimeout(r, 150))
  await page.screenshot({ path: path.resolve(outDir, `${file}.png`), fullPage: true })
  console.log(`✓ ${file}.png`)
}

await browser.close()
console.log(`预览输出目录: ${outDir}`)
