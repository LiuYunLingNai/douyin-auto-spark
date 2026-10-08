import { randomBytes } from 'node:crypto'
import { getConfig } from './config.js'
import { ADMIN_CSS, MESSAGE_CSS, heroHtml, BRAND_LOGO } from './web-theme.js'
import { listAccountSummaries, deleteAccountById } from './database.js'
import { closeBot } from './douyin.js'

const sessions = new Map()

export function createAdminSession(userId) {
  revokeAdminSessions(userId)
  const token = randomBytes(32).toString('hex')
  const minutes = Number(getConfig().web?.linkExpiresMinutes) || 10
  const session = { userId: String(userId), expiresAt: Date.now() + minutes * 60000 }
  session.timer = setTimeout(() => sessions.delete(token), minutes * 60000)
  session.timer.unref?.()
  sessions.set(token, session)
  return { token, expiresMinutes: minutes }
}

export function revokeAdminSessions(userId) {
  for (const [token, session] of sessions) {
    if (session.userId !== String(userId)) continue
    clearTimeout(session.timer)
    sessions.delete(token)
  }
}

function getSession(token) {
  const session = sessions.get(token)
  if (!session || session.expiresAt <= Date.now()) {
    clearTimeout(session?.timer)
    sessions.delete(token)
    return undefined
  }
  return session
}

function send(res, status, value, html = false) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.statusCode = status
  res.setHeader('Content-Type', html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8')
  res.end(html ? value : JSON.stringify(value))
  return true
}

/** 两种网页服务共用此入口。页面链接与 API 凭据均来自主人专用会话。 */
export async function handleAdminRequest(req, res, pathname, prefix, createEditLink, readBody) {
  const page = pathname === `${prefix}/admin`
  const api = new RegExp(`^${prefix}/api/admin/(list|edit|delete|logout)$`).exec(pathname)
  if (!page && !api) return false
  const pageToken = new URL(req.url, 'http://localhost').searchParams.get('token')
  const token = page ? pageToken : String(req.headers.authorization || '').replace(/^Bearer /, '')
  const session = getSession(token)
  if (!session) return send(res, 403, page ? renderNotice('管理链接无效或已过期', '请私聊机器人重新发送 #抖音管理账号 获取新链接。') : { ok: false, message: '管理会话无效或已过期' }, page)
  if (page) {
    if (!pageToken) return send(res, 400, renderNotice('管理链接缺少令牌', '请使用机器人私聊发送的完整链接打开。'), true)
    if (req.method !== 'GET') return send(res, 405, { ok: false, message: '请求方式不支持' })
    return send(res, 200, renderAdminPage(token, prefix), true)
  }
  const action = api[1]
  if (req.method !== (action === 'list' ? 'GET' : 'POST')) return send(res, 405, { ok: false, message: '请求方式不支持' })
  try {
    if (action === 'logout') {
      clearTimeout(session.timer)
      sessions.delete(token)
      return send(res, 200, { ok: true })
    }
    if (action === 'list') {
      const items = await listAccountSummaries()
      return send(res, 200, { ok: true, items })
    }
    const body = req.body ?? await readBody(req)
    const id = Number(body?.id)
    if (!Number.isSafeInteger(id) || id < 1) return send(res, 400, { ok: false, message: '账号编号无效' })
    const account = (await listAccountSummaries()).find((item) => item.id === id)
    if (!account) return send(res, 404, { ok: false, message: '账号不存在' })
    if (action !== 'edit' && action !== 'delete') return send(res, 404, { ok: false, message: '未知管理操作' })
    if (action === 'edit') {
      const link = createEditLink({ userId: account.userId, accountId: account.id })
      globalThis.logger?.mark?.(`[抖音续火] 主人 ${session.userId} 创建账号 ${id} 的修改链接（所属用户 ${account.userId}）`)
      return send(res, 200, { ok: true, url: link.url })
    }
    const removed = await deleteAccountById(id)
    if (removed) {
      closeBot(id)
    }
    globalThis.logger?.mark?.(`[抖音续火] 主人 ${session.userId} 删除账号 ${id}（所属用户 ${account.userId}）：${removed ? '成功' : '账号已不存在'}`)
    return send(res, 200, { ok: true, removed })
  } catch (error) {
    globalThis.logger?.error?.('[抖音续火] 管理账号请求失败', error)
    return send(res, 500, { ok: false, message: '操作失败，请检查机器人日志后重试' })
  }
}

