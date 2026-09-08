/**
 * P14d 机械验收（断面产品契约 + 弹层瘦身 + 推理档）。
 * 纯静态断言 + 确定性输出：连跑两次逐字节一致；不联网、不调模型、不写盘。
 * 用法：node scripts/verify-p14d.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }) }

const optimize = read('src/core/optimize.ts')
check('prompt 版本 = 2', /OPTIMIZE_PROMPT_VERSION = 2\b/.test(optimize), '')
check('禁分节标签与元注释写进 prompt', optimize.includes('禁止分节标题与标签') && optimize.includes('关键事实逐字保真'), '')
check('事实级候选抽取', optimize.includes('CANDIDATE_PATH_RE') && optimize.includes('mandatoryCandidateIndexes'), '')
check('元注释机械剥离', optimize.includes('stripProductMeta') && optimize.includes('isProductMetaLine'), '')
check('账本含 metaStrippedLines', optimize.includes('metaStrippedLines'), '')

const llm = read('src/platform/llm.ts')
check('推理档能力探测', llm.includes('resolveReasoningEffort') && llm.includes('resolveModelInfo'), '')
check('宽化单点仍是 toHarnessGenerateOptions', llm.includes('export function toHarnessGenerateOptions'), '')

const star = read('src/domains/star.ts')
check('★ 传推理档 off（经探测）', star.includes('OPTIMIZE_REASONING_EFFORT') && star.includes('resolveReasoningEffort'), '')
check('剥离/必保接入断面', star.includes('stripProductMeta(') && star.includes('mandatoryCandidateIndexes('), '')
check('账本记 requested/sent effort', star.includes('requestedEffort:') && star.includes('sentEffort,'), '')

const model = read('client/star/star-model.ts')
check('client 已删 diff', !model.includes('diffLines') && !model.includes('clampPreviewText'), '')
check('裁决计数摘要', model.includes('verdictSummary'), '')

const button = read('client/star/StarButton.tsx')
check('弹层无 diff 视图', !button.includes('DiffView') && !button.includes('diffLines'), '')
check('裁决折叠进 details', button.includes('<details') && button.includes('verdictSummary('), '')
check('点侧面不再关闭', !/style=\{OVERLAY\} onClick=/.test(button), '')
check('确认即发送', button.includes('inputActions.setDraft(edited)') && button.includes('inputActions.submit()'), '')
check('关键事实警告文案', button.includes('关键事实未保留'), '')

const types = read('client/star/star-types.ts')
check('client 类型无 DiffLine', !types.includes('DiffLine'), '')

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name)
console.log('')
console.log(failed.length === 0 ? 'P14D VERIFY PASS (' + results.length + ' checks)' : 'P14D VERIFY FAIL (' + failed.length + '/' + results.length + ')')
process.exitCode = failed.length === 0 ? 0 : 1