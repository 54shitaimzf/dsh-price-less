# implement · 施工总纲（P0–P21b 工单制）

> 本族是**施工计划，不是设计正典**。设计唯一正典 = `docs/00–11`；工单与正典冲突时停工上报，
> 以正典为准。全部工单完成后本族整体归档（git 历史即存档）。
> 执行模型：每份工单（`P<NN>-<slug>.md`）= 一次 **flash 级模型自主完成并自主验收**的施工单元；
> 验收全部机械化（命令 + 测试断言），无主观判断项。阶段映射与出门门槛 = [11 §8](../11-structure.md)。

## 0. 它解决什么问题（人话版）

设计文档写清了"该是什么"，但直接丢给廉价模型施工会翻车在三处：**猜 API**（harness 没这个
接口它也敢编）、**做设计**（文档留的口子它自己拍板）、**验不了**（"看起来对了"就算完）。所以
把 R0–R4 拆成 30 份工单（P0–P21b + P1.1/P1.2/P5.1/P6.1 追记）：每份大小一顿饭功夫、输入输出写死、验收是一条条能跑的命令。
flash 只需要照单干活——不需要理解全局，禁止发挥。

## 1. 工单制（角色与纪律）

- **工单文件**：开工前按 §5 模板立于本目录，命名 `P<NN>-<slug>.md`；工单内容从 §3 总表
  对应行展开（正典节号 + 现有文件 + harness 符号清单 + 验收断言）。
- **执行者**（flash 级模型）：只做工单内的事；遇到工单未覆盖的决策点 = 停工上报，不自行设计。
- **验收**：§3 总表每行出门门槛的机械化子集 + 工单专属断言；全绿才算完成，禁止"部分完成
  先提交"。里程碑（R 门）验收另见 §4，不属单工单。
- **提交**：验收全绿后单笔提交，消息用工单模板末尾给出的 conventional 格式。

## 2. 全局铁律（每份工单默认继承，工单不再重复）

1. **正典优先**：一切行为契约引用 `docs/00–11` 节号；发现工单与正典矛盾 → 停工上报。
2. **构建绿 = 唯一完成形态**：`npm run typecheck && npm run typecheck:client && npm test`
   三连过；涉产物/装配的阶段加跑 `DSH_CHECKOUT=G:/deepseek-harness npm run build`
   （AGENTS.md）。
3. **harness API 只信源码**：可用的 API 以 `G:/deepseek-harness/packages/**` 源码为准；
   已收拢的插件规范/接口事实面见 [docs/13-harness-plugin-spec.md](../13-harness-plugin-spec.md)；
   工单列出本阶段符号清单，执行者必须逐条 grep 到**定义处**才准 import；找不到 = 停工上报，
   禁止按记忆或推测书写接口。
4. **结构铁律**（P0 起以 `scripts/assert-structure.mjs` 固化进 CI 断言，逐步启用）：
   `core/` 零 harness import（含类型）；改史调用只出现在 `platform/history`；自定义会话
   事件全部 `ignorable:true`（类型级测试）；模板在前、实例参数在后。
5. **禁区（零接触）**：`experiments/**`（2026-09-06 起**封存**：旧实验管线依赖清退前生产
   lib 编译产物，随残留清空中断——`runs/**` 实验证据与 `datasets/` 资产只读保全，解封条件
   见 `experiments/evalground/SEALED.md`；**R3/R4 不再组织对照实验，实验结论已固化进
   docs/02–04 设计**，如将来重建实验面再按 [08](../08-experiment.md) 组织）、`datasets/`、
   `reports/`、`scripts/attic/`、`docs/00–11` 设计正文与 `ledger-history.md`/`legacy.md`、
   凭证类文件（凭据只存 homedir，永不进仓库）。
6. **mock 优先**：platform 端口的单测全部走 fake 实现（无网络、无真模型）；真实调用只在
   工单明示的集成点出现。
7. **度量先行**（AGENTS 硬规则）：每个机制工单第一步 = 先落 `docs/07` 对应字段的最小
   可回放记账，再写机制本体。
