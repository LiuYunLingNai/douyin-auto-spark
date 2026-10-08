/**
 * 网页视觉层 —— 抖音风格主题（douyin-ui-spec §1~§4）
 *
 * 作用于「打开链接后的两个网页」：账号配置页（添加/修改）与主人管理台。
 * 只提供 CSS 字符串 + 一段页头 HTML，不改变任何业务逻辑；
 * 各页面原有的元素 id / class 选择器保持不变，因此 JS 无需改动。
 *
 * 配色：深色 #161823 体系 / 主色洋红 #FE2C55 / 辅助青 #25F4EE
 * 说明：Logo 为原创内联 SVG（错位双描边音符），不使用任何官方素材。
 */

/** 品牌调色 + 基础重置，两个页面共用 */
const BASE_CSS = `
:root{
  --magenta:#FE2C55;--magenta-hover:#FF4D6F;--magenta-deep:#D91F47;
  --cyan:#25F4EE;--cyan-light:#7FF9F4;--cyan-deep:#12C9C3;
  --bg0:#161823;--bg1:#1C1E2C;--bg2:#232637;--bg3:#2E3245;--sunken:#12141D;
  --t1:#FFFFFF;--t2:rgba(255,255,255,.72);--t3:rgba(255,255,255,.50);--t4:rgba(255,255,255,.30);
  --line:rgba(255,255,255,.08);--line-strong:rgba(255,255,255,.14);
  --ok:#2EDB81;--warn:#FFC53D;--err:#FF4D4F;
  --r-sm:8px;--r-md:12px;--r-lg:16px;
  color-scheme:dark;
}
*{margin:0;padding:0;box-sizing:border-box}
::selection{background:rgba(254,44,85,.35);color:#fff}
html{min-height:100%}
body{
  min-height:100vh;background:var(--bg0);color:var(--t1);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","HarmonyOS Sans SC","MiSans","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
  background-image:
    radial-gradient(ellipse 70% 40% at 92% -8%,rgba(254,44,85,.14),transparent),
    radial-gradient(ellipse 50% 30% at 4% 104%,rgba(37,244,238,.07),transparent);
  background-repeat:no-repeat;
}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--bg3);border-radius:999px;border:2px solid var(--bg0)}
::-webkit-scrollbar-track{background:transparent}

/* ---- 通用按钮 ---- */
.btn,.actions button,form button,.tools button,.pages button{
  font:inherit;font-weight:600;cursor:pointer;
  border:0;border-radius:var(--r-sm);padding:11px 20px;
  transition:transform .12s ease,filter .12s ease,background .12s ease;
  -webkit-tap-highlight-color:transparent;
}
.btn-primary,form button[type=submit],#submit{
  background:linear-gradient(135deg,var(--magenta),var(--magenta-deep));
  color:#fff;box-shadow:0 6px 18px rgba(254,44,85,.28);
}
.btn-primary:hover,form button[type=submit]:hover,#submit:hover{filter:brightness(1.08)}
.btn-primary:active,form button[type=submit]:active,#submit:active{transform:translateY(1px)}
.btn-ghost,.actions button:not(.danger),.tools button:not(.danger),.pages button,.scan-actions button:not(.primary),#loadSessions,#clearTargets,#pickerPrev,#pickerNext,#scanLogin,#scanRefresh,#mfaSubmit,#refresh,#prev,#next,#deleteNo{
  background:rgba(255,255,255,.06);color:var(--t2);
  border:1px solid var(--line-strong);backdrop-filter:blur(2px);
}
.btn-ghost:hover,.actions button:not(.danger):hover,.tools button:not(.danger):hover,.pages button:hover,.scan-actions button:not(.primary):hover{background:rgba(255,255,255,.10);color:#fff;border-color:rgba(37,244,238,.35)}
.btn-danger,.danger{background:linear-gradient(135deg,#FF4D4F,#C42B2D);color:#fff}
.btn-danger:hover,.danger:hover{filter:brightness(1.08)}
button:disabled{opacity:.45;cursor:not-allowed}
button:disabled:hover{background:rgba(255,255,255,.06);color:var(--t2);border-color:var(--line-strong);filter:none}

/* ---- 输入框 ---- */
input[type=text],input[type=email],input[type=search],input:not([type]),textarea,#filter{
  width:100%;box-sizing:border-box;
  background:var(--sunken);border:1px solid var(--line-strong);border-radius:var(--r-sm);
  padding:11px 14px;color:var(--t1);font:inherit;
  transition:border-color .15s ease,box-shadow .15s ease;
}
input::placeholder,textarea::placeholder{color:var(--t4)}
input:focus,textarea:focus{
  outline:none;border-color:rgba(37,244,238,.6);
  box-shadow:0 0 0 3px rgba(37,244,238,.14);
}
textarea{min-height:88px;resize:vertical;line-height:1.6}
input[type=checkbox]{width:18px;height:18px;accent-color:var(--magenta);flex:none}
input[type=file]{color:var(--t2);font-size:13px}
input[type=file]::file-selector-button{
  background:rgba(37,244,238,.10);color:var(--cyan);border:1px solid rgba(37,244,238,.35);
  border-radius:var(--r-sm);padding:7px 14px;margin-right:12px;cursor:pointer;font:inherit;
}
.hint{color:var(--t3);font-size:12.5px;font-weight:400;line-height:1.6}
[hidden]{display:none!important}
a{color:var(--cyan-light)}
`

