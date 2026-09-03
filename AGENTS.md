# 项目定位

@dsh-external/dsh-context-economy：DSH 插件套件，目标是**全面 token 节约 + 执行效率**。
形态 = 主插件（`docs/12`：底座 + 数据面）+ 五个能力域：压缩域 02 / 输入域 03 / 提示词产品域 04 /
编排域 13 / 文件与寻址域 15（意图映射表为其寻址参考，隐式）；宪法与回退链在 `docs/05`，运行时守卫在主插件（docs/12 §4）。
完整设计在 `docs/`，本文件只给可执行的高信号指令；装配开关 sub1–sub4 + intentMapping 见 docs/12 §5。

## Build

- `DSH_CHECKOUT=G:/deepseek-harness npm run build` —— junction 链接 checkout 依赖后 tsc 编译 host，
  有 client 形态时再 `npm run build:client`（tsdown 编译 UI），产物 `lib/`。
- 改完代码必须构建通过才提交；`npm run typecheck` 只查类型。

## Test

- 每个能力域机制（task 发现 / 体积管理 / 提示词优化 / 映射检索 / 文件治理 / 管道）必须能在 `docs/08-experiment.md` 的协议里被观测；
- 改动前后必须留 `docs/07-metrics.md` 的账本快照，否则改动不算完成；
- 对照试验用配对差值（Δ=臂−基线）汇报，禁止单次运行的结论；
- **评测模型固定（硬规则）**：任何实验批次内，executor/judge 必须全部固定且同批次不换——当前固定 = **DeepSeek 官方 API 直连（https://api.deepseek.com，key 在 homedir yaml `DEEPSEEK_API_KEY`）/ executor = judge = decision = deepseek-v4-flash-vision-exp**（单一事实源 `experiments/evalground/scores.config.json` 的 executor/judge 字段；判别器默认在 `lib/boundary-mark.mjs`）。**2026-09 传输层切换：opencode zen 网关（hy3/glm-5.3-flash）整体退役；换评测模型 = 整批重跑并标注**——切换前全部 run 属 opencode 时代历史批次，与新批次数字永不混用、不混批。deepseek-v4-flash-vision-exp 是 thinking 模型（实测返回 reasoning_content、官方接受 max_completion_tokens、`prompt_tokens_details.cached_tokens` 可读），须走 `protocolFor(model)`（含 `deepseek`）的 max_completion_tokens + 宽松预算，不得退回到 max_tokens/8192 的 length-cap 老问题；
- **thinking 协议（硬规则）**：thinking 模型（GLM-5.3-Flash/deepseek 系强制 thinking 不可关）做多轮工具调用时，必须把上一轮 assistant 的 `reasoning_content` **原样回传**，否则网关 400（"reasoning_content ... must be passed back"）。`experiments/evalground/lib/gateway.mjs` 已统一处理：读取 `message.reasoning_content`（兼容数组块）并暴露给调用方、发出请求时回传；`runner.mjs` 在重建 assistant 消息时携带它。改任何 transport 都必须保持这条（gateway 的 `protocolFor(model)` 是 max 参数名/temperature 的单一事实源：thinking→max_completion_tokens、GLM→temp=1、其余→max_tokens/temp=0）。
- **缓存观测（硬要求）**：`gateway.mjs` 的 `cacheReadTokens` 必须读 OpenAI 标准 `data.usage.prompt_tokens_details.cached_tokens`（同时兜底 `prompt_cache_hit_tokens`/`cache_read_tokens`/`prompt_cache_read_tokens`）——实测 DeepSeek 官方 API 直连回 `prompt_tokens_details.cached_tokens`（2026-09 冒烟：共享前缀二连调命中 0→640），漏读会让缓存永远为 null、成本按无缓存高估。缓存命中率是 E3 压缩效率的核心对比指标，改动 gateway/usage 读取时必须保持可观测。
- **主观评判层（evalground 评分标准）**：评分 = mech（确定性事实：金色命中/范围/测试/反作弊）+ judge（固定 rubric 盲评；review 型任务含 `grounded`「证据落地」维，prompt 注入 `golden-bugs.json` 缺陷参照以区分"真实超金色集发现"与"伪造"）+ `lib/subjective.mjs` 资深 reviewer 盲评（overallQuality/wouldShip/overReport/**realExtras**，**盲评、不入总分**；prompt 不传入臂，防标记泄漏）。金色集已补全 `public/filter.js`(B9)/`public/format.js`(B10) 两个真实 planted bug；mech `report-match` 改**连续覆盖分**（hits/goldenTotal × (1 − fp/goldenTotal)，非"达标即满分"）；`score.assemble` 追加**超金色奖励** `beyondGolden`（仅 review 任务、gate 在 `grounded`≥3 时才给，`min(realExtras,6)×6×gate`），**总分可超过 100**（已批准语义）。改 golden-bugs.json / task rubric / judge / subjective / score 后必须用 `scripts/re-score-run.mjs` 或 rejudge 回填既有 run，禁止新旧口径混用。
- **压缩域实验语言（硬规则）**：压缩域按**任务尺度**标定，**不**按裸模型窗口（模型真实 1M；1M 只喂 hard-truncate 安全阀，永不作压缩触发）。DSH-native 的 `retainRatio`/`thresholdRatio` 相对压缩域窗口算预算——直接套裸窗口会让触发门永不过或保留预算吞掉全任务（`selectCompactableRange` 返回 null，压 0 字节）。正确标定：**压缩域窗口 ≈ 任务峰值上下文**（跑一次无压缩 full 实测；2026-09 实测峰值 233K ⇒ domain=125K）⇒ `retain=0.16×=20K 真实`、`threshold=0.8×=100K 真实`，任务中途可触发、有东西可压。估计器必须 wire 校准（`CHARS_PER_TOKEN=1.5`，实测 chars/4 低估 2.7×，2026-09 F10），所有 token 预算（retain/threshold/outline 等）按校准后语义解读。不变量 `retain < thresholdTokens`；且 `retain` 必须在标签范围内（`retainRatio < thresholdRatio`，否则 config 校验抛错）。**触发器语义**：`self`/C2 的 **task 边界自动触发** = orchestrator 在 `agent/pre-step` 发现 `status==='closed' && !compactedTaskIds` 的 task 就压（`src/task/orchestrator.ts`），**不是** `trigger.tokenThreshold`（=token 阈值，那是 DSH 压力/溢出触发，非插件 task 边界语义）。四旋钮方法论（A1 范围 / A2 处理 / B 方案 / C 组装 + task=架构单位）见 `experiments/evalground/EXPERIMENT.md`——它是设计级单一事实源，评价引擎/臂表是它的执行形态，不许漂移。
- **上下文窗口硬截断（仅防溢出安全阀，独立于压缩域逻辑）**：`runner.mjs` 在每次请求前用 `estimateMessagesTokens(messages)` 估算，若 ≥ `contextWindow × truncatePct` 则重建消息表：保留稳定的 `[system, task]` 前缀（缓存友好）再补最尾近消息、丢弃最旧历史，记一条 `hard-truncate` transcript 事件与 `runner.hardTruncate` 计数器。它是**全臂兜底**（独立于 compression 模式），**仅做防溢出**，平时（< floor）完全 no-op、不改变未护栏 run 的字节行为；`score.assemble` 不对 `hard-truncate` 施加惩罚（不属于任何扣分分支），因此触发与否不改变打分语义，但记录在 scorecard 供审计。**注意**：此为"防溢出安全阀"，**不等于**压缩域标定——压缩域标定按上一条的"任务尺度"，别拿这个 floor 当压缩域窗口。

## Architecture

- 平面分层：L0 确定性规则 → L1 结构（模型打辅助）→ L2 模型最小断面（`docs/01`）。
- 状态分层：L1 会话 / L2 任务 / L3 知识（偏好 vN、映射 vN、工作摘要 vN，按 task 归档）+ 意图映射表（项目级），单一事实源与版本协议在 `docs/09`。
- 可见边界（docs/01 §4）：隐藏层 = P（文件流段 + 压缩段 + 目标/步骤段，对象非文本、不入历史）；
  可见层 = 提示词产物（模板 + 锚定段，docs/04）+ 用户指令原文（权威段）。
  知识出口统一在提示词锚定，**无隐藏注入段**；P 与锚定是同一数据（L3 + 意图映射表）的两个出口——同一版本源，永远不许漂移。

## Conventions

- **确定性优先**（宪法）：能观测的用日志（`tool/call`、`tool/result`、`user/message`），能计算的用规则，能查表的用版本号；模型只碰语义核心。
- **字节稳定**：进入请求的每个字节必须可复现（同输入→同输出）；任何 LLM 产物的复用必须先版本化落盘。模板在前、实例参数在后。
- 进入模型的每一 token 都必须通过两道审查：① 它不是可确定计算的；② 缺了它模型会猜错。
- 提示词产品域的产物必须逐字保留用户的路径/数值/约束/合规词句；优化 = 包裹 + 加注 + 去重，不是改写。
- 执行路径钉"决策点"、软化"顺序"（条件化，如"若 A 不存在则走 B"），只引用本会话当前装配的工具集。

## Workflow

- 新功能：先立度量（docs/07 字段能观测）→ 再看挂点（docs/10 事件流）→ 写逻辑 → 构建 → 对照试验留账本。
- 每个模块的 TODO 必须引用对应 `docs/0X-*.md` 文件；模块注释按 `docs/05 §6` 合规自证模板（平面/回退链步数/审查清单/度量）。

## Don't

- 不要用 agent/skill 单独实现任何机制（回退链在 docs/05 §2）：先走"用户可控指令 → 代码分支 → 机械匹配 → 本地 embedding → 极小本地模型"。
- 不要把锚定段做到预算（`anchorBudgetTokens`，默认 2048）之外——那是输入 token，每轮在付。
- 不要让优化器把用户原文改写掉权威段；不要让同一版本源的隐藏出口（P）与可见出口（锚定段）漂移。
- 不要重复指令：同一规则只写在一个文档/文件里（本文件与 `docs/` 各司其职）。