8. **UI 壳不变量**：`client/` 壳（Card/controller/components/theme/mascot）零结构改动；
   配置载荷变更只经 `field-model.ts` ↔ `config.ts` 对应律同步（观察模式设置项已按用户
   定调清理，2026-09），`tests/field-model.spec.ts` 的**结构断言不变量只增不减**。

## 3. 阶段总表（P0–P21b，映射 R0–R4）

尺寸：**S** = 单文件 ≤150 行净增 + spec；**M** = 2–4 文件 ≤400 行净增 + spec；
**L** = 工单内必须拆分两份。

| # | 工单 | 映射 | 新增/改动 | 依赖 | 尺寸 |
|---|---|---|---|---|---|
| P0 | 工程零位核对（已施工 commit `274e37d`） | R0 | manifest 差距核对（[11 §1](../11-structure.md) 表逐项）；`scripts/assert-structure.mjs` 断言骨架（暂全过）+ `npm run assert` | — | S |
| P1 | 事件面接线（已施工 commit `1ed5419` + 翻转 `28351b3`；harness LogIntent 补丁 `04cba8f394`） | R1 | `platform/logger.ts` + `platform/events.ts`（H1 firehose → 异步旁路队列；[10 §1](../10-wiring.md) H1/H7） | P0 | S |
| P1.1 | 诊断落盘 sink（P1 追记，已施工 commit `545db1b` + 修正 `8e84039`，真机验证通过） | R1 | `platform/diag-sink.ts`（`ctx.logger.exporter()` → 插件 `logs/context-economy.log` JSONL，agent 自审面，零 harness 改动；[11 §4](../11-structure.md) 纪律③追记） | P1 | S |
| P1.2 | 地基修补与契约闭合（P1 追记，已施工；commit 见 git log） | R0/R1 | ① `package.json` files/exports 收编 `cordis.patch.yml`（发布包可装配）；② build.sh 补齐 client/tsdown/react/@types/react/zod 链接（干净归档构建成立）；③ `tests/client-apply-smoke.spec.ts`（client 槽注册/订阅/卸载冒烟）；④ `platform/llm.ts` C2 purpose 单点适配锚 + `tests/llm-purpose.spec.ts`；⑤ docs/03/10/11/12 进度与实现缝对齐 | P1 | S |
| P2 | 度量底座（已施工 commit `38e3af3`；扩写工单见 [P2-ledger-base.md](P2-ledger-base.md)） | R1 | `core/ledger/`（07 通用族 fold 纯函数 + fixture 回放"同输入同账"断言；**facts 源抽象**：会话 ignorable 事件 ∨ KV 事实镜像，[12 §3](../12-platform-capabilities.md)）+ `scripts/verify-p2.mjs` 自动化验收 | P1 | M |
| P3 | 持久面（已施工 commit `ac15d73`；扩写工单见 [P3-storage.md](P3-storage.md)） | R1 | `platform/storage.ts`（H10 defineDomain 四实体表 + CAS + 快照回退；**+ 事实镜像表**（降级态，[12 §3](../12-platform-capabilities.md)）；[09 §2](../09-state.md) 协议） | P1,P2 | M |
| P4 | 技能目录端口（已施工 commit `3abe364`；扩写工单见 [P4-skills.md](P4-skills.md)） | R1 | `platform/skills.ts`（H13 `ctx.skills` 官方缝快照枚举 + `skills/change` watch + 引用守卫查表接口） | P0 | S |
| P5 | 辅助调用端口（已施工 commit `f48c51f`；扩写工单见 [P5-llm.md](P5-llm.md)） | R1 | `platform/llm.ts`（H12 `llm.stream({purpose})` + usage/缓存回执；**C2 单点适配已由 P1.2 落锚；peerDep/build 链接已由 P1.2 落位，P5 只核验**） | P2 | S |
| P5.1 | P5 审查补正（已施工 commit `82c98d8`；llm 回执遏制 + docs/10 状态行闭合 + 流类型/早断语义锁定；扩写工单见 [P5.1-llm-hardening.md](P5.1-llm-hardening.md)） | R1 | 修 `platform/llm.ts`（返回类型 `AsyncGenerator`；onUsage 抛错遏制）；补 `tests/llm-stream-robustness.spec.ts` 2 用例；docs/10 状态行补 H10/H13 | P5 | S |
| P6 | 改史端口（已施工；扩写工单见 [P6-history.md](P6-history.md)） | R1 | `platform/history.ts`（H4 surfaceOp replace + `sourceEventSeqs` 协议 + H5 事务对 + 配对平衡守卫，fake session 测试） | P1 | M |
| P6.1 | 收尾补正（已施工 commit `82c98d8`；执行 P5.1 + P6 审查修正；扩写工单见 [P6.1-wrapup.md](P6.1-wrapup.md)） | R1 | 执行 P5.1（llm 回执遏制/流类型/早断测试/docs 状态）；修 verify-p6 build-first；docs/13 补 dsh-compaction 节；D7 补 summary；真机 history 冒烟 | P5,P6 | S |
| P7 | 工具端口（已施工 commit `5a8c8f2`；扩写工单见 [P7-tools.md](P7-tools.md)） | R1 | `platform/tools.ts`（H6 `tools/post-execute` accept content 覆盖/追加 = T-entry/T-note；`tools/execute` 仅信号/计量）；补 peerDep `dsh-tools` | P1 | S |
| P8 | 分划单位 + 稳定前缀（已施工 commit `fa8fdab` + fix `037b413`；真机接线修正已提交，见 [P8-units-prefix.md](P8-units-prefix.md) §3.4/§8.2） | R2 | `core/units.ts`（[01 §3.5](../01-architecture.md) 状态机）+ `core/prefix.ts`（技能目录快照**本地重声明同构类型** + 项目帧 vN；`prefixRebuildCause`；字节稳定断言，[02 §2](../02-discriminator.md)/[06 §4](../06-cache.md)；**watch 经 P4 端口在 index 装配根接线**） | P3,P4,**P2** | M |
| P9 | 卷宗（已施工 commit `78f33ad`；扩写工单见 [P9-dossier.md](P9-dossier.md)） | R2 | `core/dossier.ts`（append-only / 三分类标注 / 回填 / 边界清空；02 §2） | P3,P8 | M |
| P10 | 判据与对表（已施工 commit `e00fbd7` + 修正 `7d435b2`；扩写工单见 [P10-judge.md](P10-judge.md)） | R2 | `core/judge.ts`（L0 词表 / L1 缓存键 / 对表层；tableHitRate 入账；fail-lazy） | P9,P5,P2,**P8** | M |
| P11 | 星标断面（已施工 commit `9e5de9b` + 修正 `4a20d32`/`0b079b0`/`eb1d9b4`/`7595c43`；工单见 [P11-optimize.md](P11-optimize.md)） | R2 | `core/optimize.ts`（输入栈装配 / 双通道解析 / 行级容错 / 四道机械闸，02 §4）+ 断面 prompt 资产版本化落盘 | P8,P9,P5,**P2** | M |
| P12 | 自动断面服务（工单见 [P12-input.md](P12-input.md)） | R2 | `domains/input.ts`（T0→L0→L1→对表→LLM→fail-lazy 决策链，LLM 主路径渲染 task 内全量卷宗 [02 §2](../02-discriminator.md)；`discriminator.auto` boolean 门控（默认 false；观察模式已取消）） | P10,P3,P8,P9 | M |
| P13 | 命令面 + init 项目帧 | R2 | `/task` 系列 + `/optimize-prompt`（[10 §2](../10-wiring.md)）+ init 帧采集交互（用户确认，[02 §2](../02-discriminator.md)） | P8,P9,P11,P3,**P12** | M |
| P14a | 星标按钮 UI（槽 + 预览） | R2 | H11 `conversation.view` 槽注册 + controller 扩展 + 预览 diff 弹层（复用壳基建）+ 确认/编辑=终稿（mock host 方法契约） | P13 | M |
| P14b | 星标 host 方法 + 时序 B | R2 | host 方法（装配输入栈 → H12 断面 → 双通道解析 → 回填/优化产物落盘）+ 时序 B 端到端（mock 断面；剪切清单本阶段只落盘记账） | P14a,P11,P13,P6,P3 | M |
| P15a | 工具剪切纯核 | R3 | `core/shear/` 工具半边（ToolContextLifecycle 谓词 / T-note 协商 / T0-R 三硬规则；[03 §2](../03-shear.md)） | P2 | M |
| P15b | 工具剪切调度 | R3 | `domains/shear.ts` 调度（四档时机 / 事件接线 / `cutTokensSaved` 入账走 P2 fold 扩展面） | P15a,P6,P7,P12,P2 | M |
| P16 | 对话剪切 | R3 | run 状态机 + 吸收证明触发 + 结论三档 + 带外标志 + run 冲刷 H4（03 §3）；阈值常数按 03 §8 既有结论初值落位（不做对照实验） | P15b | M |
| P17 | 边界装配器 | R4 | `core/assemble/`（[04 §2](../04-compactor.md)：事实层冻结 / 坐标层 vN / 热尾双通道取真 / 贪心停机）+ 共享事务原语（04 §1） | P6,P8,P9 | L（拆纯核/接线两份） |
| P18 | 压缩调用 | R4 | `core/compress/`（边界/压力两模式 prompt 组装 + 产物 schema 校验；模板在前 + datasets 同源断言，04 §7） | P5,P9 | M |
| P19 | 边界路径编排 | R4 | `domains/compaction.ts` 边界触发（H2 闭合发现 → 时序 A：装配→档案 vN（[04 §6](../04-compactor.md) 15K 硬帽截断 + `archiveTruncate` 入账）→卷宗清空→T-boundary 搭车） | P17,P18,P2,P3 | M |
| P20a | 压力路径 | R4 | 时序 C：wire 锚定计量（估计器 `CHARS_PER_TOKEN=1.5` 校准，04 §5）+ 检查点/断路器 | P19 | M |
| P20b | 保险丝 | R4 | hard-truncate no-op 语义 + `request-error` 接管；`cordis.patch.yml` 加 compaction-basic `auto:false` | P19 | S |
| P21a | 恢复编排 | R4 | `domains/restore.ts`（H9 恢复序，[09 §4](../09-state.md)：KV 损毁→日志回放重建演练；`restore/*` 事实发射） | P20a,P20b,P3 | M |
| P21b | 全链验收 + 可视化 | R4 | 四触发次序验收 + 四道缓存断言（[10 §6](../10-wiring.md)）进 CI；度量消息列表可视化（加分项，[11 §5](../11-structure.md)） | P21a | M |

