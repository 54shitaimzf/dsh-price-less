# 压缩域实验设计（四旋钮方法论）

> 本文件是 evalground 压缩域实验的**单一事实源（设计级）**：方法、臂、参数约定。
> 评测引擎（lib/）+ 臂表（arms.config.json）是它的**执行形态**，两者不许漂移。
> 方法论来源 = 用户对 `@dsh-external/dsh-context-economy` 压缩域的完整意图（见文末「对齐记录」）。

## 0. 一句话

**以 task 为单位的生命周期化压缩**（插件本体）如何**省钱 + 提执行效率**——用四旋钮逐格调控，
与 DSH 原生压缩对照，配对差值（Δ=臂−基线）归因，禁止单次运行结论。

---

## 1. 核心概念：task = 架构层建模的单位

**task 是本插件对软件架构层面建模的单位划分方法论**——不是"来一条消息就切一段"（判别器对每条用户流消息判定
`new_task`/`continue`，而非无脑逐条开段），而是用**判别器（语义判定，minimax-m3 + v2.2，只判 `user/message`）**
把工程活动的**生命周期**（从"宣布/承诺发起一个新工作"→"该工作推进/细化/收口"）切成一个个**有架构语义的任务单元**。
task 边界 = 这些单元的**生命周期分界 = 判别器在用户消息流上判定 `new_task` 的位置**。
**边界只锚定用户流消息**：单用户消息的 task 恒单段（无第二条消息可作 split 点）；只有消息真正开启一个不同的任务
（换对象/换意图/换域/换形态/中止重开）才切出新段。

因此：

- **task 边界压缩** = 以**架构单位（task）**为粒度做历史管理：**一个 task 结束了，就把它的上下文压缩掉**。
- 这是 DSH 原生"阈值压力触发"做不到的：DSH 只认"上下文攒到 80% 窗口了没"，**不认"一个架构任务干完了没"**。
- 插件的压缩域本体 = **以 task 为单位的生命周期化压缩**，不是兜底的阈值压缩。

> ⚠️ 既往误判警示：此前把 `self` 臂配置成 `trigger:{tokenThreshold:8000}`（token 阈值触发），
> 那是把 DSH 的**压力/溢出触发**当成了插件的 task 边界触发——完全错误。task 边界触发是
> **orchestrator 在 agent/pre-step 发现 `status==='closed' && !compactedTaskIds` 的 task 就压**
> （`src/task/orchestrator.ts`），不是"上下文 ≥ 阈值"。

---

## 2. 主机制 + 四旋钮

```
task 边界压缩(主机制:触发)  ── 一个架构单位 lifecycle 结束 → 压缩它的上下文
  ├─ A 旋钮(正交维度) ── 压缩动作的"范围 × 处理方式"：
  │    ├─ A1 范围    : 全压(无近因门) / 压热之前(近因门)  —— 均以 task 为单位
  │    └─ A2 处理方式 : 压缩器"输入信息密度与一致性"的优化 —— **测试维度 = 类型化(保留原始 vs 具体内容展开)**，
  │                      单变量对照 方案0(保留原始) vs 方案1(具体内容展开)；【B 已并入 A2；裁剪被否决(既无用又非A2职责)】；
  │                      方向3/方向B/方向C 为插件设计空间(搭便车机制)，已抽到 docs/02-compaction.md，不在此展开
  ├─ B 旋钮 ── 已并入 A2（方案0 保留原始 / 方案1 具体内容展开；独立维度取消）
  └─ C 旋钮 ── 已取消（产物放置用成熟"稳定前缀"固定，不作变量；该权衡已成熟，训练时也按稳定前缀对齐）
```

**层级（请勿混淆）**：
- **A** 是正交维度，内部再拆 **A1（范围）× A2（处理方式）** 两个子维度（网格）。
- **B** 已并入 A2（方案0 保留原始 / 方案1 具体内容展开），不再作为独立维度。
- **C** 已取消（产物放置用成熟"稳定前缀"固定，不作变量）。
- A1、A2 都**叠加在"task 边界压缩"这个主触发机制之上**，不是独立实验组。

---

## 3. 四旋钮的语义细节（落地级）

> 本节每个旋钮给出**可落地的具体方案**，不是枚举。判定只认**质量 + 成本**（见 §7）；
> 中间量（cacheHitRate / reDiscoveryTokens / extraSearchCalls 等）只作**归因诊断**，不入判定。

### A1 范围（以 task 为单位，绝不在 task 中间切）

> **候选方案矩阵（用户校正：不是"确定死方案"，而是"原理上可能更优的方案，供实验探究"）。**
> 每个取值都是**可能更优的候选档**，用单变量消融对比，不预设哪档最优。

> **⚠️ 自洽性约束（先于候选，用户批评"12 方案没考虑 34 的漂移"）**：
> 凡**不锚 task 边界**的判定、或**非零压缩**的保留，都会引入**已压缩边界/漂移**问题——
> 处理必须复杂化。因此下面**每个候选都标柱漂移风险 + 是否需"已压缩边界"**。先定义这条约束：

> **⚠️ 已压缩边界防语义漂移（约束，非独立洞察）**：若先压掉 task 的 90%（剩 10% 摘要），后续上下文增长再压——
> 压缩器从**新尾部**反向累加可能把**已是摘要的 10%**当"更早"再压一次 → **二次损毁（loss compounding）**。
> 根因（源码 types.ts `surfaceIndex`）：task 压缩后 `startSeq`/`lastSurfaceSeq` **重映射**
> （"含压缩 replace 后的重映射；被 replace 的旧 seq 移出"），task 的**边界坐标变了**。
> 方案 = 引入**已压缩边界**（task 内的标记），告知压缩器"这段已是压缩产物，再压要对齐前一次压缩程度
> （同 schema/预算），不能当原始内容再压"——与插件 docs/02 §3 摘要区"append-only 不可改写"同源。
> **凡不锚 task 边界的判定 / 非零压缩的保留，都必须配这个已压缩边界，否则漂移。**

**热 task 判定的候选方案（A1-判定）**——"热"如何定义，各有原理依据，待实验判定：
| 候选 | 热 task = 哪些 | 锚 task 边界 | 漂移风险 | 需已压缩边界 |
|---|---|---|---|---|
| **A1-j1 最近 N 个** | 最近闭合的 N 个 task | ❌ 按数量/位置，可切 task 中间 | **高**（N 可能滑进已压缩区） | **必须** |
| **A1-j2 近因 token 尾**（插件现状） | 落在 `recencyTailCutoff` 内的 task | ~ 位置区间，可能与 task 边界不齐 | 中 | **需要**（边界不对齐处） |
| **A1-j3 引用活跃度** | 产物仍被后续任务引用的 task（`stillReferenced` 门） | ~ 按引用，可跨 task | 中 | 需要 |
| **A1-j4 混合** | 近因尾 ∩ 未引用 | ~ 组合 | 中 | 需要 |

**A1 对热 task 的处理候选（A1-保留）**：
| 候选 | 热 task 处理 | 漂移风险 | 需已压缩边界 |
|---|---|---|---|
| **A1-p1 零压缩**（插件现状） | 热 task 整段逐字保留 | **低**（无压缩产物） | 不需要（没压过） |
| **A1-p2 少压缩** | 热 task 也压，只压冷区部分（保近期交互尾） | **中**（产物+raw 混合） | **必须**（否则压到产物部分 → 漂移） |
| **A1-p3 分层压缩** | 热 task 按近因度分层：越近越少压，越冷越全压 | **高**（同 task 内多压缩梯度） | **必须**（细粒度对齐，标记复杂） |

