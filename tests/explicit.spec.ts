/**
 * 显式指令纯函数单测（无 harness：纯 node 运行，不启动 DSH）。
 * 覆盖：T0 显式边界、用户消息文本提取、无时间戳依赖（不读 event.time）。
 * v0.3.0：机械判定层（T1 信号/簇迁移/分数合议）已退役，本文件不再覆盖。
 */
import { describe, expect, it } from 'vitest'
import {
  classifyExplicitUserMessage,
  extractTaskName,
  isExplicitTaskClose,
  isExplicitTaskCommand,
  userMessageText,
} from '../src/task/explicit.js'

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

describe('用户消息文本提取', () => {
  it('只取 text 块', () => {
    const text = userMessageText(userEvent('/task 测试'))
    expect(text).toBe('/task 测试')
  })

  it('不读 event.time（时间戳非判据）——不同 time 判定结果一致', () => {
    const a = userEvent('/task 测试', 1)
    const b = { ...userEvent('/task 测试', 1), time: 9999999 }
    expect(userMessageText(a)).toBe(userMessageText(b))
  })
})