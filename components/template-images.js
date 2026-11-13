import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const imageRoot = fileURLToPath(new URL('../data/template-images/', import.meta.url))
export const MAX_TEMPLATE_IMAGE_BYTES = 5 * 1024 * 1024

function imageExtension(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg'
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'gif'
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  throw new Error('仅支持 PNG、JPEG、GIF、WebP 图片')
}

export function templateImagePath(id) {
  if (!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(id)) throw new Error('图片引用无效')
  return path.join(imageRoot, id)
}

export async function saveTemplateImage(bytes) {
  if (!bytes.length || bytes.length > MAX_TEMPLATE_IMAGE_BYTES) throw new Error('图片需大于 0 且不能超过 5 MB')
  const extension = imageExtension(bytes)
  const id = `${createHash('sha256').update(bytes).digest('hex')}.${extension}`
  await fs.mkdir(imageRoot, { recursive: true })
  await fs.writeFile(templateImagePath(id), bytes, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
  return { source: `local:${id}`, id }
}

export async function readTemplateImage(id) {
  const bytes = await fs.readFile(templateImagePath(id))
  const types = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
  return { bytes, contentType: types[id.split('.').at(-1)] }
}

/** 仅提供插件图片目录中的内容；模板不能读取机器人上的任意文件。 */
export async function imageInput(source) {
  if (source.startsWith('local:')) return (await readTemplateImage(source.slice(6))).bytes
  const response = await fetch(source, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`图片链接读取失败（HTTP ${response.status}）`) }
  const chunks = []; let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > MAX_TEMPLATE_IMAGE_BYTES) throw new Error('图片链接返回的内容超过 5 MB')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  imageExtension(bytes)
  return bytes
}

export async function assertTemplateImages(parts) {
  for (const part of parts) {
    if (part.type === 'image' && part.source.startsWith('local:')) await fs.access(templateImagePath(part.source.slice(6))).catch(() => { throw new Error('本地图片不存在，请重新上传') })
  }
}
