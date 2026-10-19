/**
 * 会话名的展示与解析工具。
 *
 * 会话名是用户可控的文本，可能含逗号、顿号、引号等标点。把它们直接拼进提示语，
 * 会出现「名字内容把拼接符吃掉」的歧义（见 formatNameList）；把它们直接当分隔符
 * 拆开，又会拆散真的带顿号的昵称（见 resolveNameTargets）。
 */

/**
 * 把会话名列表拼成一行人能看懂的文本。
 *
 * 会话名本身就可能以「、」结尾（例如好友「吵死了、」）。若直接用顿号拼接，
 * 「吵死了、」和「一群凡人」会渲染成「吵死了、一群凡人」，看起来像一个名字，
 * 用户根本分不清缺的是哪几个会话。给每个名字加直角引号，边界就不会被名字内容吃掉。
 *
 * @param {string[]} names 会话名列表，允许重复
 * @returns {string} 形如「吵死了、」、「一群凡人」的展示文本
 */
export function formatNameList(names = []) {
  return [...new Set(names.map((name) => String(name).trim()).filter(Boolean))]
    .map((name) => `「${name}」`)
    .join('、')
}

/**
 * 判断一个未命中的目标名是不是「几个会话名被顿号连成了一个」。
 *
 * 目标会话只认换行和逗号分隔，用户若用顿号分隔，多个名字会被当成一个存下来，
 * 续火时永远匹配不到。解析时不改写数据，只在运行时兜底：逐段都能对上才算数，
 * 避免把真的叫「张三、李四」的好友误判成两个人。
 *
 * @param {string} name 未命中的目标名
 * @param {Map<string, unknown>} index 会话名 → chatId 索引
 * @returns {string[]|undefined} 拆分后的会话名；不像被连在一起时返回 undefined
 */
export function splitMergedName(name, index) {
  const value = String(name)
  if (!value.includes('、')) return undefined
  const parts = [...new Set(value.split('、').map((part) => part.trim()).filter(Boolean))]
  if (parts.length < 2) return undefined
  return parts.every((part) => index.has(part)) ? parts : undefined
}

/**
 * 目标名 → 实际要发送的会话列表。
 *
 * 先按整串精确匹配：好友本身就叫「吵死了、」时不能被拆开。
 * 整串匹配不到、且按顿号拆开后每一段都是已有会话时，才还原成多个目标——
 * 这样「吵死了、一群凡人」能正确续到两个好友，而不会被当成一个查无此人的名字。
 * 只要有一段对不上就整体算未找到，宁可报错也不猜着发，避免发错人。
 *
 * @param {string} name 配置里的目标会话名
 * @param {Map<string, string>} index 会话名 → chatId 索引
 * @returns {{name: string, chatId: string}[]} 命中的会话；一个都没有时返回空数组
 */
export function resolveNameTargets(name, index) {
  const value = String(name)
  const chatId = index.get(value)
  if (chatId) return [{ name: value, chatId }]
  const parts = splitMergedName(value, index)
  return parts ? parts.map((part) => ({ name: part, chatId: index.get(part) })) : []
}
