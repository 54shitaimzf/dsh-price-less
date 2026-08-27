/**
 * lite 档真实模型 smoke：加载插件内嵌 granite-embedding-97m-multilingual-r2，
 * 验证 pooling/归一化正确（同主题对 > 跨主题对）、延迟、批量输入。
 * 运行：node scripts/embed_smoke.mjs（需要 lib/ 已构建）。
 */
import { LiteEmbeddingPort, cosineSimilarity } from 'file:///D:/deepseek-plugin/lib/task/embedding.js'
import { fileURLToPath } from 'node:url'

const modelDir = fileURLToPath(new URL('../models/granite-embedding-97m-multilingual-r2', import.meta.url))
const port = new LiteEmbeddingPort({ modelDir, maxLength: 2048 })

const pairs = {
  same_topic_A: '现在R12执行完毕，不过我在观看执行过程的时候，还是注意到了一些问题。同时因为是使用的无后端前端界面，可能测试并不完备。我希望你能选择合适的工具，尤其是运用你的多模态能力，再次为我进行一次计划R12的落地，重点关注界面元素重叠，信息量展示',
  same_topic_B: '关键是，上述改动的目的是为了让selector队列能够占据更大空间完整展示，你有什么好想法？现在的列表肯定是需要滚动的',
  boundary_turn: '现在有些问题，我觉得抽牌堆，弃牌堆都应该可以不直接显示在战斗界面，因为这并不是我们当前回合需要关注的信息',
  other_domain: '帮我写一个 Vue 组件，实现可拖拽排序的列表，需要支持键盘操作与无障碍',
}

const t0 = Date.now()
const keys = Object.keys(pairs)
const vectors = await port.embed(keys.map(k => pairs[k]))
console.log(`batch embed ${keys.length} texts: ${Date.now() - t0}ms (first load included)`)

const t1 = Date.now()
await port.embed('单条测试')
console.log(`single embed (warm): ${Date.now() - t1}ms, dim=${vectors[0].length}`)

const cos = (a, b) => cosineSimilarity(vectors[keys.indexOf(a)], vectors[keys.indexOf(b)])
console.log('\ncosine matrix (granite-97m-r2, CLS+normalize):')
for (const a of keys) for (const b of keys) if (keys.indexOf(a) < keys.indexOf(b)) {
  console.log(`${a.padEnd(16)} vs ${b.padEnd(16)} = ${cos(a, b).toFixed(4)}`)
}
const same = cos('same_topic_A', 'same_topic_B')
const cross = cos('same_topic_A', 'other_domain')
const boundary = cos('same_topic_A', 'boundary_turn')
console.log(`\n判断：同主题 ${same.toFixed(4)} vs 跨域 ${cross.toFixed(4)} vs 边界turn ${boundary.toFixed(4)}`)
console.log(same > cross && same > boundary ? 'SANITY OK: 同主题最高' : 'SANITY FAIL: 同主题不是最高')
