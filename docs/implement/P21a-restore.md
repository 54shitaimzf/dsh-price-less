# P21a 恢复编排（R4 收官前置；依赖 P20a,P20b,P3；尺寸 M）

> 设计正典 = [docs/09 §4 恢复契约](../09-state.md) + [docs/10 §1 H9](../10-wiring.md)。
> harness 符号清单（逐条 grep 到定义处，checkout `G:/deepseek-harness`）：
> - 挂点事件：`agent/session-start`（emit，非 waterfall）——payload `{ agent, source }`，
>   `source: SessionStartSource = 'startup'|'resume'|'clear'|'compact'`
>   `packages/core/agent/src/runtime-types.ts:71/262`；发出点 `packages/core/agent-loop/src/index.ts:665`。
> - 构造种子定界：`Session.firstLiveSeq`（`packages/core/session/src/index.ts:486`；种子不上 firehose）。
> - 自扫全史：`Session.snapshotEvents(fromSeq?, toSeqExclusive?)`（同上 :622）——恢复期唯一完整历史入口。
> - KV 原语（P3 已交付）：`ContextEconomyStorage.getEntity/putEntity/rollbackEntity/auditEntity/listFactMirror`
>   （`src/platform/storage.ts:65-74`）。
> - 双源等价断言：`assertFactSourcesEquivalent`（`src/core/ledger/facts.ts:25`，docs/12 §3）。

## 1. 目标

把「KV 损毁 → 日志回放重建」从设计态落成**可机械验收的恢复序**：
`agent/session-start`（种子会话）→ 按 [09 §4](../09-state.md) 顺序逐项核对 → 能重放的用日志重放
（卷宗/段状态机/度量缓存）→ 能回退的用快照回退（项目帧）→ 不可重放的如实降级（边界档案/优化产物）
→ 每步 `restore/step`、失败 `restore/degraded`、完成 `restore/done` 三类 ignorable 事实入账，
07 字段 `restoreDegraded` 由 fold 产出。

**核心纪律**：恢复是**只读 + 可重建才写**的路径——不调模型、不改史、不新建会话事件类型之外的副作用；
失败方向永远朝用户数据安全侧（坏形状 → 不覆盖盘上字节，只降级计数）。

## 2. 输入

- 挂点：`agent/session-start`（H9；**同步 emit，不可 veto**，异步恢复体必须自行遏制异常）。
- 触发条件：`session.firstLiveSeq > 0`（构造种子非空 = 有持久历史可核对）；fresh 会话零动作零事实。
- 真源：会话 JSONL（`snapshotEvents()` 全史）+ durable KV（四实体表 + `fact_mirror`）。
- 已有纯核：`foldSegmentState`（段状态机）、`factsFromSessionEvents`（事实抽取）、
  `createDossier/appendDossierMessage/annotateDossier/sessionScopedTaskId/dossierStorageKey`（卷宗重建）、
  `readArchiveStore`（档案形状校验）、`foldDossierLedger`（重建结果核对）。

