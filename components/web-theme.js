/**
 * 网页视觉层 —— 抖音风格主题 v2
 * 设计上下文见 D:/Yunzai/.impeccable.md
 *
 * 与消息卡（resources/render/common.css）共用同一套 token 与母题：
 *   · 品牌腰线（洋红→青）固定在视口顶部
 *   · 错位色差只用在页头大标题与关键数字上，除此之外零装饰
 *   · 去卡片：靠分割线、留白、字号跨度组织信息，一层表面到底
 *   · 主体近直角 2px，仅标签用胶囊 —— 靠对比而非统一圆角
 *
 * 只提供 CSS 字符串与页头 HTML，不改任何业务逻辑；
 * 各页面原有的元素 id / class 选择器保持不变，因此 JS 无需改动。
 */

/** 品牌调色 + 基础重置，三个页面共用 */
const BASE_CSS = `
:root{
  --brand:#FE2C55;--brand-dim:#D91F47;
  --cyan:#25F4EE;--cyan-dim:#12C9C3;
  --bg:#161823;--surface:#1C1E2C;--surface-2:#232637;--sunken:#12141D;
  --t1:#F2F4F8;--t2:rgba(242,244,248,.66);--t3:rgba(242,244,248,.44);--t4:rgba(242,244,248,.26);
  --line:rgba(242,244,248,.09);--line-2:rgba(242,244,248,.17);
  --ok:#2EDB81;--warn:#FFC53D;--err:#FF5A5F;
  --sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-6:24px;--sp-8:32px;--sp-12:48px;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","HarmonyOS Sans SC","MiSans","Microsoft YaHei",sans-serif;
  --num:Bahnschrift,"DIN Alternate",Consolas,monospace;
  color-scheme:dark;
}
*{margin:0;padding:0;box-sizing:border-box}
::selection{background:rgba(254,44,85,.35);color:#fff}
html{min-height:100%}
body{
  min-height:100vh;background:var(--bg);color:var(--t1);
  font:16px/1.65 var(--sans);
  -webkit-font-smoothing:antialiased;font-kerning:normal;
  padding:0 0 var(--sp-12);
}
/* 品牌腰线：滚动时固定在视口顶部 */
body::before{
  content:'';position:fixed;left:0;right:0;top:0;height:3px;z-index:9;
  background:linear-gradient(90deg,var(--brand) 0%,var(--brand) 38%,var(--cyan) 100%);
}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--surface-2);border-radius:999px;border:2px solid var(--bg)}
::-webkit-scrollbar-track{background:transparent}

/* ---- 按钮：近直角、≥46px 触控高度 ---- */
.btn,button{
  min-height:46px;font:inherit;font-size:15px;font-weight:600;cursor:pointer;
  border:0;border-radius:2px;padding:12px 22px;letter-spacing:.02em;
  transition:background .14s ease,color .14s ease,border-color .14s ease,filter .14s ease;
  -webkit-tap-highlight-color:transparent;
}
button[type=submit],#submit,.btn-primary{
  background:var(--brand);color:#fff;
}
button[type=submit]:hover,#submit:hover,.btn-primary:hover{background:#FF4368}
button[type=submit]:active,#submit:active,.btn-primary:active{background:var(--brand-dim)}
/* 次级：描边式 */
.actions button:not(.danger),.tools button:not(.danger),.pages button,
.scan-actions button:not(#loadSessions),.scan-actions button:not(#clearTargets),
#loadSessions,#clearTargets,#pickerPrev,#pickerNext,#scanLogin,#scanRefresh,#mfaSubmit,#refresh,#prev,#next,#deleteNo{
  background:transparent;color:var(--t2);border:1px solid var(--line-2);
}
.actions button:not(.danger):hover,.tools button:not(.danger):hover,.pages button:hover,
#loadSessions:hover,#clearTargets:hover,#pickerPrev:hover,#pickerNext:hover,
#scanLogin:hover,#scanRefresh:hover,#mfaSubmit:hover,#refresh:hover,#prev:hover,#next:hover,#deleteNo:hover{
  color:var(--t1);border-color:var(--cyan);background:rgba(37,244,238,.07);
}
.danger,.btn-danger{background:rgba(255,90,95,.14);color:#FF8388;border:1px solid rgba(255,90,95,.42)}
.danger:hover,.btn-danger:hover{background:var(--err);color:#fff;border-color:var(--err)}
button:disabled{opacity:.4;cursor:not-allowed}
button:disabled:hover{background:transparent;color:var(--t2);border-color:var(--line-2);filter:none}

/* ---- 输入：16px 起（防移动端缩放）、聚焦青色 ---- */
input[type=text],input[type=email],input[type=search],input:not([type]),textarea,#filter{
  width:100%;font:inherit;font-size:16px;color:var(--t1);
  background:var(--sunken);border:1px solid var(--line-2);border-radius:2px;
  padding:13px 14px;min-height:46px;
  transition:border-color .14s ease,box-shadow .14s ease;
}
input::placeholder,textarea::placeholder{color:var(--t4)}
input:focus,textarea:focus{
  outline:none;border-color:var(--cyan);
  box-shadow:inset 3px 0 0 var(--cyan);
}
textarea{min-height:96px;resize:vertical;line-height:1.7}
input[type=checkbox]{width:20px;height:20px;flex:none;accent-color:var(--brand)}
input[type=file]{color:var(--t2);font-size:14px}
input[type=file]::file-selector-button{
  background:transparent;color:var(--cyan);border:1px solid rgba(37,244,238,.4);
  border-radius:2px;padding:9px 16px;margin-right:12px;cursor:pointer;font:inherit;font-size:14px;
}
.hint{color:var(--t3);font-size:13px;font-weight:400;line-height:1.65}
[hidden]{display:none!important}
a{color:var(--cyan);text-underline-offset:3px}
`

