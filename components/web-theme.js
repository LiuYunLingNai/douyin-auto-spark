/**
 * 网页视觉层 v3 —— 纸质工单 / 印刷排版
 * 设计上下文见 D:/Yunzai/.impeccable.md
 *
 * 与消息卡（resources/render/common.css）共用同一套 token 与母题：
 *   · 纸底 + 墨字 + 朱红印章色；顶部实心墨条作报头
 *   · 分组靠 1px 分割线 + 方框编号组织，不用卡片堆叠
 *   · 直角、无渐变、无发光、无圆角胶囊
 *
 * 只提供 CSS 字符串与页头 HTML，不改任何业务逻辑；
 * 各页面原有的元素 id / class 选择器保持不变，因此 JS 无需改动。
 */

/** 纸墨调色 + 基础重置，三个页面共用 */
const BASE_CSS = `
:root{
  --paper:#F4F1EA;--paper-2:#EAE5DA;--paper-3:#E0DACE;
  --ink:#211D19;--ink-2:#4C463E;--ink-3:#7B7367;
  --rule:#211D19;--rule-soft:#D3CCBE;
  --accent:#C2402A;--accent-deep:#96291A;--accent-wash:#F0DCD5;
  --ok:#2F6B4F;--ok-wash:#DCE7DF;
  --warn:#8A6420;--warn-wash:#EFE4CE;
  --err:#A32B1C;--err-wash:#F1DAD6;
  --sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-6:24px;--sp-8:32px;--sp-12:48px;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","HarmonyOS Sans SC","MiSans","Microsoft YaHei",sans-serif;
  --serif:"Songti SC","Source Han Serif SC","Noto Serif CJK SC",SimSun,"宋体",serif;
  --num:Bahnschrift,"DIN Alternate",Consolas,monospace;
  color-scheme:light;
}
*{margin:0;padding:0;box-sizing:border-box}
::selection{background:var(--accent);color:var(--paper)}
html{min-height:100%}
body{
  min-height:100vh;background:var(--paper);color:var(--ink);
  font:16px/1.7 var(--sans);
  -webkit-font-smoothing:antialiased;font-kerning:normal;
  padding:0 0 var(--sp-12);
}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--paper-3);border:2px solid var(--paper)}
::-webkit-scrollbar-track{background:transparent}

/* ---- 按钮：直角、≥46px 触控高度 ---- */
.btn,button{
  min-height:46px;font:inherit;font-size:15px;font-weight:600;cursor:pointer;
  border:1px solid var(--ink);background:transparent;color:var(--ink);
  padding:12px 22px;letter-spacing:.01em;
  transition:background .14s ease,color .14s ease,border-color .14s ease;
  -webkit-tap-highlight-color:transparent;
}
button[type=submit],#submit,.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--paper)}
button[type=submit]:hover,#submit:hover,.btn-primary:hover{background:var(--accent-deep);border-color:var(--accent-deep)}
.btn:hover,button:hover{background:var(--ink);color:var(--paper)}
button[type=submit]:hover,#submit:hover,.btn-primary:hover{color:var(--paper)}
/* 危险操作只红在文字上：每行一个红边框会形成视觉噪音 */
.danger,.btn-danger{border-color:var(--ink);color:var(--err)}
.danger:hover,.btn-danger:hover{background:var(--err);color:var(--paper);border-color:var(--err)}
button:disabled{opacity:.4;cursor:not-allowed}
button:disabled:hover{background:transparent;color:var(--ink)}
button[type=submit]:disabled:hover{background:var(--accent);color:var(--paper)}

/* ---- 输入：16px 起（防移动端缩放）、聚焦朱红 ---- */
input[type=text],input[type=email],input[type=search],input:not([type]),textarea,#filter{
  width:100%;font:inherit;font-size:16px;color:var(--ink);
  background:var(--paper);border:1px solid var(--ink);border-radius:0;
  padding:12px 14px;min-height:46px;
  transition:box-shadow .14s ease;
}
input::placeholder,textarea::placeholder{color:var(--ink-3)}
input:focus,textarea:focus{
  outline:none;box-shadow:inset 4px 0 0 var(--accent),inset 0 0 0 1px var(--accent);
}
textarea{min-height:96px;resize:vertical;line-height:1.7}
input[type=checkbox]{width:20px;height:20px;flex:none;accent-color:var(--accent)}
input[type=file]{color:var(--ink-2);font-size:14px}
input[type=file]::file-selector-button{
  background:transparent;color:var(--ink);border:1px solid var(--ink);
  padding:9px 16px;margin-right:12px;cursor:pointer;font:inherit;font-size:14px;
}
.hint{color:var(--ink-3);font-size:13px;font-weight:400;line-height:1.65}
[hidden]{display:none!important}
a{color:var(--accent);text-underline-offset:3px}
`

