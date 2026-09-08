# 待办清单 · 真机复盘修复 + 写时剪除方向

> **用途**：只记**未完成 / 被阻塞**项与出门门槛。
> **口径**：🔶 进行中（等用户动作）· ⬜ 待办 · ✅ 已完成不展开。
> **建立**：2026-09-09（N3b 落地之后）。**更新**：2026-09-09 真机复盘修复单 F1–F5 + F8a/F8b + **F3/F11/F12/F13（快照 §70）**
> + **N 系列协商线退役（快照 §71）**。

---

## §1 N 系列协商线：已退役 ✅（2026-09-09）

**用户裁定**：协商线整体移除——`shear.negotiate` 配置、`core/shear/{negotiate,conclusion}.ts`、两型
`shear-negotiation-*` 事实、账本协商段、T-note 档与 `CUT-OK`/`CUT-HOLD` 标记协议、预设 persona 协议段全部删除。

**依据（真机只读回放）**：44 会话 / 5,032 条 tool/result → 选样 633、实际挂出注记 68 条，
**CUT-OK 0 / CUT-HOLD 0 / 无回复 100%**；叠加 N2 探针 0/134 ≈ 770 条样本零配合。

**替代方向约束（用户裁定）**：
1. 语义剪除必须**写时确定性**——剪点必须在结果入账前定死（= T-entry，断裂成本 0）；
2. **行为信号不可用**（等后续轮次再判断再剪）：会在前缀已缓存后改史 → 缓存断裂。

**保留**：N1 身份通道（`core/shear/classify.ts`，候选普查）；T0 / T0-R / run 冲刷等机械档（**T-loop 已退役，账本 §72**）。

---

## §2 真机缺陷修复单（2026-09-09）

| 单 | 内容 | 状态 | 落点 |
|---|---|---|---|
| **F1** | **工具端口注入**：`ctx.tools` → `ctx.inject([tools])` + `getTools` 回调（原缺陷 = 端口整体空转：T-entry/T0/协商注记全无） | ✅ | `src/index.ts`、`src/platform/tools.ts`、`src/domains/shear.ts` |
| **F2** | **边界压缩阻塞**：pre-step 先等本轮判词落地（`settle` 屏障，**60s** 有界，超时 fail-lazy 退回下一 pre-step） | ✅ | `src/domains/input.ts`、`src/index.ts` |
| **F4** | **诊断日志去重**：prefix 状态变化才记录（原为每次 skill watch 回调都打，18 分钟 9,136 条） | ✅ | `src/index.ts` |
| **F5a** | **档案渲染可读性**：结论先行（wrap→plan→impl→verify）+ 类型标签（`【结论】/【计划】/【实现】/【验证】`） | ✅ | `src/core/assemble/assemble.ts` |
| **F3** | **档案/前缀按会话工作区隔离**：`domains/workspace.ts` 唯一键源（`header.cwd` 优先、回落进程 cwd），compaction/restore/input/star/commands 五站点收口 | ✅ | `src/domains/workspace.ts`（新）+ 五域；`tests/workspace.spec.ts`；快照 §70 |
| **F11** | **列表不剪**：T-entry 识别列表类命令（Get-ChildItem/gci/ls/dir/tree/fd/find）→ 不整形 + `entry-skip-listing` 事实/账本分列（真机 resume 11 次实剪全为列表，丢名字） | ✅ | `core/shear/tool.ts`、`domains/shear.ts`、`core/shear/ledger.ts`；快照 §70 |
| **F12** | ~~影子模式零字节~~ → **随协商线整体退役移除**（配置/纯核/两型事实/账本段/T-note 标记协议/预设协议段全删） | ✅ | 删除面见快照 §71 |
| **F13** | **判别器 v4**：task 定义居中（同一工作对象/同类目标持续改进）+ 言说层限定「当前对象」+ 换对象覆盖针对新对象的评价/咨询（真机：换话题单句被 v3 规则 1 吞成 continue → 漏边界） | ✅ | `core/judge.ts`、`datasets/prompt-discriminator-v2.3.txt`；快照 §70 |
| **F5b** | **坐标路径相对化**：`renderDigest` 的 coords 逐行打印绝对路径；相对化依赖 F3 的会话工作区 | ⬜ | 待 F3 |
| **F8a** | **token 估算重构**：新 core/meter/estimate.ts（DSH 结构对齐 + 两桶密度 CJK 1.5 / 其余 2.9 字符/token）；策略面 charsPerToken → density 全量随迁 | ✅ | src/core/meter/、src/core/{assemble,compress,ledger}/、src/domains/compaction.ts |
| **F8b** | **标定对账**：CompressCallLedger.calibration（估算 promptTokens vs 真实 input+cacheRead）+ warnTokenDrift（±25% 告警，只观察） | ✅ | src/core/compress/ledger.ts、src/domains/compaction.ts |
| **F8c** | **口径统一**：压力触发/保险丝用 DSH meter（中文低估 ~2.7×）、体积账用两桶——两套单位并存；统一前必须重标定 thresholdTokens/domainTokens/retainTokens/archiveCapTokens | ⬜ | 待真机 calibration.ratio 样本 |
| **F9a** | **区间权威化 + 配对平衡守卫**：压力路径补 `balanceRange`；范围端点取 `HistoryPort.surfaceNodes()`（权威表面，事件窗自折会复活已遮蔽节点）；`INVALID_RANGE` 回归 | ✅ | `platform/history.ts`、`domains/compaction.ts`、`core/compress/region.ts`；快照 §62 |
| **F9b** | **产物 schema v2**：总述（零事实）+ 分步（带 ▸n 引用）+ 热尾 1:1 指针；宽松修复（唯一硬失败 = 非 JSON）+ `fact-leak` 扫描 + parse/schema 有界重试 | ✅ | `core/assemble/{types,assemble,gate,ledger}.ts`、`core/compress/{types,prompt,product,fact-leak}.ts`；快照 §63 |
| **F9c** | **热尾事实载体**：user/assistant 消息单元 + tool-call 块转写 + Zipf `1/i` 分配 + 份额帽 + 仅指针降级 + `fact` 子串校验 + dup 去重 | ✅ | `core/assemble/assemble.ts`、`core/compress/region.ts`、`domains/{assemble,compaction}.ts`；快照 §64 |
| **F9d** | **双预算 10K/10K + 存储 v2**：`archiveCapTokens` 15K→10K；`ARCHIVE_STORE_VERSION` 2 + v1 条目兼容迁移；`archiveChainMonotone` 运行时守卫；`overCap` 入账 | ✅ | `config.ts`、`client/field-model.ts`、`core/compress/store.ts`、`core/assemble/archive.ts`、`core/restore/plan.ts`；快照 §65 |
| **F9e** | **路径压缩**：`root`（session.header.cwd）+ 相对化 + 同路径 ≥2 次短 ID 表；单元清单同源相对化；`policyKey` 含 root | ✅ | `core/assemble/paths.ts`（新）、`core/assemble/assemble.ts`、`core/compress/prompt.ts`、`domains/compaction.ts`；快照 §66 |
| **F10** | **契约 v3**：总分零指针（`refs` 退役）+ 热尾头指向档案 `vN` + 档案落盘只存总分（`digestText`）+ 错误信息不进热尾 + 配额不足改丢弃 + 路径短 ID 表退役 | ✅ | `core/assemble/{types,assemble,paths,ledger}.ts`、`core/compress/{prompt,product,types}.ts`、`domains/{assemble,compaction}.ts`、`scripts/verify-f9.mjs`；快照 §69 |
| **F9g** | **回放验收**：`scripts/verify-f9.mjs` 15/15 + `scripts/verify-f9-replay.mjs` 真机对照（旧申报重装配 10,022 vs 旧 8,209——Zipf 用满预算；**产物总量下降待用户定 `retainTokens`**）；真机重启冒烟待补 | ✅ | `scripts/verify-f9{,-replay}.mjs`；快照 §68 |

