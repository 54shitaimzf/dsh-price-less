# P15a 工具剪切纯核（映射 R3；依赖 P2；尺寸 M）

> 设计正典：`docs/03` §2（四档表 / 生命周期谓词 / 三级回退）· §2.1（T-note 协议）· §2.2（T0 超越 + T0-R 三硬规则）· §2.3（落账双保险 + 配对纪律）· §4（落位律）· §6（事件与度量）· §7（验收清单）· §8（阈值初值）· 附录（原生工具粒度事实）。
> 结构正典：`docs/11` §2（`core/shear/` 行）· §9（core 零 harness import）；`docs/05 §6`（模块合规自证头注释）。
> 执行纪律：`docs/implement/00-master.md` §1（只做工单内的事，决策点未覆盖 = 停工上报）。

## 1. 目标

`src/core/shear/` 交付工具剪切四档的**纯函数决策面**——生命周期谓词 + 三级回退 + T-entry 整形 + T-loop 准入/stub + T-note 协商解析 + T0 超越 + T0-R 三硬规则；零 harness import、零副作用、同输入同输出，`docs/03 §7` 协议断言全绿。

**不做**：事件接线 / 改史执行 / 事实发射 / 账本 fold 扩展（= P15b）；对话 run 状态机（= P16）；边界搭车执行（= P19）。

## 2. 输入

- **正典要点**：T-entry = 写时整形（完整版从未入账，断裂成本 0，cmd/编译类成功裁行、失败留错因）；T-loop = cmd 类 + 当次结论极短 + **read 类排除** + **stub 占位替换**（保配对）；T-note = 体积阈值 ∧ 非 read ∧ 非问答，`CUT-OK:〈一句结论〉` / `CUT-HOLD:〈原因〉`，**无标记/坏标记/超时一律保留**（T-loop 不是 T-note 失败兜底）；T0 = read@t1 被同路径写@t2>t1 超越即剪；T0-R = 声明表类文件读后写改为修复（行号信封 + `edited` + `(path, vN, lineRange)` 锚），三硬规则 = streak 原位刷新 / 不准跨事件 / 不准跨行（`replace_all` 禁 min..max 并集）。
- **现有文件**：`src/core/ledger/fold.ts`（`estimateTokens`、工具结果文本抽取）、`src/core/ledger/types.ts`（本地重声明范式）、`src/core/dossier.ts`（纯核头注释与防御性 no-op 风格）、`src/platform/tools.ts`（**P15b 消费方，本单不 import**）。
- **harness 符号核验表**（找不到即停工上报）：

| 符号 | 定义处 |
|---|---|
| `ToolExecutionInput` / `ToolExecution` / `ToolDispatchExecution` | `packages/core/tools/src/index.ts:307/372/384` |
| `ToolExecutionSuccess` / `ToolExecutionFailure` / `PostToolDecision` | `packages/core/tools/src/index.ts:549/562/590` |
| `read` 工具名 / meta `totalLines` / `lines[{number,text}]` / 渲染格式 `N: text` | `packages/fs/tool-fs/src/read.ts:76/102`、`read-render.ts:88/163` |
| `edit` 工具名 / `old_string`/`new_string`/`replace_all` | `packages/fs/tool-fs/src/edit.ts:83/87/89` |
| `write` 工具名 | `packages/fs/tool-fs/src/write.ts:69` |
| 会话事件形状 `tool/call {callId,name,arguments}` / `tool/result {message.content[0].{toolCallId,content[].text}}` | 本仓 `src/core/ledger/fold.ts:21-50/94-107` |

## 3. 产出