/** 过期 / 参数错误的提示页（与账号配置页同一套抖音视觉） */
function renderNotice(title, desc) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#161823"><title>抖音账号管理</title><style>${MESSAGE_CSS}</style></head>
<body><div class="msg-card">${BRAND_LOGO}<div class="eyebrow">Douyin Auto Spark</div><h1>${title}</h1><p>${desc}</p><span class="chip">回到机器人私聊重新获取</span></div></body></html>`
}

export function renderAdminPage(token, prefix) {
  const data = JSON.stringify({ token, prefix }).replace(/</g, '\\u003c')
  return String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#161823"><title>抖音账号管理</title>
<style>
${ADMIN_CSS}
</style></head><body><main>${heroHtml({ title: '所有抖音账号', subTitle: 'DOUYIN AUTO SPARK · ADMIN', badge: '主人专用' })}<div class="tools"><input id="filter" aria-label="搜索账号" placeholder="按用户 ID、账号名或抖音 UID 搜索"><button id="refresh" type="button">刷新</button><button id="logout" type="button">退出管理</button></div><div class="stats"><div class="stat-cell"><div class="num c1" id="statTotal">0</div><div class="lab">全部账号</div></div><div class="stat-cell"><div class="num c2" id="statCookie">0</div><div class="lab">已存 Cookie</div></div><div class="stat-cell"><div class="num c3" id="statMissing">0</div><div class="lab">缺少 Cookie</div></div></div><div id="status" role="status"></div><div class="table"><table><thead><tr><th>用户 ID</th><th>账号名</th><th>抖音 UID</th><th>目标数</th><th>Cookie</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pages"><button id="prev" type="button">上一页</button><span id="pageInfo"></span><button id="next" type="button">下一页</button></div><div id="confirmDelete" hidden><p id="deleteText"></p><div class="actions"><button id="deleteYes" class="danger" type="button">确认删除</button><button id="deleteNo" type="button">取消</button></div></div></main>
<script>
const config=${data};
history.replaceState(null,'',config.prefix+'/admin');
const rows=document.querySelector('#rows'),status=document.querySelector('#status'),filter=document.querySelector('#filter'),confirmDelete=document.querySelector('#confirmDelete');
let items=[],page=0,pendingDelete=null,busy=false;const pageSize=20;
async function request(action,body){const response=await fetch(config.prefix+'/api/admin/'+action,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},cache:'no-store',body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!data.ok)throw Error(data.message||'请求失败');return data}
function draw(){const q=filter.value.trim().toLowerCase();const matches=items.filter(x=>[x.userId,x.name,x.douyinUid].some(v=>String(v).toLowerCase().includes(q)));const pages=Math.max(1,Math.ceil(matches.length/pageSize));page=Math.min(page,pages-1);rows.innerHTML='';document.querySelector('#prev').disabled=busy||page===0;document.querySelector('#next').disabled=busy||page>=pages-1;document.querySelector('#pageInfo').textContent='第 '+(page+1)+' / '+pages+' 页 · '+matches.length+' 个账号';for(const item of matches.slice(page*pageSize,(page+1)*pageSize)){const tr=document.createElement('tr');for(const [index,value] of [item.userId,item.name,item.douyinUid||'未记录',item.targetCount,item.hasCookie?'已保存':'缺失'].entries()){const td=document.createElement('td');td.textContent=value;if(index===1)td.className='name';tr.appendChild(td)}const td=document.createElement('td');const actions=document.createElement('div');actions.className='actions';const edit=document.createElement('button');edit.textContent='编辑';edit.disabled=busy;edit.onclick=async()=>{if(busy)return;busy=true;draw();try{const data=await request('edit',{id:item.id});const a=document.createElement('a');a.href=data.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent='打开账号“'+item.name+'”的修改页';status.textContent='';status.appendChild(a)}catch(error){status.textContent=error.message}finally{busy=false;draw()}};const del=document.createElement('button');del.className='danger';del.textContent='删除';del.disabled=busy;del.onclick=()=>{pendingDelete=item;document.querySelector('#deleteText').textContent='确定删除用户 '+item.userId+' 的账号“'+item.name+'”？此操作无法撤销。';confirmDelete.hidden=false};actions.append(edit,del);td.appendChild(actions);tr.appendChild(td);rows.appendChild(tr)}}
async function load(){if(busy)return;busy=true;draw();status.textContent='正在读取账号…';try{const data=await request('list');items=data.items||[];const ok=items.filter(x=>x.hasCookie).length;document.querySelector('#statTotal').textContent=items.length;document.querySelector('#statCookie').textContent=ok;document.querySelector('#statMissing').textContent=items.length-ok;status.textContent='共 '+items.length+' 个账号'}catch(error){status.textContent=error.message}finally{busy=false;draw()}}
filter.oninput=()=>{page=0;draw()};document.querySelector('#prev').onclick=()=>{page=Math.max(0,page-1);draw()};document.querySelector('#next').onclick=()=>{page++;draw()};document.querySelector('#refresh').onclick=load;
document.querySelector('#deleteNo').onclick=()=>{pendingDelete=null;confirmDelete.hidden=true};document.querySelector('#deleteYes').onclick=async()=>{if(!pendingDelete||busy)return;const item=pendingDelete;busy=true;document.querySelector('#deleteYes').disabled=true;draw();try{await request('delete',{id:item.id});pendingDelete=null;confirmDelete.hidden=true;items=items.filter(x=>x.id!==item.id);status.textContent='账号已删除'}catch(error){status.textContent=error.message}finally{busy=false;document.querySelector('#deleteYes').disabled=false;draw()}};
document.querySelector('#logout').onclick=async()=>{if(busy)return;try{await request('logout',{});config.token='';items=[];draw();document.querySelectorAll('button,input').forEach(el=>el.disabled=true);confirmDelete.hidden=true;status.textContent='已退出管理，请私聊机器人重新获取链接'}catch(error){status.textContent=error.message}};load();
</script></body></html>`
}
