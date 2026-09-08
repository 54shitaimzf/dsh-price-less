# P20c 压力阀门按上下文窗口比例（R4 修正；依赖 P20；尺寸 S）

> 设计正典修订依据（用户裁定，2026-09-09）：「压力触发阀门，我设定应该为 35% 上下文窗口，
> 一般认为这个尺度后，模型能力会下降」。本单据此**修订 docs/04 §3/§4/§5 与 docs/00 §6、
> docs/10 §1 H3、docs/11 §6** 的触发标定口径，并在 §8 记录与旧正典的冲突与替换关系。
> harness 符号清单（逐条 grep 到定义处）：
> - 模型真实窗口：llm.resolveModelInfo(provider, model, signal).context.contextWindow
>   G:/deepseek-harness/packages/llm/llm/src/index.ts:726（P20b 已落 `platform/llm.ts` `resolveContextWindow`，route 缓存）。
> - 主会话路由模型：`readSessionModel(session)`（最近一次 request/header 的 config.provider/model；
>   `src/platform/events.ts:51`）——**窗口必须取主模型**，不是辅助调用（判别/压缩）路由。
> - wire 锚定计量：ctx.tokenMeter.measure(session).totalTokens（P20a 已落 `platform/meter.ts` `wireTokens`）。

## 1. 目标

把压力触发从「绝对设计值 100K（0.4×域窗作 fallback）」改为用户裁定的
**「压力阀门 = pressureRatio × 主模型上下文窗口，默认 0.35」**，并把窗口探针从
辅助调用路由修正为**主会话路由**（P20b 保险丝同步受益）。

## 2. 输入

- 旧口径（P20a 落地）：`pressureThreshold` = thresholdTokens（正有限数即用）→ 0.4 × domainTokens。
- 新口径（本单）：
  1. 主模型窗口已知 → `ceil(pressureRatio × contextWindow)`；
  2. 窗口未知（适配器未声明 / 无 request/header）→ `ceil(pressureRatio × domainTokens)`（domainTokens = **假定窗口**兜底）；
  3. 以上都不可用 → `thresholdTokens`（绝对设计值，末位安全网）；
  4. 全不可用 → 不触发（fail-lazy）。
- `pressureRatio` 默认 **0.35**；`domainTokens` 默认 125000（改注释为"假定窗口"）；
  `thresholdTokens` 默认 100000（改注释为"末位绝对安全网 + 不变量伙伴"）。
- 不变量扩展：`0 < pressureRatio < 1`；违例 → 整个 compression 块回退设计值（既有失败方向）。
- **保险丝口径修正**：P20b 的 `runFuse` 原用 `resolveJudgeModel`（辅助调用路由）探窗口——
  与"被压的是主对话上下文"不符；本单改为与压力路径共用**主模型窗口**探针。

## 3. 产出

- `src/config.ts`（改）：compression 增 `pressureRatio: 0.35`；`compressionInvariantOk` 增比例区间校验；
  `domainTokens`/`thresholdTokens` 注释改为新角色。
- `src/core/compress/pressure.ts`（改）：`PRESSURE_RATIO = 0.35`；`pressureThreshold` 输入扩为
  `{ contextWindow?, domainTokens?, thresholdTokens?, pressureRatio? }` 并按 §2 优先级；
  `PressureFireFactData` 增可选 `contextWindow?`/`pressureRatio?`（审计面）。
- `src/domains/compaction.ts`（改）：`resolvePressureWindow(session)`（主模型路由 + `resolveContextWindow`）；
  `onPreStep` 每步探一次窗口，传入 `runPressure`/`runFuse`；`runFuse` 改用该窗口；
  `pressure-fired` 事实带 `contextWindow`/`pressureRatio`。
- `client/field-model.ts`（改）：增 `compression.pressureRatio` 数字字段（min 0.05 / max 0.9 / step 0.05 /
  默认 0.35）+ 文案；`domainTokens`/`thresholdTokens` 文案改为新角色。
- 测试：`tests/compress-pressure.spec.ts`（优先级与默认值）· `tests/compaction-domain.spec.ts`
  （窗口比例触发 / 窗口未知退回假定窗口 / 保险丝窗口同源）· `tests/field-model.spec.ts`（12 字段）。
- `scripts/verify-p20.mjs`（改）：阈值优先级 + 默认比例 0.35 + 配置对应律。

## 4. 实现要点

