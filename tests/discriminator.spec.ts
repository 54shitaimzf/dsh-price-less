/**
 * 判别器纯函数单测（无 harness：纯 node 运行，不启动 DSH）。
 *
 * 覆盖（v0.4.0，docs/07 §18）:
 * - L0 词表：整体匹配/标点变体/非词不命中（词表与 phase_a_l0.mjs 冻结同源）；
 * - 溯源：指纹确定性、缓存键含配置面、判定解析（围栏/废话/坏 JSON）；
 * - 窗口：v6 冻结裁剪（350/350/800 头600尾200）、模板占位替换、模板与 datasets 同源、
 *   未注册版本回退 undefined；
 * - 自适应链：materialize 过滤 undefined 覆盖、sanitizeEffort 两层交集全组合；
 * - 台账：环表幂等/有界/统计；
 * - 引擎纯函数：段内历史收集（窗口/过滤/顺序）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isL0Continue,
  isPseudoUser,
  stripL0,
  DISC_L0_CONTINUE_WORDS,
} from '../src/discriminator/l0.js'
import {
  fingerprintText,
  makeJudgeCacheKey,
  makeJudgeId,
  parseDecision,
  serializeJudgeRecord,
} from '../src/discriminator/trace.js'
import {
  DISC_PROMPTS,
  DISC_PROMPT_DEFAULT_VERSION,
  buildDiscWindow,
  clampWindowHead,
  clampWindowTarget,
  renderDiscPrompt,
} from '../src/discriminator/prompt.js'
import {
  DEFAULT_DISC_PRESET,
  DISC_PRICING,
  estimateJudgeCost,
  materializeDiscCallConfig,
  sanitizeEffort,
} from '../src/discriminator/presets.js'
import { JudgeJournal } from '../src/discriminator/journal.js'
import { collectHistoryTexts, isAppendUserMessage, userIndexBefore } from '../src/discriminator/engine.js'

describe('L0 快速路径', () => {
  it('延续词整体匹配命中', () => {
    expect(isL0Continue('好')).toBe(true)
    expect(isL0Continue('好的')).toBe(true)
    expect(isL0Continue('ok')).toBe(true)
    expect(isL0Continue('OK !')).toBe(true)
    expect(isL0Continue('继续做')).toBe(true)
  })

  it('整条消息归一化后必须整体等于词表（前缀/包含不命中）', () => {
    expect(isL0Continue('帮我写代码')).toBe(false)
    expect(isL0Continue('好的，继续吧，我们开始下一步')).toBe(false)
    expect(isL0Continue('好的哇')).toBe(false)
  })

  it('strip 与冻结脚本口径一致（去空白标点小写）', () => {
    expect(stripL0('好 的，')).toBe('好的')
    expect(stripL0('OK!')).toBe('ok')
    expect(stripL0('嗯！！！')).toBe('嗯')
  })

  it('伪 user 过滤（phase_b_prep.mjs 冻结 3 正则）', () => {
    expect(isPseudoUser('approval policy changed by user')).toBe(true)
    expect(isPseudoUser('changed by the user')).toBe(true)
    expect(isPseudoUser('permission preset applied')).toBe(true)
    expect(isPseudoUser('帮我确认一下缓存前缀')).toBe(false)
  })
})

describe('溯源图基元', () => {
  it('指纹确定性（同输入同输出，异输入异输出）', () => {
    expect(fingerprintText('你好')).toBe(fingerprintText('你好'))
    expect(fingerprintText('你好')).not.toBe(fingerprintText('你好啊'))
    expect(fingerprintText('')).toBe(fingerprintText(''))
    expect(fingerprintText('abc')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('缓存键含配置面（配置变即键变）', () => {
    const base = { sessionId: 's1', seq: 7, provider: 'opencode-go', model: 'minimax-m3', promptVersion: 'v2.2', text: '继续' }
    const a = makeJudgeCacheKey(base)
    const b = makeJudgeCacheKey({ ...base, text: '继续' })
    const c = makeJudgeCacheKey({ ...base, promptVersion: 'v2.1' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('judgeId 稳定（同会话同 seq 唯一）', () => {
    expect(makeJudgeId('s1', 3)).toBe(makeJudgeId('s1', 3))
    expect(makeJudgeId('s1', 3)).not.toBe(makeJudgeId('s1', 4))
    expect(makeJudgeId('s1', 3)).not.toBe(makeJudgeId('s2', 3))
  })

  it('判定解析：裸 JSON / 围栏 / 前后废话 / 坏输入', () => {
    expect(parseDecision('{"decision":"new_task"}')).toBe('new-task')
    expect(parseDecision('{"decision":"continue"}')).toBe('continue')
    expect(parseDecision('```json\n{"decision":"new_task"}\n```')).toBe('new-task')
    expect(parseDecision('好的，判定结果：{"decision":"continue"} 完')).toBe('continue')
    expect(parseDecision('')).toBeUndefined()
    expect(parseDecision('今天天气不错')).toBeUndefined()
    expect(parseDecision('{"decision":"maybe"}')).toBeUndefined()
    expect(parseDecision('{bad json')).toBeUndefined()
  })

  it('记录序列化 round-trip（plain JSON）', () => {
    const record = {
      judgeId: 'j:s:1',
      sessionId: 's',
      seq: 1,
      atMs: 0,
      mode: 'observe' as const,
      trigger: 'llm' as const,
      verdict: 'continue' as const,
      call: materializeDiscCallConfig('minimax', undefined),
      requestedEffort: 'none' as const,
      sentEffort: 'none' as const,
      window: { anchorChars: 10, patchCount: 2, targetChars: 20, targetExcerpt: '' },
      modelView: { efforts: ['off', 'low'] },
      llm: { status: 'ok' as const, latencyMs: 100 },
      errors: [],
      sources: [],
    }
    const restored = JSON.parse(serializeJudgeRecord(record))
    expect(restored.judgeId).toBe('j:s:1')
    expect(restored.call.provider).toBe('opencode-go')
    expect(restored.sources).toEqual([])
  })
})

describe('窗口与模板（v6 冻结口径）', () => {
  it('头截断（≤cap 原样；>cap 截断标记）', () => {
    expect(clampWindowHead('abc', 3)).toBe('abc')
    const capped = clampWindowHead('abcdef', 3)
    expect(capped.startsWith('abc')).toBe(true)
    expect(capped).toContain('…[truncated]…')
  })

  it('目标截断（头600+尾200，中缀截断标记）', () => {
    const short = 'x'.repeat(800)
    expect(clampWindowTarget(short)).toBe(short)
    const long = 'a'.repeat(600) + 'b'.repeat(300) + 'c'.repeat(200)
    const clamped = clampWindowTarget(long)
    expect(clamped.length).toBeLessThan(long.length)
    expect(clamped).toContain('…[truncated]…')
    expect(clamped.startsWith('a'.repeat(600))).toBe(true)
    expect(clamped.endsWith('c'.repeat(200))).toBe(true)
  })

  it('窗口组装：patch 取最近 window 条、逐条裁剪', () => {
    const window = buildDiscWindow('a'.repeat(400), ['p1', 'p2'], 't', 2)
    // 冻结口径：锚头 350 字符 + 截断标记（长度 = cap + 标记，语义"头 350"）
    expect(window.anchor.slice(0, 350)).toBe('a'.repeat(350))
    expect(window.anchor).toContain('…[truncated]…')
    expect(window.patches).toEqual(['p1', 'p2'])
    const window1 = buildDiscWindow('a', ['p0', 'p1', 'p2'], 't', 2)
    expect(window1.patches).toEqual(['p1', 'p2'])
  })

  it('模板与 datasets 定稿逐字节同源（两处不许漂移）', () => {
    const dir = fileURLToPath(new URL('..', import.meta.url))
    const file = `${dir}datasets/prompt-discriminator-v2.2.txt`
    const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
    expect(DISC_PROMPTS['v2.2']).toBe(source)
  })

  it('渲染：占位符替换且不误伤规则文本花括号', () => {
    const rendered = renderDiscPrompt('v2.2', { anchor: 'A', patches: ['H1', 'H2'], target: 'T' })
    expect(rendered).toBeDefined()
    expect(rendered!).toContain('<anchor>A</anchor>')
    expect(rendered!).toContain('<history>H1\nH2</history>')
    expect(rendered!).toContain('<target>T</target>')
    expect(rendered!).not.toContain('{ANCHOR}')
    expect(rendered!).not.toContain('{TARGET}')
    // 规则文本里的 JSON 花括号保留（split/join 只换占位符）
    expect(rendered!).toContain('{"decision":"new_task"|"continue"}')
  })

  it('未注册版本 → undefined（调用方降级）', () => {
    expect(renderDiscPrompt('v9.9', { anchor: '', patches: [], target: 't' })).toBeUndefined()
    expect(DISC_PROMPT_DEFAULT_VERSION).toBe('v2.2')
  })
})

describe('自适应链（presets 纯函数）', () => {
  it('materialize：undefined 覆盖被过滤（不冲掉预设值）', () => {
    const out = materializeDiscCallConfig('minimax', { effort: undefined, temperature: 0 })
    expect(out.effort).toBe('none')
    expect(out.temperature).toBe(0)
    expect(out.provider).toBe('opencode-go')
  })

  it('sanitizeEffort：两层交集（运行时许可 ∩ 实测验证层）', () => {
    // none 短路
    expect(sanitizeEffort(['low'], 'none', ['low'])).toBe('none')
    // 双命中
    expect(sanitizeEffort(['off', 'low', 'high', 'max'], 'low', ['low', 'high', 'max'])).toBe('low')
    // 运行时许可缺
    expect(sanitizeEffort(undefined, 'low', ['low'])).toBe('none')
    // 验证层缺
    expect(sanitizeEffort(['low'], 'low', undefined)).toBe('none')
    // 交集空（声明有、实测无——GLM 案例）
    expect(sanitizeEffort(['off', 'high', 'max'], 'low', ['low', 'high', 'max'])).toBe('none')
    // 验证层不含（运行时多出的档位不越权）
    expect(sanitizeEffort(['off', 'minimal', 'low', 'medium', 'high'], 'medium', [])).toBe('none')
  })

  it('默认预设 = minimax（全局默认配置）', () => {
    expect(DEFAULT_DISC_PRESET).toBe('minimax')
  })

  it('estimateJudgeCost：单价 × 用量（含缓存读折扣）', () => {
    const pricing = DISC_PRICING['opencode-go@minimax-m3']
    expect(pricing).toBeDefined()
    const cost = estimateJudgeCost(
      { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 },
      pricing,
    )
    // 1000×0.30/1M + 500×1.20/1M + 2000×0.06/1M = 0.00030 + 0.00060 + 0.00012 = 0.00102
    expect(cost).not.toBeNull()
    expect(cost!.usd).toBeCloseTo(0.00102, 8)
    expect(cost!.inputUsd).toBeCloseTo(0.00030, 8)
    expect(cost!.outputUsd).toBeCloseTo(0.00060, 8)
    expect(cost!.cacheReadUsd).toBeCloseTo(0.00012, 8)
  })

  it('estimateJudgeCost：无 usage / 无单价 → null（不猜价）', () => {
    expect(estimateJudgeCost(undefined, DISC_PRICING['opencode-go@minimax-m3'])).toBeNull()
    expect(estimateJudgeCost({ inputTokens: 100 }, undefined)).toBeNull()
    expect(estimateJudgeCost({ inputTokens: 100, outputTokens: 50 }, DISC_PRICING['deepseek-official@deepseek-v4-flash'])).toBeNull()
  })

  it('成本字段随记录序列化（plain JSON + cost 快照）', () => {
    const record = {
      judgeId: 'j:s:1',
      sessionId: 's',
      seq: 1,
      atMs: 0,
      mode: 'observe' as const,
      trigger: 'llm' as const,
      verdict: 'new-task' as const,
      call: materializeDiscCallConfig('minimax', undefined),
      requestedEffort: 'none' as const,
      sentEffort: 'none' as const,
      window: { anchorChars: 0, patchCount: 0, targetChars: 1, targetExcerpt: '' },
      modelView: null,
      llm: { status: 'ok' as const, latencyMs: 5, usage: { inputTokens: 500, outputTokens: 80, cacheReadTokens: 0 } },
      cost: estimateJudgeCost({ inputTokens: 500, outputTokens: 80, cacheReadTokens: 0 }, DISC_PRICING['opencode-go@minimax-m3']),
      errors: [],
      sources: [],
    }
    const restored = JSON.parse(serializeJudgeRecord(record))
    expect(restored.cost.usd).toBeCloseTo(0.000246, 8) // 500×0.30 + 80×1.20 / 1M
  })
})

describe('台账（JudgeJournal）', () => {
  function record(judgeId: string, seq: number, trigger: 'llm' | 'l0-continue' | 'l1-cache' = 'llm', verdict: 'continue' | 'new-task' = 'continue') {
    return {
      judgeId,
      sessionId: 's',
      seq,
      atMs: seq,
      mode: 'observe' as const,
      trigger,
      verdict,
      call: materializeDiscCallConfig('minimax', undefined),
      requestedEffort: 'none' as const,
      sentEffort: 'none' as const,
      window: { anchorChars: 0, patchCount: 0, targetChars: 1, targetExcerpt: '' },
      modelView: null,
      errors: [],
      sources: [],
    }
  }

  it('judgeId 幂等：同 id 覆盖不重复计数', () => {
    const journal = new JudgeJournal(16)
    journal.append(record('j:s:1', 1))
    journal.append(record('j:s:1', 1))
    expect(journal.statsNow().judged).toBe(1)
    expect(journal.recent(10)).toHaveLength(1)
  })

  it('环表有界 + 新→旧排序', () => {
    const journal = new JudgeJournal(3)
    journal.append(record('j:s:1', 1))
    journal.append(record('j:s:2', 2))
    journal.append(record('j:s:3', 3))
    journal.append(record('j:s:4', 4))
    expect(journal.recent(10).map(r => r.seq)).toEqual([4, 3, 2])
    expect(journal.recent(10)).toHaveLength(3)
  })

  it('统计计数（judge/l0/errors/verdict 分类）', () => {
    const journal = new JudgeJournal(16)
    journal.append(record('j:s:1', 1, 'l0-continue'))
    journal.append(record('j:s:2', 2, 'llm', 'new-task'))
    journal.append({ ...record('j:s:3', 3, 'llm'), errors: [{ phase: 'parse', code: 'PARSE_FAILED', message: 'x', action: 'fallback' }] })
    const stats = journal.statsNow()
    expect(stats.judged).toBe(3)
    expect(stats.l0).toBe(1)
    expect(stats.llm).toBe(2)
    expect(stats.errors).toBe(1)
    expect(stats.newTasks).toBe(1)
  })
})

describe('引擎纯函数：段内历史收集', () => {
  function ev(seq: number, text: string, kind = 'user' as string, replace = false) {
    return {
      type: 'user/message' as const,
      seq,
      time: 0,
      surfaceOp: replace ? { op: 'replace' as const } : undefined,
      data: {
        content: [{ type: 'text' as const, text }],
        source: { kind },
        id: `m-${seq}`,
        role: 'user' as const,
      },
    }
  }

  it('取 target 前最近 window 条（时间升序返回）', () => {
    const events = [
      ev(1, '段头'),
      ev(2, '第一'),
      ev(3, '第二'),
      ev(4, '第三'),
      ev(5, 'target'),
    ]
    expect(collectHistoryTexts(events, 1, 5, 2)).toEqual(['第二', '第三'])
    expect(collectHistoryTexts(events, 1, 5, 0)).toEqual([])
  })

  it('过滤：非 user kind / replace / 伪 user / 空文本；startSeq 边界', () => {
    const events = [
      ev(1, '段头'),
      ev(2, '注入', 'plugin'),
      ev(3, '被替换', 'user', true),
      ev(4, 'approval policy changed by user'),
      ev(5, '   '),
      ev(6, '有效的'),
      ev(7, 'target'),
    ]
    const out = collectHistoryTexts(events, 1, 7, 6)
    expect(out).toEqual(['有效的'])
  })

  it('startSeq 之前的事件不入窗', () => {
    const events = [ev(1, '更早'), ev(3, 'target')]
    expect(collectHistoryTexts(events, 2, 3, 6)).toEqual([])
  })
})

describe('U 空间锚定（会话日志推导，重载/重启不丢）', () => {
  function evSeq(seq: number, kind = 'user' as string, replace = false) {
    return {
      type: 'user/message' as const,
      seq,
      time: 0,
      surfaceOp: replace ? { op: 'replace' as const } : undefined,
      data: {
        content: [{ type: 'text' as const, text: `m${seq}` }],
        source: { kind },
        id: `m-${seq}`,
        role: 'user' as const,
      },
    }
  }

  it('isAppendUserMessage：undefined/字符串 append 通过；replace 拒绝', () => {
    expect(isAppendUserMessage(evSeq(1))).toBe(true)
    expect(isAppendUserMessage({ ...evSeq(1), surfaceOp: 'append' })).toBe(true)
    expect(isAppendUserMessage({ ...evSeq(1), surfaceOp: { op: 'replace' } })).toBe(false)
    expect(isAppendUserMessage({ type: 'assistant/message', seq: 1, time: 0, data: {} })).toBe(false)
  })

  it('userIndexBefore：seq 之前的 U 空间数量（任意 kind，replace 不计）', () => {
    const events = [
      evSeq(10, 'user'),
      evSeq(20, 'plugin'),
      evSeq(30, 'user', true), // replace 不计
      evSeq(40, 'tool'),
    ]
    // 目标消息 seq=50：它之前的 U 空间 = 10/20/40 三条
    expect(userIndexBefore(events, 50)).toBe(3)
    // 目标消息 seq=30：只算 10/20 两条（30 自身与 replace 不计）
    expect(userIndexBefore(events, 30)).toBe(2)
    expect(userIndexBefore([], 5)).toBe(0)
  })

  it('重载场景：新 engine 实例对"装配后的第 N 条消息"推出正确 u（不误判首条）', () => {
    const events = [
      evSeq(100, 'user'),
      evSeq(200, 'user'),
      // ...装配发生在 seq=300 之后的某时刻，新实例只见 200 之后的流
    ]
    const targetSeq = 300
    // 目标消息是会话第 3 条 U 空间消息（u=2，0 基）→ u≥1 → 应判
    expect(userIndexBefore(events, targetSeq) + 1).toBe(3)
  })
})