/** 品牌 Logo（错位双描边音符，原创内联 SVG，无外部素材） */
export const BRAND_LOGO = `<div class="logo">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <g fill="none" stroke="#25F4EE" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" transform="translate(-0.7,-0.7)">
            <path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/>
          </g>
          <g fill="none" stroke="#FE2C55" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" transform="translate(0.7,0.7)">
            <path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/>
          </g>
          <g fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/>
          </g>
        </svg>
      </div>`

/** 页头：Logo + 标题 + 说明 + 右侧徽标 */
export function heroHtml({ title, subTitle, badge = '' }) {
  return `<header class="hero">
    <div class="hero-inner">
      ${BRAND_LOGO}
      <div class="hero-text">
        <h1>${title}</h1>
        <div class="hero-sub">${subTitle}</div>
      </div>
      ${badge ? `<div class="hero-badge">${badge}</div>` : ''}
    </div>
  </header>`
}

const HERO_CSS = `
/* ---- 页头 ---- */
.hero{
  padding:26px 30px 24px;
  background:linear-gradient(135deg,rgba(254,44,85,.22),rgba(37,244,238,.10));
  border-bottom:1px solid rgba(254,44,85,.28);
  position:relative;overflow:hidden;
}
.hero::after{
  content:'';position:absolute;right:-70px;top:-80px;width:220px;height:220px;border-radius:50%;
  background:radial-gradient(circle,rgba(254,44,85,.28),transparent 70%);pointer-events:none;
}
.hero-inner{display:flex;align-items:center;gap:16px;position:relative}
.logo{width:46px;height:46px;flex:none}
.logo svg{width:100%;height:100%;display:block}
.hero-text{flex:1;min-width:0}
.hero h1{font-size:23px;font-weight:700;letter-spacing:.5px;line-height:1.3}
.hero-sub{
  font-size:12px;letter-spacing:1.6px;text-transform:uppercase;
  color:var(--t3);margin-top:3px;font-family:"DIN Alternate",Consolas,monospace;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.hero-badge{
  flex:none;font-size:12px;font-weight:600;color:var(--magenta);
  background:rgba(254,44,85,.14);border:1px solid rgba(254,44,85,.4);
  padding:5px 14px;border-radius:999px;white-space:nowrap;
}
`

