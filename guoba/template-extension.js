import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { TEMPLATE_FIELDS, parseMessageTemplate, validateImageSource } from '../components/message-template.js'
import { MAX_TEMPLATE_IMAGE_BYTES, readTemplateImage, saveTemplateImage } from '../components/template-images.js'

const capabilities = new Map()
const installed = new WeakSet()
let waiting
const prefix = '/guoba-plugin-mock-root'
const mediaPrefix = `${prefix}/spark-template-media`

function capability(action, source) {
  const token = randomBytes(32).toString('hex')
  capabilities.set(token, { action, source, expiresAt: Date.now() + 10 * 60000 })
  for (const [key, value] of capabilities) if (value.expiresAt <= Date.now()) capabilities.delete(key)
  return `${mediaPrefix}/${action}/${token}`
}

/** 由原版锅巴已鉴权的 action 调用，上传与预览只签发短期单用途凭据。 */
export const templateActions = {
  templateUpload(_args, { Result }) { return Result.ok({ upload: capability('upload') }) },
  templateImage(args, { Result }) {
    const source = validateImageSource(String(args?.[0] || ''))
    if (!source.startsWith('local:')) return Result.error('仅支持本地图片引用')
    return Result.ok({ url: capability('image', source) })
  },
}

function exportAlias(source, name) {
  const exports = source.slice(source.lastIndexOf('export{'))
  const match = exports.match(new RegExp(`(?:[,\\{])${name}(?:\\$\\d+)? as ([\\w$]+)[,}]`))
  if (!match) throw new Error(`锅巴前端缺少 ${name} 导出`)
  return match[1]
}

async function componentModule() {
  const assets = new URL('../../Guoba-Plugin/server/static/assets/', import.meta.url)
  const index = await fs.readFile(new URL('index.js', assets), 'utf8')
  const registryFile = 'BasicForm.vue_vue_type_style_index_0_lang.js'
  const registry = await fs.readFile(new URL(registryFile, assets), 'utf8')
  const names = { defineComponent: 'defineComponent', h: 'h', ref: 'ref', watch: 'watch', onMounted: 'onMounted', onBeforeUnmount: 'onBeforeUnmount', nextTick: 'nextTick', defHttp: 'defHttp' }
  const imports = Object.keys(names).map(name => `${exportAlias(index, name)} as ${name}`).join(', ')
  const source = await fs.readFile(new URL('template-component.js', import.meta.url), 'utf8')
  return `import { ${imports} } from '${prefix}/assets/index.js';\nimport { ${exportAlias(registry, 'componentMap')} as componentMap } from '${prefix}/assets/${registryFile}';\nconst TEMPLATE_FIELDS = ${JSON.stringify(TEMPLATE_FIELDS)};\nconst validateImageSource = ${validateImageSource.toString()};\nconst parseMessageTemplate = ${parseMessageTemplate.toString()};\n${source}\nregisterTemplateEditor({${Object.keys(names).join(',')}}, componentMap, { TEMPLATE_FIELDS, parseMessageTemplate, validateImageSource });`
}

function json(res, status, value) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)) }

/** 只给锅巴首页附加插件模块，不改锅巴磁盘文件或其他表单组件的行为。 */
function install(app) {
  if (!app || installed.has(app)) return
  installed.add(app)
  let modulePromise
  const middleware = async (req, res, next) => {
    const pathname = new URL(req.originalUrl || req.url, 'http://localhost').pathname
    if (pathname === `${prefix}/spark-template-component.js`) {
      try {
        modulePromise ||= componentModule()
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(await modulePromise)
      } catch (error) { modulePromise = undefined; globalThis.logger?.error?.('[抖音续火] 锅巴模板编辑器加载失败', error); res.statusCode = 500; res.end('/* 模板编辑器加载失败 */') }
      return
    }
    const media = new RegExp(`^${mediaPrefix}/(upload|image)/([a-f0-9]{64})$`).exec(pathname)
    if (media) {
      const [, action, token] = media
      const grant = capabilities.get(token)
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
      if (!grant || grant.action !== action || grant.expiresAt <= Date.now()) return json(res, 403, { ok: false, message: '图片授权已过期，请重新上传或刷新配置页' })
      if (req.method !== (action === 'image' ? 'GET' : 'POST')) return json(res, 405, { ok: false, message: '请求方式不支持' })
      try {
        if (action === 'image') {
          const image = await readTemplateImage(grant.source.slice(6)); res.setHeader('Content-Type', image.contentType); res.end(image.bytes); return
        }
        capabilities.delete(token)
        if (req.headers['content-type'] !== 'application/x-douyin-template-image') throw new Error('图片上传请求格式不正确')
        const chunks = []; let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > MAX_TEMPLATE_IMAGE_BYTES) throw new Error('图片不能超过 5 MB'); chunks.push(chunk) }
        const image = await saveTemplateImage(Buffer.concat(chunks))
        return json(res, 200, { ok: true, source: image.source })
      } catch (error) { return json(res, 400, { ok: false, message: error.code === 'ENOENT' ? '图片不存在，请重新上传' : error.message }) }
    }
    const send = res.send
    res.send = function (body) {
      if (typeof body === 'string' && body.includes('id="app"') && body.includes('/assets/index.js') && !body.includes(`<script type="module" src="${prefix}/spark-template-component.js"`)) {
        body = body.replace('</head>', `<script type="module" src="${prefix}/spark-template-component.js"></script></head>`)
      }
      return send.call(this, body)
    }
    next()
  }
  app.use(middleware)
  // 首页由锅巴早期 preload 返回；扩展需要在 preload 和静态资源之前执行。
  const stack = app.router?.stack || app._router?.stack
  if (stack) { const index = stack.findIndex(layer => layer.handle === middleware); if (index > 0) stack.unshift(stack.splice(index, 1)[0]) }
}

export function installTemplateExtension() {
  if (globalThis.Guoba?.app) install(globalThis.Guoba.app)
  if (!waiting) {
    // 锅巴可独立重载；应用实例变化时再次挂载，不需要改锅巴自身重载逻辑。
    waiting = setInterval(() => { if (globalThis.Guoba?.app) install(globalThis.Guoba.app) }, 1000)
    waiting.unref?.()
  }
}