> **结论（候选待探究 + 自洽约束）**：凡涉及 **j1（不锚 task 边界）** 或 **p2/p3（非零压缩）** 的候选，
> **处理必须复杂化（配已压缩边界）**，否则漂移。插件现状（A1-j2 近因 token 尾 + A1-p1 零压缩）之所以安全，
> 是因为近因尾 + 零压缩**不产生多次压缩产物**；一旦引入"少压缩/分层压缩"或"最近N/引用活跃"，
> 就**必须同时落位已压缩边界**。这不是"是否更好"，而是**这些候选能否自洽的前提**。

**热 task 定义的准确机制（源码 `range-task-partitioned.ts`，供参考）**：
近因判定是**纯 token 位置**（`recencyTailCutoff` 反向累加 ≥ retainTokens 处为近因尾起点），
凡 `lastSurfaceSeq` 下标 ≥ 该起点的 task 在近因尾内；热点是连续 token 区间，长度由 `retainTokens` 决定，
非离散"最近1个"。**热 task = 零压缩（整段逐字保留）**：`selectColdClosedTask` 对 `lastIdx >= tailCutoffIdx`
直接 `return false`（不选为候选）。——这是**A1-j2/A1-p1 的具体实现**，不是唯一正确形态。

> **⚠️ 少压缩的统一性（用户洞察）**：既然引入了"近因保留（少压缩/保热尾）"机制，那么
> **单 task 上下文超阈值触发的自动压缩同样应该用"少压缩"（保尾），不能只在 task 边界用**。
> 插件当前把"保留策略"割裂成两个模式：task 边界压缩（职责B，task-partitioned 近因门）与
> 溢出兜底（职责C，DSH 原生 whole-surface）——同一个"保热尾"原则未被统一应用到两种触发上。
> 这与 evalground 实验对照（触发方式/选择算法）关系不大，但属**插件正确形态**，应记档。

### A1 可落地规格（收敛为两方案；候选矩阵保留为"未采用档"参考）

> 本次实验落地的 A1 = **下面两个具体方案**，单变量对照（只变近因门开/关，其余触发/选择算法固定，判定唯二 = 质量 + 成本）。候选矩阵（j1-j4 × p1-p3）及其漂移/已压缩边界标注保留为背景，不再逐一实现。

#### A1-S1 引用化保尾（类 DSH 原生保尾思想 · 语义边界 · 无原文）
**参数**：`retainCap`（建议 2000 tok）、`maxRetainRefs`（8）、`outlineTokenBudget`（40 tok）。压缩单元 = **task**（绝不切 task 中间）。

**每轮压缩机制**（PTC 式，M4）：
1. **定位热子结构**：判别器切出的最近一个闭合子 task（语义边界，非 token 窗）。
2. **压缩整段**：把该 task 的**全部原始工作**压成 `[summary]+[typed subtask1..K]`（与 S2 同壳——A1-S1 只**多一层**热子结构保留）。
3. **引用化保留热子 task**：最后一个子 task 的**引用集**（原始记录 span / 文件坐标 / 命令测试引用，代码算+验）+ **一行提纲**（模型作者 ≤40 tok）。**零原文直出**——原文在缓存/transcript 落盘；上下文只背引用（≈200 tok，远低于旧 8K token 尾），细节按引用恢复。
4. **下次压缩整片删除**：保留节点是**瞬态桥接**——下次压缩开始即删除（不重喂、不重压，防"同一子流二次表示"漂移；到那时它已不是热上下文）。

**防漂移约束**：保留节点在压缩时被删除 → 每片段只压一次，无双表示；压缩器输入=真前缀（含旧分节，FROZEN 指令排除）→ 缓存粘贴 native 的"真前缀"招，且**无重凝缩路径**（非 native 的 merge）。

**落地挂点**：`lib/runner.mjs` 的 `compression:'task-boundary'` 分支（M4）；产物 `retain` 字段 + `renderRetain` 渲染为独立瞬态节点。

#### A1-S2 闭合即全压（无热子结构保留）
**参数**：无保留（`retain` 字段省略）。机制：task 一旦闭合，其全部内容立即压成 `[summary]+[typed subtasks]`；无引用化保留。**代价/风险**：刚闭合、仍热的 task 被立即压 → 连续任务需其上下文时重发现成本高；任务独立性高时可接受。
**对照**：A1 变量 = 热子结构保留 开（S1 引用化保尾）/ 关（S2），其余固定 → 单变量对照；判定唯二 = 质量（mech/judge 盲评）+ 成本（`costPerSuccessfulTask`）。

### A2 处理方式（压缩器"输入信息密度与一致性"的优化）

> **定位（用户校正，取代旧稿"去噪/裁剪"）**：
> - **输出（压缩产物）不是 A2 的职责**——产物怎么组织是 B/C 的事（B 已并入 A2、C 已取消）；
> - **裁剪无用**：机械裁剪不可能比 LLM 更准地判断"哪句该删"，且破坏一致性/缓存——**A2 不做裁剪**。
> - A2 真正的问题是：**在保持压缩成本低廉的同时，优化压缩器输入的信息密度与一致性**，比原生更好。

**原生压缩器的输入 = `[system+tools] + 被压区间原始消息逐字节原样`**（复用 agent 前缀缓存，故成本最低），
但**信息密度低**（全是过程噪声）且**一致性靠"逐字节原样"保证**。A2 的优化基准 = 信息论：
输出信息质量 = 输入有效信息 ÷ 需要的提取能力。目标是**在不破坏"压缩输入=原始前缀逐字节"（保缓存）的前提下，
提高有效信息占比**。

#### A2 测试变量（唯一 = 类型化压缩指令）

**A2 类型化：方案0 保留原坐标 vs 方案1 具体内容展开（单变量对照，PTC 式落定）**
不改输入（保持 旧分节(FROZEN)+原始消息 的**真前缀** 复用缓存），只优化压缩器怎么处理产物：
- **产物结构（PTC/代码化，M2）**：每个 `[compressed task]` 块 = `[summary] + [typed subtask1..K]`；
  每个 typed subtask 是信息块（`plan/impl/verify/wrap`，偏重 + 信息量 + 严格格式机械校验），
  **impl 用指针**（`path + lineRange/symbol` 坐标，"位置转移"，细节在文件里——**指针由代码从真实
  transcript/文件计算并校验**（`locate_change`/`validate_pointer`/`verifyRefGroundTruth`），模型不编坐标）。
- **方案0 = 保留原坐标**：typed subtask 内是指针坐标（紧凑，恢复时按坐标 `read/glob` 取）。
- **方案1 = 具体内容展开**：**展开 = harness 侧替换**——同一指针经 `resolve_pointer` 把内容替换进产物
  （`refs[].content`，非模型产物）；模型从不嵌入文件内容。同一产物结构、只差"坐标 vs 展开"，机械可断言。
- **成本 = 0**（只改产物处理逻辑，输入不变）。**可验证**：产物结构的分野可机械断言（refs 是否携带 content）。

**❌ 方向2（否决）**：压缩的"单独可缓存前缀"无意义——信息不需要被反复压缩（一次压缩后即产物，不会再以原始
形态二次送压缩器，这正是"FROZEN 旧分节 + 只增不改"要防的）；且重排=重新组织字节≠逐字节一致，破坏 agent 前缀复用，**成本激增**。
方向2 删除。