/**
 * 报头标记：印刷裁切标记 + 朱红套准块（原创几何绘制，非图标、非官方素材）
 */
export const BRAND_LOGO = `<span class="logo" aria-hidden="true">
  <svg viewBox="0 0 32 32">
    <g fill="none" stroke="#211D19" stroke-width="1.6">
      <path d="M6 1v6M1 6h6M26 1v6M31 6h-6M6 31v-6M1 26h6M26 31v-6M31 26h-6"/>
    </g>
    <rect x="12" y="12" width="8" height="8" fill="#C2402A"/>
  </svg>
</span>`

/**
 * 页头：实心墨条报头 + 英文小标 + 大标题
 * @param {{title:string, subTitle?:string, badge?:string}} opt
 */
export function heroHtml({ title, subTitle = '', badge = '' }) {
  return `<header class="hero">
    <div class="masthead">
      <span class="mk">Douyin Auto Spark</span>
      ${badge ? `<span class="rg">${badge}</span>` : ''}
    </div>
    <div class="hero-body">
      ${subTitle ? `<div class="hero-eyebrow">${subTitle}</div>` : ''}
      <h1 class="hero-title">${title}</h1>
    </div>
  </header>`
}

const HERO_CSS = `
.hero{margin:0 0 var(--sp-8)}
.masthead{
  display:flex;align-items:baseline;justify-content:space-between;gap:var(--sp-4);
  background:var(--ink);color:var(--paper);
  padding:10px var(--sp-8);
  font-family:var(--num);font-size:12px;letter-spacing:.3em;text-transform:uppercase;
}
.masthead .rg{letter-spacing:.16em;opacity:.72;text-transform:none}
.hero-body{padding:var(--sp-8) var(--sp-8) 0;position:relative}
.logo{display:none}
.hero-eyebrow{
  font-family:var(--num);font-size:12px;font-weight:700;
  letter-spacing:.32em;text-transform:uppercase;color:var(--accent);
}
.hero-title{
  font-family:var(--serif);font-size:36px;font-weight:700;line-height:1.15;
  margin-top:var(--sp-2);letter-spacing:-.01em;
}
`

