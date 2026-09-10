/**
 * 编译期结构锚原语（唯一出处；platform 各触点单元共用）。
 *
 * 用途：`AssertAssignable<A extends B, B>` —— 本地结构面与 harness 权威形状做互赋性断言，
 * 任一处漂移即 `typecheck` 红。总纲不变式（REPAIR-2026-09-10 §8）：**能被编译器抓住的漂移
 * 不许留到运行期**；编译器抓不住的漂移必须留锚或留事实。本文件只提供原语，具体锚在各单元声明。
 *
 * 模块: platform 编译期锚（唯一 harness 触点层的类型级工具）
 * 平面: L0（纯类型；零运行期代码）
 * 回退链步数: 0（类型级，无运行期失败面）
 * 审查清单: 零 import、零运行期语句——不得演变成通用类型工具库。
 * 度量: 无。
 */

/** `A` 必须可赋给 `B`；不成立即 typecheck 红（`B` 由调用处显式给出，避免被推断成 unknown）。 */
export type AssertAssignable<A extends B, B> = true