/** 品牌 Logo（错位双描边音符，原创内联 SVG，无外部素材） */
export const BRAND_LOGO = `<span class="logo" aria-hidden="true">
  <svg viewBox="0 0 24 24">
    <g fill="none" stroke="#25F4EE" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" transform="translate(-0.8,-0.8)">
      <path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/>
    </g>
    <g fill="none" stroke="#FE2C55" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" transform="translate(0.8,0.8)">
      <path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/>
    </g>
    <g fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/>
    </g>
  </svg>
</span>`

/** 页头：Logo + 英文小标 + 大标题（错位）+ 说明 + 右侧徽标 */
export function heroHtml({ title, subTitle, badge = '' }) {
  return `<header class="hero">
    <div class="hero-top">
      ${BRAND_LOGO}
      ${badge ? `<span class="hero-badge">${badge}</span>` : ''}
    </div>
    ${subTitle ? `<div class="hero-eyebrow">${subTitle}</div>` : ''}
    <h1 class="hero-title">${title}</h1>
  </header>`
}

const HERO_CSS = `
.hero{padding:var(--sp-8) var(--sp-8) var(--sp-6);border-bottom:1px solid var(--line-2)}
.hero-top{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-4)}
.logo{display:block;width:40px;height:40px;flex:none}
.logo svg{width:100%;height:100%;display:block}
.hero-badge{
  font-size:12px;font-weight:600;color:var(--brand);letter-spacing:.04em;
  border:1px solid rgba(254,44,85,.42);background:rgba(254,44,85,.1);
  padding:6px 14px;border-radius:999px;white-space:nowrap;
  letter-spacing:.04em;
}
.hero-eyebrow{
  margin-top:var(--sp-6);font-family:var(--num);font-size:12px;font-weight:700;
  letter-spacing:.3em;text-transform:uppercase;color:var(--brand);
}
.hero-title{
  font-size:34px;font-weight:700;line-height:1.2;margin-top:var(--sp-2);
  text-shadow:1.3px 0 0 rgba(254,44,85,.85),-1.3px 0 0 rgba(37,244,238,.85);
}
`

