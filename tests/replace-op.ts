/**
 * 测试用 replace `surfaceOp` 期望形状（HC2 / 升级 runbook `docs/14`）。
 *
 * **这里刻意不复制端点键名**——单一事实源 = `platform/history.ts` 的 `REPLACE_OP_KEYS`。
 * 键名本身的权威钉法有两条，都不走本助手：
 *   ① 编译期 `ReplaceOpAnchor` / `ReplaceOpAnchorBack`（键名或 `SurfaceOp` 形状漂移 → typecheck 红）；
 *   ② `tests/history-real-session.spec.ts`（**真** harness 校验器实际接受该形状）。
 * 因此本助手只承担"区间端点被正确透传、且恰好是这三个键"的断言，不承担键名契约。
 */
import { REPLACE_OP_KEYS } from '../src/platform/history.ts'

/** 构造期望的 replace `surfaceOp`（键名取自 `REPLACE_OP_KEYS`）。 */
export function expectedReplaceOp(start: unknown, end: unknown): Record<string, unknown> {
  return { op: 'replace', [REPLACE_OP_KEYS.start]: start, [REPLACE_OP_KEYS.end]: end }
}

/** 期望的端点键名集合（恰好 3 键的断言用；顺序无关）。 */
export const EXPECTED_REPLACE_KEYS: readonly string[] = ['op', REPLACE_OP_KEYS.start, REPLACE_OP_KEYS.end]

/**
 * 测试替身专用：读 replace `surfaceOp` 的区间端点（键名取自 `REPLACE_OP_KEYS`）。
 *
 * 替身**必须**走本函数，不许写字面 `op.start`：基线一换，字面读法静默取到 `undefined`，
 * 于是替身不再执行 replace（表面不收敛），失败会伪装成"别的原因"。
 * 2026-09-10 实测：6 处替身同时踩中（升级 runbook `docs/14 §3`）。
 *
 * @returns 端点；非 replace 形状或端点非数值 → undefined（替身按"不改表面"处理）。
 */
export function replaceEndpoints(surfaceOp: unknown): { start: number; end: number } | undefined {
  if (typeof surfaceOp !== 'object' || surfaceOp === null) return undefined
  const op = surfaceOp as Record<string, unknown>
  if (op.op !== 'replace') return undefined
  const start = op[REPLACE_OP_KEYS.start]
  const end = op[REPLACE_OP_KEYS.end]
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined
}
