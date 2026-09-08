# P21b 全链验收 + 可视化（R4 关门单；依赖 P21a；尺寸 M）

> 正典：[docs/10 §6 缓存对齐检查点](../10-wiring.md)（断言 1–4）+ [docs/04 §3 生产/消费不对称律 / §8 验收标准](../04-compactor.md)
> + [docs/11 §8 R4 出门门槛](../11-structure.md)。本单把「协议级断言」从设计态落成 **CI 里可跑的机械用例**，
> 不新增机制代码（除 §8-3 决策外）。

## 1. 目标

R4 关门：把**四触发次序交错闭合**（共享模块用例）与**四道缓存断言**从文档验收项变成
`npm test`（gate 内）必过的用例；并把「关闭任一层其余完整」补成机械断言。
度量消息列表可视化 = **加分项**，本单**不做**（落位计划见 §4-4）。

## 2. 输入

- `core/compress/consume.ts` `planTailConsumption`（四次序闭合表，P18 交付）+
  `core/assemble/archive.ts` `archiveChainShape`/`archiveChainAppendOnly`（P17c 交付）。
- `domains/compaction.ts` 真域（H2 边界 + H3 压力 + 保险丝）与既有 fake env 夹具。
- 缓存断言对应实现面：`renderRegionTranscript`（前缀性质）· 纯核 fold/render（字节稳定）·
  `renderBoundaryPrompt`/`renderPressurePrompt`/`renderJudgePrompt`（同 purpose 模板前缀）·
  `appendArchiveEntry`/`truncateArchiveArea`（只追加 + 整条截断）。

## 3. 产出

| 文件 | 动作 | 内容 |
|---|---|---|
| `tests/full-chain-order.spec.ts` | 新 | 四触发次序：共享模块闭合表（边→边/边→压/压→边/压→压）+ 域侧混合次序 e2e + 层隔离（关 boundary/关 pressure） |
| `tests/cache-invariants.spec.ts` | 新 | 四道缓存断言（10 §6）：① 前缀性质 ② 同版本逐字节一致 ③ 同 purpose 辅助调用共享模板前缀 ④ 档案只追加/整条截断 |
| `scripts/verify-p21b.mjs` | 新 | 机械验收（本单 §5）+ R4 出门门槛汇总（调用 P15a–P21a 全部 verify） |
| `docs/implement/00-master.md` | 改 | P21b 行标记 + 施工记录 + R4 关门声明 |
| `docs/11-structure.md` | 改 | 状态行（R4 完成）+ §8 R4 出门门槛勾选 |
| `AGENTS.md` / `docs/ledger-history.md` | 改 | 现状 + 快照 §50（只增不改） |

## 4. 实现要点

1. **四次序闭合表**（纯核，04 §3）：对 `priorChain` 三形态（空 / boundary 块 / checkpoint 块）×
   本次层（boundary / pressure）逐一断言 `planTailConsumption` 的
   `{ok, form, carryCount, appendKind, foldMaterial}`；非法链形态 → `ok:false chain-invalid`。
2. **域侧混合次序**：真 `mountCompactionDomain` 跑「边→压」与「压→边」，断言档案链
   `[boundary, checkpoint]` / `[checkpoint, boundary]` 两形态、`carried` 计数、
   **先前条目逐字节不变**（只追加）。
3. **四道缓存断言**：
   - ① 前缀：追加事件后 `renderRegionTranscript` 旧输出为新输出前缀（同输入同输出 + 尾部增长）；
   - ② 同版本逐字节：`foldSegmentState`/`rebuildDossiers`/两次 `appendArchiveEntry` 的 JSON 全等；
   - ③ 同 purpose 模板前缀：同 purpose 两次渲染的**公共前缀 ≥ 模板长度**，实例数据只出现在尾区
     （模板在前 + 实例在后；真前缀形态的偏差见 §8-3）；
   - ④ 只追加：`appendArchiveEntry` 后旧条目逐字节不变；硬帽截断只删最老**整条**，绝不改写；
     `archiveChainAppendOnly` 对两形态恒真。
4. **可视化（加分项，本单不做）**：落位计划 = 仿 harness `ui-workflow-run`：
   注册 `ConversationNodeDefinition`（消费 `context-economy/*` 事件）+ keyed
   `conversation.chat.node` 渲染器（轻量条目：剪了多少/压了什么）。**不做理由**：
   ① 需新增 client 模块与节点定义（壳结构改动，超本单 M 预算）；② 真机浏览器验收
   在本环境不可完成（无 UI 观测面）——按「不做假验证」纪律，留独立 client 单（P22+）。

## 5. 验收（全机械；[x] = 实测已过，2026-09-09）