1. `pressureThreshold` 先算比例阈（窗口 → 域窗兜底），再落绝对安全网；比例非法（≤0/NaN）跳过比例分支。
2. 域侧窗口探针只认 `readSessionModel`（主模型）；无 llm / 无 request/header = undefined（不猜）。
3. 每步只探一次（`resolveContextWindow` route 缓存；失败不缓存），压力与保险丝共用同一值。
4. 事实如实记录计算后的 `thresholdTokens` 与 `contextWindow`/`pressureRatio`（回放可复算阀门）。
5. 失败方向不变：窗口未知 ≠ 不压，而是退回假定窗口/绝对安全网（宁晚不误压的边界由 `thresholdTokens` 兜底）。

## 5. 验收（全机械；[x] = 实测已过，2026-09-09）

- [x] `npm run gate` → **512 用例 / 49 文件**（M1–M5 / S1–S5 / D1–D15 全 PASS，`ok=true vacuous=[]`）；`npm run typecheck:tests` 绿；build 绿（host + client）
- [x] `node scripts/verify-p20.mjs` → **P20 VERIFY PASS (35 checks)**（含阀门优先级 / 主会话路由窗口 / 紧急上限 / 断路器越过 / 地板 no-op）
- [x] 回归：`verify-p19`（27）/ `verify-p18`（45）/ `verify-p17`（54）/ `verify-p16`（30）/ `verify-p15b`（19）→ PASS
- [x] 文档同步：docs/04 §3/§4/§5 + 状态行；docs/00 §6；docs/10 H3 + §5；docs/11 §6 + 状态行；
      总纲 P20c 行 + 施工记录；AGENTS；`docs/ledger-history.md` 快照 §48（只增不改）

## 6. 禁区与注意

- 不动 datasets/、experiments/、reports/、scripts/attic/。
- **N1**：窗口未知不得"猜"主模型窗口；只退回假定窗口/绝对安全网并如实记账。
- **N2**：保险丝地板仍为 0.8 × 主模型窗口；压力阀门 0.35 必须 < 0.8（不变量区间校验）。
- **N3**：配置对应律 = host `Config.compression` ↔ client `field-model` 同步（field-model.spec 断言）。
- **N4**：阀门语义只改触发点；压力折叠/断路器/保留区/缩水校验不变。
- **N5**：尺寸申报（实测）——src 净增 **97**（config 13 / pressure 27 / compaction 57，估计 ≤150，**在预算内**）；
  client +9、spec ≈ +26、`verify-p20.mjs` +16。
- **N6**：P20c 额外修正一处 P20b 缺陷——保险丝窗口原取辅助调用路由，现与压力阀门共用主会话路由探针；
  且紧急折叠可越过断路器（否则 35% 阀门提前耗尽断路器后，80% 保险丝形同虚设）。

## 7. 完成动作

- commit：`feat(p20c): 压力阀门按上下文窗口比例（默认 35%）+ 主模型窗口探针修正`；
  `docs(p20c): 工单 + 快照 §48 + 正典修订同步`。
- 账本快照：`docs/ledger-history.md` 新增 §48（只增不改）。

## 8. 计划修正（用户裁定 → 正典修订）

| # | 旧正典 | 本次修订 | 落位 |
|---|---|---|---|
| 1 | docs/04 §4：「裸模型窗口归保险丝层专用…**永不作为压缩触发**」；§5：「按任务尺度标定，不按裸模型窗口」 | 用户裁定：模型能力在上下文窗口约 35% 后下降 ⇒ 压力阀门 = 35% × **主模型窗口**；裸窗口不再是禁区，改由比例旋钮 + 断路器 + 保险丝三层共同约束 | docs/04 §3/§4/§5 + §3 config/core |
| 2 | docs/04 §3：`pressureRatio = 0.4` × 压缩域窗口；§5：`thresholdTokens=100K` 绝对设计值为主 | 比例基准从"域窗"改为"模型窗"，比例 0.4 → **0.35**；绝对阈值降为末位安全网 | §3 core/config |
| 3 | P20a：`pressureThreshold` 绝对为主、0.4×域窗 fallback；domainTokens 仅作 fallback 基数 | 优先级改为 窗口比例 → 域窗假定比例 → 绝对；domainTokens 改义为"假定窗口" | §3 core |
| 4 | P20b：保险丝窗口取自辅助调用路由（`resolveJudgeModel`） | 修正为主会话路由（`readSessionModel`）；压力与保险丝共用同一次探针 | §3 domain |
