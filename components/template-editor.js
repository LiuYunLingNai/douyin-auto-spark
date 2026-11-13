import { TEMPLATE_FIELDS, parseMessageTemplate, validateImageSource, validateEmojiValue, parseEmojiPayload, emojiTemplate } from './message-template.js'
import { SETUP_CSS, heroHtml } from './web-theme.js'

export const TEMPLATE_EDITOR_CSS = `
.template-editor{border-block:1px solid var(--rule-soft);padding-block:var(--sp-4);margin-block:var(--sp-4)}
.template-tools{display:flex;flex-wrap:wrap;gap:var(--sp-2);margin-block:var(--sp-2)}
.template-tools button{padding:var(--sp-2) var(--sp-3)}
.template-preview{padding:var(--sp-4);background:var(--paper-2);margin-top:var(--sp-4);overflow-wrap:anywhere}
.template-preview p{white-space:pre-wrap;max-width:35em;margin-block:var(--sp-2)}
.template-preview img{display:block;max-width:100%;max-height:240px;object-fit:contain;margin-block:var(--sp-2)}
.template-preview .hint{display:block}.template-editor details{margin-block:var(--sp-3)}
.template-editor summary{cursor:pointer;font-weight:600}.template-editor label{display:block;margin-top:var(--sp-2);padding-left:0}
.template-editor input[type=url]{display:block;width:100%;font:inherit;font-size:16px;background:var(--paper);color:var(--ink);border:1px solid var(--ink);border-radius:0;padding:var(--sp-3);min-height:46px}
.template-editor input[type=file]{display:block;max-width:100%;margin-top:var(--sp-2)}
.template-emoji-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:var(--sp-2);max-height:360px;overflow:auto;margin-block:var(--sp-3)}
.template-emoji-grid button{min-width:0;padding:var(--sp-2);font-size:13px;overflow-wrap:anywhere}
.template-emoji-grid img{display:block;width:64px;height:64px;object-fit:contain;margin:0 auto var(--sp-2)}
.template-editor select{max-width:100%;font:inherit;padding:var(--sp-2)}
.template-emoji-preview img{width:96px;height:96px;object-fit:contain}
`

export function templateEditorHtml() {
  return `<section class="template-editor" aria-label="消息模板编辑器">
    <label for="messageTemplate">消息模板</label>
    <div class="template-tools" id="templateTokens">${Object.entries(TEMPLATE_FIELDS).map(([key, label]) => `<button type="button" data-token="${key}">${label}</button>`).join('')}<button type="button" id="templateNewline">换行</button></div>
    <textarea id="messageTemplate" rows="5" placeholder="留空使用默认模板；点击上方按钮插入会话名称、随机一言等内容"></textarea>
    <details><summary>添加图片</summary>
      <label for="templateImageUrl">图片链接<input id="templateImageUrl" type="url" placeholder="https://example.com/image.png"></label>
      <div class="template-tools"><button id="templateAddImage" type="button">插入图链</button></div>
      <label for="templateImageFile">本地图片<input id="templateImageFile" type="file" accept="image/png,image/jpeg,image/gif,image/webp"></label>
      <span class="hint">支持 PNG、JPEG、GIF、WebP，每张最多 5 MB。图片会上传到机器人并保存，续火时作为图片发送。</span>
    </details>
    <details id="templateEmojiPanel"><summary>添加抖音表情</summary>
      <label id="templateEmojiAccountLabel" hidden>读取表情的账号<select id="templateEmojiAccount"><option value="">请选择账号</option></select></label>
      <div class="template-tools"><button type="button" id="templateLoadEmojis">读取小表情</button></div>
      <label>搜索小表情<input id="templateEmojiSearch" type="search" placeholder="按名称搜索"></label>
      <span class="hint" id="templateEmojiStatus" role="status">读取后点击图片添加小表情。</span>
      <div id="templateEmojiList" class="template-emoji-grid"></div>
    </details>
    <span class="hint">文字、图片与表情按位置分别发送。直接换行即可；也兼容原有的 \\n 写法。</span>
    <div class="template-preview" id="templatePreview" aria-label="发送内容预览"></div>
    <span id="templateEditorStatus" class="hint" role="status"></span>
  </section>`
}

