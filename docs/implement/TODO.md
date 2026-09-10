# 待办清单 · 真机复盘修复 + 写时剪除方向

> **用途**：只记**未完成 / 被阻塞**项与出门门槛。
> **口径**：🔶 进行中（等用户动作）· ⬜ 待办 · ✅ 已完成不展开。
> **建立**：2026-09-09（N3b 落地之后）。**更新**：2026-09-09 真机复盘修复单 F1–F5 + F8a/F8b + **F3/F11/F12/F13（快照 §70）**
> + **N 系列协商线退役（快照 §71）**。
>
> **🔴 当前进行中（2026-09-10 起）**：五路审查缺陷修复战役 —— **U1–U13 全部落地**
> （U1–U7 = `9142d0e..664c239`；U8–U13 = `9ca139c`/`80493fe`/`dc671df`/`14172a0`/`7c14e3d`/`82af4a4`），
> **HC 系列（兼容性收口）亦全部落地**——账本 §80（基线 A）+ **§81（基线切换 B+）** + **§82（U8–U13）**，
> 现行基线 **662 用例绿** + **lib 级冒烟 24/24**（`npm run smoke:lib`）。
> **剩余 = 阶段二三**：真机冒烟（`REPAIR-2026-09-10.md §5.3`，含 ⓪ 构建陈旧性核验与 ⑦ 事实轨落点核验）、
> 账本回放对照（§5.4）、三个只读复审代理（§6.1）——均**需用户重启宿主**后执行。
> 逐单元改法与两处偏离工单的理由见 [`REPAIR-2026-09-10.md`](REPAIR-2026-09-10.md) §4/§9 + 账本 §82。
>
> **⚠️ 现行基线 = B+（2026-09-10 用户裁定）**：上游 `origin/master` @ `c291e7961a`（**0.1.5-rc.2**）
> **+ 重放本仓的 ignorable 补丁**（harness 分支 `bplus-0.1.5` @ `f0dc41471c`）——跟主线 **且**
> 保住事实轨的会话日志真源。上一代基线 A（`feat/ignorable-logintent-alpha2`，alpha.2 补丁分支）
> **已不受支持**。
> **升级 harness 前先读 [`docs/14-upstream-upgrade.md`](../14-upstream-upgrade.md)**（可复现步骤 +
> 8 条接触面清单 + 验收 + 回滚）；切换用 `scripts/promote-bplus.ps1`。
> replace `surfaceOp` 端点名的单一事实源 = `src/core/ledger/types.ts: REPLACE_OP_ENDPOINT_KEYS`，
> `platform/history.ts` 配双向编译期锚（上游再改端点名 → typecheck 红）。
> 另：**U8（判别默认模型去硬编码）已落地**（`9ca139c`）——写死的 `deepseek-v4.1-flash-expires-on-0910`
> 已删除；无路由（会话首条消息）跳过判别并发 `CE_JUDGE_NO_ROUTE`，第二条消息起跟随会话模型。

---

## §1 N 系列协商线：已退役 ✅（2026-09-09）

登记移入 [legacy.md](../legacy.md) §9（是什么 / 依据 / 后继 / 随附清理 / 全文）。

**替代方向约束（现行硬规则）**：
1. 语义剪除必须**写时确定性**——剪点必须在结果入账前定死（= T-entry，断裂成本 0）；
2. **行为信号不可用**（等后续轮次再判断再剪）：会在前缀已缓存后改史 → 缓存断裂。

**保留**：N1 身份通道（`core/shear/classify.ts`，候选普查）；T0 / T0-R / run 冲刷等机械档。

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
| **F13b** | **判别器 v5（粒度收紧，用户裁定 2026-09-10）**：v4 的对象枚举（文件/模块/项目/产物）与「或同类目标」是**并列洞**——模型挑"项目"这层即可把整仓一天算作同一 task（实测 150 条消息只出 2 条 new-task，且全在事件窗外 → 边界压缩零触发）。v5：定义改**功能/模块锚**并删去「或同类目标」；规则 6 合格对象去掉「项目/代码库」+ 写明「仓库名/项目名/产品名不是工作对象」；规则 5 补「同一仓库内推进另一件功能 = 换意图」；**新增粒度自检**（名字不同即换对象；"这个插件/这个项目"判不合格）；continue 尾巴禁止以「都在同一个仓库」放行 | ✅ | `core/judge.ts`、`datasets/prompt-discriminator-v2.4.txt`（新）、`tests/judge.spec.ts`、`docs/{00,01,02}`；快照 §83 |
| **F5b** | **坐标路径相对化**：`renderDigest` 的 coords 逐行打印绝对路径；相对化依赖 F3 的会话工作区 | ✅ **已由 F9e 落地**（`core/assemble/paths.ts`：root + 相对化 + 短 ID 表；快照 §66） | F9e |

