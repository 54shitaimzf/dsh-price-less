/**
 * 判别器 L0 快速路径：极窄延续词表（整体匹配，零 LLM 成本）。
 *
 * 模块: 判别器 L0 快速通道
 * 平面: L0（确定性词表匹配——纯函数，无模型/无 IO）
 * 回退链步数: 2（词表直判 → LLM 判别（主路径，回退链第 2 级））
 * 审查清单: 词表与 scripts/phase_a_l0.mjs / phase_b_prep.mjs 同源冻结
 *           （phase-a-l0.md：1107 条语料 L0 拦截 1.2%、翻转泄漏=0）；
 *           只做【整条消息归一化后整体等于词表项】——禁止前缀/包含匹配
 *           （"帮我…" 前缀已被证伪，phase-a-l0.md §3/§6：精度 0.0%、单意图误开）；
 *           strip 规则与冻结脚本逐字符一致（禁 re 属性、Unicode 属性扫描）；
 *           模块自证附于本头注释。
 * 度量: l0CaptureRate / l0Leak（docs/07 §18：泄漏必须保持 0）
 */

/** 去空白与标点（与 phase_b_prep.mjs 冻结同源；禁 re 属性但允许 \p{P}）。 */
export function stripL0(text: string): string {
  return text.replace(/[\s\u3000！？。，、；：""''（）《》【】!?.,;:()\[\]{}~\-—_…]/gu, '').toLowerCase()
}

/** L0 延续词表（phase_a_l0.mjs 冻结版；增加词 = 升版本，禁止原地改）。 */
export const DISC_L0_CONTINUE_WORDS: ReadonlySet<string> = new Set([
  '继续', '继续吧', '继续继续', '好的', '好的好的', '好', '好哦', '好呀', '好吧', '行', '行吧', '嗯', '嗯嗯',
  '对', '对的', '是的', '没错', '确实', '明白了', '明白', '知道了', '可以', '可以了', '没问题', '收到', '好滴',
  '谢谢', '然后呢', '还有', '接着', '接着吧', '继续做', '接着做', '继续说', '继续搞', '来吧', '请继续',
  'ok', 'okay', 'yes', 'yep', 'yeah', 'sure', 'great', 'nice', 'gotit', 'understood', 'thanks', 'thanks!',
  'continue', 'goon', 'alright', 'fine', 'right', 'indeed', 'good', 'perfect', 'done', 'works', 'ok!',
  'k', 'kk', 'ok.', 'yes.', 'sure.', 'thanks.', 'right.', 'great.', 'nice.', 'perfect.',
])

/** L0-continue：整条消息去掉空白标点后 = 一个延续词（含标点变体）。 */
export function isL0Continue(text: string): boolean {
  const normalized = stripL0(text)
  if (normalized.length === 0) return false
  return DISC_L0_CONTINUE_WORDS.has(normalized)
}

/** 伪 user 检测（harness 记录被标 kind=user 的系统语义消息；phase_b_prep.mjs 冻结 3 正则）。 */
const PSEUDO_USER_RES = [
  /approval policy changed/i,
  /changed by the user/i,
  /permission preset/i,
]

/** 输入面过滤：伪 user（系统注入却被标 kind=user）不进判别面。 */
export function isPseudoUser(text: string): boolean {
  return PSEUDO_USER_RES.some(re => re.test(text))
}
