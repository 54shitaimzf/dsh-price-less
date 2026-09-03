/**
 * mech-features 纯函数单测：tokenize/jaccard/双语 correction/lexical/liveness/语用/工具直方图。
 * 这是 probe22 粒度升级特征集的确定性契约（无时间、无模型、双语）。
 */
import { describe, it, expect } from 'vitest'
import {
  tokenize,
  jaccard,
  correctionFeatures,
  lexicalFeatures,
  livenessFeatures,
  pragmaticFeatures,
  toolClassHistogram,
  staticFeatures,
} from '../scripts/mech_features.mjs'

describe('tokenize', () => {
  it('拉丁词 token（小写、标点剔除）', () => {
    const t = tokenize('Fix the Error: build.sh fails!')
    expect(t).toContain('error')
    expect(t).toContain('build.sh')
    expect(t).not.toContain('Error')
  })
  it('CJK 2-gram（单字退化为 1 元）', () => {
    const t = tokenize('接下来我们开始')
    expect(t).toContain('接下')
    expect(t).toContain('下来')
  })
  it('空串 → []', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('jaccard', () => {
  it('同集 = 1，无交 = 0', () => {
    expect(jaccard(['a'], ['a'])).toBe(1)
    expect(jaccard(['a'], ['b'])).toBe(0)
  })
  it('空集对 = 0', () => {
    expect(jaccard([], [])).toBe(0)
  })
})

describe('correctionFeatures（双语两级）', () => {
  it('EN 方向否决级命中（stop）', () => {
    expect(correctionFeatures('Stop doing that and redo it').f1Strong).toBe(1)
  })
  it('ZH 方向否决级命中（不是这样）', () => {
    expect(correctionFeatures('不是这样，重新来一遍').f1Strong).toBe(1)
  })
  it('EN 细节修正级（please change it）→ 0.4', () => {
    expect(correctionFeatures('please change the color').f1Fine).toBeCloseTo(0.4)
  })
  it('普通指令不触发 correction', () => {
    const r = correctionFeatures('帮我看看这个文件的内容')
    expect(r.f1Strong + r.f1Fine).toBe(0)
  })
})

describe('lexicalFeatures（双语话语标记）', () => {
  it('EN 强标记（new task）', () => {
    expect(lexicalFeatures('New task: build the API').f2Lex).toBeGreaterThanOrEqual(1)
  })
  it('ZH 强标记（接下来我们）', () => {
    expect(lexicalFeatures('接下来我们实现登录').f2Lex).toBeGreaterThanOrEqual(1)
  })
  it('弱标记（另外）仅 0.3', () => {
    expect(lexicalFeatures('另外，注意这个细节').f2Lex).toBeCloseTo(0.3)
  })
})

describe('livenessFeatures', () => {
  it('转储类：代码围栏/错误栈', () => {
    expect(livenessFeatures('```bash\nnpm install\n```').f5Dump).toBe(1)
    expect(livenessFeatures('Traceback (most recent call last):\n  File "x.py"').f5Dump).toBe(1)
  })
  it('目标类：约束词（must / 必须）', () => {
    expect(livenessFeatures('You must not remove this file').f5Goal).toBe(1)
    expect(livenessFeatures('必须确保不回归').f5Goal).toBe(1)
  })
})

describe('pragmaticFeatures', () => {
  it('问句', () => {
    expect(pragmaticFeatures('这样做行吗？', []).f9Question).toBe(1)
  })
  it('祈使开头', () => {
    expect(pragmaticFeatures('请你整理一下目录', [5]).f9Imperative).toBe(1)
  })
  it('长度比：远超中位数 → 接近 1', () => {
    expect(pragmaticFeatures('x'.repeat(400), [10, 12, 11]).f9LenRatio).toBeGreaterThan(0.9)
  })
})

describe('toolClassHistogram', () => {
  it('read/write/exec/config 归类', () => {
    const h = toolClassHistogram([
      { name: 'read' }, { name: 'edit' }, { name: 'bash' }, { name: 'todo' }, { name: 'web_search' },
    ])
    expect(h).toEqual({ f7R: 1, f7W: 1, f7X: 1, f7C: 1, f7O: 1 })
  })
})

describe('staticFeatures', () => {
  it('输出对齐 U 且含 f6Prev', () => {
    const session = {
      us: [
        { u: 0, text: '开始做 A', tools: [], todos: [] },
        { u: 1, text: '接下来我们做 B', tools: [{ name: 'edit', dir: 'src', file: 'x' }], todos: [] },
      ],
    }
    const sf = staticFeatures(session)
    expect(sf).toHaveLength(2)
    expect(sf[0].u).toBe(0)
    expect(sf[1].f6Prev).toBeGreaterThanOrEqual(0)
    expect(sf[1].f7W).toBe(1)
  })
})