> **A2 结论**：A2 不做裁剪。**进压缩域测试的 A2 变量只有一个 = 方向1（类型化压缩指令）**，单变量对照
> 方案0（保留原坐标）vs 方案1（具体内容展开=harness 侧）——只改指令、输入不变、成本=0、产物流密度分野可机械断言。
> **方向3/方向B/方向C 是插件设计空间（搭便车机制），已抽到 `docs/02-compaction.md`**，将来随压缩定稿作为单一变量
> 参与新实验；本文件不再叠加它们。方向2 已否决。

#### A2 可落地规格（两方案；信息块模板；严格格式靠机械校验兜底；PTC 程序）

> **任务分工（定死，勿混）**：
> - **边界判定**（task 分界 / 何时压）= 额外模型 minimax 判别器（premark），预处理落盘，`costs.decision` 记真实成本。
> - **信息块类型/内容判定** = 压缩器（程序）自己判（有全量上下文），**不单独调用模型**。
> - **指针计算/校验/展开** = 代码（`locate_change`/`validate_pointer`/`resolve_pointer`/`verifyRefGroundTruth`），
>   模型**永不**自造坐标、永不嵌入内容。

**信息块模板集**（压缩器在 task 内容里识别各信息块，每块套对应模板；**偏重 = 保留哪类，信息量 = 保留粒度/上限 + 丢弃什么**，双重差异）：
| 块类型 | 对应阶段 | 偏重（保留哪类） | 信息量（粒度 + 上限） | 丢弃 |
|---|---|---|---|---|
| `plan` | 规划/设计 | 目标 + 约束 + 决策 + 关键权衡 | 条目化，≤120 词 | 过程推导、中间尝试、铺垫 |
| `impl` | 实现 | **文件坐标**（`path` + `lineRange`/`symbol`）+ 改动一句话摘要 + 测试 | **指针 + 摘要**，≤80 词 | **代码片段全文**、推理链路、冗长输出 |
| `verify` | 验证 | 测试命令 + 结果 + 失败原因 | 命令 + 结论，≤150 词 | 日志全文、无关注输出 |
| `wrap` | 收尾/结论 | 结论 + 交付物 + 遗留 | 清单，≤100 词 | 复述、背景重复 |

> **impl 用坐标而非片段**（"位置转移"——细节在文件里，上下文只留高密度指针，恢复时按坐标 `read/glob` 取，不衬入代码字节）。
> `impl` 块示例：`{ type:"impl", path:"src/x.js", lineRange:"120-145", change:"<一句话改动>", test:"<命令+结论>", refs:[{path,lineRange,symbol}] }`。

**方案0 = 保留原坐标（= 对照/保守）**：refs 只含坐标（path/lineRange/symbol），不展开、不改写（已压好的不再处理，防二次损毁）。

**方案1 = 具体内容展开（= 实验/类型化）**：**harness 侧**对每个 ref 调 `resolve_pointer` 把内容替换进产物
（refs[].content）；其余与方案0 同构。**模型从不嵌入内容**（指示明确："A2 expand 由 harness 完成"）。

> **B 独立维度已并入 A2**（不再单列 B 方案；原"产物组织 = 保留原始 vs 具体内容展开"即 A2 的方案0 vs 方案1）。

**保证格式严格（双层，硬保证靠机械层）**：
1. **prompt 层（软引导）**：指令给**严格契约 + 完整模板（可执行）+ 1 个完整示例 + 禁止项**（禁未知块类型 / 禁自造坐标 / 禁原文 / 禁改旧分节）。
2. **机械层（硬保证，不依赖 LLM 自觉）**：schema 校验器——块类型 ∈ 枚举、每块必填字段齐全、无非法字段、`total`=子任务数；
   **指针门**——`validate_pointer`（存在性）+ `verifyRefGroundTruth`（准确性=对齐真实改动记录）；
   **压缩比门**——`ratio > 0.75` fail-lazy；**OUT 门**——无原文回显（harness 展开内容豁免）。
   **不合格 → fail-lazy**（返回 `ok:false`，记 violation，**产物不入上下文**/回退原文）。**脏产物绝不注入**。

**成本口径**：只改指令 + 机械校验，输入不变（缓存底座）→ 无 type 判定成本。压缩域成本 = 摘要成本 + `costs.decision`。

**落地挂点**：`lib/compress.mjs`（`compressWithProgram` 一次完成：模型写程序 → `runProgram` 执行 → 门检查）+
`lib/compressor-io.mjs`（绑定/指针门）+ `lib/compressor-validate.mjs`（schema/ratio/retention）+ `lib/assemble.mjs`（`renderSection`）；
`arms.config.json` 配 `a2` + `compressor` 块（ratio/retention/codeRun），与 A1（S1/S2）正交。

### ~~B 方案~~（已并入 A2 = 方案0 保留原始 / 方案1 具体内容展开；独立维度取消，消融链变 A1×A2）
### ~~C 组装~~（已取消：产物放置用成熟"稳定前缀"固定，不作变量——该权衡已成熟，训练时按稳定前缀对齐）

---

## 4. 实验臂（消融）

> 消融结构（已拍板）：**对照组 = 两个**（① `native-auto` 原生+自动管理 ② `manual-habit` 模仿人类压缩习惯）；
> **实验侧 = 插件压缩**（task 边界触发 + A1×A2 单变量 E1–E4；2026-09 起臂表落地为 `self-s{1,2}-{orig,expand}` 网格 4 臂，`self-compact` 已并入 `self-s2-orig`）。每实验相对 `native-auto` 只换 1 槽；
> `manual-habit` 只作**质量标杆**（纯规则/人工，无 token 成本，不进"每成功任务成本"比较）。
> **`full`（无压缩基线）与 `self`（误配：token 阈值触发 + 插件 semantic 产物）已移除**——无意义/比错对象。
> 产品结构三分类防污染：`native-auto`/`manual-habit` → **native 8段**；`task-boundary`/插件 → **plugin**；无压缩/截断 → 无。

| 臂 | 选择算法 | 触发 | 产物 | 隔离变量 / 定位 |
|---|---|---|---|---|
| **native-auto**（对照 A） | **DSH-native**：移植 `selectCompactableRange` 保尾压头 + `toolPairing` 平衡 | **自动**：任务尺度校准阈值（`domain × 0.8`） | **原生 8段 `<compacted-summary>`** | **机械基准**：标准 harness 自动压缩（`assertCompressionFired` 防退化） |
| **manual-habit**（对照 B） | **人类习惯规则集**：近因保尾 + focus 保留集（objective/改过路径/未解决失败/架构决策）+ offload | **硬编码人类时机**：大文件读取完成 / 通过 run / ~50% 任务尺度压力（远早于自动 ~95%） | **原生 8段**（被 focus directive 增强） | **质量标杆**：人手动管理能做到多好（纯规则，无 token 成本） |
| **self-*（实验侧，= A1×A2 网格 4 臂）** | **插件压缩域**（task-partitioned：A1 近因门/S2 + A2 方案0/1） | **task 边界自动**：判别器切段（`boundaries/<id>.boundaries.json` 预处理数据标记），段结束即压 | **插件**（semantic 或 A2 信息块） | **A1×A2 实验**：E1 触发 / E2 范围 / E3 保留 / E4 产物，各相对 `native-auto` 单变量 |

