# implement · 施工总纲（P0–P21b 工单制）

> 本族是**施工计划，不是设计正典**。设计唯一正典 = `docs/00–11`；工单与正典冲突时停工上报，
> 以正典为准。全部工单完成后本族整体归档（git 历史即存档）。
> 执行模型：每份工单（`P<NN>-<slug>.md`）= 一次 **flash 级模型自主完成并自主验收**的施工单元；
> 验收全部机械化（命令 + 测试断言），无主观判断项。阶段映射与出门门槛 = [11 §8](../11-structure.md)。

## 0. 它解决什么问题（人话版）

设计文档写清了"该是什么"，但直接丢给廉价模型施工会翻车在三处：**猜 API**（harness 没这个
接口它也敢编）、**做设计**（文档留的口子它自己拍板）、**验不了**（"看起来对了"就算完）。所以
把 R0–R4 拆成 35 份工单（P0–P21b + P1.1/P1.2/P5.1/P6.1 追记 + P14b 拆分 P14b1/P14b2 + P14c–P14f 修正）：每份大小一顿饭功夫、输入输出写死、验收是一条条能跑的命令。
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
| P12 | 自动断面服务（已施工 commit `6746c1b`；工单见 [P12-input.md](P12-input.md)） | R2 | `domains/input.ts`（T0→L0→L1→对表→LLM→fail-lazy 决策链，LLM 主路径渲染 task 内全量卷宗 [02 §2](../02-discriminator.md)；`discriminator.auto` boolean 门控（默认 false；观察模式已取消）） | P10,P3,P8,P9 | M |
| P13 | 命令面 + init 项目帧（已施工；工单见 [P13-commands.md](P13-commands.md)） | R2 | `/task` 系列 + `/init` + `/optimize-prompt`（[10 §2](../10-wiring.md)）+ init 帧采集交互（用户确认，[02 §2](../02-discriminator.md)） | P8,P9,P11,P3,**P12**,**P5** | M |
| P14a | 星标按钮 UI（槽 + 预览） | R2 | H11 `conversation.input.right` 槽注册 + 预览 diff 弹层（复用壳基建）+ 确认/编辑=终稿（mock host 方法契约） | P13 | M |
| P14b1 | 星标 host 断面服务 + RPC 桥端口（**已施工** [P14b1-star-host-service.md](P14b1-star-host-service.md)） | R2 | `platform/star-bridge.ts`（Connection RPC 通道 `/context-economy` = P14a 桥接口的 host 实现；**否决 Typert Remote**，依据见工单 §0.1）+ `domains/star.ts`（装配输入栈 → H12 断面 → 双通道解析 → 预览态 → 确认后回填/优化产物落盘）+ `domains/optimize-facts.ts`（`optimize-run` 两相事实 + fold）；剪切清单本阶段只落盘记账；client 仍用 mock | P14a,P11,P13,P6,P3 | M |
| P14b2 | 星标真实桥 + 时序 B 端到端（**已施工** [P14b2-star-live-bridge.md](P14b2-star-live-bridge.md)） | R2 | client 真实 `StarHostBridge`（Connection RPC → P14b1 端口；常量两侧独立声明 + 契约测试）+ 预览→确认→回填端到端 + 隔离 home 冒烟 + R2 出门验收（07 快照 §32） | P14b1 | M |
| P14c | 判别链瘦身 + ★ 断面修复（**已施工** [P14c-gate-slim-and-star-fix.md](P14c-gate-slim-and-star-fix.md)） | R2 修正 | 删 L0 词表；对表保守打分（签名2/具体词2/泛词1，≥2 命中）；★ 唯一门控 = 本次提示词极短（零调用短路）；★ 上下文读会话事件（不受 `auto` 门控）+ 四角星勾线图标 | P14b2 | M |
| P14d | 断面产品契约 + 弹层瘦身（**已施工** [P14d-optimize-product-and-ui.md](P14d-optimize-product-and-ui.md)） | R2 修正 | prompt v2：关键事实保真（路径/引号/数值必保）+ 大胆重写 + 禁标签/元注释；候选段事实级预抽；元注释机械剥离入账；弹层删 diff/统计、裁决折叠、禁点侧面关闭、确认即发送 | P14c | M |
| P14e | ★ 结果复用（**已施工** commit `dfbac32`；快照 [§36](../ledger-history.md)） | R2 修正 | 同会话 + 同 prompt + 同输入指纹的二次点击回放缓存（零调用/零事实/零等待；apply 后失效重断面）+ client `cached` 态（连桥调用都省） | P14d | M |
| P14f | 推理档做成设置项 + 弹层去噪（**已施工** commit `4711849`；快照 [§37](../ledger-history.md)） | R2 修正 | `discriminator.reasoningEffort`（留空 = 跟随模型默认 / off/low/medium/high/max）**判别与 ★ 共用**，能力探测后只传模型声明的档，账本记 `requestedEffort`/`sentEffort`；删除"已发送"提示 | P14e | M |
| P15a | 工具剪切纯核（**已施工** commit `0274e4a`；工单 [P15a-shear-tool-core.md](P15a-shear-tool-core.md)；快照 §38） | R3 | `core/shear/` 工具半边（生命周期谓词 + 三级回退 / 四档准入 T-entry/T-loop/T-note/T0-R / T-note 协商；[03 §2](../03-shear.md)）；**纯核未接线**（接线 = P15b）；实测 632 行（预算 M、实际 L、未拆单，见 §38 尺寸申报） | P2 | M |
| P15b | 工具剪切调度（**已施工**；工单 [P15b-shear-scheduling.md](P15b-shear-scheduling.md)；快照 §39） | R3 | `domains/shear.ts` 调度（四档时机 / 事件接线 / `cutTokensSaved` 入账 = 独立 `core/shear/ledger.ts` fold）+ `shear.enabled` 开关；实测 src 净增 883 行（预算 700 / 红线 800，见 §39 尺寸申报） | P15a,P6,P7,P12,P2 | M |
| P16 | 对话剪切（**已施工** commit `9add76d`+`6abb7c0`；工单 [P16-dialogue-shear.md](P16-dialogue-shear.md)；快照 §40/§41） | R3 | `core/shear/run.ts` run 状态机 + 吸收证明触发 + 结论三档 + 带外标志 + `domains/shear.ts` run 冲刷 H4（03 §3）；★ `CLASS` 回填作分类输入、G10 尾部窗；阈值常数按 03 §8 既有结论初值落位（不做对照实验）；**L → 工单内拆 P16a/P16b 两单两提交** | P15b | M |
| P17 | 边界装配器（**已施工** commit `24c30a5`+`67de3cd`+`6c9cbaf` + **P17c 修正**；工单 [P17-boundary-assembler.md](P17-boundary-assembler.md)；快照 §42/§43/§44） | R4 | `core/assemble/`（[04 §2](../04-compactor.md)：事实层冻结 / 坐标层 vN / 热尾双通道取真 / 贪心停机 + 地板/兜底）+ 共享事务原语（04 §1）+ `platform/files.ts`（H15 盘上取真）+ `domains/assemble.ts` 装配域 + `assemble-run` 事实 + P17c 修正（HT 软门 / 档案区 15K 硬帽纯核 / 追加式链两形态 / 丢弃归因）；**L → 工单内拆 P17a/P17b + P17c 修正单** | P6,P8,P9 | L |
| P18 | 压缩调用（**已施工** commit `eab06ab`；工单 [P18-compress-call.md](P18-compress-call.md)；快照 §45） | R4 | `core/compress/`（边界/压力两模式 prompt 组装 + 产物 schema 校验 + 共享消费模块 + `compress-run` 调用账本；模板在前 + **版本化常量/字节稳定断言**〔原「datasets 同源断言」无资产可断，P18 §8 修正 #2〕，04 §2/§3/§8） | P5,P9 | M（实测超线，见工单 §6） |
| P19 | 边界路径编排 | R4 | `domains/compaction.ts` 边界触发（H2 闭合发现 → 时序 A：装配→档案 vN（[04 §6](../04-compactor.md) 档案区落盘 + 15K 硬帽调用〔纯核已由 P17c 交付〕+ `archiveTruncate` 入账）→卷宗清空→T-boundary 搭车） | P17,P18,P2,P3 | M |
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
    │      └────────┴─ P11 ─ P13(P8,P9,P11,P3,P12,P5) ─ P14a(P13) ─ P14b1(P14a,P11,P13,P6,P3) ─ P14b2(P14b1) ─ P14c ─ P14d ─ P14e ─ P14f
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

