# 待办清单 · N 系列「协商剪除」收口

> **用途**：只记**未完成 / 被阻塞**项与出门门槛；单元定义、硬规则、决策记录见
> [`00-master.md`](00-master.md) §2/§3/§6（不在此重复）。
> **口径**：🔶 进行中（等用户动作）· ⬜ 待办 · ✅ 已完成不展开。
> **建立**：2026-09-09（N3b 落地之后）。**更新**：2026-09-09 真机缺陷修复单 F1–F5 + token 估算重构 F8a/F8b。

---

## §1 当前阻塞：N3a 真机采样 🔶

**2026-09-09 真机三轮对话复盘发现：采样拿不到数据不是模型不配合，是 H6 端口在真机上抛错空转**
（`ctx.tools` 未 inject → 211 次 `tools/post-execute hook failed`）。F1 已修（见 §2）。

| # | 事项 | 负责 | 出门门槛 |
|---|---|---|---|
| ① | **重新 build + 重启 DSH**（F1/F2 已落地，旧进程仍跑 9/9 03:33 的构建） | 用户 | 重启后长工具结果末尾出现单独一行 `（协商：…）` |
| ② | 用「价格低耗（协商剪除）」预设开**新会话**正常干活 | 用户 | 每个 basis 攒到 **≥30** 条样本 |
| ③ | `node scripts/probe-n3.mjs` | 我 | 产出三张表 + 每 basis 晋升判定 |
| ④ | 兜底（条件项）：配合率 <30% → 试通道 B（`additionalContexts`）；仍 <30% → **停止 N4 立项** | 我 | — |

**前置已就绪**：`~/.dsh/settings.yaml` = `context-economy.shear.negotiate: shadow` + `discriminator.auto: true`。

**晋升规则**（③ 的判据）：样本 ≥30 ∧ CUT-HOLD <5% ∧ 保真 ≥95% → 该 basis 进 N4 白名单。

**已知采样偏倚**（设计预期）：`command` basis 的长结果多被 T-entry 写前整形吸收；某 basis 攒不满 30 条则不晋升。

---

## §2 真机缺陷修复单（2026-09-09）

| 单 | 内容 | 状态 | 落点 |
|---|---|---|---|
| **F1** | **工具端口注入**：`ctx.tools` → `ctx.inject([tools])` + `getTools` 回调（原缺陷 = 端口整体空转：T-entry/T0/协商注记全无） | ✅ | `src/index.ts`、`src/platform/tools.ts`、`src/domains/shear.ts` |
| **F2** | **边界压缩阻塞**：pre-step 先等本轮判词落地（`settle` 屏障，**60s** 有界，超时 fail-lazy 退回下一 pre-step） | ✅ | `src/domains/input.ts`、`src/index.ts` |
| **F4** | **诊断日志去重**：prefix 状态变化才记录（原为每次 skill watch 回调都打，18 分钟 9,136 条） | ✅ | `src/index.ts` |
| **F5a** | **档案渲染可读性**：结论先行（wrap→plan→impl→verify）+ 类型标签（`【结论】/【计划】/【实现】/【验证】`） | ✅ | `src/core/assemble/assemble.ts` |
| **F3** | **档案/前缀按会话工作区隔离**：现为 `process.cwd()`（实体键 `boundary_archive:G:/deepseek-harness`），跨项目串档；需按 `session.header.cwd` 解析（4 个域 + 装配接线） | ⬜ | 待立项（M/L） |
| **F5b** | **坐标路径相对化**：`renderDigest` 的 coords 逐行打印绝对路径；相对化依赖 F3 的会话工作区 | ⬜ | 待 F3 |
| **F8a** | **token 估算重构**：新 core/meter/estimate.ts（DSH 结构对齐 + 两桶密度 CJK 1.5 / 其余 2.9 字符/token）；策略面 charsPerToken → density 全量随迁 | ✅ | src/core/meter/、src/core/{assemble,compress,ledger}/、src/domains/compaction.ts |
| **F8b** | **标定对账**：CompressCallLedger.calibration（估算 promptTokens vs 真实 input+cacheRead）+ warnTokenDrift（±25% 告警，只观察） | ✅ | src/core/compress/ledger.ts、src/domains/compaction.ts |
| **F8c** | **口径统一**：压力触发/保险丝用 DSH meter（中文低估 ~2.7×）、体积账用两桶——两套单位并存；统一前必须重标定 thresholdTokens/domainTokens/retainTokens/archiveCapTokens | ⬜ | 待真机 calibration.ratio 样本 |

**F5a 说明**：只改渲染面（块序 + 标签），产物 schema 与校验序（`DIGEST_BLOCK_ORDER`）不变；若要真正的「总述块」需第 5 种块型，属 schema 变更，另行拍板。

---

## §3 待立项（等 §1 数据）

| 单元 | 内容 | 出门门槛 | 状态 |
|---|---|---|---|
| **N4** 剪除执行 | 整块替换（上一轮调用 + 结果 + 上一轮思考，本轮思考尽量一并剪）；配对与缓存断言 | 四触发次序不破；缓存断言进 CI；**白名单起步 = 空集**（`signature` 可剪实测 **0**），按 basis 逐组晋升 | ⬜ |
| **N5** 三道闸门 + 误剪退避 | 事实保真 / 深度 / 配对三道护栏；复用 `cutMisfireDetected` 记账；超阈自动关协商 | 护栏不过必 hold；误剪率可回放 | ⬜ |
| **N6** 验收与账本快照 | `verify-n.mjs` + `docs/ledger-history.md` §51+ 快照 + 正典同步 | 全链 verify + 快照 | ⬜ |

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