/** 账号配置页（添加 / 修改） */
export const SETUP_CSS = BASE_CSS + HERO_CSS + `
main{
  width:min(720px,100%);margin:0 auto;background:var(--surface);
  border:1px solid var(--line);border-top:0;
}
form{
  padding:var(--sp-8);
  display:grid;gap:var(--sp-8);
}
/* 区块：靠上分割线分组，不做卡片套卡片 */
form > label,form > .scan,form > .picker{
  padding-top:var(--sp-6);border-top:1px solid var(--line);
}
form > label:first-child{padding-top:0;border-top:0}
label{display:grid;gap:var(--sp-2);font-size:14px;font-weight:600;color:var(--t2);letter-spacing:.04em}
label .hint{font-weight:400}
.check{display:flex;align-items:center;gap:var(--sp-3);font-weight:400;font-size:15px;color:var(--t2);min-height:46px}
.check input{width:20px;height:20px}
#status{margin:0;min-height:22px;color:var(--err);font-size:14px;line-height:1.6}
#status.ok{color:var(--ok)}
form button[type=submit]{justify-self:start;padding:13px 34px;font-size:16px}

/* 扫码 / 会话选择面板：沉底表面 + 左侧标记线，不是卡片 */
.scan,.picker{
  display:grid;gap:var(--sp-3);padding:var(--sp-6) 0 var(--sp-2) var(--sp-4);
  border-left:2px solid var(--line-2);background:transparent;
}
.scan-actions{display:flex;flex-wrap:wrap;gap:var(--sp-2);align-items:center}
.scan-actions button{font-size:14px;padding:11px 18px}
.qr{
  display:none;width:min(300px,100%);max-height:320px;object-fit:contain;
  background:#fff;padding:12px;border-radius:2px;margin:var(--sp-2) 0;
}
.sms{display:none;gap:var(--sp-2);grid-template-columns:minmax(0,1fr) auto}
.verify{display:none;color:var(--cyan);font-size:14px}
.cookie{min-height:170px;font-family:var(--num);font-size:14px;line-height:1.8}

/* 会话选择器：扁平列表 + 左侧色标，不用卡片 */
.picker-list{display:grid;gap:0;max-height:270px;overflow-y:auto}
.picker-item{
  display:flex;align-items:center;gap:var(--sp-3);
  font-size:15px;color:var(--t1);
  padding:11px var(--sp-2);border-bottom:1px solid var(--line);
  cursor:pointer;transition:background .12s ease;
}
.picker-item:hover{background:rgba(242,244,248,.03)}
.picker-item:last-child{border-bottom:0}
.picker-item .tag{
  font-size:11px;letter-spacing:.02em;padding:3px 9px;border-radius:999px;
  border:1px solid var(--line-2);color:var(--t3);white-space:nowrap;
}
.picker-item .tag.group{border-color:rgba(46,219,129,.4);color:var(--ok);background:rgba(46,219,129,.09)}
.picker-item .tag.nohist{border-color:rgba(255,197,61,.4);color:var(--warn);background:rgba(255,197,61,.09)}
.picker-empty{color:var(--t3);font-size:14px}
#pickerPageInfo{font-size:13px}

@media(max-width:720px){
  main{border:0}
  .hero{padding:var(--sp-6) var(--sp-6) var(--sp-4)}
  .hero-title{font-size:27px}
  form{padding:var(--sp-6)}
  form button[type=submit]{width:100%;justify-self:stretch}
  .scan-actions button{flex:1}
}
`