> P14b 拆分（2026-09-08 计划修正）：原 P14b 一单超出 M 尺寸（host 端口 + 断面服务 + 真实桥 + 端到端 ≈ 1000 行），
> 按总纲 §3「L = 工单内必须拆分两份」拆为 **P14b1**（host 断面服务 + RPC 桥端口，client 零改动）与
> **P14b2**（client 真实桥 + 时序 B 端到端 + R2 出门）。传输选型 = **Connection 通用 RPC 通道**
> （channel `/context-economy`），否决 P14a §8.2 的 Typert Remote 设想（依据见 P14b1 §0.1）。

> R2 进行中（2026-09-07）：P8/P9/P10/P11/P12/P13 已施工（P8 分划单位 + 稳定前缀 commit `fa8fdab` + 真机接线修正 `037b413`；P9 卷宗纯核 commit `78f33ad`；P10 判据与对表纯核 commit `e00fbd7` + 修正 `7d435b2`；P11 星标断面纯核 commit `9e5de9b` + 修正 `4a20d32`/`0b079b0`/`eb1d9b4`/`7595c43`；P12 自动断面服务 commit `6746c1b`；**P14a 星标按钮 UI 已施工（`node scripts/verify-p14a.mjs` PASS）**；**P14b1 星标 host 断面服务 + Connection RPC 桥端口已施工（commit `ebb5463`；`node scripts/verify-p14b1.mjs` PASS）**；**P14b2 真实桥 + 时序 B 端到端已施工（commit `f04998e`；`node scripts/verify-p14b2.mjs` PASS，含隔离 home 冒烟）**；`node scripts/verify-p8.mjs`、`node scripts/verify-p9.mjs`、`node scripts/verify-p12.mjs` 与 `node scripts/verify-p13.mjs` 输出 PASS；P10/P11 为纯核工单，其“src/index.ts 零改动”断言在后续接线后不再逐项复跑（各自历史提交点 PASS）。**R2 判别域完成**（段末账本快照 = [ledger-history.md §32](../ledger-history.md)；主 profile 浏览器点击为待人工确认项）；**下一未执行单元 = P15a**（R3 剪切域，core/shear）。

