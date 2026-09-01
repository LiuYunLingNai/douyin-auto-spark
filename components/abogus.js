// a_bogus 签名封装
// 算法来源：https://github.com/ShilongLee/Crawler/blob/main/lib/js/douyin.js
// （SM3 + 魔改 RC4 + 环境指纹 + 魔改 Base64，纯算法零依赖，MediaCrawler 同源实现）
// 若签名失效，可用该仓库最新 lib/js/douyin.js 替换同目录 abogus-src.js
// （注意保持函数签名参数名不为 arguments，并保留文件末尾的 export 行）
import { sign, sign_datail, sign_reply } from './abogus-src.js'

const MSTOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=_-'

/**
 * 生成随机伪 msToken（抖音服务端对 msToken 只做格式校验，随机串即可通过）
 * @param {number} [length=107]
 * @returns {string}
 */
export function genMsToken(length = 107) {
  let result = ''
  for (let i = 0; i < length; i += 1) {
    result += MSTOKEN_CHARS[Math.floor(Math.random() * MSTOKEN_CHARS.length)]
  }
  return result
}

/**
 * 生成合法格式的 verifyFp / fp（verify_xxxx 前缀随机串）
 * @returns {string}
 */
export function genVerifyFp() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const segment = (length) => Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `verify_${segment(8)}_${segment(4)}_${segment(4)}_${segment(4)}_${segment(12)}`
}

/**
 * 对 query string 计算 a_bogus 签名（通用 GET 接口）
 * @param {string} queryString 不含 a_bogus 的完整 query string（需包含 msToken）
 * @param {string} userAgent 与请求一致的 User-Agent
 * @returns {string} 168 位签名（含结尾 =）
 */
export function signABogus(queryString, userAgent) {
  return sign_datail(queryString, userAgent)
}

export { sign, sign_datail, sign_reply }
