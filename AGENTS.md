# 项目定位

@dsh-external/dsh-context-economy：DSH 的**全自动上下文管理工具**——双核心
（优化判别器 `docs/02` / 压缩器 `docs/04`）+ 四层防御（交换对剪切 `docs/03` /
task 边界压缩+热尾 / 40% 压力路径 / 防溢出保险丝）+ 五条节约理念（缓存复用 / 软件架构经验
提取 / 无关内容剪枝 / 执行路线确定化 / 多做·相信用户决策·必要才探索，正典 `docs/05 §1`）。
宪法与回退链在 `docs/05`，缓存纪律 `docs/06`，状态协议 `docs/09`。
完整设计在 `docs/`，本文件只给可执行的高信号指令。

**现状**：src/ = 模板态三件（index/config/settings），client/ 设置壳**全保留**（星标按钮 +
度量可视化按 `docs/11 §5` 接线）；机制实现按 `docs/11 §8` 搭建序（R0–R4）推进，
核心纪律：core 零 harness import、改史唯一通道 = surfaceOp replace + sourceEventSeqs、
自定义会话事件必须 ignorable:true、LLM 产物先版本化落盘再复用。
实验框架 `experiments/evalground/` 原样保留（活平台 + 全部 run 证据）。

## Build

- `DSH_CHECKOUT=G:/deepseek-harness npm run build` —— junction 链接 checkout 依赖后 tsc 编译 host，
  随后 tsdown 编译 client（UI 壳），产物 `lib/`。
- 改完代码必须构建通过才提交；`npm run typecheck`（host）/ `npm run typecheck:client`（client）只查类型。

## Test

- 每个机制（判别/星标断面/剪切/压缩）必须能在 `docs/08-experiment.md` 的协议里被观测；
- 改动前后必须留账本快照（`docs/07-metrics.md` 现行口径；历史快照档 = `docs/ledger-history.md`，
  只增不改），否则改动不算完成；