> P14 修正追记（2026-09-08）：P14c（判别链瘦身 + ★ 断面修复，commit `23d217f`/`b7225f9`，快照 §33）、
> P14d（断面产品契约 + 弹层瘦身，commit `040f07e`，快照 §35）、P14e（★ 结果复用，commit `dfbac32`，快照 §36）、
> P14f（推理档做成设置项（默认跟随）+ 删除"已发送"提示，commit `4711849`，快照 §37）均已施工；
> 依赖链 P14c → P14d → P14e → P14f 挂在 P14b2 之后，**不改变 R2–R4 主干依赖**；下一未执行单元仍 = P15a。

> P15a 施工记录（R3 开工，2026-09-08）：工具剪切纯核已施工（commit `0274e4a`；快照 §38；`node scripts/verify-p15a.mjs` PASS，gate 274 用例 / 30 文件）。
> **下一未执行单元 = P15b**（`domains/shear.ts` 调度：四档时机 / 事件接线 / `cutTokensSaved` 入账走 P2 fold 扩展面；依赖 P15a,P6,P7,P12,P2）。

> P15b 施工记录（R3 第二单，2026-09-08）：工具剪切调度已施工（`domains/shear.ts` 四档执行 + 三类 ignorable 事实 + `core/shear/ledger.ts` 独立账本 fold + `shear.enabled` 开关；快照 §39；
> `node scripts/verify-p15b.mjs` PASS 19 checks，gate 307 用例 / 32 文件）。顺带修正 P15a streak 语义（assistant 消息不再打断 T0-R streak）。