**F5a 说明**：只改渲染面（块序 + 标签），产物 schema 与校验序（`DIGEST_BLOCK_ORDER`）不变；若要真正的「总述块」需第 5 种块型，属 schema 变更，另行拍板。

---

## §3 待立项

| 单元 | 内容 | 出门门槛 | 状态 |
|---|---|---|---|
| ~~N4/N5/N6~~ | ~~协商剪除执行 / 三道闸门 / 验收~~ —— **随协商线退役**（真机 0/770 配合率；账本 §71） | — | ✅ 退役 |
| ~~T-loop~~ | ~~工具思考后截断（思考后占位：模型消费完结果后 stub 替换）~~ —— **用户裁定退役**（插件不是「模型是否已消费」的权威；任何「等后续轮次再剪」都改史断缓存；账本 §72） | — | ✅ 退役 |
| **W2** 写时确定性剪除（方向待拍板） | 在 T-entry 位置用确定性判据多剪：① 结论型 vs 事实型准入分层（F11 是其一步）；② ~~形态解析器（测试/tsc/git/包管理器）~~——**已评估并关闭（用户裁定 2026-09-09；账本 §74）：实测 ≤0.44%、宽目录零增量、旧口径 90–99% 误报；评估记录见 `docs/implement/archive/W2c-output-shape.md`（本仓 .gitignore 排除 archive/，故为本地只读历史）**；③ 同结果内确定性去重。**①工具自声明结果契约（`meta`/`presentResult` 摘要 + 句柄）已否决**——插件不是这个判断的权威（2026-09-09） | **剪点必须在结果入账前定死**（断裂成本 0）；不得依赖模型回应、不得等行为信号（缓存断裂）；失败方向 = 保留 | ⬜ |

---

## §4 非 N 系列（可选，未纳入收口）

- 裁 `presets/price-less/` 的工具目录（native 呈现下工具目录不进系统提示词，收益待估）。
- 瘦身 `AGENTS.md`（14,478 B → 内容迁入账本）。
- 迁移用户自有旧预设（legacy persona `text:` → `prefix:`/`suffix:`，`dsh-persona` 新契约要求）。

---

## §5 变更记录

- **2026-09-09** 初版：N3b 完成后落盘，记录 N3a 采样阻塞项与 N4–N6 待立项。
- **2026-09-09** 更新：真机复盘新增修复单 F1–F5（F1/F2/F4/F5a 已落地，F3/F5b 待立项）；
  §1 阻塞原因从「通道未验证」改为「H6 端口空转（F1 已修，待重新 build + 重启）」。
- **2026-09-09** 更新：新增 F8a/F8b（token 估算重构 + 标定对账，已落地，账本 §61）；F8c 口径统一待真机样本。
- **2026-09-09** 更新：新增 **F9 压缩产物重构**（F9a–F9e 已落地：区间权威/schema v2/热尾事实载体/双预算 10K+存储 v2/路径压缩；
  F9g 回放验收待跑；F5b 由 F9e 落地，F3 仍待立项；账本 §62–§66）。
- **2026-09-09** 更新：用户裁定契约 v3（**F10**）：总分里指针删除、热尾改为指向档案且每次直接抛弃、
  错误信息不进热尾；档案落盘只存总分（`archiveCapTokens` 只计总分）。账本 §69。