| 文件 | 导出面 |
|---|---|
| `src/core/shear/types.ts` | 本地重声明事件/调用/结果/谓词接口；`ShearTier`/`ShearDecision`/`RederiveCost`/`ShearToolCategory`；`ShearOp` 判别式联合（`shape-entry`/`stub-replace`/`note-cut`/`t0-supersede`/`t0r-repair`）；`ShearPolicy` + `DEFAULT_SHEAR_POLICY` + `SHEAR_POLICY_VERSION` |
| `src/core/shear/t0r.ts` | `isDeclarationTable` / `indentLevelOf` / `parseReadEnvelope` / `formatReadEnvelope` / `editArgsOf` / `repairReadAfterWrite` |
| `src/core/shear/tool.ts` | `toolCategory` / `pathOfCall` / `DEFAULT_LIFECYCLE` / `resolveLifecycle` / `admitEntry` / `admitLoop` / `parseNoteMarker` / `admitNote` / `assertPairing` / `foldToolShear` / `isBoundaryRideCandidate` |
| `src/core/shear/index.ts` | 公共面 re-export |

阈值初值（`DEFAULT_SHEAR_POLICY`，docs/03 §8 先立度量）：`noteMinBytes=8192`、`loopMaxConclusionChars=120`、`t0rMaxSegments=4`、`t0rMaxIndent=1`（缩进宽度 2 计 1 级）、`version=1`。

## 4. 实现要点

1. `types.ts`：纯类型 + 策略常量；头注释按 `docs/05 §6` 四段。
2. `t0r.ts`：声明表判据（路径模式 + 缩进深度）；读信封解析/渲染；逐 hunk 修复（对齐必须整行、`replace_all` 逐段、段数超限/歧义 → 返回 undefined）；行号按 delta 平移。
3. `tool.ts`：类别表（read/edit+write/search/cmd/other）+ 三级回退；T-entry 整形（失败保错因、成功保首尾 + 中性省略标记，**不带插件标签**）；T-loop（cmd ∧ 短结论 → 中立叙述 stub）；T-note（阈值 ∧ 非 read ∧ 非问答 → 解析标记；无标记/坏标记/超时 → 保留；结论超长 → hold 不截断）；T0（同路径写超越）；`foldToolShear` 单遍确定性 fold（事件保序、输入不 mutate）。
4. 配对纪律：整对剪或 stub 替换；孤儿调用 → 拒绝该 op（失败默认保留）。
5. 接线零改动：`src/index.ts` / `src/domains/*` 不出现 `core/shear` 引用（verify 断言）。

## 5. 验收（全机械）

- [ ] `npm run gate`（typecheck + typecheck:client + test + assert）与 `npm run typecheck:tests` 全绿；
- [ ] `tests/shear-tool.spec.ts`：四档各 ≥1；T-entry 成功/失败两路；T-loop read 排除 + stub 保配对；T-note 无标记/坏标记/超时三路 → 全保留，`CUT-OK` 剪 / `CUT-HOLD` 留；T0 正/逆/异路径；T0-R 跨事件/跨行/streak 打断各退回；信封格式 + `edited` + 锚；段数超限放弃；同输入双跑 JSON 相等 + 输入未 mutate；
- [ ] `DSH_CHECKOUT=G:/deepseek-harness` + `bash scripts/build.sh` 绿（host + client）；
- [ ] `node scripts/verify-p15a.mjs` → `P15A VERIFY PASS (n checks)`（导出面 / 零 harness import / 未接线 / 确定性双跑 / T0-R 真机会话探针）；
- [ ] `node scripts/verify-p14c.mjs` 无回归；
- [ ] 账本快照 = `docs/ledger-history.md` §38（明记"纯核未接线，live Δ=0" + 探针四指标 + 阈值初值表）。

## 6. 禁区与注意

- 不 import harness/platform（S1 断言）；不出现 H6 端口符号词汇（D8 断言：`ToolExecution`/`PostToolDecision`/端口事件名字面量只许在 `platform/tools.ts`）；
- 不写 KV / 日志 / 事实；不改 `docs/07` 字段表（剪切族字段已在册）；
- 阈值初值是**本单固定值**：探针只记录分布，不在本单改阈值；探针无样本 → 输出"样本 0"照常通过；
- 尺寸红线：4 文件 ≤400 行净增（不含 spec）；**>450 行或需要第 5 个文件 → 停工上报**，不自行扩单。