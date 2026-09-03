/**
 * Archive — 留档完整性辅助（2026-09 计费核验补齐）：
 *   writeCompressSnapshots(runDir, snapshots) — 把每次压缩前/后的完整消息快照
 *   （runner.compressSnapshots，断言已验证的深拷贝 plain JSON）落盘为 JSONL，
 *   每行 { index, range, before, after }。零语义影响：纯增量写盘。
 *
 * 配合 run-cascade/run-one 的 RecordingGateway（calls.jsonl 完整 req/resp），
 * 三者共同构成「字节级可复验」留档：压缩前原文（before）/压缩器实际输入
 * （calls.jsonl req）/压缩产物（P-*.json）/压缩后上下文（after）。
 */
import fs from 'node:fs'
import path from 'node:path'

export function writeCompressSnapshots(runDir, snapshots = []) {
  const file = path.join(runDir, 'compress-snapshots.jsonl')
  const lines = (Array.isArray(snapshots) ? snapshots : []).map((s, i) => JSON.stringify({ index: i, ...s }))
  fs.writeFileSync(file, lines.length > 0 ? lines.join('\n') + '\n' : '')
  return lines.length
}