> **实验语义（每实验相对 `native-auto` 只换 1 槽）**：
> - **E1 触发**：自动 token 阈值 → task 边界自动（判别器切段）。
> - **E2 范围**：whole-surface 保尾压头 → task 单位（绝不切 task 中间）。
> - **E3 保留**：保尾 `retain≈8K` → 闭合即全压 `retain=0`。
> - **E4 产物**：原生 8段 → 方案1 具体内容展开（信息块 `plan/impl/verify/wrap` + 严格格式机械校验 + fail-lazy）。
> A1×A2 存在理论强交互 → 先做**主效应单变量**；若交互显著再补定点格点，不预设加性成立。

> **执行形态（已落地，见 `arms.config.json`）**：A1×A2 网格 4 臂 =
> `self-s1-orig`（S1 近因门·保尾压头 × 方案0）/ `self-s1-expand`（S1 × 方案1）/
> `self-s2-orig`（S2 闭合即全压 × 方案0）/ `self-s2-expand`（S2 × 方案1）。
> 各自相对 `native-auto` 单变量：E3 保留（S1 保尾 vs S2 闭合即全压）、E4 产物（方案0 vs 方案1 信息块）。

### 5. 压缩域标定（关键前提）

DSH-native 的参数（`retainRatio`、`thresholdRatio`）是**相对窗口**的。此前 `contextWindow=256000` 使
`retain=40960`、`threshold=204800`——**压不动的根因**：
1. 任务上下文（~40–60K）远小于 threshold 204800 → **触发门永不过**；
2. 保留预算 40960 **吞掉整个任务**（`selectCompactableRange` 里 `keepFromIdx` 走到 0 → 返回 null → 压 0 字节）。

**标定协议（已拍板：实测峰值定标）**：
- **压缩域窗口 = 任务的压缩尺度（≈50K）**，不是裸模型窗口 256K。
- 先跑一次**无压缩 full T1**，测真实上下文峰值（每次请求前 `estimateMessagesTokens(messages)` 的最大值）。
- 设 **压缩域窗口 ≈ 峰值**（或峰值×1.25），则 `retainTokens = floor(域 × retainRatio) ≈ 8000`、
  `thresholdTokens = floor(域 × thresholdRatio) ≈ 40000`，任务末尾可达 → 触发门能过，且保尾 8K、压头 ~40K **有东西可压**。
- 不变量：`retainTokens < thresholdTokens`（config 校验强制）。

**执行形态（已落地，见 `lib/calibrate.mjs` + `lib/arm-spec.mjs`）**：
- `calibrate(peakTokens)` → `{domain, retainTokens, thresholdTokens, retainRatio, thresholdRatio}`（纯函数，无 IO）；
  `domainTokens(null)` 缺省用 `COMPRESSION_DOMAIN_DEFAULT = 50000`（任务尺度）。
- `compressionDomain()` 从 `arms.config.json` 顶层 `"compressionDomain"` 读；`calibrateThresholds()` 导出校准后的 retain/threshold。
- **独立于 hard-truncate floor**：压缩域窗口（≈50K）≠ 模型窗口安全阀（`contextWindow×truncatePct`=204.8K）。压缩域只作用于压缩触发阈值与保留预算；安全阀是"仅防溢出"，不因压缩域窗口改而改变行为。

---

## 6. 判别器约定（全局对照-边界 / self 共用边界来源）

**复用插件输入域已写好的最优策略**，不在 evalground 重设计：
- **模型**：`opencode-go@minimax-m3`（预设 `minimax`：综合最优——准确率与切换召回双高 + 成本中档）
- **判据**：prompt **v2.2**（生产固化，与 `datasets/prompt-discriminator-v2.2.txt` 逐字节同源），排除式规则：
  - 先决排除（判 continue）：追问/澄清/报错/汇报/工具输出/讲解/方案设计/观点讨论（言说层）、收尾清理（收尾层）、无法确定
  - new_task 检查（命中任一即 new_task）：**宣布/承诺/命令链**、**换意图**、**换对象**（文件/项目/产物变化）、**换域**、**换形态**（说→做）、**中止重开**
  - 否则 = continue（同一工作推进/细化/讨论）
- **调用参数**：`temperature 0`、`maxTokens 400`、`effort none`（minimax 直出型，不发推理参数）
- **窗口口径**（v6 冻结）：`anchor ≤350` / 每条 `patch ≤350`（最近 **2** 条）/ `target ≤800`（头600尾200中缀截断）

**⭐ 边界只锚定用户流消息（用户校正，取代旧稿"单任务内部切多子单元"）**：
- 判别器**只对 `user/message` 事件判定**（`u≥1`；`u=0` 首条由投影隐式开段，不判）——任务边界是**用户消息流**
  的切分结果，`<target>` = 当前这一条用户消息，`<anchor>` = 当前任务锚（段头原文），`<history>` = 同任务最近 N 条
  （`collectHistoryTexts`，段头开区间）。**segments = 判别器在用户消息流上切出的段。**
- **单用户消息的 task（只读审查 T1 / 单 prompt 的 T0–T6）恒为 1 段**——没有第二条用户消息作 split 点，判别器
  无法在其内部切出子单元。这类 task 没有可压的段边界，self-* 实验臂对它们**天然退化为无压缩**（无段可压）。
- 判 `continue` 即不切段：**同对象（文件/项目/产物未变）+ 稳定意图流 = 同一 task**（上下文复用 + 用户意图稳定流动，
  `换对象`/`换意图`/`换域`/`换形态`/`中止重开` 均未命中）。只有消息真正开启一个**不同的任务**（判断同上，命中任一
  `new_task` 触发）才切出新段。
- 旧稿"判别器把 T1 审查流程切成『读源码各规则 / 审查 filter.js / 产出 REVIEW.md』多个子单元"**作废**——
  那是把 agent 内部的工具调用子步骤当成了 task 边界；真实判别器只判 `user/message`，T1 单消息 = 单段。
- 数据标记（`boundaries/<id>.boundaries.json`）记录的就是**用户消息流**的切段结果 + 每次判定的真实成本。

---

## 7. 判定指标与公平性

### 7.0 消融协议（单变量主效应 + 双因素定点交互校验 + 质量门，预注册）

> 立场（用户确认）：**单变量消融**而非全组合；**"平行策略贪心（加性）"只作为待检验的工作假设**，
> 不默认成立。因为 A1×A2、A2×B 存在理论性强交互，贪心在强交互点会欺骗。

**策略分层**：

1. **主效应消融（首阶段）**：每个旋钮**单变量**扫主效应，其他档固定基线。约 10–14 格 × 3 复现。
   - A1（判定：热如何定）：最近 N / 近因 token 尾 / 引用活跃度 / 混合 —— 各档是候选，待探究
   - A1（保留：热如何处理）：零压缩 / 少压缩 / 分层压缩 —— 各档是候选，待探究
   - A2（处理方式）：**方案0 保留原始 vs 方案1 具体内容展开** —— 单变量对照，A2 唯一进测试的变量（B 已并入）；
     方向2 已否决；方向3/方向B/方向C 为插件设计空间（搭便车机制），已抽到 docs/02-compaction.md，不进本测试
2. **双因素定点交互校验（仅理论强交互处）**：在 **A1×A2** 一处补少量双因素格点，
   检验**加性假设是否 hold**（B 已并入 A2，A2×B 交互格取消）：
   - 判据：若 `Δ(交互格) ≈ Δ(各自主效应之和)`（偏差在噪声内）→ 加性成立，可用贪心叠加；
     若偏差显著（超出置信区间）→ **该维度对必须联合调，不能贪心**。
3. **质量门门槛（每一格都先过）**：`costPerSuccessfulTask` 必须**完成率不降**。贪心目标若是"省 token 最多"，
   必须以质量为前提——一个在质量门上不合格的"token 最优"格**不算赢**（docs/08 §3 纪律：先过门再比钱）。
