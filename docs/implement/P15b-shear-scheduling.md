# P15b 工具剪切调度（R3；依赖 P15a,P6,P7,P12,P2；尺寸 M+ 放宽）
> 设计正典：docs/03 §1/§2/§2.1/§2.2/§2.3/§4/§6/§7/§8；docs/10 §1 H4/H6；docs/11 §2/§6/§8 R3 行；docs/07 §0.5 剪切族；docs/12 §2；docs/13 §3.9。
> harness 符号清单（执行前逐条 grep 到定义处；找不到 = 停工上报）：`ToolExecution`/`ToolExecutionResult`/`PostToolDecision`/`ToolExecutionInput.parent`（packages/core/tools/src/index.ts:307-331,372-387,590-593）、post-execute 应用点（同文件 1732-1770）、`Agent.session`（packages/core/agent/src/runtime-types.ts:114）、`tool/result` 载荷（packages/core/session/src/types.ts:337-343）、`SurfaceEventType`（同文件 393-396）、`session.surface.nodes`/`eventAt`/`snapshotEvents`、`createHistoryPort`（src/platform/history.ts:136）。

## 1. 目标

把 P15a 纯核决策接进运行期：T-entry 写时整形、T-note 贴注与协商剪除、T-loop stub 替换、T0 超越剪、T0-R 读件修复，全部经唯一改史通道执行并按 docs/07 剪切族字段入账；失败一律默认保留、零重试。

## 2. 输入

- 正典要点（工单自足）：
  - T-entry = 落账前整形（断裂成本 0），走 `tools/post-execute` accept `content` 覆盖（docs/03 §2 表后注：`tools/execute` 返回值会被 `normalizeDispatchResult` 按 value 重渲染，content-only 修改会丢）。
  - T-note = 贴注（accept 追加）→ 叙述尾部 `CUT-OK:`/`CUT-HOLD:` 协商；无标记/坏标记/超时 = 默认保留，零重试（docs/03 §2.1）。
  - T-loop = cmd 类 + 当次结论极短 → stub 占位替换（保配对）；read 类排除（docs/03 §2）。
  - T0 = read 被同路径后写超越 → 旧读剪；T0-R = 声明表类读后写 → 修复（读窗 + `(edited: path, vN, start-end)` 锚），三硬规则（streak 原位刷新 / 不跨事件 / 不跨行）（docs/03 §2.2）。
  - 改史唯一通道 = `surfaceOp replace` + 完整 `sourceEventSeqs`；`compaction/prune` 影子价紧随（docs/10 §1 H4）；配对纪律：整对剪或占位替换（docs/03 §2.3）。
  - 经济学：只有断裂点贴近尾部或完整版从未入账才有正收益；老调用对只许 T-boundary 搭车（docs/03 §1/§2.2）。
- 现有文件：`src/core/shear/{types,t0r,tool,index}.ts`（P15a）；`src/platform/{tools,history,events,logger}.ts`；`src/domains/{input,star,optimize-facts}.ts`；`src/config.ts`；`client/field-model.ts`；`tests/{history,tools,shear-tool,field-model,assert-structure}.spec.ts`；`scripts/{assert-structure,verify-p15a}.mjs`。

## 3. 产出

1. `src/core/shear/types.ts`：`SHEAR_NOTE_TEMPLATE`（T-note 贴注模板，中性、无标签、含 CUT-OK/CUT-HOLD 契约）、`SHEAR_NOTE_TEMPLATE_VERSION = 1`；`ShearOp` 的 `t0-supersede` 增 `writeCallId` + `path`。
2. `src/core/shear/tool.ts`：`textOfContentBlocks`、`noteEligible`、`buildSupersededStub`；`foldToolShear(events, policy?, options?: {entryShaped?, lifecycles?})`（默认行为与 P15a 逐字节一致）。
3. `src/core/shear/ledger.ts`（新）：`ShearFactRecord`、`ShearLedger`、`foldShearLedger(events, facts, policy?)`、`surfaceTailTokens(events, seq)`；字段 = docs/07 §0.5 剪切族全表；`shearDecision` 来自重跑 fold，`cut*` 来自事实，两者分列。
4. `src/platform/tools.ts`：`ToolResultView`、`ShearToolHooks`、`createShearToolPort(ctx, hooks, logger?)`（只挂 post-execute；跳过 `parent !== undefined` 与 `origin === 'subagent'`；`hasNonText` 不整形；整形优先于贴注；异常 catch+warn+next）。
5. `src/domains/shear-facts.ts`（新）：三个 ignorable 事实类型 + 载荷接口 + 构造器（`compact` 去 undefined）。
6. `src/domains/shear.ts`（新）：`mountShearDomain(ctx, deps)`——会话态、回填基线、两相接线、九道门槛、改史执行、事实发射、stats。
7. `src/index.ts`：pump 后挂载 + `ctx.effect` 卸载。
8. `src/config.ts` + `client/field-model.ts` + `tests/field-model.spec.ts`：`shear.enabled`（默认 true）对应律。
9. `scripts/assert-structure.mjs` + `tests/assert-structure.spec.ts`：D3 白名单增 `src/domains/shear-facts.ts`；新增 D10（`src/core/shear/**` 禁时钟/随机）；零位快照加 D10。
10. `tests/shear-ledger.spec.ts`（新）、`tests/shear-domain.spec.ts`（新）、`tests/shear-tool.spec.ts`（补断言）。
11. `scripts/verify-p15b.mjs`（新）+ `scripts/verify-p15a.mjs`（③ 改判接线白名单）。