/** 账号配置页专用样式（表单、扫码、会话选择器） */
export const SETUP_CSS = BASE_CSS + HERO_CSS + `
body{padding:26px 14px 44px}
main{
  width:min(680px,100%);margin:0 auto;
  background:var(--bg1);border:1px solid var(--line);
  border-radius:var(--r-lg);overflow:hidden;
  box-shadow:0 24px 60px rgba(0,0,0,.45);
}
form{padding:26px;display:grid;gap:20px}
label{display:grid;gap:8px;font-size:13.5px;font-weight:600;color:var(--t2);letter-spacing:.3px}
#status{margin:0;min-height:20px;color:var(--err);font-size:13.5px}
#status.ok{color:var(--ok)}
form button[type=submit]{justify-self:start;padding:12px 30px;font-size:15px}
.check{display:flex;align-items:center;gap:10px;font-weight:400;color:var(--t2);font-size:14px}

/* 面板：扫码 / 会话选择 */
.scan,.picker{
  display:grid;gap:10px;padding:16px;
  background:var(--sunken);border:1px solid var(--line);border-radius:var(--r-md);
}
.scan-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.scan-actions button{padding:9px 16px;font-size:13.5px}
.qr{
  display:none;width:min(320px,100%);max-height:340px;object-fit:contain;
  border-radius:var(--r-md);background:#fff;padding:10px;margin:2px auto 0;
  box-shadow:0 0 0 1px rgba(255,255,255,.18);
}
.sms{display:none;gap:8px;grid-template-columns:minmax(0,1fr) auto}
.verify{display:none;color:var(--cyan-light);font-size:13.5px}
.cookie{min-height:160px;font-family:Consolas,"SFMono-Regular",monospace;font-size:12.5px;line-height:1.7}

/* 会话选择器 */
.picker-list{display:grid;gap:6px;max-height:260px;overflow-y:auto;padding-right:2px}
.picker-item{
  display:flex;align-items:center;gap:10px;
  font-weight:400;font-size:14px;padding:8px 10px;border-radius:var(--r-sm);
  background:rgba(255,255,255,.03);border:1px solid transparent;transition:background .12s ease;
}
.picker-item:hover{background:rgba(255,255,255,.07)}
.picker-item input{flex:none}
.picker-item .tag{
  flex:none;font-size:11px;padding:2px 8px;border-radius:999px;
  background:rgba(255,255,255,.10);color:var(--t2);border:1px solid var(--line-strong);
}
.picker-item .tag.group{background:rgba(46,219,129,.12);color:var(--ok);border-color:rgba(46,219,129,.35)}
.picker-item .tag.nohist{background:rgba(255,197,61,.12);color:var(--warn);border-color:rgba(255,197,61,.35)}
.picker-empty{color:var(--t3);font-size:13px}
#pickerPageInfo{font-size:12.5px}

@media(max-width:600px){
  body{padding:12px 10px 30px}
  .hero{padding:20px 20px 18px}
  .logo{width:38px;height:38px}
  .hero h1{font-size:19px}
  form{padding:18px;gap:16px}
  form button[type=submit]{width:100%;justify-self:stretch}
  .scan-actions button{flex:1}
}
`