依赖主干（其余见各行"依赖"列）：

```text
P0 ─┬─ P1 ─┬─ P2 ─ P5 ─┐
    │      ├─ P6 ────────┤
    │      └─ P7 ─┐      │
    ├─ P3(P1,P2) ─ P8 ─ P9 ─ P10 ─ P12(P10,P3,P8,P9) ─ P15b(P15a,P6,P7,P12,P2) ─ P16
    │      └────────┴─ P11 ─ P13(P8,P9,P11,P3,P12) ─ P14a(P13) ─ P14b(P14a,P11,P13,P6,P3)
    └─ P4 ─ P8                │
P2 ─ P15a ────────────────────┘
P17(P6,P8,P9) ─ P19(P17,P18,P2,P3) ─┬─ P20a(P19) ─┐
P18(P5,P9)                          └─ P20b(P19) ─┤
                                                   └─ P21a(P20a,P20b,P3) ─ P21b(P21a)
```

> P5.1 追记（2026-09-07 审查补正）：P5 ─ P5.1；只做回执遏制/流类型语义锁定/docs 状态行闭合，
> 不改变 R1–R4 主干依赖。
> P6.1 追记（2026-09-07 收尾补正）：P5/P6 ─ P6.1；执行 P5.1 并修正 P6 审查发现，
> 不改变 R1–R4 主干依赖。
> R1 完成记录（2026-09-07 里程碑验收）：R1 平台面最后一单 P7 已施工（commit `5a8c8f2`）。
> 按 §4 执行 R1 出门验收：首份 07 报表（docs/ledger-history §31，fixture 回放管道产出）、
> 结构断言全绿（M/S/D1–D8）、R1 出门门槛核对（docs/11 §8 R1 行：JSONL 回放 + ignorable 断言 +
> platform 七端口齐）通过；下一段 = R2 判别域。