## 4. 实现要点（顺序即依赖；每步可独立验证）

1. **先立度量**：写 `ledger.ts` + `tests/shear-ledger.spec.ts`（fixture 回放同输入同账；空输入全 0）。
2. 纯核接线缝：`types.ts` / `tool.ts` / `index.ts`；跑 `tests/shear-tool.spec.ts`（补 t0-supersede 字段断言 + entryShaped/lifecycles 用例）。
3. 平台适配器 + `tests/tools.spec.ts` 补 3 用例（整形短路 / 贴注追加 / 子分发与 subagent 委托）。
4. 事实面 `domains/shear-facts.ts`（声明合并必须在此文件，D3 白名单同批更新）。
5. 调度域 `domains/shear.ts`：会话态 → 回填基线 → pending 结算 → 重折 → 门槛 → 执行 → 事实。
6. 装配与开关（index/config/client）+ 字段断言。
7. 断言与验收脚本（D10 + verify-p15b + verify-p15a ③）。
8. `npm run gate` → `npm run typecheck:tests` → `DSH_CHECKOUT=G:/deepseek-harness npm run build` → 三个 verify。

## 5. 验收（全机械）

- [ ] `npm run gate` 绿（M1–M5/S1–S5/D1–D10 全 PASS）；`npm run typecheck:tests` 绿；build 绿。
- [ ] `node scripts/verify-p15b.mjs` → `P15B VERIFY PASS`。
- [ ] `node scripts/verify-p15a.mjs`、`node scripts/verify-p14c.mjs`、`node scripts/verify-p14d.mjs` → PASS（无回归）。
- [ ] `tests/shear-domain.spec.ts`：四档各 ≥1 端到端；G1–G9 门槛各 ≥1；`replaceSurface` 抛错 → 遏制 + `shear-error` + 零重试；`enabled=false` 零行为；回填不执行历史 op；确定性双跑同账。
- [ ] `tests/shear-ledger.spec.ts`：`cutBreakCost`/`repairCoverage`/`rereadAfterRepair`/`rerunAfterCut` 各 ≥1。
- [ ] 账本快照：`docs/ledger-history.md` §39（只增不改）。

## 6. 禁区与注意

- 默认禁区见总纲 §2；本单特有：不改 `core/ledger/fold.ts` 与 P2 fixture；不新增 harness 挂点；不改 `docs/00–11` 正文（除状态行/开关表同步）；`core/shear` 零 harness import（S1）；改史只经 `platform/history`（S2）；事实必须 ignorable（S3/D3）。
- 收窄项（用户已批准）：N1 T-note v1 只替换 tool/result 节点（整对/思考剪除归 P16）；N2 T0/T0-R 尾部窗 8 节点；N3 三级回退只接第一级（第三级不激活）；N4 剪切账本独立 fold；N5 `shear.enabled` 默认 true（重启后 T-entry 生效）；N6 只对根调用生效。
- 与正典冲突 / harness 符号找不到 → 停工上报，禁止自行设计。

## 7. 完成动作

commit: `feat(p15b): 工具剪切调度接线（四档执行 + 事实 + 账本）` + `docs(p15b): 快照 §39 与文档同步`；账本快照：需要（§39，含真机会话离线回放）。