4. **加性假设判定**：主效应 + 定点交互校验完成后，用交互项显著性判断"平行策略贪心"是否 hold；
   若 hold → 用加性模型归因；若不 hold → A1×A2 必须成对报告，禁止拆成独立结论。

### 7.1 判定指标（唯二 = 产出质量 + 成本）

> **方法论（用户确认，取代此前"列一串中间量"的做法）**：压缩域的所有动作（A1/A2）最终只有两条通道影响价值——
> **① 产物质量  ② 成本（token/美元）**。除此之外的任何中间量（cacheReadTokens / reDiscoveryTokens /
> extraSearchCalls / recencyZoneRetainRate / compressionCacheHitRate / digestCoverage / compoundedVolume 等）
> **只有在与质量/成本存在定量函数关系时才有意义**——而它们**没有稳定的定量关系**。因此：
> - **判定 = 产出质量 + 成本 两条**（唯二）；
> - **中间量只作"归因诊断"**（解释"为什么某臂更好"），**不入判定**、不作为对比指标。

- **产出质量**：mech（确定性事实：金色命中/范围/测试/反作弊）+ judge（固定 rubric 盲评；judge 不见臂标签）。
- **成本**：`costPerSuccessfulTask`——`costPerSuccessfulTask` = 总成本 ÷ 成功任务数；成功 = 质量门通过
  （完成率不降 + 盲评不劣）。这是唯二的成本判定。
- **归因诊断（备用，不入判定）**：`cacheReadTokens` / `reDiscoveryTokens` / `extraSearchCalls` /
  `recencyZoneRetainRate` / `compressionCacheHitRate` 等，仅用于解释中间机制，不用于下"更优"结论。

### 7.2 公平性

- 同模型/provider/effort/temperature；**配对**（同一任务在所有臂各跑一遍）；
  复现 ≥3 遍；冷/热缓存分开报；只报配对差值 Δ，禁止单次运行结论。

---

## 8. 多组实验与待深究项

**已写入（讨论稿，用户继续细化中）**：
- A1 = **候选方案待探究**（判定：最近N/近因token尾/引用活跃度/混合；保留：零压缩/少压缩/分层压缩）——每一档都是"原理上可能更优"，非锁定插件现状；
- A2 = **不做裁剪**；进测试的 A2 变量 = **方案0 保留原始 vs 方案1 具体内容展开**（单变量对照；B 已并入）；方向3 结构化抽取 / 方向B 提问式 / 方向C provenance 置信度 = **插件设计空间（搭便车机制），已抽到 docs/02-compaction.md**，随压缩定稿再作为单一变量参与新实验；方向2 已否决；
- C 策略 = **已取消**（产物放置用成熟"稳定前缀"固定，不作变量——该权衡已成熟）。

**待用户给出 / 深究**：
- **C 的组装策略与缓存成本的精确对应**：用户指出需深究（本节 C 标注为讨论稿，非定稿）；
- **A1 候选档的具体探究**：判定（最近N/近因token尾/引用活跃度/混合）× 保留（零压缩/少压缩/分层压缩）——待用户给变量；
  **且每一档必须标注"是否需已压缩边界"**（不锚 task 边界的判定 / 非零压缩的保留 → 必须配已压缩边界，否则漂移）；
- **已压缩边界的落位**：漂移约束如何与各 A1 候选对齐（边界不对齐处、多层压缩梯度）——需细化；
- **少压缩跨触发统一**：近因保留应统一作用于【task 边界压缩】+【单 task 超阈值自动压缩】，不能只在 task 边界用；
- **A2 方向1（类型化指令）落地**：按 task 类型建模信息损失函数（解释/计划 → 目标+约束+决策；落地 → 文件+改动+测试+失败原因）——需具体 prompt 模板；
- **A2 方向3/方向B/方向C（搭便车机制）**：属**插件设计空间**，**已连同全部机制讨论抽到 `docs/02-compaction.md`**；将来插件压缩**定稿设计**时各自作为**单一变量**参与新的实验方案——故本文件不再追踪其详细落地，只保留"已抽离"这一事实；
- **self 的精确选择算法组合**：用户已确认"需要多组实验，控制更多不同的变量，具体之后告诉我"；
- **A1 × A2 网格**的逐格矩阵：待用户给具体变量后展开（B 已并入 A2）；
- 本文件**不预设**这些组合；先锁定"方法 + 三臂 + 标定 + 判别器"这层确定的内容，待变量齐再扩。

---

## 9. 实现 ↔ 机制对应表（防"设计有、代码无"）

| 机制 | 代码 | 断言 |
|---|---|---|
| 压缩域标定（任务尺度） | `lib/calibrate.mjs`（`calibrate/domainTokens/retainTokens/thresholdTokens`） | `tests/assert-compaction.mjs` CAL 组 |
| 标定配置接入 | `lib/arm-spec.mjs`（`compressionDomain`/`calibrateThresholds`） | DOMAIN 组 |
| 预处理标注（判别器逐条在线判定 + 真实成本） | `lib/boundary-mark.mjs`（`markBoundaries`/`userMessagesOf`/`userEvent`/`verdictEvent`） | PREMARK 组 |
| 数据标记读侧 + 定位 | `lib/boundaries.mjs`（`loadBoundaries`/`findBoundaryAt`） | BOUNDARIES 组 |
| 运行时边界压缩（消费标记） | `lib/runner.mjs`（`compression:'task-boundary'` 分支） | RUNNER 组 |
| 判定成本落盘（预处理真实成本 → `costs.decision`） | `lib/run-one.mjs`（`loadBoundaries` → decisionCost） | MARK-COST 组 |
| 边界/压缩事件类型 | `lib/transcript.mjs`（`task-boundary`/`task-compact`，`validateEntry`/`summarize`；`task-compact` 含 `segmentIndex` 段序号 + `slot` 关闭段最后消息真实流位置） | RUNNER + U 组 |
| 压缩域臂 | `arms.config.json`（A1×A2 网格 4 臂 + 2 对照，`compressionDomain`；2026-09 瘦身后仅此 6 臂） | ARMS 组 |
| 级联化：完整流切段 + 任务边界 | `lib/cascade.mjs`（`humanTaskStream`/`markCascadeBoundaries`/`splitTranscriptByTask`） | CAS / CSCORE 组 |
| 级联化：整条流一次运行 | `lib/run-cascade.mjs`（`runCascade`） | CASCADE-RUN 组 + CASCADE-JUDGE 组（judge 账本 + slot 归因） |
| 级联化：逐 task 判分不串味 | `lib/run-one.mjs`（`scoreOne`/`taskFinalText`）+ `lib/cascade.mjs`（`splitTranscriptByTask`，按 `stage.index`/`task-compact.slot` 切回每 task 子窗口） | CASCADE-SCORE 组 + CJ 组 |
| 级联化：共享工作区写范围（ALLOW 并集） | `lib/tools.mjs`（`createTools` `allowedPaths`）+ `lib/allow.mjs` | TOOLS 组 |
| 既有臂不回退 | `lib/compress.mjs`/`lib/assemble.mjs`（未改核心） | COMPAT 组 + 既有断言 |
| A1×A2 网格 4 臂（本文件 §3 可落地规格收敛 = A1-S1/S2 × A2 方案0/方案1） | `arms.config.json`（`self-s{1,2}-{orig,expand}`，task-boundary + `a1` + `a2`）+ `runner.mjs`（task-boundary 分支 `a1` S1 引用化保尾/`a2` harness 侧展开）+ `assemble.mjs`（`renderSection`/`renderRetain`） | `tests/assert-arms-grid.mjs`（ARMS-A / A1-SEM / A2-RENDER / TRIAL 组） |
| PTC 式压缩器（模型写程序，一次完成） | `lib/compress.mjs`（`compressWithProgram`/`enrichRefs`）+ `lib/code-run.mjs`/`code-run.worker.mjs`（worker_threads seam）+ `lib/sdk.mjs`（SDK+模板）+ `lib/compressor-prompt.mjs`（严格指令+PROGRAM CONTRACT） | `tests/assert-template-battery.mjs`（PROBE/RUN/OUT/RATIO/RET/SCHEMA/PTR/ERR 组）+ `tests/assert-prompt-contract.mjs` + `scripts/direct-compressor-check.mjs` |
| 指针计算/校验/展开（代码保证） | `lib/compressor-io.mjs`（`probe_substructure`/`locate_change`/`validate_pointer`/`resolve_pointer`/`read_transcript`/`estimate_tokens`/`computePointers`/`verifyRefGroundTruth`/`rawEchoMarkers`/`findRawEcho`）+ `lib/compressor-validate.mjs`（schema/ratio/retention） | 电池 PTR/Schema/RATIO 组 |
| 压缩比检查 + 保留长度门 | `lib/compressor-validate.mjs`（`checkRatio`/`checkRetention`）+ `arms.config.json` `compressor` 块（0.5/0.75/0.45/3000/8/40/codeRun） | 电池 RATIO/RET 组 + 审计脚本 |
| 真实级联循环（T0..T7 一次会话）+ PTC 防损 | `run-cascade.mjs`（透传 `calibrated`/`compressionDomain`/`maxSteps`/`maxCompressions`）+ `runner.mjs`（task-boundary 压缩输入=含旧分节 FROZEN 真前缀；旧分节=不可变消息节点 只增不改；S1 保留节点下次压缩即删、绝不重喂）+ `boundary-mark.mjs`/`cascade.mjs`（真实投影 fold 边界） | `tests/assert-cascade-loop.mjs`（MASTER / S2O / S2X / S1 / NAT 组，第 7 文件）+ `scripts/audit-compression.mjs` |