/** 账号配置页（添加 / 修改） */
export const SETUP_CSS = BASE_CSS + HERO_CSS + `
main{width:min(720px,100%);margin:0 auto}
form{padding:0 var(--sp-8) var(--sp-8);display:grid;gap:var(--sp-8);counter-reset:sec}
/* 区块：靠上分割线 + 方框编号分组，不做卡片套卡片 */
form > label,form > .scan,form > .picker{
  position:relative;padding-top:var(--sp-6);border-top:1px solid var(--rule-soft);
}
form > label:first-child{padding-top:0;border-top:0}
form > label::before{
  counter-increment:sec;content:counter(sec,decimal-leading-zero);
  position:absolute;left:0;top:var(--sp-6);
  width:26px;height:26px;border:1px solid var(--ink);color:var(--accent);
  font-family:var(--num);font-size:13px;font-weight:700;
  display:flex;align-items:center;justify-content:center;
}
form > label:first-child::before{top:2px}
label{display:grid;gap:var(--sp-2);padding-left:40px;font-size:14px;font-weight:700;color:var(--ink)}
label .hint{font-weight:400}
.check{display:flex;align-items:center;gap:var(--sp-3);font-weight:400;font-size:15px;color:var(--ink-2);min-height:46px;padding-left:0}
label.check{padding-left:0}
.check input{width:20px;height:20px}
#status{margin:0;min-height:22px;padding-left:40px;color:var(--err);font-size:14px;line-height:1.6}
#status.ok{color:var(--ok)}
form button[type=submit]{justify-self:start;padding:13px 34px;font-size:16px;margin-left:40px}

/* 扫码 / 会话选择面板：左侧墨色标记线，不是卡片 */
.scan,.picker{
  display:grid;gap:var(--sp-3);padding:var(--sp-6) 0 var(--sp-2) var(--sp-4);
  border-left:3px solid var(--ink);
}
.scan-actions{display:flex;flex-wrap:wrap;gap:var(--sp-2);align-items:center}
.scan-actions button{font-size:14px;padding:11px 18px}
.qr{
  display:none;width:min(300px,100%);max-height:320px;object-fit:contain;
  background:var(--paper);padding:12px;border:1px solid var(--ink);margin:var(--sp-2) 0;
}
.sms{display:none;gap:var(--sp-2);grid-template-columns:minmax(0,1fr) auto}
.verify{display:none;color:var(--accent);font-size:14px}
.cookie{min-height:170px;font-family:var(--num);font-size:14px;line-height:1.8}

/* 会话选择器：扁平列表 + 行分割线 */
.picker-list{display:grid;gap:0;max-height:270px;overflow-y:auto}
.picker-item{
  display:flex;align-items:center;gap:var(--sp-3);
  font-size:15px;color:var(--ink);
  padding:11px var(--sp-2);border-bottom:1px solid var(--rule-soft);
  cursor:pointer;transition:background .12s ease;
}
.picker-item:hover{background:var(--paper-2)}
.picker-item:last-child{border-bottom:0}
.picker-item .tag{
  font-size:11px;letter-spacing:.02em;padding:2px 8px;
  border:1px solid var(--rule-soft);color:var(--ink-2);white-space:nowrap;
}
.picker-item .tag.group{border-color:var(--ok);color:var(--ok);background:var(--ok-wash)}
.picker-item .tag.nohist{border-color:var(--warn);color:var(--warn);background:var(--warn-wash)}
.picker-empty{color:var(--ink-3);font-size:14px}
#pickerPageInfo{font-size:13px;color:var(--ink-3)}

@media(max-width:720px){
  .masthead{padding:10px var(--sp-4);letter-spacing:.2em}
  .hero-body{padding:var(--sp-6) var(--sp-4) 0}
  .hero-title{font-size:28px}
  form{padding:0 var(--sp-4) var(--sp-6)}
  label{padding-left:0}
  form>label::before{display:none}
  #status{padding-left:0}
  form button[type=submit]{width:100%;justify-self:stretch;margin-left:0}
  .scan-actions button{flex:1}
}
`

