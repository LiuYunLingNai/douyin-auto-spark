// 抖音扫码登录（纯 API，无浏览器）
// 移植自 jumpbyte-bot（github.com/sisi0318/jumpbyte-bot，Go）的抖音PC客户端登录流程：
// 走 imdesktop.douyin.com（PC 端 passport），签名 sign/qs 规则与 account_sdk_source_info 指纹见下。
import crypto from 'node:crypto'
import { signABogus } from './abogus.js'

const HOST = 'https://imdesktop.douyin.com'
const AID = '339757'
const APP_KEY = '3c452fb664e3de0e936108429a0bc697'
const NEXT_URL = 'https://www.douyin.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) douyinim/1.1.31 Chrome/130.0.6723.58 Electron/33.4.11 Safari/537.36'
const REQUEST_TIMEOUT_MS = 30000

// 浏览器发包时的固定参数顺序（取自真机 HAR；顺序乱了对不上风控）
const PARAM_ORDER = {
  passport_jssdk_version: 0, passport_jssdk_type: 1, is_from_ttaccountsdk: 2,
  aid: 3, language: 4, account_app_language: 5, ts: 6,
  next: 7, need_logo: 8, need_short_url: 9, is_new_login: 10,
  is_from_iesaccountsaas: 11, account_sdk_source: 12, account_sdk_source_info: 13,
  p_js_v: 14, p_js_t: 15, p_zt: 16, p_ver: 17, request_host: 18, p_bd: 19,
  biz_trace_id: 20, new_authn_sdk_version: 21,
  device_id: 22, iid: 23, version_code: 24, device_platform: 25,
  sign: 100, qs: 101, msToken: 102, a_bogus: 103,
}