**本机已落地（数据标记边界）**：self-* 实验臂（`self-s{1,2}-{orig,expand}`）用**预处理数据标记**定位 task 边界（判别器切段，存 `boundaries/<id>.boundaries.json`），运行时在段结尾压缩——**无运行时动态 task 分划状态机**。task 分划的**真实成本**（判别器调用）记入 `costs.decision`，来源 `source:'premark'`。**A1（S1 近因门·保尾压头 / S2 闭合即全压）与 A2（方案0 保留原始 / 方案1 具体内容展开·信息块）已作为 A1×A2 网格 4 臂落地**（`runner.mjs` task-boundary 分支读 `a1`/`a2`，`assemble.mjs` 加 `renderBlocks`）；候选矩阵（A1-j1/j3/j4、A1-p2/p3）与方向2/方向3/B/C 仍为设计空间，见 `docs/02-compaction.md`，未在 evalground 实现。**2026-09 臂表瘦身为最终协议 6 臂**（2 对照 + 4 网格；无压缩条件取消，`self-compact` 并入 `self-s2-orig`，历史 V1/V2/V3/X 臂清理）。

**⚠️ 防损压缩（PTC 式落定——真前缀 + FROZEN + 只增不改，不再切片）**：task-boundary 压缩器的输入 = **当前真前缀
（system + 旧分节节点 + 新段原始工作，FROZEN 指令排除旧分节）**——旧分节留在输入（缓存复用），**不重压靠指令 +
程序结构**（`probe_substructure` 只覆盖新段；`emit` 只追加），非剪切。旧分节 = **每压缩一段一个不可变消息节点**
（只 push 不重写 → 跨压缩前缀字节稳定）；S1 保留节点（refs+outline）为瞬态，**下次压缩开始即整片删除**（不重喂、
不重压）。**wire 前缀 = system + tools + messages 逐字对齐**（DSH-native 逐字回放工具 schema）：压缩请求必须携带与
路由请求**相同**的工具 schema，否则提供方缓存在 tools 位置分叉——2026-09 真实交错验证发现 PTC 压缩请求**曾漏传
tools**（压缩调用 cacheRead 128 vs 执行调用 ~3k），修复后压缩调用 cacheRead 3008/2944（`compressWithProgram` +
`taskBoundaryStep` 传 `makeSchemas()`；审计 M5 断言同步扩展为 wire 前缀含 tools）。
`runner.mjs` 现按此实现；累积块单体字符串（每次重写）已废弃。**真实级联 `runCascade` 试运行验证**：
S2 每闭合段边界压 1 次（seg1..seg7）、全无保留（E3）；A2 方案0 落盘=坐标指针 / 方案1 落盘=refs+harness 展开内容
（E4）；S1 逐压缩保留 refs+outline + 下次压缩删除；所有压缩器请求的 FROZEN 前缀（system+分节）字节不变（真前缀缓存复用）；
`native-auto`（M0 严格原生：surface=slice(1) 含 task）在 `calibrated` 覆盖下可驱动不退化，压缩器请求为真前缀 +
checkpoint 单一 `<compacted-summary>` 节点。见 `tests/assert-cascade-loop.mjs` + `scripts/audit-compression.mjs`（V5 覆盖矩阵全 PASS）。

**级联化执行形态（完整流 = 最终实验目标）**：
- **完整流 = T0–T7 串成一条会话**：`humanTaskStream` 把各 task 的用户消息（`userMessagesOf`）按序展开成一条消息流；`markCascadeBoundaries` 在**整条流**上跑逐条判别器（复用 `boundary-mark.mjs` 的 `judgeMessage` 内核）切出 task 边界，存为 `boundaries/CASCADE.boundaries.json`。
- **`runCascade` 一次 `runSession` 跑到底**：self-* 实验臂在**段边界（进入下一个段头 `startSeq` 之前）**压缩上一段上下文——task 边界触发，非 token 阈值。
- **边界只锚用户流消息**：单消息 task（T1/T0 等）在**单 task 视角**下恒 1 段；只有**跨 task 切换**（完整流）才切出多段。判别器判 `continue`（同对象推进）是正确行为，不干预。
- **逐 task 判分不串味**：完整流的 transcript 用 `splitTranscriptByTask` 按 `stage.index` 切回每 task 子窗口，`taskFinalText` 取该 task 自己的 DONE（`answer-contains` 不泄漏到别的 task）；mech/judge/subjective 逐 task 判，聚合 `taskBreakdown`。
- **共享工作区写范围**：完整流下 `tools` 写范围 = 全部 task 的 `ALLOW` 并集（同一 relaudit 工作区连续做 8 件事）。
- **单 task 路径保留**：`runOne`/`runMatrix` 逐 task 运行不变，仅作**验证/省成本路径**；`runCascade` 是完整流实验入口。
- **成本口径**：完整流 scorecard 的 `costs.execution`=整条流执行、`costs.judge`=逐 task 真实 judge usage 聚合（subjective 不入账）、`costs.compression`=压缩真实成本、`costs.decision`=判别器真实成本（source premark / real）。
- **压缩语义（本轮修正，用户拍板 DSH）**：
  - **压缩器身份恒定**：压缩提示词是固定"上下文压缩器"角色，**不是任务锚定**（`TASK ID` 框架已移除）；任务内容是**数据（进 context）**，不是压缩器身份。
  - **只压未压缩新增**：压缩器每次只拿到**上次压缩之后新攒的原始执行记录**（`compactFrom` 游标按段切片），早前段已压成的**压缩段不再重喂**。
  - **无压缩上限**：`maxCompressions` 对 task-boundary 分支**不再封顶**（每段边界压一次；旧上限 2 会低估 self-* 实验臂）——段数即边界数，无 runaway 风险。
  - **压缩段累积组装**：每次产出的压缩段**追加**进一个累积前缀块（`[system] + 压缩段块 + 当前任务指示`），持久存在、被组装到合适位置，但**永不参与下次压缩**。
  - **⑤ 有界截断（DSH 设计，实验不实现）**：压缩段过长时"截断最早、保留最近几个"——记录于 `docs/02-compaction.md` §3；evalground 只实现累积、不实现截断（压缩段实际占用/边界行为正是探究对象）。

