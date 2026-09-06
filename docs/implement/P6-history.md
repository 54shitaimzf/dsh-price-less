# P6 改史端口（映射 R1；依赖 P1；尺寸 M）

> 状态：**已施工（工作树验收全绿；`node scripts/verify-p6.mjs` 输出 `P6 VERIFY PASS`）**。
> 设计正典：[10 §1 H4/H5](../10-wiring.md)（改史唯一通道 + 压缩事务）/
> [11 §2](../11-structure.md)（history.ts 行 + 依赖铁律）/
> [04 §1](../04-compactor.md)（共享事务原语 + 配对平衡）/ [05 守卫表](../05-constitution.md)。
> harness 符号清单：`Session.append`、`Session.surface.nodes`、`Session.snapshotEvents`、
> `Session.eventAt`（`@deepseek-ai/dsh-session`）；
> `CompactionId`、`toolPairingBalancedBefore/After`（`@deepseek-ai/dsh-compaction`）。

## 1. 目标

实现 `src/platform/history.ts`，把「改史」的机械协议收口到唯一 platform 端口：
- H4：`surfaceOp.replace` + 完整 `sourceEventSeqs`（被遮蔽表面节点自动补全）；
- H5：`compaction/start … end` 事务标记对（日志扫描防重入，重启后仍可发现未闭合事务）；
- `compaction/prune` 影子计价；
- 配对平衡守卫（可注入，默认 harness `toolPairingBalanced*`）。

本单只做协议层，不触发剪切/压缩业务，不给 `index.ts` 增加装配行为。

## 2. 输入与决策

### 2.1 关键设计决策

1. **sourceEventSeqs 由端口机械补全**：调用方只声明额外引用源；被遮蔽集合永远从
   `session.surface.nodes` 当前值计算，不可能漏列（H4 契约）。
2. **assistant/message 禁止 sourceEventSeqs**：与 harness 类型契约一致，端口显式抛错。
3. **事务状态从会话日志扫描**：不依赖进程内可变标志；重启/恢复后仍能发现未闭合
   `compaction/start`，杜绝绕过日志的锁状态。
4. **配对平衡默认走 harness 官方实现**：不重抄工具对算法；测试注入 fake checker，
   因此 `tests/history.spec.ts` 零真 harness 运行时依赖。
5. **新增 peerDeps/build 链接**：`@deepseek-ai/dsh-compaction`（compaction/* 类型 +
   pairing）、`@deepseek-ai/dsh-commands`（dsh-compaction 类型依赖的 brand）。
6. **D7 结构规则**：history 协议概念（CompactionId/compaction/*/toolPairing/
   dsh-compaction）只许出现在 `src/platform/history.ts`，防止域层绕端口。

### 2.2 现有文件

| 路径 | 动作 |
|---|---|
| `src/platform/history.ts` | **新**（H4/H5 协议 + pairing） |
| `tests/history.spec.ts` | **新**（10 用例，fake session） |
| `scripts/verify-p6.mjs` | **新**（机械化验收入口） |
| `scripts/assert-structure.mjs` | **追加 D7** |
| `tests/assert-structure.spec.ts` | **D7 负/正样本 + 快照** |
| `package.json` | peerDeps += dsh-compaction/dsh-commands |
| `scripts/build.sh` | += dsh-commands/dsh-compaction 链接 |
| `tsconfig.tests.json` | += tests/history.spec.ts |
| `docs/10-wiring.md` / `docs/11-structure.md` / `docs/13-harness-plugin-spec.md` | 状态回写 |

## 3. 产出

### 3.1 `src/platform/history.ts`（≤280 行）

- `HistoryError`（code + message）；
- `SurfaceRange` / `ReplaceSurfaceRequest` / `HistoryReplaceResult`；
- `PairBalanceChecker` / `nativePairBalanceChecker`；
- `ActiveCompaction` / `CompactionBegin` / `CompactionEnd`；
- `createHistoryPort(session, options?)`：
  * `replaceSurface`：计算 shadowedSeqs、合并 sourceEventSeqs、调用 `Session.append`；
  * `beginCompaction` / `endCompaction` / `assertNoActiveCompaction` / `findActiveCompaction`；
  * `recordPrune`：按当前表面生成 `compaction/prune`；
  * `balanceRange` / `pairBalancedBefore` / `pairBalancedAfter`。

### 3.2 `tests/history.spec.ts`（≤260 行）

H4：自动补全 + 额外引用合并 + 非法区间 + assistant 禁源。
H5：begin/end + 防重入 + ID/turn 校验 + 日志扫描 + recordPrune。
配对：balanceRange 收缩 + 无平衡点 null + checker 委托。

### 3.3 `scripts/verify-p6.mjs`（≤140 行）

`npm run gate` → build → assert 双跑字节一致 + D7 pass → history.ts 必备符号/禁词 →
peerDeps/build 链接 → 行数预算 → P6 VERIFY PASS。

## 4. 验收（已全绿）

- [x] `npm run gate` 全绿（typecheck ×3 + 130 tests + assert）
- [x] `node scripts/verify-p6.mjs` 输出 `P6 VERIFY PASS`
- [x] `DSH_CHECKOUT=G:/deepseek-harness npm run build` 通过
- [x] `tests/history.spec.ts` 10 用例全过
- [x] assert `--json` 双跑字节一致，D7 pass
- [x] 行数预算不超

## 5. 完成动作

- 单笔提交：`feat(p6): 改史端口——H4 surfaceOp replace/sourceEventSeqs + H5 事务对 + 配对平衡守卫 + D7 收口`
- 账本快照：本单不需要（无 docs/07 字段产出；剪切/压缩域后续经端口返回值入账）。