## 3. 产出

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/core/restore/plan.ts` | 新 | 恢复序词表与顺序（`RESTORE_STEPS`）+ 实体审计（`auditEntityRecord`：missing / version-mismatch / corrupt）+ 各表形状校验器 |
| `src/core/restore/rebuild.ts` | 新 | 日志回放重建：`rebuildDossiers`（段区间归属 + judge-recorded 标注回放）、`summarizeRestore` |
| `src/core/restore/ledger.ts` | 新 | 三类事实载荷 + `foldRestoreLedger`（07 `restoreDegraded`） |
| `src/core/restore/index.ts` | 新 | barrel（仅具名导出） |
| `src/platform/agent-step.ts` | 改 | H9 收口 `onAgentSessionStart`（`agent/session-start` 字面唯一处，D16） |
| `src/domains/restore-facts.ts` | 新 | 三类 ignorable 声明合并（D3 白名单） |
| `src/domains/restore.ts` | 新 | 恢复编排：`onSessionStart` → 逐项恢复 → 事实发射；`run()` 供演练/验收 |
| `src/index.ts` | 改 | 同步注册 H9（**带 pending 缓冲**，避免 storage 异步打开期丢事件）+ 域挂载 |
| `scripts/assert-structure.mjs` | 改 | 追加 D16（H9 收口）/ D17（core/restore 确定性）+ D3 白名单加 `domains/restore-facts.ts` |
| `tests/restore-core.spec.ts` / `tests/restore-domain.spec.ts` | 新 | 纯核 fixture + fake storage/session 端到端 |
| `scripts/verify-p21a.mjs` | 新 | 机械验收（本单 §5） |

## 4. 实现要点

1. **恢复序（09 §4 + 本单补正）**：`project_frame → dossier → boundary_archive → optimize_artifact → segment_state → metrics_cache`。
   前四项 = durable 实体；后两项 = 纯函数重算。`optimize_artifact` 为**本单补入**（09 §4 表漏列第四实体，
   见 §8-1），策略 = 只读校验（不重建）。
2. **项目帧**：审计 → 坏则用 `auditEntity` 找**最新合法快照版本** → `rollbackEntity(targetVersion)`（快照回退，
   P3 原语；写入带 source `rollback`）；无可用快照 → `restore/degraded`（`rollback-unavailable`，需重新 init）。
3. **卷宗**：审计 → 坏则**日志重放重建**（用户消息经 `readSessionUserMessages` 平台面过滤 + 段区间归属 +
   `judge-recorded` 的 `class` 作 `auto` 标注）→ 写回 KV（missing 用 `baseVersion:0`；
   坏记录用 `baseVersion:当前版本`，CAS 前进并留存损毁版快照）。
4. **边界档案**：审计（`readArchiveStore` 形状 + schemaVersion + workspace）→ 坏则**只降级不重建**
   （LLM 产物不在日志里；重建需再调模型 = 违反"恢复零模型"）；盘上字节不动（失败默认保留）。
5. **优化产物**：只读审计（version-mismatch/corrupt 检测）→ 坏则降级（用户可重新星标生成）。
6. **段状态机**：`foldSegmentState` 全史重放（纯函数，恒可重建）→ 报 `rebuilt = taskCount`。
7. **度量缓存**：`context-economy/*` 事实重放计数 + **双源等价核对**——`fact_mirror` 非空且与
   `factsFromSessionEvents(全史)` 不等价 → `restore/degraded`（`mirror-divergence`）+ `version-mismatch`；
   镜像为空（通道健康）= 正常态，不算降级。
8. **零成本零动作**：fresh 会话（`firstLiveSeq === 0`）直接 return；同会话重复 session-start 由
   `WeakSet` 去重（幂等）。
9. **失败遏制**：恢复体整体 try/catch → `restore/degraded`（`internal`）+ warn，**绝不上抛**（H9 不可 veto）。
10. **演练注入**：域构造参数 `drill.damaged`（`entityKey → 'missing'|'corrupt'|'version-mismatch'`）
    供机械验收模拟 KV 损毁，不污染生产路径。

## 5. 验收（全机械；[x] = 实测已过，2026-09-09）

- [x] `npm run gate` → **532 用例 / 51 文件**（M1–M5 / S1–S5 / D1–**D17** 全 PASS，`ok=true vacuous=[]`）；`npm run typecheck:tests` 绿；build 绿（host + client）
- [x] `node scripts/verify-p21a.mjs` → **P21a VERIFY PASS（32 checks）**（文件/导出面/结构/纯核 fixture/端到端/降级/双源/幂等/真机回放/文档/尺寸）
- [x] 回归：`verify-p20`（35）/ `verify-p19`（27）/ `verify-p18`（45）/ `verify-p17`（54）/ `verify-p16`（30）/ `verify-p15b`（19）→ PASS
- [x] 真机只读回放：44 会话 / 可重放 41 / 含卷宗 41 / 重建消息 190 / 双跑漂移 0；live `restore-*` 事实 = **0**（需重启加载新构建）
- [x] 文档同步：docs/09 状态行 + §4 补注；docs/10 H9 状态；docs/11 树/状态行/§9；总纲 P21a 行 + 施工记录；
      AGENTS 现状；`docs/ledger-history.md` 快照 §49（只增不改）

## 6. 禁区与注意

- 不动 `datasets/`、`experiments/`、`reports/`、`scripts/attic/`；不改 docs/00–11 设计正文
  （本单只在 09 §4 加"补注"一行，正文表不动）。
- **N1**：恢复期**零模型调用、零改史**（H4 不碰；只 KV 写 + 事实发射）。
- **N2**：`agent/session-start` 字面只许出现在 `platform/agent-step.ts`（D16）；域侧只见
  `{ session, source }`。
- **N3**：core/restore 零 harness import（S1）+ 零时钟/随机（D17）——`at` 一律由域侧传入。
- **N4**：边界档案与优化产物**不重建**（LLM 产物不可确定性再生）；失败默认保留盘上字节。
- **N5**：双源核对只在镜像非空时判不等价（通道健康 = 镜像空 = 正常，不得误报降级）。
- **N6**：H9 监听在 `apply()` 同步注册 + pending 缓冲；storage 打开后回放 pending（防启动竞态丢事件）。
- **N7**：尺寸申报（实测）见 §6.5（工单执行后回填）。

## 6.5 尺寸申报（实测，`git diff --numstat`）

- src 净增 **870**（新增 877 / 删除 7）：`core/restore` **400**（plan 157 / rebuild 121 / ledger 118 / index 4）
  + `domains/restore.ts` **368** + `domains/restore-facts.ts` **34** + 端口/接线/键面 **68**（agent-step +33 / index +30 / star +5）。
- **超 M 预算（2–4 文件 ≤400 净增）已申报**：本单跨 7 个 src 文件、净增 ≈2.2×。理由：恢复序天然是
  「纯核审计/重放 + 端口收口 + 域编排 + 配置无关的接线」四段；纯核自身 4 文件已顶满文件数与 400 行。
  拆单方案（若审查要求）：**P21a1** = `core/restore/`（纯核 + fixture，零接线，≈400）/
  **P21a2** = 端口 + 域 + 接线（≈470）。本单按「一个可独立验收的恢复序」一次落位，两笔提交
  （feat 实现 / docs 工单+快照）分开。
- spec **422**（`restore-core` 154 + `restore-domain` 268）；`verify-p21a.mjs` **424**；assert 规则 +2（D16/D17）。

## 7. 完成动作

- commit：`0386f14 feat(p21a): 恢复编排（H9 恢复序 + 日志回放重建 + restore-* 事实）`；
  `docs(p21a): 工单 + 快照 §49 + 文档同步`。
- 账本快照：`docs/ledger-history.md` §49（只增不改），含 `restoreDegraded` 读数与真机回放口径。
- **事实名澄清**：文档里的 `restore/*` = 事实族简写；实际会话事件名 =
  `context-economy/restore-step` / `restore-degraded` / `restore-done`（与既有扁平命名一致）。

## 8. 计划修正（相对 09 §4 / 总纲 P21a 行）

| # | 原计划 | 本单细化 | 依据 |
|---|---|---|---|
| 1 | 09 §4 恢复序 5 项（项目帧/卷宗/边界档案/段状态机/度量缓存） | 补入第四实体 `optimize_artifact`（只读审计 + 降级），其余顺序不变 | 09 §2 四实体表含优化产物；漏列会使恢复覆盖不全 |
| 2 | 总纲：`domains/restore.ts` + `restore/*` 事实 | 细化为 core/restore 三文件（plan/rebuild/ledger）+ 域编排 + H9 端口；事实三类 | 度量先行（`restoreDegraded` 先有 fold）+ 纯核可 fixture |
| 3 | 「KV 损毁→日志回放重建」笼统 | 分策略落位：卷宗=重放写回 / 项目帧=快照回退 / 档案+产物=降级不重建 / 段状态机+度量=纯函数重算 | 可重建性分析（LLM 产物不在日志、档案正文不在事实） |
| 4 | H9「重启重建需自扫或订阅时区分」 | 自扫入口 = `snapshotEvents()` 全史；`firstLiveSeq>0` 为触发条件；监听同步注册 + pending 缓冲 | harness 种子不上 firehose 的事实约束 |
| 5 | 双源降级（docs/12 §3）仅设计态 | 恢复序内落地 `fact_mirror` ↔ 会话事实等价核对（非空才判） | 12 §3 降级契约 + `assertFactSourcesEquivalent` |
| 6 | P20c 对接：压力检查点链 / 档案 KV 形态 | 恢复只校验 `readArchiveStore` 形状（含 `cutPointSeq/rangeEndSeq` 可选字段），**不重建** | P20 压力档案正文亦不在事实里 |