- 对照试验用配对差值（Δ=臂−基线）汇报，禁止单次运行的结论；
- 插件侧 vitest 仅剩设置壳不变量（`tests/field-model.spec.ts`）；机制测试随搭建按 docs/08 协议恢复。
- **评测模型固定（硬规则）**：任何实验批次内，executor/judge 必须全部固定且同批次不换——当前固定 = **DeepSeek 官方 API 直连（https://api.deepseek.com，key 在 homedir yaml `DEEPSEEK_API_KEY`）/ executor = judge = decision = deepseek-v4-flash-vision-exp**（单一事实源 `experiments/evalground/scores.config.json` 的 executor/judge 字段；判别器默认在 `lib/boundary-mark.mjs`）。**2026-09 传输层切换：opencode zen 网关（hy3/glm-5.3-flash）整体退役；换评测模型 = 整批重跑并标注**——切换前全部 run 属 opencode 时代历史批次，与新批次数字永不混用、不混批。deepseek-v4-flash-vision-exp 是 thinking 模型（实测返回 reasoning_content、官方接受 max_completion_tokens、`prompt_tokens_details.cached_tokens` 可读），须走 `protocolFor(model)`（含 `deepseek`）的 max_completion_tokens + 宽松预算，不得退回到 max_tokens/8192 的 length-cap 老问题；
- **thinking 协议（硬规则）**：thinking 模型（GLM-5.3-Flash/deepseek 系强制 thinking 不可关）做多轮工具调用时，必须把上一轮 assistant 的 `reasoning_content` **原样回传**，否则网关 400（"reasoning_content ... must be passed back"）。`experiments/evalground/lib/gateway.mjs` 已统一处理：读取 `message.reasoning_content`（兼容数组块）并暴露给调用方、发出请求时回传；`runner.mjs` 在重建 assistant 消息时携带它。改任何 transport 都必须保持这条（gateway 的 `protocolFor(model)` 是 max 参数名/temperature 的单一事实源：thinking→max_completion_tokens、GLM→temp=1、其余→max_tokens/temp=0）。
- **缓存观测（硬要求）**：`gateway.mjs` 的 `cacheReadTokens` 必须读 OpenAI 标准 `data.usage.prompt_tokens_details.cached_tokens`（同时兜底 `prompt_cache_hit_tokens`/`cache_read_tokens`/`prompt_cache_read_tokens`）——实测 DeepSeek 官方 API 直连回 `prompt_tokens_details.cached_tokens`（2026-09 冒烟：共享前缀二连调命中 0→640），漏读会让缓存永远为 null、成本按无缓存高估。缓存命中率是压缩效率的核心对比指标，改动 gateway/usage 读取时必须保持可观测。
- **主观评判层（evalground 评分标准）**：评分 = mech（确定性事实：金色命中/范围/测试/反作弊）+ judge（固定 rubric 盲评；review 型任务含 `grounded`「证据落地」维，prompt 注入 `golden-bugs.json` 缺陷参照以区分"真实超金色集发现"与"伪造"）+ `lib/subjective.mjs` 资深 reviewer 盲评（overallQuality/wouldShip/overReport/**realExtras**，**盲评、不入总分**；prompt 不传入臂，防标记泄漏）。金色集已补全 `public/filter.js`(B9)/`public/format.js`(B10) 两个真实 planted bug；mech `report-match` 改**连续覆盖分**（hits/goldenTotal × (1 − fp/goldenTotal)，非"达标即满分"）；`score.assemble` 追加**超金色奖励** `beyondGolden`（仅 review 任务、gate 在 `grounded`≥3 时才给，`min(realExtras,6)×6×gate`），**总分可超过 100**（已批准语义）。改 golden-bugs.json / task rubric / judge / subjective / score 后必须用 `scripts/re-score-run.mjs` 或 rejudge 回填既有 run，禁止新旧口径混用。
- **压缩域实验语言（硬规则）**：压缩域按**任务尺度**标定，**不**按裸模型窗口（模型真实 1M；1M 只喂 hard-truncate 安全阀，永不作压缩触发）。DSH-native 的 `retainRatio`/`thresholdRatio` 相对压缩域窗口算预算——直接套裸窗口会让触发门永不过或保留预算吞掉全任务（`selectCompactableRange` 返回 null，压 0 字节）。正确标定：**压缩域窗口 ≈ 任务峰值上下文**（跑一次无压缩 full 实测；2026-09 实测峰值 233K ⇒ domain=125K）⇒ **threshold=100K 真实触发**；**retain 是绝对设计值 10K 真实**（`retainTokens/thresholdTokens` 绝对覆写，DSH 本体保留 8K 量级；比例派生只作 fallback），任务中途可触发、有东西可压。估计器必须 wire 校准（`CHARS_PER_TOKEN=1.5`，实测 chars/4 低估 2.7×，2026-09 F10），所有 token 预算（retain/threshold/outline 等）按校准后语义解读。不变量 `retain < thresholdTokens`；且 `retain` 必须在标签范围内（`retainRatio < thresholdRatio`，否则 config 校验抛错）。**触发器语义**：`self`/C2 的 **task 边界自动触发** = 在 `agent/pre-step` 发现 `status==='closed' && !compactedTaskIds` 的 task 就压（挂点语义见 `docs/10` 时序 A），**不是** `trigger.tokenThreshold`（=token 阈值，那是 DSH 压力/溢出触发，非插件 task 边界语义）。四旋钮方法论（A1 范围 / A2 处理 + task=架构单位）见 `experiments/evalground/EXPERIMENT.md`——它是实验方法学单一事实源（机制设计正典 = `docs/02–04` 域文档），评价引擎/臂表是它的执行形态，不许漂移。
- **上下文窗口硬截断（仅防溢出安全阀，独立于压缩域逻辑）**：`runner.mjs` 在每次请求前用 `estimateMessagesTokens(messages)` 估算，若 ≥ `contextWindow × truncatePct` 则重建消息表：保留稳定的 `[system, task]` 前缀（缓存友好）再补最尾近消息、丢弃最旧历史，记一条 `hard-truncate` transcript 事件与 `runner.hardTruncate` 计数器。它是**全臂兜底**（独立于 compression 模式），**仅做防溢出**，平时（< floor）完全 no-op、不改变未护栏 run 的字节行为；`score.assemble` 不对 `hard-truncate` 施加惩罚（不属于任何扣分分支），因此触发与否不改变打分语义，但记录在 scorecard 供审计。**注意**：此为"防溢出安全阀"，**不等于**压缩域标定——压缩域标定按上一条的"任务尺度"，别拿这个 floor 当压缩域窗口。

## Architecture

- 平面分层：L0 确定性规则 → L1 结构（模型打辅助）→ L2 模型最小断面（`docs/01`）。
- 分划单位（正典 `docs/01 §3.5`）：task = 意图轴单位（项目某一方面目标的持续努力；**闭合 = 区间信息稳定点，边界压缩时机的根据**）；子task = 活动类型轴单位（构建/审查…，压缩分结构单位，无检测机制/无档案地位）；交换对 = 剪切层微削单位（连续同类交换构成 run）。判别器只守意图轴，剪切层只动交换对。
- 状态分层：会话（历史/工具结果）/ task（卷宗 vN、优化产物 vN）/ 项目（项目帧 vN、边界档案 vN）——单一事实源与版本协议在 `docs/09`。
- 可见性（docs/01 §4）：**无隐藏注入段**——可见层 = 优化后 prompt（用户预览确认）+ 用户指令原文（权威段）+ 剪除/压缩的结论落位物；插件内部标志（run 范围、行式裁决）**不进模型视野**（带外原则，docs/03 §3）。
- 工程结构：platform 适配 / core 纯核（零 harness import）/ domains 编排 / client 壳——模块树与搭建序 = `docs/11`。

## Conventions

- **确定性优先**（宪法 `docs/05`）：能观测的用日志（`tool/call`、`tool/result`、`user/message`），能计算的用规则，能查表的用版本号；模型只碰语义核心（选择/压缩/意图）。
- **字节稳定**：进入请求的每个字节必须可复现（同输入→同输出）；任何 LLM 产物的复用必须先版本化落盘。模板在前、实例参数在后。
- 进入模型的每一 token 都必须通过两道审查：① 它不是可确定计算的；② 缺了它模型会猜错。
- 优化产物必须逐字保留用户的路径/数值/约束/合规词句；优化 = 包裹 + 加注 + 去重 + 路径固定化，不是改写。
- 执行路径钉"决策点"、软化"顺序"（条件化，如"若 A 不存在则走 B"），只引用本会话当前装配的工具集与已安装技能（引用守卫查表）。
- **失败默认保留**：协商不成不动刀（无标记/解析失败/超时 → 不剪、不替换、不回填），失败方向永远朝用户数据安全侧。
- **相信用户决策**：Tier-0 一票算数；星标回填即终审；预览确认即生效；用户编辑即终稿。

## Workflow

- 新功能：先立度量（docs/07 字段能观测）→ 再看挂点（docs/10 事件流）→ 写逻辑 → 构建 → 对照试验留账本。
- 每个模块的 TODO 必须引用对应 `docs/0X-*.md` 文件；模块注释按 `docs/05 §6` 合规自证模板（平面/回退链步数/审查清单/度量）。

## Don't

- 不要用 agent/skill 单独实现任何机制（回退链在 docs/05 §3）：先走"用户可控指令 → 代码分支 → 机械匹配 → 本地 embedding → 极小本地模型"。
- 不要做隐藏注入段；不要让插件内部标志进入模型视野（带外原则）。
- 不要让优化产物改写掉权威段；用户编辑即终稿，不要建学习存储揣度编辑意图。
- 不要让模型自造坐标、自报数字（选坐标不造坐标；热尾/装配零转写零算术）。
- 不要做中段独立剪除（断裂成本公式 docs/06 §2）；老调用对只许 T-boundary 搭车。
- 不要重复指令：同一规则只写在一个文档/文件里（本文件与 `docs/` 各司其职）。