/** code_encrypt / account_sdk_source_info 编码：UTF-8 字节逐位 ^ 5 后转十六进制 */
export function xor5(input) {
  const bytes = []
  for (const ch of String(input)) {
    const c = ch.codePointAt(0)
    if (c <= 0x7f) bytes.push(c)
    else if (c <= 0x7ff) bytes.push(0xc0 | ((c >> 6) & 0x1f), 0x80 | (c & 0x3f))
    else if (c <= 0xffff) bytes.push(0xe0 | ((c >> 12) & 0x0f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    // > 0xffff 跳过，与 JS 原版一致
  }
  return bytes.map((b) => (b ^ 5).toString(16).padStart(2, '0')).join('')
}

/** 排序后前 limit 个参数拼 k=v&k=v；limit<0 为全部。返回 [拼接串, 使用的键] */
function sortedKv(map, limit) {
  let keys = Object.keys(map).sort()
  if (limit >= 0 && limit < keys.length) keys = keys.slice(0, limit)
  return [keys.map((k) => `${k}=${map[k]}`).join('&'), keys]
}

/** sign = sha256(前10个排序query + "&" + 排序body + "&app_key=...")；qs = xor5(前10个键名) */
function signParams(query, body) {
  const [tStr, keys] = sortedKv(query, 10)
  const [eStr] = sortedKv(body ?? {}, -1)
  const sign = crypto.createHash('sha256').update(`${tStr}&${eStr}&app_key=${APP_KEY}`, 'utf8').digest('hex')
  return { sign, qs: xor5(keys.join(',')) }
}

const MS_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function msToken(length = 128) {
  const bytes = crypto.randomBytes(length)
  return [...bytes].map((b) => MS_ALPHABET[b & 63]).join('')
}

function randHex(length) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
}

/** 生成 device_id：324 开头 + 7 位随机数字 */
function genDeviceId() {
  const bytes = crypto.randomBytes(7)
  return '324' + [...bytes].map((b) => String(b % 10)).join('')
}

/**
 * account_sdk_source_info 指纹（xor5(JSON)）。
 * 内容为稳定合理的 Windows+Chromium 指纹；服务端只要能解码即可。
 */
function buildFingerprint(deviceId) {
  return xor5(JSON.stringify({
    hardwareConcurrency: 8,
    webdriver: false,
    chromedriver: false,
    shelldriver: false,
    plugins: 5,
    permissions: [{ name: 'notifications', state: 'granted' }],
    innerHeight: 484,
    innerWidth: 726,
    outerHeight: 484,
    outerWidth: 726,
    stoargeStatus: {
      indexedDB: {
        idb: 'object', open: 'function', indexedDB: 'object',
        IDBKeyRange: 'function', openDatabase: 'function', isSafari: false, hasFetch: false,
      },
      localStorage: { isSupportLStorage: true, size: 1993, write: true },
      storageQuotaStatus: { usage: 0, quota: 36104626176, isPrivate: false },
    },
    webgl: {
      vendor: 'Google Inc. (Google)',
      renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    },
    notificationPermission: 'granted',
    performance: {
      timeOrigin: 1787813991280.3,
      usedJSHeapSize: 18200000,
      navigationTiming: {
        decodedBodySize: 2527, entryType: 'navigation', initiatorType: 'navigation',
        name: `file:///renderer/login/index.html?window=login&channel=0&guid=${deviceId}`,
        renderBlockingStatus: 'non-blocking',
      },
    },
    request_host: '',
    request_pathname: '/renderer/login/index.html',
    browser: { t: '7781993187871', bit_protocol: 'false', bit_helper: false },
  }))
}

function encodeKv(map) {
  const keys = Object.keys(map).sort((a, b) => {
    const oa = PARAM_ORDER[a]
    const ob = PARAM_ORDER[b]
    if (oa !== undefined && ob !== undefined) return oa - ob
    if (oa !== undefined) return -1
    if (ob !== undefined) return 1
    return a < b ? -1 : a > b ? 1 : 0
  })
  return keys.map((k) => `${k}=${encodeURIComponent(map[k])}`).join('&')
}

/** 极简 Cookie Jar */
class CookieJar {
  constructor() { this.store = new Map() }
  update(setCookies) {
    for (const line of setCookies ?? []) {
      const [pair] = String(line).split(';')
      const index = pair.indexOf('=')
      if (index <= 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (!value || value.toLowerCase() === 'deleted') this.store.delete(name)
      else this.store.set(name, value)
    }
  }
  header() {
    return [...this.store].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  has(name) { return this.store.has(name) }
}

/**
 * 扫码登录会话。用法：
 *   const session = new QrLoginSession()
 *   await session.start()          // 开始，后台轮询
 *   session.qr                     // data:image/png;base64,... 二维码
 *   session.status                 // waiting | scanned | sms | success | error
 *   session.submitSmsCode(code)    // 触发短信验证时提交验证码
 *   session.cookies                // 成功后的 Cookie-Editor 格式数组
 */
export class QrLoginSession {
  constructor() {
    this.deviceId = genDeviceId()
    this.fingerprint = buildFingerprint(this.deviceId)
    this.jar = new CookieJar()
    this.status = 'idle'
    this.qr = ''
    this.screenName = ''
    this.message = ''
    this.cookies = undefined
    this.error = undefined
    this.cancelled = false
    this.smsResolver = undefined
  }

  cancel() {
    this.cancelled = true
    if (this.smsResolver) {
      this.smsResolver('')
      this.smsResolver = undefined
    }
  }

  submitSmsCode(code) {
    if (this.smsResolver) {
      this.smsResolver(code)
      this.smsResolver = undefined
    }
  }

  waitForSms() {
    return new Promise((resolve) => { this.smsResolver = resolve })
  }

  normalBase() {
    return {
      passport_jssdk_version: '2.4.12', passport_jssdk_type: 'normal', is_from_ttaccountsdk: '1',
      aid: AID, language: 'zh', ts: String(Math.floor(Date.now() / 1000)),
      account_sdk_source: 'web', account_sdk_source_info: this.fingerprint,
      p_js_v: '2.4.12', p_js_t: 'pro', p_zt: '3.3.5', p_ver: '1.0.29',
      request_host: 'file://', p_bd: '1.0.1.7', biz_trace_id: randHex(8),
      device_id: this.deviceId, iid: '0', version_code: '1.1.31', device_platform: 'PC',
      is_from_iesaccountsaas: '1', is_new_login: '1',
    }
  }

  liteBase() {
    return {
      passport_jssdk_version: '5.1.2', passport_jssdk_type: 'lite', is_from_ttaccountsdk: '1',
      aid: AID, language: 'zh', account_app_language: 'zh', new_authn_sdk_version: '1.0.0.421-web',
      biz_trace_id: randHex(8), device_id: this.deviceId, iid: '0', version_code: '1.1.31',
      device_platform: 'PC', is_from_iesaccountsaas: '1', is_new_login: '1',
    }
  }

  /** 发一个已签名的 passport 请求，返回解析后的 JSON */
  async call(path, queryExtra, body, lite = false) {
    const query = { ...(lite ? this.liteBase() : this.normalBase()), ...(queryExtra ?? {}) }
    if (!lite) {
      const { sign, qs } = signParams(query, body)
      query.sign = sign
      query.qs = qs
    }
    query.msToken = msToken(128)
    const queryStr = encodeKv(query)
    const aBogus = signABogus(queryStr, UA)
    const url = `${HOST}${path}?${queryStr}&a_bogus=${encodeURIComponent(aBogus)}`

    const headers = {
      'bd-ticket-guard-version': '2',
      'bd-ticket-guard-iteration-version': '2',
      'bd-ticket-guard-ree-public-key': 'BEPhQJtcnGrFIlCf8/m+Boe2kyBwe7Wj0hKUVpdDZlj1Dbb4qkcqtSzxGD4eaO6mc4aG9alH1Ka95D1e1ngTKJg=',
      'bd-ticket-guard-server-cert-sn': '533240336124694022040808462028007165443034493949',
      'x-tt-passport-aid-sign': '437536ae85fd28413d036ecf7bf60798421979bdc1fcc15a493474d3bacfb525',
      'x-tt-passport-csrf-token': '',
      'x-tt-passport-trace-id': randHex(8),
      'x-tt-passport-verify-portrait': '41918735-2cb8-47d6-a412-9f970bb8410d.login',
      'user-agent': UA,
      referer: HOST,
      accept: 'application/json, text/plain, */*',
    }
    const cookieHeader = this.jar.header()
    if (cookieHeader) headers.cookie = cookieHeader
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded'

    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? encodeKv(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    this.jar.update(response.headers.getSetCookie?.() ?? [])
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return { _raw: text.slice(0, 200), _status: response.status }
    }
  }

  /** 登录前置：拿设备追踪 cookie */
  async ttwidCheck() {
    try {
      const response = await fetch(`${HOST}/ttwid/check/`, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/json', referer: HOST },
        body: JSON.stringify({
          aid: 339757, service: 'imdesktop.douyin.com', unionHost: 'https://ttwid.bytedance.com',
          host: 'https://imdesktop.douyin.com', union: false, needFid: false, fid: '', migrate_priority: 0,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      this.jar.update(response.headers.getSetCookie?.() ?? [])
    } catch { /* 探测失败不阻断登录 */ }
  }

  /** 开始登录流程（异步后台轮询，状态体现在 this.status） */
  async start() {
    if (this.status !== 'idle') return
    this.status = 'waiting'
    ;(async () => {
      await this.ttwidCheck()
      const qr = await this.call('/passport/web/get_qrcode/', { next: NEXT_URL, need_logo: 'false', need_short_url: 'false' }, null)
      const data = qr?.data ?? {}
      if (!data.qrcode || Number(data.error_code) !== 0) {
        throw new Error(`获取二维码失败：${data.description || qr?.message || JSON.stringify(qr).slice(0, 200)}`)
      }
      this.qr = `data:image/png;base64,${data.qrcode}`
      this.token = String(data.token)
      this.expireAt = Number(data.expire_time) ? Number(data.expire_time) * 1000 : Date.now() + 180000
      await this.runLoop()
    })().catch((error) => {
      this.status = 'error'
      this.error = error.message || '扫码登录失败'
    })
  }

  /** 轮询扫码状态（调用前需已设置 this.token / this.expireAt） */
  async runLoop() {
    const token = this.token
    const expireAt = this.expireAt || Date.now() + 180000
    const baseBody = {
      need_logo: 'false', need_short_url: 'false', is_frontier: 'true',
      token, is_new_login: '1', next: NEXT_URL,
    }
    let extraBody = {}
    let scanned = false
    let mfaDone = false

    while (Date.now() < expireAt && !this.cancelled) {
      const body = { ...baseBody, ...extraBody }
      let result
      try {
        result = await this.call('/passport/web/check_qrconnect/', null, body)
      } catch {
        await sleep(2000)
        continue
      }
      const d = result?.data ?? {}

      if (!mfaDone && (d.account_flow === 'verify' || d.biz_params)) {
        await this.doMfa(d)
        extraBody = pickBizParams(d.biz_params ?? {})
        mfaDone = true
        continue
      }

      if (d.status === 'scanned') {
        if (!scanned) {
          scanned = true
          this.screenName = String(d.scan_user_info?.screen_name ?? '')
          this.status = 'scanned'
          this.message = this.screenName ? `${this.screenName} 已扫码，请在抖音 App 上确认` : '已扫码，请在抖音 App 上确认'
        }
      } else if (d.status === 'confirmed') {
        if (!this.jar.has('sessionid')) throw new Error('已确认但未拿到 sessionid，请重试')
        this.cookies = [...this.jar.store].map(([name, value]) => ({
          name, value, domain: '.douyin.com', path: '/',
        }))
        this.status = 'success'
        this.message = '登录成功'
        return
      } else if (Number(d.error_code) === 4031) {
        throw new Error('触发抖音风控（4031），请稍后重试或改用粘贴 Cookie 方式')
      }
      await sleep(2000)
    }
    if (!this.cancelled) throw new Error('二维码已过期，请刷新后重新扫码')
  }

  /** 短信二次验证（MFA） */
  async doMfa(d) {
    const bp = d.biz_params ?? {}
    const cp = d.common_params ?? {}
    const pick = (m, k, def) => String(m?.[k] ?? def ?? '')
    const mfa = {
      mix_mode: '1', type: '3737', encrypt_uid: pick(d, 'encrypt_uid'), verify_ticket: '',
      copywriting_key: pick(cp, 'copywriting_key', 'qr_connect'),
      ies_safety_diversion_tag: pick(cp, 'ies_safety_diversion_tag', 'mfa'),
      new_verify_flow: pick(cp, 'new_verify_flow'),
      std_verify_flow_id: pick(bp, 'std_verify_flow_id', pick(cp, 'std_verify_flow_id')),
      std_verify_scene: pick(bp, 'std_verify_scene', 'account_login'),
      std_verify_template: pick(bp, 'std_verify_template', 'ato'),
      std_verify_token: pick(bp, 'std_verify_token', pick(cp, 'std_verify_token')),
      std_verify_type: pick(bp, 'std_verify_type', 'MFA'),
      std_verify_way: 'mobile_sms_verify',
    }
    const withTail = (extra) => ({ ...mfa, ...extra, aid: '339757', new_authn_sdk_version: '1.0.0.421-web' })

    const sent = await this.call('/passport/web/send_code/', null, withTail({ is6Digits: '1' }), true)
    const mobile = String(sent?.data?.mobile ?? '')
    this.status = 'sms'
    this.message = `已向 ${mobile || '绑定手机'} 发送短信验证码，请输入`
    const code = String(await this.waitForSms()).trim()
    if (!/^\d{4,8}$/.test(code)) throw new Error('短信验证码无效')
    this.message = '正在校验短信验证码…'
    const validated = await this.call('/passport/web/validate_code/', null, withTail({ code: xor5(code) }), true)
    if (!validated?.data?.ticket) {
      throw new Error(`短信验证失败：${validated?.data?.description || validated?.message || '未知错误'}`)
    }
    this.status = 'waiting'
    this.message = '短信验证通过，请继续扫码确认'
  }
}

function pickBizParams(bp) {
  const out = {}
  for (const key of ['passport_mfa_retry_tag', 'std_verify_flow_id', 'std_verify_scene',
    'std_verify_template', 'std_verify_token', 'std_verify_type', 'std_verify_way']) {
    if (bp[key] !== undefined) out[key] = String(bp[key])
  }
  return out
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ===================== 手机号短信验证码登录（备选方案，参考 jumpbyte-bot smslogin.go） =====================

/** 手机号归一化为 '+86 <号码>'（服务端要求国家码与号码间有空格） */
export function formatMobile(raw) {
  let s = String(raw).replace(/[\s\-()]/g, '')
  if (!s) return ''
  if (s.startsWith('+86')) return '+86 ' + s.slice(3)
  if (s.startsWith('+')) return s
  if (s.startsWith('86') && s.length > 11) return '+86 ' + s.slice(2)
  return '+86 ' + s
}

/** 手机号 + 短信验证码登录会话（无需扫码）。status: idle -> sms_sent -> success/error */
export class SmsLoginSession extends QrLoginSession {
  constructor() {
    super()
    this.mobile = ''
    this.mobileMasked = ''
  }

  async sendCode(mobile) {
    mobile = formatMobile(mobile)
    if (!mobile) throw new Error('手机号为空')
    await this.ttwidCheck()
    this.mobile = mobile
    const resp = await this.call('/passport/web/send_code/', null, {
      mix_mode: '1',
      mobile: xor5(mobile),
      type: xor5('24'),
      is6Digits: '1',
      fixed_mix_mode: '1',
    })
    if (resp?.message !== 'success') {
      throw new Error(`发送验证码失败：${resp?.data?.description || resp?.message || '未知错误'}`)
    }
    this.mobileMasked = String(resp?.data?.mobile || mobile)
    this.status = 'sms_sent'
    this.message = `已向 ${this.mobileMasked} 发送短信验证码`
  }

  async submitCode(code) {
    if (this.status !== 'sms_sent' || !this.mobile) throw new Error('请先发送短信验证码')
    code = String(code).trim()
    if (!/^\d{4,8}$/.test(code)) throw new Error('验证码格式不正确')
    const resp = await this.call('/passport/web/sms_login/', null, {
      service: 'https://www.douyin.com',
      mix_mode: '1',
      mobile: xor5(this.mobile),
      code: xor5(code),
      fixed_mix_mode: '1',
      login_only: 'true',
    })
    if (resp?.message !== 'success') {
      throw new Error(`验证码登录失败：${resp?.data?.description || resp?.message || '未知错误'}`)
    }
    if (!this.jar.has('sessionid')) throw new Error('登录成功但未拿到 sessionid')
    this.cookies = [...this.jar.store].map(([name, value]) => ({ name, value, domain: '.douyin.com', path: '/' }))
    this.status = 'success'
    this.message = '登录成功'
  }
}