**记档知情：已知保真度偏移与参数假设（2026-09 审计，仅记录、不改变行为）**：

- **F1（影响 E1 对照保真度）**：native 对照（`native-auto`/`manual-habit`）的触发压力 = `st.lastPromptTokens + estimateMessagesTokens(messages)`（`lib/runner-compress.mjs` `wholeSurfaceStep`，native-auto 分支）——"上一个请求的提示 token"与"当前同批消息的估算"**相加，上下文被算了两遍**，触发会**早于**真实 DSH 原生行为。这是当初"标定到能触发"时接受的偏移，用户已知情；它**只作用于 E1（触发方式）这一对照维度**（self-* 臂触发 = task 边界，不经此压力值），解读 E1 的"触发时机"时要按此偏移解释，不能把 native-auto 的触发轮数当真实原生轮数。
- **F2（极端情况才威胁不变量）**：防溢出硬截断（`lib/runner.mjs` 硬截断分支，`keep = messages.slice(0, 2)` = **[system, task] 固定前缀**）在溢出时会把第 2 条之后的所有消息当旧历史丢弃——任务边界臂的**不可变分节节点**排在第 2 条之后，真到溢出会被丢，"分节只增不改"被破坏。参数前提（此前未写）：压缩域（任务尺度 ≈5e4 tok）**远小于**截断地板（`contextWindow×0.8`，默认 256000×0.8=204800），正常永远到不了该分支；该分支是**全臂防溢出安全阀**，非压缩域机制。
- **F3（设计内死约定，无行为影响）**：①边界文件"存在才压缩、不存在静默跳过"——单消息 task 本无段可压，属设计内；②工具结果入上下文截 12000 字符、入记录截 1500 字符——`manual-habit` 的"测试通过"检测读的是 1500 截断版，超长输出尾部的通过标记可能漏看（影响极低，纯规则质量标杆使用）。
- **F5（压缩器输入形态差异 → 单次压缩成本结构性差 3–4×，同装置实测）**：DSH 原生回放 = system+tools+**被压区域**（头锚定，区域即头部前缀，输入小：实测 1314/1441 input）；PTC 压缩**尾部新工作**，回放**全量前缀**（system+旧分节+新工作：实测 4563/4739 input）——以"大输入"换缓存前缀完全对齐（命中率同级 62–66% vs 0→67%）+ 压缩器上下文完整。**成本侧判断：每次 PTC 压缩需回收足够大才划算，门槛高于原生**。同装置样本仅 1 流 2 次/臂，方向性结论，非批次判定；E3/E4 判分时压缩器成本是真实变量，不得忽略。
- **F6（API 缓存固化时序——环境行为，非组装问题；2026-09 两个彩排实测）**：opencode zen 网关的硬盘缓存"输入结尾/模型输出结尾"前缀单元**固化需数秒**（DeepSeek 官方 Context Caching 文档：*"Cache construction takes seconds"*、best-effort、完全匹配单元才命中）；**超长输出（thinking 长推理）后紧邻的请求常整笔 miss**——字节前缀已由装配审计 P5 逐字节证明一致，故非组装缺陷：native-auto 彩排压缩调用#1 0 命中（前序执行全 miss 继承）；manual-habit 彩排主循环**尾部** 2 次执行调用 0 命中（压缩调用本身 99%+ 命中）。**对成本影响真实（miss 轮全价）、对臂公平（同机制、随超长输出轮出现，真实 harness 的工具循环内亦无等待）**；解读 E3 缓存命中率时须按"与超长输出轮的紧邻性"归因，勿归为组装/压缩策略差异。
- **F7（特殊情况单样本，仅记录、暂不重跑；待批次复现裁定）**：manual-habit 彩排 `CASCADE-manual-habit-mtkrx7zs`（2026-09-03）**T7 机械归零**（`tests-tampered` → mech=0 / total=0）：模型基于一次 `dist/**` glob 假阴性误判"`audit.test.js` 缺 fixture tarball"，试图写 `tests/00-gen-fixture.test.js`（其 reasoning 明示"临时生成→跑完删除→tests/ 保持 pristine"），被 write-guard 拒绝、**未落盘**（scope diff 无 tests/ 改动）；归属账按"**尝试**"计入（意图级零容忍）→ tests-tampered 触发归零；judge 仅判 `suspect`（scope=2、finalState=4，antiCheat "attempted write… nothing landed"）。**定性**：模型行为样本（错误推理→善意越界），与压缩臂机制无关；mech 零容忍 vs judge 渐变系评测设计内（防测试作弊的核心防线，无"未遂豁免"）。**处理：不重跑、不改任务提示**；3 复现批次若系统性出现（≥2/3）再议——若系统性，修法为任务提示澄清"fixture 由评测环境提供、tests/（含新建辅助文件）不可触碰"，**不动机械判分规则**。**（随记 2026-09-03：按用户指令对 scorecard 做反事实评分替换——T7 mech 0→100/judge 80→88/total 0→95、顶层 total 76→87/avgJudge 75→76；原始分备份 `scorecard.original.json`，数值快照与口径声明见 `docs/07-metrics.md §28.3`。）**
- **F8（机制级缺陷已修复——PTR 门坐标粒度冲突；2026-09-04 定位并修复，全离线验证）**：s1-expand 3 复现中 `CASCADE-self-s1-expand-mtlejbtj` **4 次压缩被打回**（seg2–5 各一次，全部 `duplicate ref to truth:write:41`，白烧 ~$0.031、该 rep 压缩覆盖 2/6——但 fail-lazy 保住质量，rep 得 93 与 native-auto 持平）。**根因是机制缺陷而非模型波动**（修正此前"模型行为异常"类归因）：①`pointerOfWrite` 坐标 =（path + 写入时行数 + 首函数名），同文件**等长重写**两次的坐标逐字节相同（实证：该 run `docs/api.md '1-161' ×2`、`docs/rules.md '1-113' ×2`；`clusterSubtasks` 不合并被 verify/read 簇隔开的同文件两次写 → 2 个 edit subtask 各产一个同坐标 ref）；②`verifyRefGroundTruth` 用 find-first + used Set 执行"一条 truth 至多引用一次"，把两个**真实且不同**的写事件折叠到同一条 truth → 必判 duplicate → 误杀；③**失败放大器**：打回后 `st.segmentEntriesStart` 不前移（成功才推进），后续每段的压缩上下文重新呈现同一碰撞 → 4 连败全死在同一坐标。**修复（三层）**：门改 `auditRefs` **坐标组配额制**（`lib/compressor-io.mjs`——每个坐标的引用数上限 = 该坐标真实记录数，消费序 = recordIdx 序，确定性）；编造型 ref（无落点）仍**整程序拒绝**（反幻觉硬线未松），超额型 ref **确定性剪除**（`lib/compress.mjs` 原位移除 + `prunedRefs` 账目，product 存活，凑数经济上一无所获）；A2 expand 同目标**只 resolve/内联一次**（`lib/compress.mjs` enrichRefs resolve 缓存 + `lib/assemble.mjs` 渲染 `→同` 指针去重）。提示词同步换措辞（"cite where owned, harness collapses"）。**回归证明**：`tests/fixtures/template-battery-multiwrite` 复现碰撞形状（两条 truth 同坐标 `1-6/checkAuth`、refKey 不同），MW-1..7 离线断言——旧门红（2 合法 ref → `duplicate ref to truth:write:5`），新门绿；全量 `ground:assert` 0 失败。**批次声明**：既有 run 原样入账，4 次失败按**机制归因**分层解释（不计入 A1/S1 机制效率账、不归模型波动）；修复后重跑 = **新批次并标注**（template.sha256 自动留痕）；`compression-failed` 字符串非评分输入（score penalties 表不含），无需 re-score 回填。