> P16 施工记录（R3 关门单，2026-09-08）：对话剪切已施工（`core/shear/run.ts` run 状态机/吸收证明/结论三档 +
> `domains/shear.ts` 整段 run 冲刷 H4 多节点 replace → `user/message` notice 源 + G10 尾部窗 + 第四类事实
> `context-economy/shear-run-plan`（含 ★ `CLASS` 回填）；快照 §40/§41；`node scripts/verify-p16.mjs` PASS 30 checks，
> gate 338 用例 / 33 文件；尺寸 P16a src 净增 436（超预算 16）/ P16b 220，合计 656 = L 已拆单）。
> **诚实声明**：机械路径历史无样本（44 会话 / 27,112 事件行中 `judge-recorded` = 0），两条激活路径 = 开启 `discriminator.auto`
> 或 ★ 产出 `SHEAR`/`CLASS` 行（已接线）。
> **R3 关门；下一未执行单元 = P17 边界装配器**（R4 压缩域首单：`core/assemble/` + 共享事务原语；按 L 拆纯核/接线）。

> P17 施工记录（R4 开工单，2026-09-08）：边界装配器已施工（commit `24c30a5` P17a 纯核 + `67de3cd` P17b 接线 +
> `6c9cbaf` 表面 fold 上移通用回放层；
> 快照 §42/§43；`node scripts/verify-p17.mjs` PASS 40 checks，gate 391 用例 / 37 文件，结构断言 D1–**D12**）。
> 交付 = 双通道坐标（通道 A 版本补丁链重映射 + **H15 盘上取真** / 通道 B 单元 span）+ 预算三环（贪心停机 10K +
> 单单元尾截断 + 地板填充 + 位置兜底）+ 共享事务原语（open → prune → replace → close）+ `assemble-run` 事实 +
> 压缩族账本 fold；**不触发压缩**（触发 / 档案 vN / 卷宗清空 / T-boundary 搭车归 P19）。
> 尺寸：P17a src 净增 **1,229**（预算 780 / 红线 860，超 369——已申报 + 拆单方案见工单 §6）/ P17b **381**（预算内），
> 合计 1,610 = L（已按 a/b 拆两单两提交）。
> **诚实声明**：真机回放 44 会话中文件操作 read 57 / write 22 / edit 24、单元 4,335、版本链 60（链断 3）、
> 重映射 ok 74 / chain-break 21、假想热尾 219,252 token；live `assemble-run` = **0**（装配域无触发）。
> **下一未执行单元 = P18 压缩调用**（边界/压力两模式 prompt 组装 + 产物 schema 校验；依赖 P5,P9）。

> P17c 修正记录（2026-09-08）：按 P17a/P17b 执行结果**修正并细化计划**（工单 §8 八项）——
> HT 软门（`gateHotTailDecls`：坏形状只降级计数、不抛错，域侧取真前调用）+ `clipped` 恒 0 缺陷修复 +
> 位置兜底按 policy cpt + 档案区 15K 硬帽机械截断（`truncateArchiveArea`：从最老整条截断，最新单条超帽保最新 + `overCap`）+
> `archiveTruncate` fold 路径打通（生产者 = P19 档案区）+ 追加式链两形态校验（`archiveChainShape`/`archiveChainAppendOnly` +
> `priorChain` 续传）+ 丢弃归因 `{badDecl,unknownUnit,remap,fetch}`；工单事实纠错（`foldAssembleInputs` /
> txn **prune → replace** / 尺寸统一：P17a 1,223〔现文件 1,229〕、P17b **402**、合计 1,625）。
> 快照 §44；`node scripts/verify-p17.mjs` PASS **54 checks**（原 40 + 14），gate **413 用例 / 38 文件**，D1–D12 全 PASS。
> 真机归因：44 会话 / 版本链 60（链断 3）/ 重映射 chain-break 21 = **write 屏障 9 + 定位失败 12**（不猜位置，丢弃 + 计数）。
> 尺寸：P17c src 净增 **217**（预算 ≤300，在预算内）；P17 合计 1,842。
> **下一未执行单元 = P18 压缩调用**（边界/压力两模式 prompt 组装 + 产物 schema 校验；依赖 P5,P9）。

