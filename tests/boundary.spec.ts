/**
 * 判界纯函数单测（无 harness：纯 node 运行，不启动 DSH）。
 * 覆盖：T0 显式、簇迁移评估、分数合议、无时间戳依赖（所有判定不读 event.time）。
 */
import { describe, expect, it } from 'vitest'
import {
  BOUNDARY_SCORE_THRESHOLD,
  CLUSTER_SHIFT_THRESHOLD,
  classifyExplicitUserMessage,
  decideBoundary,
  decideBoundaryWithSemantic,
  evaluateClusterShift,
  extractTaskName,
  fileDirKey,
  filePathInfo,
  hasLexicalBoundaryHint,
  isExplicitTaskClose,
  isExplicitTaskCommand,
  isTodoAllCompleted,
  isUserCorrection,
  userMessageText,
  SIGNAL_SCORES,
} from '../src/task/boundary.js'

function userEvent(text: string, seq = 1) {
  return {
    type: 'user/message' as const,
    seq,
    time: 0,
    data: {
      content: [{ type: 'text' as const, text }],
      source: { kind: 'human' as const },
      id: `m-${seq}`,
      role: 'user' as const,
    },
  }
}

function toolCallEvent(name: string, args: string, seq = 100) {
  return {
    type: 'tool/call' as const,
    seq,
    time: 0,
    data: { turn: 1, step: 1, callId: `c-${seq}`, name, arguments: args },
  }
}

describe('T0 显式信号', () => {
  it('识别 /task 前缀', () => {
    expect(isExplicitTaskCommand('/task 重构模块')).toBe(true)
    expect(isExplicitTaskCommand('/task close')).toBe(true)
    expect(isExplicitTaskCommand('帮我写代码')).toBe(false)
  })

  it('识别 /task close', () => {
    expect(isExplicitTaskClose('/task close')).toBe(true)
    expect(isExplicitTaskClose('/task close 描述')).toBe(true)
    expect(isExplicitTaskClose('/task')).toBe(false)
  })

  it('classify 返回 open/close/null', () => {
    expect(classifyExplicitUserMessage('/task 修 bug')).toBe('open')
    expect(classifyExplicitUserMessage('/task close')).toBe('close')
    expect(classifyExplicitUserMessage('继续改')).toBe(null)
  })

  it('提取任务名', () => {
    expect(extractTaskName('/task 修 bug')).toBe('修 bug')
    expect(extractTaskName('/task')).toBeUndefined()
    expect(extractTaskName('/task close')).toBeUndefined()
  })
})

describe('T1 机械信号', () => {
  it('lexical 边界提示词', () => {
    expect(hasLexicalBoundaryHint('我们换一个任务吧')).toBe(true)
    expect(hasLexicalBoundaryHint('开始做新任务')).toBe(true)
    expect(hasLexicalBoundaryHint('继续修复刚才的问题')).toBe(false)
  })

  it('用户纠正/否决（方案级，非任务内细节修正）', () => {
    expect(isUserCorrection('不是这样理解，方向不对')).toBe(true)
    expect(isUserCorrection('先别动手')).toBe(true)
    // 任务内细节修正不算（"不要改这个文件"是任务内操作修正，方向未变）
    expect(isUserCorrection('不要改这个文件，改用另一个文件')).toBe(false)
    expect(isUserCorrection('继续')).toBe(false)
  })

  it('文件路径信息提取（目录+文件名规范化）', () => {
    const read = toolCallEvent('read', JSON.stringify({ file_path: 'src/index.ts' }))
    expect(filePathInfo(read)).toEqual({ tool: 'read', dir: 'src', name: 'index.ts' })
    const read2 = toolCallEvent('read', JSON.stringify({ path: 'src/index.ts' }))
    expect(filePathInfo(read2)).toEqual({ tool: 'read', dir: 'src', name: 'index.ts' })
    const readWin = toolCallEvent('read', JSON.stringify({ file_path: 'C:\\proj\\src\\index.ts' }))
    expect(filePathInfo(readWin)).toEqual({ tool: 'read', dir: 'proj/src', name: 'index.ts' })
    expect(filePathInfo(toolCallEvent('bash', JSON.stringify({ command: 'ls' })))).toBe(null)
  })

  it('文件目录键', () => {
    expect(fileDirKey({ tool: 'read', dir: 'src', name: 'index.ts' })).toBe('src')
    expect(fileDirKey({ tool: 'read', dir: 'rust/core', name: 'a.rs' })).toBe('rust/core')
  })

  it('todo 全完成', () => {
    const done = {
      type: 'todo/write' as const,
      seq: 5,
      time: 0,
      data: {
        todos: [
          { content: 'a', status: 'completed' as const },
          { content: 'b', status: 'completed' as const },
        ],
      },
    }
    const pending = {
      ...done,
      data: { todos: [{ content: 'a', status: 'completed' as const }, { content: 'b', status: 'in_progress' as const }] },
    }
    expect(isTodoAllCompleted(done)).toBe(true)
    expect(isTodoAllCompleted(pending)).toBe(false)
  })
})