/** 主人管理台 */
export const ADMIN_CSS = BASE_CSS + HERO_CSS + `
main{
  width:min(1120px,100%);margin:0 auto;background:var(--surface);
  border:1px solid var(--line);border-top:0;
}
.tools,.pages,.actions{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap}
.tools{padding:var(--sp-6) var(--sp-8) 0}
.tools input{flex:1;min-width:0}
#status{min-height:20px;margin:var(--sp-3) var(--sp-8) 0;color:var(--t3);font-size:13px}

/* 概览：大数字 + 竖线分隔，不做卡片 */
.stats{
  display:grid;grid-template-columns:repeat(3,1fr);
  margin:var(--sp-8) var(--sp-8) 0;padding-bottom:var(--sp-6);
  border-bottom:1px solid var(--line-2);
}
.stat-cell{padding-left:var(--sp-6);border-left:1px solid var(--line)}
.stat-cell:first-child{padding-left:0;border-left:0}
.stat-cell .num{
  font-family:var(--num);font-size:38px;font-weight:700;line-height:1;
  font-variant-numeric:tabular-nums;
}
.stat-cell .num.c1{color:var(--brand)}
.stat-cell .num.c2{color:var(--cyan)}
.stat-cell .num.c3{color:var(--warn)}
.stat-cell .lab{font-size:12px;color:var(--t3);margin-top:var(--sp-2);letter-spacing:.04em}

/* 表格：无斑马线，靠行分割线 */
.table{overflow-x:auto;margin:var(--sp-6) 0 0;padding:0 var(--sp-8)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:14px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
th{
  font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--t4);
  text-transform:uppercase;white-space:nowrap;border-bottom:1px solid var(--line-2);
  padding-top:0;
}
tbody tr{transition:background .12s ease}
tbody tr:hover{background:rgba(242,244,248,.035)}
td{font-size:14.5px;color:var(--t2)}
td.name{color:var(--t1);font-weight:600;overflow-wrap:anywhere}
.pages{padding:var(--sp-6) var(--sp-8) var(--sp-8)}
#pageInfo{font-size:13px;color:var(--t3)}
#confirmDelete{
  margin:0 var(--sp-8) var(--sp-8);padding:var(--sp-4) var(--sp-6) var(--sp-4) var(--sp-4);
  border-left:3px solid var(--err);background:rgba(255,90,95,.07);
}
#confirmDelete p{color:var(--t2);font-size:14px;line-height:1.7}
#confirmDelete .actions{margin-top:var(--sp-4)}

@media(max-width:700px){
  main{border:0}
  .hero{padding:var(--sp-6) var(--sp-4) var(--sp-4)}
  .hero-title{font-size:27px}
  .tools{padding:var(--sp-6) var(--sp-4) 0}
  .tools{flex-wrap:wrap}
  .tools input{flex-basis:100%}
  .tools button{flex:1}
  #status,.pages,.table,#confirmDelete{margin-left:0;margin-right:0;padding-left:var(--sp-4);padding-right:var(--sp-4)}
  .stats{margin-left:var(--sp-4);margin-right:var(--sp-4)}
  .stat-cell .num{font-size:30px}
  /* 表格转卡片，列名用伪元素补（不动 JS 生成的 DOM） */
  .table{overflow:visible}
  table,thead,tbody,tr,td{display:block;width:100%}
  thead{display:none}
  tbody tr{
    border-bottom:1px solid var(--line-2);padding:var(--sp-4) 0;
    display:flex;flex-direction:column;gap:var(--sp-1);
  }
  tbody tr:hover{background:transparent}
  td{padding:2px 0;border:0;display:flex;gap:var(--sp-3);align-items:center;font-size:14px}
  td::before{flex:none;width:76px;font-size:12px;color:var(--t4);letter-spacing:.06em}
  td:nth-of-type(1)::before{content:'用户 ID'}
  td:nth-of-type(2)::before{content:'账号名'}
  td:nth-of-type(3)::before{content:'抖音 UID'}
  td:nth-of-type(4)::before{content:'目标数'}
  td:nth-of-type(5)::before{content:'Cookie'}
  td:nth-of-type(6)::before{content:'操作'}
  td.name{font-weight:600;font-size:17px}
  td:nth-of-type(6){margin-top:var(--sp-3)}
  .actions{width:100%}
  .actions button{flex:1}
}
`

/** 提示页（链接过期 / 404 / 403） */
export const MESSAGE_CSS = BASE_CSS + `
body{display:flex;align-items:center;justify-content:center;padding:var(--sp-6);min-height:100vh}
.msg-card{width:min(460px,100%)}
.msg-card .logo{display:block;width:48px;height:48px;margin-bottom:var(--sp-6)}
.msg-card .logo svg{width:100%;height:100%;display:block}
.msg-card .eyebrow{
  font-family:var(--num);font-size:12px;font-weight:700;letter-spacing:.3em;
  text-transform:uppercase;color:var(--brand);
}
.msg-card h1{
  font-size:30px;font-weight:700;line-height:1.35;margin-top:var(--sp-3);
}
.msg-card p{
  margin-top:var(--sp-4);padding-top:var(--sp-4);border-top:1px solid var(--line);
  font-size:15px;color:var(--t3);line-height:1.75;
}
.msg-card .chip{
  display:inline-block;margin-top:var(--sp-6);font-family:var(--num);font-size:14px;
  color:var(--cyan);border:1px solid rgba(37,244,238,.4);background:rgba(37,244,238,.07);
  padding:9px 18px;border-radius:999px;
}
`