### §2b 缺陷修复战役 U1–U13（2026-09-10；一句话 + 提交）

| 单 | 对应 | 内容 | 提交 |
|---|---|---|---|
| **F15** | U1 [P0] | 边界区间坐标系统一（端点候选排除 plugin 源节点 + 定义域改实际遮蔽集） | `9142d0e` |
| **F16** | U2 [P1] | 剪切域 run 面 live 断线（facts 路由未订阅）+ run 幂等键去掉 endSeq | `251feff` |
| **F17** | U3 [P1] | `applyHunksToWindow` 多 hunk 升序错位 → 按原窗口 offset 计 + 降序应用 | `6c7f72c` |
| **F18** | U4 [P1] | 内层 inject 未 effect 化（双挂载 / 监听器泄漏）+ pendingStarts 上界 | `352de4a` |
| **F19** | U5 [P1] | 判别卷宗 CAS 陈旧体盲写（改重放式 CAS） | `1a6b8dd` |
| **F20** | U6 [P1] | 压力路径幽灵 checkpoint（事务失败回滚档案）+ 快照首照为王 | `058bc12` |
| **F21** | U7 [P1] | 镜像双源核对恒漂移（加 sessionId + 同身份矛盾才判漂移） | `664c239` |
| **F22** | U8 | 判别/辅助调用模型**去硬编码**（无路由跳过判别 + `CE_JUDGE_NO_ROUTE`） | `9ca139c` |
| **F23** | U9 [P2] | 永久封禁族：段锚键 + 重试预算 2（transient 扩面）+ **孤儿事务自愈** | `80493fe` |
| **F24** | U10 [P2] | 屏障与超时族：LLM 流硬超时 + drain 按会话分桶 + settle 超时闩 + 失败码透传 | `dc671df` |
| **F25** | U11 [P2] | 口径与计量族 8 项（摘要估算/取真首申报/折叠材料/T-entry isError/run 动词/verifyQ 窗/守卫键/range 事实） | `14172a0` |
| **F26** | U12 [P2] | 存储与恢复族 3 项（diag-sink 双修 / skill-watch 多根 / 恢复段归属） | `7c14e3d` |
| **F27** | U13 [P3] | 选择性五项（截断收口 / locator 开销按幸存 / chain 逐字替换 / class 白名单 / drain 分批） | `82af4a4` |