> R2 进行中（2026-09-07）：P8/P9/P10/P11 已施工（P8 分划单位 + 稳定前缀 commit `fa8fdab` + 真机接线修正 `037b413`；P9 卷宗纯核 commit `78f33ad`；P10 判据与对表纯核 commit `e00fbd7` + 修正 `7d435b2`；P11 星标断面纯核 commit `9e5de9b` + 修正 `4a20d32`/`0b079b0`/`eb1d9b4`/`7595c43`；`node scripts/verify-p8.mjs`、`node scripts/verify-p9.mjs`、`node scripts/verify-p10.mjs` 与 `node scripts/verify-p11.mjs` 均输出 PASS）。

> P2 修正边（2026-09-06 扩写）：P2 ─ P8 / P10 / P11 / P15b（行依赖列已同步；P5 原已依赖 P2）。
> P3 修正边（2026-09-06 P3 工单）：P1/P2 ─ P3（行依赖列已同步；P13/P14b/P19/P21a 补 P3）。
> P13 修正边（2026-09-07 P12 工单计划）：P13 补 P12——复用 P12 交付的 `core/t0.ts` T0 解析，避免 T0 双发与 taskId 分叉。

平台通道横切（[docs/12](../12-platform-capabilities.md) 正典）：ignorable 发射通道缺失时事实轨
降级 KV 镜像——P2 事实源抽象 / P3 事实镜像表 / P8 段状态机 KV 双源 / P21b 可视化读事实源抽象，
各工单编写时按 docs/12 展开。降级实现整体居于 `platform/ignorable-channel.ts`（D3 断言锁定
单元边界，机制代码零感知），上游合并后按 docs/12 §2 清单原子删除。