/** 主人管理台专用样式（统计条 + 深色表格） */
export const ADMIN_CSS = BASE_CSS + HERO_CSS + `
body{padding:26px 14px 44px}
main{
  max-width:1100px;margin:0 auto;
  background:var(--bg1);border:1px solid var(--line);
  border-radius:var(--r-lg);overflow:hidden;
  box-shadow:0 24px 60px rgba(0,0,0,.45);
}
.tools,.pages,.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tools{padding:18px 24px 0}
.tools input{flex:1;min-width:0}
.tools button,.pages button,.actions button{padding:9px 16px;font-size:13.5px}
#status{min-height:20px;margin:12px 24px 0;color:var(--t3);font-size:13px}

/* 统计条 */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);margin:18px 24px 0;border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden}
.stat-cell{background:var(--bg2);padding:14px 10px;text-align:center}
.stat-cell .num{font-family:"DIN Alternate",Consolas,monospace;font-size:24px;font-weight:700;line-height:1.2}
.stat-cell .num.c1{color:var(--magenta)}
.stat-cell .num.c2{color:var(--cyan)}
.stat-cell .num.c3{color:var(--warn)}
.stat-cell .lab{font-size:12px;color:var(--t3);margin-top:4px}

/* 表格 */
.table{overflow-x:auto;margin:18px 0 0;padding:0 24px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:12px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
th{
  font-size:12px;font-weight:600;letter-spacing:.6px;color:var(--t3);
  text-transform:uppercase;white-space:nowrap;border-bottom:1px solid var(--line-strong);
}
tbody tr{transition:background .12s ease}
tbody tr:hover{background:rgba(255,255,255,.04)}
td{font-size:14px;color:var(--t2)}
td.name{overflow-wrap:anywhere;color:var(--t1);font-weight:600}
.pages{padding:16px 24px 22px}
#pageInfo{font-size:13px;color:var(--t3)}
#confirmDelete{
  margin:0 24px 24px;padding:16px 18px;
  background:rgba(255,77,79,.07);border:1px solid rgba(255,77,79,.3);border-radius:var(--r-md);
}
#confirmDelete p{color:var(--t2);font-size:14px}#confirmDelete p+p{margin-top:8px}

@media(max-width:640px){
  body{padding:12px 10px 30px}
  .hero{padding:20px 18px 18px}
  .logo{width:38px;height:38px}
  .hero h1{font-size:19px}
  .tools{flex-wrap:wrap}
  .tools input{flex-basis:100%}
  .tools button{flex:1}
  .pages,.table,#confirmDelete,#status{padding-left:16px;padding-right:16px}
  .stats{margin-left:16px;margin-right:16px}
  .stat-cell .num{font-size:21px}
  /* 表格转卡片：列头隐藏，用伪元素补标签 */
  .table{overflow:visible}
  table,thead,tbody,tr,td{display:block;width:100%}
  thead{display:none}
  tbody tr{
    background:var(--bg2);border:1px solid var(--line);border-radius:var(--r-md);
    padding:12px 14px;margin-bottom:10px;
  }
  tbody tr:hover{background:var(--bg2)}
  td{padding:5px 0;border:0;display:flex;gap:10px;align-items:center}
  td::before{
    flex:none;width:74px;font-size:12px;color:var(--t4);letter-spacing:.5px;
  }
  td:nth-of-type(1)::before{content:'用户 ID'}
  td:nth-of-type(2)::before{content:'账号名'}
  td:nth-of-type(3)::before{content:'抖音 UID'}
  td:nth-of-type(4)::before{content:'目标数'}
  td:nth-of-type(5)::before{content:'Cookie'}
  td:nth-of-type(6)::before{content:'操作'}
  td.name{font-weight:600}
  .actions{width:100%}
  .actions button{flex:1}
}
`

/** 提示页（链接过期 / 404 / 403）样式 */
export const MESSAGE_CSS = BASE_CSS + `
body{display:flex;align-items:center;justify-content:center;padding:24px}
.msg-card{
  width:min(440px,100%);text-align:center;
  background:var(--bg1);border:1px solid var(--line);border-radius:var(--r-lg);
  padding:40px 32px;box-shadow:0 24px 60px rgba(0,0,0,.45);
}
.msg-card .logo{width:56px;height:56px;margin:0 auto 18px;opacity:.9}
.msg-card .logo svg{width:100%;height:100%;display:block}
.msg-card h1{font-size:19px;font-weight:600;color:var(--t1);line-height:1.6}
.msg-card p{margin-top:12px;font-size:14px;color:var(--t3);line-height:1.7}
.msg-card .chip{
  display:inline-block;margin-top:20px;font-size:13px;color:var(--cyan);
  background:rgba(37,244,238,.08);border:1px solid rgba(37,244,238,.3);
  padding:7px 16px;border-radius:999px;
}
`