**尚未取得**：真机冒烟读数（`CE_JUDGE_NO_ROUTE` / `range-empty` / 双守卫事实 / 归档键段锚）与
F8c calibration 样本 —— 需重启宿主（`REPAIR-2026-09-10.md §5.3`）。
| **F8a** | **token 估算重构**：新 core/meter/estimate.ts（DSH 结构对齐 + 两桶密度 CJK 1.5 / 其余 2.9 字符/token）；策略面 charsPerToken → density 全量随迁 | ✅ | src/core/meter/、src/core/{assemble,compress,ledger}/、src/domains/compaction.ts |
| **F8b** | **标定对账**：CompressCallLedger.calibration（估算 promptTokens vs 真实 input+cacheRead）+ warnTokenDrift（±25% 告警，只观察） | ✅ | src/core/compress/ledger.ts、src/domains/compaction.ts |
| **F8c** | **口径统一**：压力触发/保险丝用 DSH meter（中文低估 ~2.7×）、体积账用两桶——两套单位并存；统一前必须重标定 thresholdTokens/domainTokens/retainTokens/archiveCapTokens | ⬜ | 待真机 calibration.ratio 样本 |
| **F9a** | **区间权威化 + 配对平衡守卫**：压力路径补 `balanceRange`；范围端点取 `HistoryPort.surfaceNodes()`（权威表面，事件窗自折会复活已遮蔽节点）；`INVALID_RANGE` 回归 | ✅ | `platform/history.ts`、`domains/compaction.ts`、`core/compress/region.ts`；快照 §62 |
| **F9b** | **产物 schema v2**：总述（零事实）+ 分步（带 ▸n 引用）+ 热尾 1:1 指针；宽松修复（唯一硬失败 = 非 JSON）+ `fact-leak` 扫描 + parse/schema 有界重试 | ✅ | `core/assemble/{types,assemble,gate,ledger}.ts`、`core/compress/{types,prompt,product,fact-leak}.ts`；快照 §63 |
| **F9c** | **热尾事实载体**：user/assistant 消息单元 + tool-call 块转写 + Zipf `1/i` 分配 + 份额帽 + 仅指针降级 + `fact` 子串校验 + dup 去重 | ✅ | `core/assemble/assemble.ts`、`core/compress/region.ts`、`domains/{assemble,compaction}.ts`；快照 §64 |
| **F9d** | **双预算 10K/10K + 存储 v2**：`archiveCapTokens` 15K→10K；`ARCHIVE_STORE_VERSION` 2 + v1 条目兼容迁移；`archiveChainMonotone` 运行时守卫；`overCap` 入账 | ✅ | `config.ts`、`client/field-model.ts`、`core/compress/store.ts`、`core/assemble/archive.ts`、`core/restore/plan.ts`；快照 §65 |
| **F9e** | **路径压缩**：`root`（session.header.cwd）+ 相对化 + 同路径 ≥2 次短 ID 表；单元清单同源相对化；`policyKey` 含 root | ✅ | `core/assemble/paths.ts`（新）、`core/assemble/assemble.ts`、`core/compress/prompt.ts`、`domains/compaction.ts`；快照 §66 |
| **F10** | **契约 v3**：总分零指针（`refs` 退役）+ 热尾头指向档案 `vN` + 档案落盘只存总分（`digestText`）+ 错误信息不进热尾 + 配额不足改丢弃 + 路径短 ID 表退役 | ✅ | `core/assemble/{types,assemble,paths,ledger}.ts`、`core/compress/{prompt,product,types}.ts`、`domains/{assemble,compaction}.ts`、`scripts/verify-f9.mjs`；快照 §69 |
| **F14** | **v4 定位标注 + 可定位性审计**：热尾条目仅当内容**不能自证位置**时渲染 `相对路径@vN:lines`（`pointerOverheadTokens` 只对这类条目计费，不再白扣）+ `hotTailLocated`/`hotTailUnlocated` 账本位 + `extraSearchCalls` 压缩后窗口内重发已见调用（口径先立不空转 → 落地） | ✅ | `core/assemble/{locatable,assemble,types,ledger}.ts`、`domains/assemble.ts`、`docs/{04,07}`、`tests/{locatable,assemble-paths,assemble-ledger}.spec.ts`；快照 §79 |
| **F9g** | **回放验收**：`scripts/verify-f9.mjs` 15/15 + `scripts/verify-f9-replay.mjs` 真机对照（旧申报重装配 10,022 vs 旧 8,209——Zipf 用满预算；**产物总量下降待用户定 `retainTokens`**）；真机重启冒烟待补 | ✅ | `scripts/verify-f9{,-replay}.mjs`；快照 §68 |

**F5a 说明**：只改渲染面（块序 + 标签），产物 schema 与校验序（`DIGEST_BLOCK_ORDER`）不变；若要真正的「总述块」需第 5 种块型，属 schema 变更，另行拍板。

---

## §3 待立项