/** 浏览器与服务端共用解析器；预览只使用文本节点。 */
export function templateEditorScript(token, prefix, defaultTemplate = '', defaultEditor = false) {
  const boot = JSON.stringify({ token, prefix, defaultTemplate, defaultEditor }).replace(/</g, '\\u003c')
  return String.raw`(() => {
    const boot = ${boot};
    const TEMPLATE_FIELDS = ${JSON.stringify(TEMPLATE_FIELDS)};
    const validateImageSource = ${validateImageSource.toString()};
    const validateEmojiValue = ${validateEmojiValue.toString()};
    const parseEmojiPayload = ${parseEmojiPayload.toString()};
    const emojiTemplate = ${emojiTemplate.toString()};
    const parseMessageTemplate = ${parseMessageTemplate.toString()};
    const input = document.getElementById('messageTemplate');
    const preview = document.getElementById('templatePreview');
    const notice = document.getElementById('templateEditorStatus');
    const localPreviews = new Map();
    let uploading = false;
    const imageUrl = source => source.startsWith('local:')
      ? localPreviews.get(source) || boot.prefix + '/api/template/image/' + boot.token + '/' + source.slice(6)
      : source;
    function refresh() {
      preview.replaceChildren();
      const caption = document.createElement('span'); caption.className = 'hint';
      caption.textContent = input.value.trim() ? '发送预览 · 示例名称和一言' : '留空：使用默认模板；默认也为空时发送随机一言';
      preview.append(caption);
      try {
        const now = new Date();
        const values = { account: document.getElementById('name')?.value || '我的账号', friend: '好友小明', yiyan: '愿你今天也有好心情。', from: '示例一言', date: now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), time: now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }), weekday: now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }) };
        const parts = parseMessageTemplate(input.value.trim() || boot.defaultTemplate || '{{yiyan}}');
        for (const part of parts) {
          if (part.type === 'image') {
            const img = document.createElement('img'); img.src = imageUrl(part.source); img.alt = '模板图片'; img.referrerPolicy = 'no-referrer';
            img.onerror = () => { img.replaceWith(document.createTextNode('图片无法预览，请检查图链或重新上传本地图片')); }; preview.append(img);
          } else if (part.type === 'emoji') {
            const figure = document.createElement('div'); figure.className = 'template-emoji-preview';
            const img = document.createElement('img'); img.src = part.preview; img.alt = part.name; img.referrerPolicy = 'no-referrer';
            img.onerror = () => img.replaceWith(document.createTextNode('表情图片不可用，请重新读取并选择'));
            const name = document.createElement('span'); name.className = 'hint'; name.textContent = part.name;
            figure.append(img, name); preview.append(figure);
          } else if (part.text.trim()) {
            const text = document.createElement('p'); text.textContent = part.text.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, name) => values[name] || ''); preview.append(text);
          }
        }
        notice.textContent = '';
      } catch (error) { notice.textContent = error.message; }
    }
    function insert(text) {
      input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end'); input.focus(); refresh();
    }
    document.getElementById('templateTokens').addEventListener('click', event => {
      const key = event.target.dataset.token; if (key) insert('{{' + key + '}}');
    });
    document.getElementById('templateNewline').onclick = () => insert('\n');
    document.getElementById('templateAddImage').onclick = () => {
      try { insert('{{image:' + validateImageSource(document.getElementById('templateImageUrl').value.trim()) + '}}'); }
      catch (error) { notice.textContent = error.message; }
    };
    const fileInput = document.getElementById('templateImageFile');
    fileInput.onchange = async () => {
      const file = fileInput.files[0]; if (!file) return;
      if (!file.size || file.size > 5 * 1024 * 1024) { notice.textContent = '图片不能超过 5 MB'; return; }
      const start = input.selectionStart, end = input.selectionEnd, before = input.value;
      uploading = true; fileInput.disabled = true; notice.textContent = '正在上传图片…';
      try {
        const response = await fetch(boot.prefix + '/api/template/upload/' + boot.token, { method: 'POST', headers: { 'Content-Type': 'application/x-douyin-template-image' }, body: file });
        const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.message || '图片上传失败');
        if (input.value === before) input.setSelectionRange(start, end);
        localPreviews.set(data.source, URL.createObjectURL(file)); insert('{{image:' + data.source + '}}');
      } catch (error) { notice.textContent = error.message; }
      finally { uploading = false; fileInput.disabled = false; fileInput.value = ''; }
    };
    const emojiStatus = document.getElementById('templateEmojiStatus'), emojiList = document.getElementById('templateEmojiList');
    const emojiAccount = document.getElementById('templateEmojiAccount');
    const emojiSearch = document.getElementById('templateEmojiSearch'), emojiLoad = document.getElementById('templateLoadEmojis');
    let emojiPage, emojiLoading = false, accountLoaded = false;
    function drawEmojis() {
      emojiList.replaceChildren(); const search = emojiSearch.value.trim().toLowerCase();
      for (const item of emojiPage?.items || []) {
        if (search && !item.name.toLowerCase().includes(search)) continue;
        const button = document.createElement('button'); button.type = 'button'; button.title = item.name;
        const img = document.createElement('img'); img.src = item.url; img.alt = item.name; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        img.onerror = () => { button.disabled = true; img.replaceWith(document.createTextNode('图片不可用')); };
        const name = document.createElement('span'); name.textContent = item.name; button.append(img, name);
        button.onclick = () => { try { insert(emojiTemplate(item)); } catch (error) { notice.textContent = error.message; } }; emojiList.append(button);
      }
    }
    async function loadEmojis() {
      if (emojiLoading) return; emojiLoading = true; emojiLoad.disabled = true; emojiAccount.disabled = true; drawEmojis(); emojiStatus.textContent = '正在读取小表情…';
      try {
        const body = { kind: 'small', accountId: emojiAccount.value, name: document.getElementById('name')?.value, cookies: document.getElementById('cookieText')?.value || '' };
        const response = await fetch(boot.prefix + '/api/template/emojis/' + boot.token, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.message || '表情读取失败');
        emojiPage = data;
        emojiStatus.textContent = (data.items.length ? '点击图片插入小表情（共 ' + data.items.length + ' 个）' : '没有可用小表情') + (data.skipped ? '；' + data.skipped + ' 个表情缺少图片资源，已跳过' : '');
      } catch (error) { emojiStatus.textContent = error.message; }
      finally { emojiLoading = false; emojiLoad.disabled = false; emojiAccount.disabled = false; drawEmojis(); }
    }
    document.getElementById('templateEmojiPanel').addEventListener('toggle', async event => {
      if (!boot.defaultEditor || !event.target.open || accountLoaded) return;
      accountLoaded = true; document.getElementById('templateEmojiAccountLabel').hidden = false;
      try { const data = await (await fetch(boot.prefix + '/api/template/accounts/' + boot.token)).json(); if (!data.ok) throw new Error(data.message);
        for (const account of data.accounts) { const option = document.createElement('option'); option.value = account.id; option.textContent = account.name + '（' + account.id + '）'; emojiAccount.append(option); }
        if (data.accounts.length) emojiAccount.value = data.accounts[0].id; else emojiStatus.textContent = '请先添加一个抖音账号，再读取表情';
      } catch (error) { accountLoaded = false; emojiStatus.textContent = error.message; }
    });
    emojiLoad.onclick = () => loadEmojis();
    emojiSearch.oninput = drawEmojis;
    emojiAccount.onchange = () => { emojiPage = undefined; emojiSearch.value = ''; drawEmojis(); emojiStatus.textContent = '点击“读取小表情”加载所选账号'; };
    input.addEventListener('input', refresh); document.getElementById('name')?.addEventListener('input', refresh);
    window.addEventListener('pagehide', () => { for (const url of localPreviews.values()) URL.revokeObjectURL(url); });
    input.form.addEventListener('submit', event => { if (uploading) { event.preventDefault(); event.stopImmediatePropagation(); notice.textContent = '请等待图片上传完成再保存'; } }, true);
    refresh();
  })();`
}

export function renderDefaultTemplatePage(token, prefix, template) {
  const initial = JSON.stringify(template).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>默认消息模板</title><style>${SETUP_CSS}${TEMPLATE_EDITOR_CSS}</style></head><body><main>
    ${heroHtml({ title: '默认消息模板', subTitle: 'Template Editor', badge: '仅主人可编辑' })}
    <form id="template-form">${templateEditorHtml()}<p class="hint">保存后，未设置账号专属模板的账号会使用这份内容。</p><p id="status" role="status"></p><button type="submit">保存默认模板</button></form>
    </main><script>document.getElementById('messageTemplate').value = ${initial};${templateEditorScript(token, prefix, '', true)}
    document.getElementById('template-form').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.target, button = form.querySelector('button[type=submit]'), status = document.getElementById('status'); button.disabled = true;
      try { const response = await fetch(${JSON.stringify(prefix + '/api/template/save/' + token)}, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ template: document.getElementById('messageTemplate').value }) }); const data = await response.json(); if (!data.ok) throw new Error(data.message); status.textContent = data.message; form.querySelectorAll('input,textarea,button').forEach(item => item.disabled = true); }
      catch (error) { status.textContent = error.message || '保存失败'; button.disabled = false; }
    });</script></body></html>`
}