/** 主人管理台 */
export const ADMIN_CSS = BASE_CSS + HERO_CSS + `
main{width:min(1120px,100%);margin:0 auto}
.tools,.pages,.actions{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap}
.tools{padding:0 var(--sp-8)}
.tools input{flex:1;min-width:0}
#status{min-height:20px;margin:var(--sp-3) var(--sp-8) 0;color:var(--ink-3);font-size:13px}

/* 概览：大数字 + 竖线分隔，不做卡片 */
.stats{
  display:grid;grid-template-columns:repeat(3,1fr);
  margin:var(--sp-8) var(--sp-8) 0;padding-bottom:var(--sp-4);
  border-top:2px solid var(--rule);
}
.stat-cell{padding:var(--sp-4) 0 0 var(--sp-6);border-left:1px solid var(--rule-soft)}
.stat-cell:first-child{padding-left:0;border-left:0}
.stat-cell .num{
  font-family:var(--num);font-size:40px;font-weight:700;line-height:1;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em;
}
/* 统计一律墨色；唯一彩色留给「缺少 Cookie」这类异常信息 */
.stat-cell .num.c1{color:var(--ink)}
.stat-cell .num.c2{color:var(--ink)}
.stat-cell .num.c3{color:var(--warn)}
.stat-cell .lab{font-size:12px;color:var(--ink-3);margin-top:var(--sp-2);letter-spacing:.04em}

/* 表格：无斑马线，靠行分割线 */
.table{overflow-x:auto;margin:var(--sp-6) 0 0;padding:0 var(--sp-8)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:13px 10px;border-bottom:1px solid var(--rule-soft);vertical-align:middle}
th{
  font-family:var(--num);font-size:11px;font-weight:700;letter-spacing:.16em;
  color:var(--ink-3);text-transform:uppercase;white-space:nowrap;
  border-bottom:2px solid var(--rule);padding-top:0;
}
tbody tr{transition:background .12s ease}
tbody tr:hover{background:var(--paper-2)}
td{font-size:14.5px;color:var(--ink-2)}
td.name{color:var(--ink);font-weight:700;overflow-wrap:anywhere}
.pages{padding:var(--sp-6) var(--sp-8) var(--sp-8)}
#pageInfo{font-size:13px;color:var(--ink-3)}
#confirmDelete{
  margin:0 var(--sp-8) var(--sp-8);padding:var(--sp-4) var(--sp-6) var(--sp-4) var(--sp-4);
  border-left:3px solid var(--err);background:var(--err-wash);
}
#confirmDelete p{color:var(--ink);font-size:14px;line-height:1.7}
#confirmDelete .actions{margin-top:var(--sp-4)}

@media(max-width:700px){
  .masthead{padding:10px var(--sp-4);letter-spacing:.2em}
  .hero-body{padding:var(--sp-6) var(--sp-4) 0}
  .hero-title{font-size:28px}
  .tools{padding:0 var(--sp-4)}
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
    border-bottom:1px solid var(--rule-soft);padding:var(--sp-4) 0;
    display:flex;flex-direction:column;gap:var(--sp-1);
  }
  tbody tr:hover{background:transparent}
  td{padding:2px 0;border:0;display:flex;gap:var(--sp-3);align-items:center;font-size:14px}
  td::before{flex:none;width:76px;font-size:12px;color:var(--ink-3)}
  td:nth-of-type(1)::before{content:'用户 ID'}
  td:nth-of-type(2)::before{content:'账号名'}
  td:nth-of-type(3)::before{content:'抖音 UID'}
  td:nth-of-type(4)::before{content:'目标数'}
  td:nth-of-type(5)::before{content:'Cookie'}
  td:nth-of-type(6)::before{content:'操作'}
  td.name{font-weight:700;font-size:17px}
  td:nth-of-type(6){margin-top:var(--sp-3)}
  .actions{width:100%}
  .actions button{flex:1}
}
`

/** 提示页（链接过期 / 404 / 403） */
export const MESSAGE_CSS = BASE_CSS + HERO_CSS + `
body{display:flex;align-items:center;justify-content:center;padding:var(--sp-6)}
.msg-card{width:min(480px,100%)}
.msg-card .masthead{padding:10px var(--sp-6)}
.msg-card .hero-body{padding:var(--sp-8) var(--sp-6) 0}
.msg-card .hero-title{font-size:30px}
.msg-card p{
  margin:var(--sp-6) var(--sp-6) 0;padding-top:var(--sp-4);border-top:1px solid var(--rule-soft);
  font-size:15px;color:var(--ink-2);line-height:1.75;
}
.msg-card .chip{
  display:inline-block;margin:var(--sp-6) var(--sp-6) 0;
  font-family:var(--num);font-size:14px;
  color:var(--accent);border:1px solid var(--accent);background:var(--accent-wash);
  padding:8px 16px;
}
`
