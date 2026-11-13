/** 此文件由锅巴扩展路由加上 Vue 导入后发送，不在 Node 中执行。 */
export function registerTemplateEditor(vue, componentMap, tools) {
  const { defineComponent, h, ref, watch, onMounted, onBeforeUnmount, nextTick } = vue
  const original = componentMap.get('InputTextArea')
  if (original?.sparkTemplateWrapper) return
  const { parseMessageTemplate, TEMPLATE_FIELDS } = tools
  const css = `
  .spark-template{width:100%;color:inherit}.spark-template button{font:inherit;cursor:pointer;border:1px solid #d9d9d9;border-radius:4px;background:transparent;color:inherit;padding:6px 10px;min-height:36px}
  .spark-template button:focus-visible,.spark-template [contenteditable]:focus-visible{outline:2px solid #1890ff;outline-offset:2px}
  .spark-template button:disabled{opacity:.5;cursor:wait}.spark-template .st-tools{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
  .spark-template .st-block{border:1px solid #d9d9d9;border-radius:4px;padding:12px;margin-bottom:12px}
  .spark-template .st-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
  .spark-template .st-actions span{flex:1}.spark-template .st-text{white-space:pre-wrap;overflow-wrap:anywhere;min-height:64px;line-height:1.8;outline:none}
  .spark-template .st-token{display:inline-block;background:#e6f7ff;color:#0050b3;border:1px solid #91d5ff;border-radius:4px;padding:0 6px;margin:0 2px;user-select:all}
  .spark-template .st-image{max-width:100%;max-height:200px;display:block;object-fit:contain;margin:8px 0}
  .spark-template .st-url,.spark-template .st-source{box-sizing:border-box;width:100%;font:inherit;border:1px solid #d9d9d9;border-radius:4px;background:transparent;color:inherit;padding:8px}
  .spark-template .st-help{font-size:13px;line-height:1.7;opacity:.8;overflow-wrap:anywhere}.spark-template .st-error{color:#cf1322;overflow-wrap:anywhere}
  .spark-template .st-preview{border-top:1px solid #d9d9d9;padding-top:12px;margin-top:16px}.spark-template .st-preview p{white-space:pre-wrap;overflow-wrap:anywhere;max-width:35em}
  .spark-template details{margin:12px 0}.spark-template summary{cursor:pointer}.spark-template .st-preview-title{font-weight:600;margin-bottom:8px}
  .spark-template .st-emoji-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px;max-height:340px;overflow:auto;margin:12px 0}
  .spark-template .st-emoji-grid button{min-width:0;overflow-wrap:anywhere;font-size:13px;padding:8px}
  .spark-template .st-emoji-grid img{display:block;width:64px;height:64px;object-fit:contain;margin:0 auto 8px}
  .spark-template .st-emoji-image{display:block;width:96px;height:96px;object-fit:contain;margin:8px 0}
  .spark-template select{max-width:100%;font:inherit;padding:6px}.spark-template .st-emoji-panel input{min-width:0}
  [data-theme=dark] .spark-template .st-block,[data-theme=dark] .spark-template button,[data-theme=dark] .spark-template .st-url,[data-theme=dark] .spark-template .st-source{border-color:#595959}
  [data-theme=dark] .spark-template .st-token{background:#111d2c;color:#69c0ff;border-color:#177ddc}
  `
  const Editor = defineComponent({
    name: 'SparkVisualTemplate', inheritAttrs: false,
    props: { value: { type: String, default: '' }, disabled: Boolean }, emits: ['change'],
    setup(props, { emit }) {
      const blocks = ref([]), error = ref(''), busy = ref(false), imageUrl = ref(''), preview = ref([])
      const emojiOpen = ref(false), emojiLoading = ref(false), emojiAccounts = ref([]), emojiAccount = ref(''), emojiSearch = ref(''), emojiPage = ref(null), emojiStatus = ref('请选择账号，读取后点击图片添加小表情')
      let accountsLoaded = false
      const editors = new Map(), imageUrls = new Map(), editorRefs = new Map()
      let sequence = 0, ownValue = props.value, active, caret, alive = true, previewGeneration = 0
      const makeBlock = part => ({ ...part, key: ++sequence })
      function decode(value) {
        try { blocks.value = parseMessageTemplate(value).map(makeBlock); error.value = '' }
        catch (cause) { blocks.value = [makeBlock({ type: 'text', text: value })]; error.value = cause.message }
        if (!blocks.value.length) blocks.value.push(makeBlock({ type: 'text', text: '' }))
        active = blocks.value.find(block => block.type === 'text')?.key; caret = undefined
        refreshPreview()
      }
      function encode() { return blocks.value.map(block => block.type === 'image' ? '{{image:' + block.source + '}}' : block.type === 'emoji' ? tools.emojiTemplate(block) : block.text).join('') }
      function update() { ownValue = encode(); emit('change', ownValue); refreshPreview() }
      async function action(name, args) {
        const response = await vue.defHttp.post({ url: '/plugin/do/douyin-auto-spark/action', params: { action: name, args } }, { isTransformResponse: false })
        if (!response.ok) throw new Error(response.message || '操作失败')
        return response.result
      }
      async function localUrl(source) {
        if (!source.startsWith('local:')) return source
        if (!imageUrls.has(source)) {
          const promise = action('templateImage', [source]).then(result => result.url)
          imageUrls.set(source, promise); promise.catch(() => imageUrls.delete(source))
        }
        return imageUrls.get(source)
      }
      async function refreshPreview() {
        const generation = ++previewGeneration
        try {
          const now = new Date(), values = { account: '我的账号', friend: '好友小明', yiyan: '愿你今天也有好心情。', from: '示例一言', date: now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), time: now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }), weekday: now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }) }
          const parts = parseMessageTemplate(encode() || '{{yiyan}}')
          const rows = await Promise.all(parts.map(async part => part.type === 'image' ? { ...part, url: await localUrl(part.source) } : part.type === 'emoji' ? { ...part, url: part.preview } : { ...part, text: part.text.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, key) => values[key] || '') }))
          if (alive && generation === previewGeneration) { preview.value = rows; error.value = '' }
        } catch (cause) { if (alive && generation === previewGeneration) error.value = cause.message }
      }
      function readText(node) {
        if (node.nodeType === 3) return node.textContent
        if (node.dataset?.placeholder) return '{{' + node.dataset.placeholder + '}}'
        if (node.nodeName === 'BR') return '\n'
        let text = ''
        for (const child of node.childNodes) {
          const block = ['DIV', 'P'].includes(child.nodeName)
          if (block && text && !text.endsWith('\n')) text += '\n'
          const emptyLine = block && child.childNodes.length === 1 && child.firstChild.nodeName === 'BR'
          text += emptyLine ? (text.endsWith('\n') ? '' : '\n') : readText(child)
        }
        return text
      }
      function fillEditor(node, text) {
        node.replaceChildren()
        const re = /\{\{\s*([a-zA-Z]+)\s*\}\}/g
        let offset = 0
        for (const match of text.matchAll(re)) {
          node.append(document.createTextNode(text.slice(offset, match.index)))
          const chip = document.createElement('span'); chip.className = 'st-token'; chip.contentEditable = 'false'; chip.dataset.placeholder = match[1]; chip.textContent = TEMPLATE_FIELDS[match[1]] || match[1]; node.append(chip)
          offset = match.index + match[0].length
        }
        node.append(document.createTextNode(text.slice(offset)))
      }
      function editorRef(block) {
        if (!editorRefs.has(block.key)) editorRefs.set(block.key, node => { if (node) { if (editors.get(block.key) !== node) { editors.set(block.key, node); fillEditor(node, block.text) } } else editors.delete(block.key) })
        return editorRefs.get(block.key)
      }
      function remember(key) {
        active = key
        const selection = window.getSelection()
        if (selection.rangeCount && editors.get(key)?.contains(selection.anchorNode)) caret = selection.getRangeAt(0).cloneRange()
      }
      function textChanged(block, node) { block.text = readText(node); remember(block.key); update() }
      function addText() { const block = makeBlock({ type: 'text', text: '' }); blocks.value.push(block); active = block.key; caret = undefined; update(); nextTick(() => editors.get(active)?.focus()) }
      function insertToken(key) {
        let node = editors.get(active)
        if (!node) { addText(); nextTick(() => insertToken(key)); return }
        node.focus()
        const range = caret && node.contains(caret.startContainer) ? caret : document.createRange()
        if (!caret || !node.contains(range.startContainer)) { range.selectNodeContents(node); range.collapse(false) }
        range.deleteContents()
        const chip = document.createElement('span'); chip.className = 'st-token'; chip.contentEditable = 'false'; chip.dataset.placeholder = key; chip.textContent = TEMPLATE_FIELDS[key]
        range.insertNode(chip); range.setStartAfter(chip); range.collapse(true); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); caret = range.cloneRange()
        textChanged(blocks.value.find(block => block.key === active), node)
      }
      function addImage(source) { tools.validateImageSource(source); blocks.value.push(makeBlock({ type: 'image', source })); imageUrl.value = ''; update() }
      async function upload(event) {
        const file = event.target.files[0]; if (!file) return
        if (!file.size || file.size > 5 * 1024 * 1024) { error.value = '图片不能超过 5 MB'; event.target.value = ''; return }
        busy.value = true; error.value = ''
        try {
          const link = await action('templateUpload', [])
          const response = await fetch(new URL(link.upload, location.origin), { method: 'POST', headers: { 'Content-Type': 'application/x-douyin-template-image' }, body: file })
          const result = await response.json(); if (!result.ok) throw new Error(result.message || '图片上传失败')
          imageUrls.set(result.source, Promise.resolve(URL.createObjectURL(file))); addImage(result.source)
        } catch (cause) { error.value = cause.message }
        finally { busy.value = false; event.target.value = '' }
      }
      async function openEmojis() {
        emojiOpen.value = !emojiOpen.value
        if (!emojiOpen.value || accountsLoaded) return
        try {
          const data = await action('templateEmojiAccounts', [])
          if (!alive) return
          emojiAccounts.value = data.accounts; accountsLoaded = true; emojiAccount.value = data.accounts[0]?.id || ''
          if (!data.accounts.length) emojiStatus.value = '请先添加一个抖音账号，再读取表情'
        } catch (cause) { if (alive) emojiStatus.value = cause.message }
      }
      function resetEmojis() { emojiPage.value = null; emojiSearch.value = ''; emojiStatus.value = '点击“读取小表情”加载所选账号' }
      async function loadEmojis() {
        if (emojiLoading.value) return
        if (!emojiAccount.value) { emojiStatus.value = '请选择一个抖音账号'; return }
        emojiLoading.value = true; emojiStatus.value = '正在读取小表情…'
        try {
          const data = await action('templateEmojis', [emojiAccount.value, { kind: 'small' }])
          if (!alive) return
          emojiPage.value = data
          emojiStatus.value = (data.items.length ? `点击图片添加小表情（共 ${data.items.length} 个）` : '没有可用小表情') + (data.skipped ? `；${data.skipped} 个表情缺少图片资源，已跳过` : '')
        } catch (cause) { if (alive) emojiStatus.value = cause.message }
        finally { emojiLoading.value = false }
      }
      function addEmoji(item) { try { tools.emojiTemplate(item); blocks.value.push(makeBlock({ type: 'emoji', emoji: item.value, preview: item.url, name: item.name, kind: item.kind })); update() } catch (cause) { error.value = cause.message } }
      const emojiImage = (url, name, className) => h('img', { class: className, src: url, alt: name, referrerpolicy: 'no-referrer', onError: event => { event.target.replaceWith(document.createTextNode('表情图片不可用，请重新读取')) } })
      function move(index, direction) { const [block] = blocks.value.splice(index, 1); blocks.value.splice(index + direction, 0, block); update() }
      const button = (text, handler, disabled = false) => h('button', { type: 'button', disabled: props.disabled || busy.value || disabled, onMousedown: event => event.preventDefault(), onClick: handler }, text)
      watch(() => props.value, value => { if (value !== ownValue) { ownValue = value; decode(value) } })
      onMounted(() => decode(props.value))
      onBeforeUnmount(() => { alive = false; for (const promise of imageUrls.values()) promise.then(url => { if (url.startsWith('blob:')) URL.revokeObjectURL(url) }).catch(() => {}); editors.clear() })
      return () => h('div', { class: 'spark-template' }, [
        h('style', css),
        h('div', { class: 'st-tools' }, Object.entries(TEMPLATE_FIELDS).map(([key, label]) => button(label, () => insertToken(key))).concat(button('添加文字', addText))),
        ...blocks.value.map((block, index) => h('div', { key: block.key, class: 'st-block' }, [
          h('div', { class: 'st-actions' }, [h('span', `${index + 1}. ${block.type === 'text' ? '文字' : block.type === 'emoji' ? '表情 · ' + block.name : '图片'}`), button('上移', () => move(index, -1), index === 0), button('下移', () => move(index, 1), index === blocks.value.length - 1), button('删除', () => { blocks.value.splice(index, 1); update() })]),
          block.type === 'text' ? h('div', {
            class: 'st-text', contenteditable: !props.disabled && !busy.value, role: 'textbox', 'aria-label': '模板文字', 'aria-multiline': 'true',
            ref: editorRef(block),
            onInput: event => textChanged(block, event.target), onFocus: () => remember(block.key), onKeyup: () => remember(block.key), onMouseup: () => remember(block.key),
            onPaste: event => { event.preventDefault(); const text = event.clipboardData.getData('text/plain'); document.execCommand('insertText', false, text) },
          }) : block.type === 'emoji' ? [emojiImage(block.preview, block.name, 'st-emoji-image'), h('span', { class: 'st-help' }, block.kind === 'small' ? '抖音小表情' : '抖音贴纸')] : [
            h('input', { class: 'st-url', value: block.source, disabled: props.disabled || busy.value, 'aria-label': '图片地址', onInput: event => { block.source = event.target.value; update() } }),
            preview.value.find(part => part.source === block.source)?.url ? h('img', { class: 'st-image', src: preview.value.find(part => part.source === block.source).url, alt: '模板图片', referrerpolicy: 'no-referrer' }) : null,
          ],
        ])),
        button(emojiOpen.value ? '收起表情' : '添加抖音表情', openEmojis),
        ...(emojiOpen.value ? [h('section', { class: 'st-emoji-panel', 'aria-label': '抖音表情选择器' }, [
          h('div', { class: 'st-tools' }, [
            h('select', { value: emojiAccount.value, disabled: emojiLoading.value, 'aria-label': '读取表情的账号', onChange: event => { emojiAccount.value = event.target.value; resetEmojis() } }, [h('option', { value: '' }, '请选择账号'), ...emojiAccounts.value.map(account => h('option', { value: account.id }, account.name + '（' + account.id + '）'))]),
            button('读取小表情', () => loadEmojis(), emojiLoading.value),
          ]),
          h('input', { class: 'st-url', placeholder: '搜索小表情名称', 'aria-label': '搜索表情', value: emojiSearch.value, onInput: event => emojiSearch.value = event.target.value }),
          h('p', { class: 'st-help', role: 'status' }, emojiStatus.value),
          h('div', { class: 'st-emoji-grid' }, (emojiPage.value?.items || []).filter(item => item.name.toLowerCase().includes(emojiSearch.value.trim().toLowerCase())).map(item => h('button', { type: 'button', disabled: props.disabled || busy.value, title: item.name, onClick: () => addEmoji(item) }, [h('img', { src: item.url, alt: item.name, loading: 'lazy', referrerpolicy: 'no-referrer', onError: event => { event.target.parentElement.disabled = true; event.target.replaceWith(document.createTextNode('图片不可用')) } }), h('span', item.name)]))),
        ])] : []),
        h('div', { class: 'st-tools' }, [h('input', { class: 'st-url', value: imageUrl.value, disabled: props.disabled || busy.value, placeholder: '图片链接 https://…', 'aria-label': '添加图片链接', onInput: event => imageUrl.value = event.target.value }), button('添加图链', () => { try { addImage(imageUrl.value.trim()) } catch (cause) { error.value = cause.message } }), h('label', [h('span', '上传本地图片 '), h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', disabled: props.disabled || busy.value, onChange: upload })])]),
        h('p', { class: 'st-help' }, busy.value ? '正在上传图片，请完成后再保存。' : '文字、图片与表情按顺序发送。图片最多 10 张，每张最多 5 MB；表情最多 20 个。'),
        h('p', { class: 'st-error', role: 'status' }, error.value),
        h('div', { class: 'st-preview', 'aria-label': '模板实时预览' }, [h('div', { class: 'st-preview-title' }, encode().trim() ? '实时预览 · 示例好友和一言' : '模板留空 · 将发送随机一言'), ...preview.value.map(part => part.type === 'image' ? h('img', { class: 'st-image', src: part.url, alt: '发送图片预览', referrerpolicy: 'no-referrer' }) : part.type === 'emoji' ? h('div', [emojiImage(part.url, part.name, 'st-emoji-image'), h('span', part.name)]) : h('p', part.text))]),
        h('details', [h('summary', '查看模板内容'), h('textarea', { class: 'st-source', rows: 4, value: ownValue, readonly: true, 'aria-label': '模板内容' })]),
      ])
    },
  })
  const Wrapper = defineComponent({
    name: 'SparkTemplateTextArea', inheritAttrs: false,
    props: { sparkTemplateEditor: Boolean, value: [String, Number], disabled: Boolean },
    setup(props, { attrs }) { return () => props.sparkTemplateEditor ? h(Editor, { ...attrs, value: String(props.value || ''), disabled: props.disabled }) : h(original, { ...attrs, value: props.value, disabled: props.disabled }) },
  })
  Wrapper.sparkTemplateWrapper = true
  componentMap.set('InputTextArea', Wrapper)
}