describe('文件簇迁移评估（非相邻文件武断判断）', () => {
  const ctx0 = { seenDirs: [], pendingDir: null, pendingDirCount: 0 }

  it('单个新文件不触发（< 阈值）', () => {
    const r1 = evaluateClusterShift(ctx0, 'src')
    expect(r1.shifted).toBe(false)
    expect(r1.next.pendingDir).toBe('src')
    expect(r1.next.pendingDirCount).toBe(1)
  })

  it('同一目录连续多个文件才触发迁移', () => {
    let ctx = evaluateClusterShift(ctx0, 'src').next
    for (let i = 1; i < CLUSTER_SHIFT_THRESHOLD; i++) {
      const r = evaluateClusterShift(ctx, 'src')
      ctx = r.next
      if (i < CLUSTER_SHIFT_THRESHOLD - 1) expect(r.shifted).toBe(false)
    }
    const final = evaluateClusterShift(ctx, 'src')
    expect(final.shifted).toBe(true)
  })

  it('回到已见目录 → 重置候选（迁移不成立）', () => {
    // 模拟 src 已进过 seenDirs（真实场景由投影层 applyDirAccess 追加）
    const ctx = { seenDirs: ['src'], pendingDir: 'other', pendingDirCount: 2 }
    const r = evaluateClusterShift(ctx, 'src')
    expect(r.shifted).toBe(false)
    expect(r.next.pendingDir).toBeNull()
    expect(r.next.pendingDirCount).toBe(0)
  })

  it('换另一个新目录 → 重置计数', () => {
    let ctx = evaluateClusterShift(ctx0, 'src').next
    const r = evaluateClusterShift(ctx, 'other')
    expect(r.next.pendingDir).toBe('other')
    expect(r.next.pendingDirCount).toBe(1)
  })
})

describe('分数制合议', () => {
  it('信号分数表（弱信号 < 强信号；实测校准：file-cluster-shift 为弱）', () => {
    expect(SIGNAL_SCORES['file-cluster-shift']).toBeLessThan(1)
    expect(SIGNAL_SCORES['user-correction']).toBeGreaterThanOrEqual(1)
    expect(SIGNAL_SCORES['todo-completed']).toBeLessThan(1)
  })

  it('弱信号组合（todo+lexical）不触发边界', () => {
    expect(decideBoundary(['todo-completed', 'lexical-hint'])).toBe('pending')
  })

  it('强信号单独触发边界（user-correction；file-cluster-shift 弱信号不触发）', () => {
    expect(decideBoundary(['user-correction'])).toBe('boundary')
    expect(decideBoundary(['file-cluster-shift'])).toBe('pending')
  })

  it('弱信号+强信号触发', () => {
    expect(decideBoundary(['todo-completed', 'user-correction'])).toBe('boundary')
  })

  it('空信号 → drop', () => {
    expect(decideBoundary([])).toBe('drop')
  })

  it('阈值常量一致', () => {
    expect(BOUNDARY_SCORE_THRESHOLD).toBeGreaterThan(0)
  })
})

describe('用户消息文本提取', () => {
  it('只取 text 块', () => {
    const text = userMessageText(userEvent('/task 测试'))
    expect(text).toBe('/task 测试')
  })

  it('不读 event.time（时间戳非判据）——不同 time 判定结果一致', () => {
    const a = userEvent('先别动手', 1)
    const b = { ...userEvent('先别动手', 1), time: 9999999 }
    expect(isUserCorrection(userMessageText(a))).toBe(isUserCorrection(userMessageText(b)))
  })
})

describe('语义票合议（decideBoundaryWithSemantic）', () => {
  const off = { mode: 'off' as const, threshold: 0.5 }
  const on = { mode: 'on' as const, threshold: 0.5 }

  it("'off' 档忽略语义票（票漂移也不转正）", () => {
    expect(decideBoundaryWithSemantic([], { score: 0.1 }, off)).toBe('drop')
    expect(decideBoundaryWithSemantic(['user-correction'], { score: 0.1 }, off)).toBe('boundary')
  })

  it("'on' 档：无机械信号 + 票漂移（score < threshold）→ 转正——embedding 主判据", () => {
    expect(decideBoundaryWithSemantic([], { score: 0.4 }, on)).toBe('boundary')
  })

  it("'on' 档：无机械信号 + 票同任务（score ≥ threshold）→ 不转正", () => {
    expect(decideBoundaryWithSemantic([], { score: 0.6 }, on)).toBe('drop')
  })

  it("'on' 档：无票（null，embedding 失败）→ 纯机械底线", () => {
    expect(decideBoundaryWithSemantic([], null, on)).toBe('drop')
    expect(decideBoundaryWithSemantic(['user-correction'], null, on)).toBe('boundary')
  })

  it("'on' 档：票漂移 + 机械强信号 → 转正（证据双通道，取并）", () => {
    expect(decideBoundaryWithSemantic(['user-correction'], { score: 0.2 }, on)).toBe('boundary')
  })

  it("'on' 档：弱信号组合（todo+lexical）无票 → 仍 fail-lazy", () => {
    expect(decideBoundaryWithSemantic(['todo-completed', 'lexical-hint'], null, on)).toBe('pending')
  })
})