## 4. 里程碑验收（R 门，单工单之外）

每个 R 段最后一单完成后，按 [11 §8](../11-structure.md) 出门门槛逐条核验，并执行：

1. **账本快照**（AGENTS 硬规则）：改动前后各留一份 07 报表（回放管道产出），入
   `docs/ledger-history.md` 追记（只增不改）；
2. **缓存四断言**（[10 §6](../10-wiring.md)）：R2 起每次里程碑必跑；
3. **结构断言**：`npm run assert` 全绿（core 零 import / 改史归口 / ignorable / UI 不变量）；
4. **机制验收（无对照实验，2026-09 定）**：实验结论已固化进 docs/02–04 设计；R3/R4 以
   机械断言 + 07 账本回放 + 真机冒烟验收，不组织臂对照 run。

## 5. 工单模板（`P<NN>-<slug>.md` 统一骨架）

```markdown
# P<NN> <标题>（<映射 R 段>；依赖 P…；尺寸 S/M/L）
> 设计正典：<docs 节号清单>；harness 符号清单：<类型/函数名@包名>

## 1. 目标
<一句话，可验收的动词句>

## 2. 输入
- 正典：<逐节引用与要点摘录（工单内自足，免执行者翻全文）>
- 现有文件：<路径 + 相关导出>
- harness 核验源：<符号 → packages/.../file.ts 定义处>（找不到即停工上报）

## 3. 产出
<逐文件：路径 / 导出面 / 契约要点（参数、语义、错误处理）>

## 4. 实现要点
<编号步骤；每步可独立验证；含度量记账先行步骤>

## 5. 验收（全机械）
- [ ] npm run typecheck && npm run typecheck:client && npm test
- [ ] <新增 spec 文件与逐条断言描述>
- [ ] npm run assert（如本阶段启用了新断言）
- [ ] <其他命令级检查（grep 断言等）>

## 6. 禁区与注意
<本单特有风险；默认禁区见总纲 §2>

## 7. 完成动作
commit: `<type>(<scope>): <一行>`；账本快照：<是否需要>
```

## 6. 总纲自身的验收

- [ ] §3 表 30 行（含 P1.1/P1.2/P5.1/P6.1 追记）与 [11 §8](../11-structure.md) R0–R4 内容逐行对得上（无漏项、无新增设计）；
- [ ] 每行依赖列构成 DAG（无环）；
- [ ] 尺寸全部 S/M（L 已注明拆分）；
- [ ] 工单模板含 harness 符号核验位与停工上报条款。