> P18 施工记录（R4 第二单，2026-09-08）：压缩调用纯核已施工（commit `eab06ab`；
> 快照 §45；`node scripts/verify-p18.mjs` PASS **45 checks**，gate **440 用例 / 42 文件**，结构断言 D1–**D13**）。
> 交付 = `core/compress/`（两模式 prompt 组装〔模板在前 / 清单在尾 / 零预算泄漏 / 机制 A 续传〕+ 产物 schema 校验
> 〔围栏剥离 + 平衡抽取 + `validateDigest`/`gateHotTailDecls` 复用 + `validateCutPoint` 缝两校验〕+ 共享消费模块
> 〔摘要块续传 / 材料块折叠 + 四触发次序闭合表〕+ `compress-run` 调用账本〔`compressionCallCount`/
> `compressionCacheHitRate` fold 路径打通，生产者 = P19/P20a〕）；**零模型调用零接线**。
> 计划修正（工单 §8 八项）：04 节号纠错（§2/§3/§8）· 删除 datasets 同源断言（无资产；改版本化常量 + 字节稳定断言）·
> 组合复用 P17 校验器 · 消费模块建在 P17c 链校验之上 · 度量先行 · 缝两校验落点 · usage 字段缺口上报 ·
> 真机只读回放口径。
> 尺寸：P18 src 净增 **567**（新 6 文件 544 + `assemble/ledger.ts` +23），预算 400 / 红线 480，**超 87**
> （合规自证头约 66 行 + 度量先行 fold 路径；不拆单理由见工单 §6）。
> **诚实声明**：真机回放 44 会话 / 37 会话含单元 / 单元 4,462 / 渲染 74 次 prompt（平均 6,402 token、峰值 26,581）、
> 字节漂移 0、模板预算泄漏 0、清单帽省略 4,117 条；live `compress-run` = **0**（调用归 P19/P20a）。
> **下一未执行单元 = P19 边界路径编排**（触发 H2 + 档案 vN + 卷宗清空 + T-boundary 搭车 + 缩水校验）。

> P13 审查补齐（2026-09-08）：taskId 跨会话唯一性按 P9/P10/P11 前置要求落地为
> `sessionScopedTaskId(sid, taskId)`，P12/P13 卷宗键会话级限定；docs/00、docs/09、
> docs/12 同步补齐命令面与四值 purpose 契约。
> P2 修正边（2026-09-06 扩写）：P2 ─ P8 / P10 / P11 / P15b（行依赖列已同步；P5 原已依赖 P2）。
> P3 修正边（2026-09-06 P3 工单）：P1/P2 ─ P3（行依赖列已同步；P13/P14b1/P19/P21a 补 P3）。
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

- [ ] §3 表 35 行（含 P1.1/P1.2/P5.1/P6.1 追记、P14b1/P14b2 拆分与 P14c–P14f 修正）与 [11 §8](../11-structure.md) R0–R4 内容逐行对得上（无漏项、无新增设计）；
- [ ] 每行依赖列构成 DAG（无环）；
- [ ] 尺寸全部 S/M（L 已注明拆分）；
- [ ] 工单模板含 harness 符号核验位与停工上报条款。