---

## 对齐记录（方法论来源，防再漂移）

1. DSH = **DeepSeek Harness**（框架本体），非 "DeepSeek" 非 "自研压缩"。
2. `self` 臂复刻的 DSH 自研压缩 = **task 边界自动触发**（orchestrator），**不是 token 阈值**。
3. task = **架构层建模的单位划分方法论**，用判别器切生命周期。
4. A1/A2 是**叠加在 task 边界压缩之上的旋钮**，不是独立实验组；A 拆 A1/A2 两正交子维度；**B 已并入 A2**（方案0 保留原始 / 方案1 具体内容展开）、**C 已取消**（稳定前缀固定），不再独立.
5. （B 已并入 A2。）类型化 = 方案0 保留原始 vs 方案1 具体内容展开。
6. **判定唯二 = 产出质量 + 成本**（用户方法论，取代"列一串中间量"）：A1/A2 终归只通过这两条通道影响价值；
   中间量（cacheHitRate / reDiscoveryTokens / extraSearchCalls 等）只在与质量/成本有定量函数关系时有意义，
   但它们没有——所以**只作归因诊断，不入判定**。
7. **A2 不做裁剪（用户校正，取代旧稿"确定性裁剪"）**：输出（压缩产物）不是 A2 职责（是 B/C 的事）；**裁剪无用**
   ——机械不可能比 LLM 准，且破坏一致性/缓存。A2 真正的问题是"优化压缩器输入的信息密度与一致性，且保持成本低廉"。
8. **压缩器输入缓存（源码事实，非 A2 方案）**：原生压缩器输入 = `[system+tools] + 被压区间原始消息逐字节原样`，
   复用 agent 前缀缓存故成本最低；但**信息密度低**。DSH `toolResultPruner` 用 `surfaceOp:{op:'replace'}` 原位替换
   超大 content（位置/seq/角色不变）→ 前缀连续保缓存——这是**缓存机制的技术事实**（删消息断缓存/原位替换保缓存），
   **不是** A2 优化方向。
9. **热 task 定义**（源码）：近因判定是**纯 token 位置**（`recencyTailCutoff` 反向累加 ≥ retainTokens），
   非"最近1个 task"；热 task = **零压缩（整段逐字保留）**，不是"少压"。
10. **少压缩跨触发统一（用户洞察）**：近因保留（保热尾）应统一作用于【task 边界压缩】与【单 task 超阈值自动压缩】，
    不能只在 task 边界用。插件当前把保留策略割裂为 task-boundary（近因门）与 overflow（whole-surface），需统一。
11. **已压缩边界防语义漂移（用户洞察 → 自洽约束）**：二次压缩会把已压缩的摘要当原始内容再压 → 语义二次损毁。
    根因（types.ts `surfaceIndex`）：task 压缩后 `startSeq`/`lastSurfaceSeq` 重映射，边界坐标变了。
    方案 = task 内"已压缩边界"标记，对齐前后压缩程度；与 docs/02 §3 摘要区 append-only 同源。
    **这是一条约束（制约所有候选方案），不是独立洞察**：凡触发跨边界/多次压缩的候选都必须配它。
12. **A1/A2 是候选方案待探究，不是确定死方案（用户校正）**：A1 的"热"判定（最近N/近因token尾/引用活跃度/混合）
    与"热 task 处理"（零压缩/少压缩/分层压缩）各自都还有原理上可能更优的候选，应纳入单变量消融探究，
    而非锁定插件现状（A1-j2 近因 token 尾 + A1-p1 零压缩）。
13. **候选方案与已压缩边界自洽（用户批评"12 方案没考虑 34 漂移"）**：凡**不锚 task 边界**的判定（A1-j1 最近N）
    或**非零压缩**的保留（A1-p2 少压缩 / A1-p3 分层压缩），处理**必须复杂化**——配"已压缩边界"对齐前后压缩程度，
    否则漂移。插件现状（近因尾 + 零压缩）之所以安全是因为**不产生多次压缩产物**；引入少压缩/分层/最近N
    **必须以已压缩边界为前提**，否则该候选不成立。
14. **A2 优化方向合议（用户）**：① **方向1 类型化压缩指令 = 基础必选**（只改指令不改输入，让 LLM 聚焦该任务
    类型需保留的信息；A2 的输入侧），成本=0、可机械断言；② **方向2 否决**（压缩的单独可缓存前缀无意义——
    信息不需反复压缩；重排破坏 agent 前缀复用，成本激增）；③ **方向3 结构化事实抽取 = 搭便车**——复用必然发生的
    LLM 调用（判别器判边界时顺便输出图谱 JSON），输入成本零、天然对齐 task=图谱节点；④ **方向B 提问式压缩**
    契合 mech 层（问题-答案对可机械对照 transcript 验证，非 judge）；⑤ **方向C provenance 置信度**
    必须机械——置信度 = 记录 provenance 确定性推导（{sourceType, replayable, fieldComplete, consistent}），
    非模型自证数字（LLM/MoE 对数字与语义混杂的置信度不可信）。
    **⑥ 工作范围区划与对照结构（用户校正，最终）**：方向1 是**进压缩域测试的 A2 唯一变量**，且对照结构为
    **方案0（全部结构化 / DSH 原生压缩指令）vs 方案1（类型化压缩指令）**——是"方案 1 vs 全部结构化"的单变量对照，
    **不是"方案1 开/关"**（开关没有确切的对照基准，原生方案是有确定的 DSH 行为）。**方向3/方向B/方向C 是插件的设计空间**
    （搭便车机制），**已抽到 `docs/02-compaction.md`**——将来压缩**定稿设计**时各自作为**单一变量**参与新的
    实验方案；它们与"压缩省 token / 提效"测试主轴无关，为它们单独设计测试只会徒增无用维度。其余各优化方向
    （B、C、A1）同样遵循"存在一个类似 DSH 原生方案的对照组"这一结构。
15. **方向A 位置转移（用户已在规划）**：压缩是"位置转移"而非"信息压缩"——细节不在上下文（图谱/语义化文件读取），
    上下文只留高密度索引+指针；但**已完成的 task 不配占这么多资源**（连指针都不留全套，只留结论+可重放锚）。
    方向A 不在此重复展开（用户已在知识图谱/文件读取中规划）。