- [x] `npm run gate` → **552 用例 / 53 文件**（M1–M5 / S1–S5 / D1–D17 全 PASS，`ok=true vacuous=[]`）；`npm run typecheck:tests` 绿；build 绿（host + client）
- [x] `node scripts/verify-p21b.mjs` → **P21b VERIFY PASS（22 checks）**（四次序闭合表 + 四缓存断言实跑 + CI 用例实跑 + R4 出门门槛汇总）
- [x] 回归：`verify-p21a`（32）/ p20（35）/ p19（27）/ p18（45）/ p17（54）/ p16（30）/ p15b（19）/ **p15a（10，陈旧白名单已收编）** 全 PASS
- [x] R4 出门门槛（11 §8）：`hotTail*/pressure*/archiveTruncate` 入账；强制重读率经 07 账本可观测；
      `auto:false` 协调生效；结构断言全绿；**验收发现并修正 2 处问题**（§8-6 边界起点缺陷 / §8-7 陈旧白名单）
- [x] 文档同步：总纲 P21b 行 + 施工记录 + R4 关门声明；11 状态行/§8；AGENTS；快照 §50

## 6. 禁区与注意

- 不动 `datasets/`、`experiments/`、`reports/`、`scripts/attic/`；不改 docs/00–11 设计正文（只改状态行/门槛勾选）。
- **N1**：本单原则上**零机制代码改动**；若全链验收发现缺陷 → 记 §8 决策项。**实际发生 1 处**（见 §8-6）：
  `runBoundary` 起点定位缺陷，因属「验收门槛不通过」的阻塞缺陷，本单**就地修正 + 加回归用例**（已申报）。
- **N2**：断言 ③ 的「真前缀」口径偏差（压缩/判别 prompt = 模板在前单字符串，非原生 compaction 的
  上一次请求真前缀）在 P19 §8-3 已记账；本单以「同 purpose 共享模板前缀」形式落 CI，并把
  「是否改真前缀布局」作为 R4 出门决策项如实上报（不改正典、不静默）。
- **N3**：可视化不做 ≠ 承诺不做；§4-4 给出落位计划与理由，进路线图。
- **N4**：尺寸申报见 §6.5（工单执行后回填）。

## 6.5 尺寸申报（实测，`git diff --numstat`）

- **src 净增 2**（`domains/compaction.ts` +3/−1 = 起点定位缺陷修正；本单唯一机制改动，已申报）。
- tests **428**（`full-chain-order.spec.ts` 287 + `cache-invariants.spec.ts` 141）；`verify-p21b.mjs` **168**；
  `verify-p15a.mjs` +2（陈旧白名单收编）；工单 94。
- 尺寸合规：**M 预算内**（机制改动 ≈0；主体 = 验收用例）。

## 7. 完成动作

- commit：`2827846 test(p21b): 四触发次序闭合 + 四道缓存断言进 CI（含边界起点缺陷修正）`；
  `docs(p21b): 工单 + 快照 §50 + R4 关门`。
- 账本快照：`docs/ledger-history.md` §50（只增不改）。

## 8. 计划修正与决策项

| # | 项 | 处理 | 依据 |
|---|---|---|---|
| 1 | 04 §8「四触发次序交错闭合（共享模块用例）」 | 落为纯核闭合表 4 次序 + 域侧两混合次序 e2e | 验收按次序组织（04 §3） |
| 2 | 10 §6 断言 1–4「进 CI」 | 落为 `cache-invariants.spec.ts` 四组用例（gate 内） | 10 §6 / 06 §7 |
| 3 | 断言 3 真前缀口径 | 以「同 purpose 共享模板前缀」落 CI；**R4 出门决策项**：是否改真前缀布局（P19 §8-3 遗留） | 不改正典、如实记账 |
| 4 | 11 §5 度量可视化（加分项） | **不做**；落位计划 + 理由（超预算 + 无浏览器验收面） | 不做假验证 |
| 5 | 10 §8「关闭任一域其余完整」 | 补层隔离用例（关 boundary → 压力仍工作；关 pressure → 边界仍工作；双关 → 零行为不抛） | 10 §8 |
| 6 | 全链验收**发现 1 处边界路径缺陷** | `runBoundary` 起点 = `surface.find(seq >= segment.startSeq)`：压缩产物节点（checkpoint）**seq 高但排在表面表头**，在「多闭合段积压」场景（恢复后 / 曾关 `compression.boundary`）被当起点 → 区间反空 → **每步 rangeSkip 卡死，后续闭合段永不归档**。修正 = 起点同时满足 `seq < nextStartSeq`；回归用例「积压多闭合段 → 逐次各压一个」入 CI | 04 §2 区间落表面 + 09 §4 恢复语义 |
| 7 | 全链验收**发现 1 处陈旧验收表** | `verify-p15a` 的 core/shear 接线白名单未随 P19/P20 更新（`domains/compaction.ts` 自 P19 起合法消费 shear 事实做 T-boundary 搭车会计）→ P15a 脚本单跑必红。修正 = 白名单收编 `domains/compaction.ts`（带依据注释） | 11 §2 依赖铁律 + 03 §2 |