| 单元 | 内容 | 出门门槛 | 状态 |
|---|---|---|---|
| **W2** 写时确定性剪除（方向待拍板） | 在 T-entry 位置用确定性判据多剪：① 结论型 vs 事实型准入分层（F11 是其一步）；② 形态解析器——**已评估并关闭**（账本 §74；遗留登记 [legacy.md](../legacy.md) §11）；③ 同结果内确定性去重。**工具自声明结果契约（`meta`/`presentResult` 摘要 + 句柄）已否决**——插件不是这个判断的权威（2026-09-09） | **剪点必须在结果入账前定死**（断裂成本 0）；不得依赖模型回应、不得等行为信号（缓存断裂）；失败方向 = 保留 | ⬜ |
| **B 系列** 分支-合并上下文（checkout/merge） | 空间换效率：把独立工作放进**独立会话分支**（现有 `fork`/`spawn` 子会话，各自稳定前缀与独立缓存），主会话只收**事实级合并产物**（H6 整形，零断裂）；分支图 = 插件 KV。**三档改动量**（已读 harness 源码核实）：① 零 harness 改动——`subagent-fork-in-process` 已提供「父会话完成轮前缀」种子，`SessionHeader.parentSession`/`isSeeded`/`session/end-seed` 提供血缘；② 3–5 文件加法式——**选择性种子**（现契约 = 从 seq 0 连续且平衡，`subagent/subagent/src/types.ts:237-243`），让子会话只带相关节点；③ 不建议——同会话多分支/跨会话检出/事件级合并，要动 `core/session` 地基（`seq===数组下标`、surface 单列表、`surfaceOp replace` 只引用本会话 seq、无多 head）。**先验数据**：42 会话并行面 **5.5%**（arch-big 13.3%、cur5 0%），subagent 委派 **5/6,631**。**关键经济学**：fork 继承全量前缀 → 不选择性种子时只省父会话，子会话照样背全上下文；N 个并行子会话 = N 份父上下文成本 | **M0（零施工度量）**：可隔离活上下文占比 ≥30% 且主上下文缩小 ≥30%、断裂成本 < 节省的 20%、合并冲突率可回放；不达标不立项。**档 2 仅在 M0 证明「子会话必须显著小于父会话」后才提 harness 改动** | ⬜ 待验证 |
| **R 系列** 思考回放剪除（reasoning strip） | 剪掉历史 reasoning 在后续请求里的回放。**三方案实测**（42 会话 + cur5/arch-big，DeepSeek v4-flash offpeak $0.22/$0.007/$0.66）：① **零断裂**（harness 适配器对已完成回合不回传 `reasoning_content`）省 **15.8–20.9%** 账单；② **插件渐进剪**（H2 pre-step + H4 replace，保留带工具调用的最新块）语料平均 **~0%**（回本需 67 次回放 vs 实测 66.6 次）；③ **轮边界一次性全剪** **−1.5%**（断裂尾巴 = 整轮，收益窗口只有下一轮）。复利口径：cur5 思考 2.95M token → 226M token-请求 = **76.5×**（arch-big 104.5×）；cur5 账单 $8.01 中思考回放 **$1.26–1.58**。**协议硬约束**：正在等工具结果的 assistant 消息必须保留 `reasoning_content`，只能剪已完成回合 | **出门门槛**：① DeepSeek 接受非最新 tool-call 回合缺 reasoning；② 网关能 re-encode；③ 行为 A/B 无退化。三者缺一不施工 | ⬜ 待验证 |

### §3b 审查登记「不修」清单（2026-09-10；理由见各条）

| 项 | 内容 | 为什么不动刀 |
|---|---|---|
| CJK 扩展区漏算 | `core/meter/estimate.ts` 只按基本区两桶密度 | 需真机语料重标定；当前误差在 ±25% 告警带内（F8b 可观测） |
| 无界增长面 | `records` / `seqs` / `fact_mirror` 等长驻集合 | 单会话量级有界（事件窗 2000 / 事实桶 2000）；跨会话面留待真机样本 |
| judge prompt 规则 1/4 优先级倒置 | `datasets/prompt-discriminator-v2.3.txt` | 待真机样本（F13 已改 v4 定义，需新样本再判） |
| `resolveContextWindow` 探测成功但仍 `undefined` 时永久缓存 | `platform/llm.ts` | 宿主返回 `undefined` = 未声明窗口（非瞬时失败），缓存是正确语义 |
| compaction 每 pre-step 全量 snapshot fold | `domains/compaction.ts` | CPU 面；需先有真机耗时读数（07 无该字段） |
| mirrored 计数 ≠ 落盘 | fire-and-forget 写镜像 | 计数口径已在 `docs/12 §3` 说明（不谎报成功） |
| storage H9 重启后恢复序失效 | 重跑路径不重注册 `onAgentSessionStart` | 真机冒烟⑥ 观察项（与 U4 部分重叠） |

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
- **2026-09-09** 清理：退役特性封存——T-note/T-loop 类型与度量面、`appendContent`、N2/N3 工单、
  失效验收脚本分别移入 `docs/implement/archive/` 与 `scripts/archive/`；统一登记 = [legacy.md](../legacy.md)（账本 §75）。
- **2026-09-09** 登记：新增 **B 系列（分支-合并上下文）** 与 **R 系列（思考回放剪除）** 两个待验证方向——
  harness 改动三档核实 + 42 会话并行面/成本实测（账本 §76）。
