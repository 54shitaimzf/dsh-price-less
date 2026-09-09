# legacy · 退役设计存档

> 本文件是**唯一的遗留登记**——所有已退役设计、特性、工单、脚本与实验框架在此各占一节：
> 是什么 / 为何退役 / 后继在哪 / 全文在哪。
> 已封存正文（只读）在 `docs/implement/archive/`（`.gitignore` 排除，本地保全；git 历史仍可追溯）
> 与 `experiments/evalground/`（见其 SEALED.md）；账本历史见 [ledger-history.md](ledger-history.md)。
> 本文件不在文档编号序与阅读顺序内；现行设计文档集（00–13）不含以下任何内容。

## 0. 退役清单速查

| # | 退役项 | 裁定/依据 | 代码/脚本去向 | 文档去向 |
|---|---|---|---|---|
| 1 | 锚定段与四节产品 | 知识图谱初级形态 | — | §1（git 历史 docs/04-prompt-domain.md） |
| 2 | P 公共前缀包（隐藏层） | 随锚定段失去对端 | — | §2（docs/01 §4 / docs/12 §6 旧版） |
| 3 | 意图映射表 + 三级意图树 | 出口退役后无消费者 | — | §3（git 历史 docs/15 §1） |
| 4 | L3 三类知识存储 | 违背「相信用户决策」 | — | §4（git 历史 docs/09-state-store.md） |
| 5 | 编排管道 | 依赖 §2，移入路线图 | — | §5（git 历史 docs/13-orchestrator.md） |
| 6 | 渲染转发提案 | 评估结论为否 | — | §6（git 历史 docs/14-render-forward.md） |
| 7 | embedding 选型与内嵌运行时 | 成本远超收益 | `EmbeddingPort` 空壳保留为回退链第 4 级 | §7（git 历史 docs/11-embedding.md） |
| 8 | 页式/快照/补丁链/CAS 文件工具 | DSH 原生工具已覆盖 | — | §8（git 历史 docs/15 §2–§5） |
| 9 | **N 系列协商剪除**（N2 结论契约 / N3 影子模式 / T-note 注记 / CUT-OK·CUT-HOLD 协议 / `shear.negotiate`） | 真机 44 会话 633 选样 68 注记 → CUT-OK 0 / CUT-HOLD 0 / 无回复 100%；叠加 N2 探针 0/134（账本 §71） | 已删除：`core/shear/{negotiate,conclusion}.ts`、两型 `shear-negotiation-*` 事实、`appendContent`、`shearNoteAttached`/`thinkingCutTokens` 字段；N1 分类器保留 | §9；工单封存 `implement/archive/{00-master-N-series,N2-conclusion-contract,N3-shadow-mode}.md` |
| 10 | **T-loop 工具思考后截断** | 插件不是「模型是否已消费结果」的权威；等后续轮次再剪必改史断缓存（账本 §72） | 已删除：`ShearOp.stub-replace`、`T-loop` 档、`loopMaxConclusionChars`（策略 v2→v3） | §10 |
| 11 | **W2 方向② 形态解析器**（测试/编译器输出形态匹配） | 实测 ≤0.44%、宽目录零增量、旧口径 90–99% 误报（账本 §74） | 未施工（仅评估探针，已删） | §11；评估记录 `implement/archive/W2c-output-shape.md` |
| 12 | **R1–R4 工单与验收脚本** | 已封存为历史记录 | 工单在 `implement/archive/`；失效脚本在 `scripts/archive/` | §12 |
| 13 | **实验框架 evalground** | 依赖清退前生产 lib，随残留清空中断 | 封存只读（`runs/`/`datasets/` 保全） | §13；`experiments/evalground/SEALED.md` |

## 1. 锚定段与四节产品（模板缓存 / 锚定预算）

- **是什么**：提示词产品的固定结构——四节（Intent 三级意图 / Constraints / Map 映射坐标 /
  Deliverable），模板缓存（任务类型签名 → 字节稳定模板主体 + 实例槽），
  `anchorBudgetTokens`（默认 2048）预算守卫。原 docs/04-prompt-domain.md 全文。
- **为何退役**：知识图谱设计的初级形态——其信息供给（意图映射表 / L3）与出口（锚定段）
  双双退役；四节结构与模板缓存是为"锚定段每轮携带"设计的子系统，复杂度高而信息密度低。
- **后继**：优化判别器的优化后 prompt（[02 §4](02-discriminator.md)）——同样逐字保留权威段、
  同样路径固定化，但产品一次生成、用户确认、原地替换，无每轮携带预算与模板缓存机制。

## 2. P 公共前缀包（隐藏层）

- **是什么**：提前拼好的公共前缀包（文件流段 + 压缩段 + 目标/步骤段），对象非文本、
  不进对话历史，请求时摆最前吃缓存；与锚定段"同一数据两个出口、同版本源不漂移"。
  原 docs/01 §4 / docs/12 §6。
- **为何退役**：整个"隐藏层注入"叙事随锚定段失去对端；文件流段依赖已退役的文件工具治理
  （§8）；"P 与锚定同源不漂移"的双出口检查是不必要的复杂度。
- **后继**：**稳定前缀**（技能目录 + 项目最终目标，[02 §2](02-discriminator.md)）——
  极薄、版本化、可查表；压缩档案堆（[04 §6](04-compactor.md)）承担"已积累知识前缀"角色，
  追加式。无任何隐藏注入段（宪法：知识出口可见）。

## 3. 意图映射表 + 三级意图树

- **是什么**：项目级"意图 → 代码坐标"映射表 + 三层意图树（L0 项目意图 / L1 框架方向 /
  L2 架构设计思路），全部意图语义的唯一来源；机械检索（关键词/前缀/符号/Jaccard），
  查询时失效。原 docs/15 §1。
- **为何退役**：为锚定段供给坐标而存在的项目级结构——出口退役后无消费者；
  其"意图定义唯一来源"职责与项目帧（轻量）重叠。
- **后继**：项目帧的方面分解（判别参照系）、优化后 prompt 的路径固定化（task 级坐标）、
  边界档案的坐标层（[04 §6](04-compactor.md)，逐 task 坐标 + 版本重映射）。

## 4. L3 三类知识存储（偏好 / 工作摘要 / 映射）

- **是什么**：跨 task 知识层——preferences（用户偏好学习）、taskSummaries（工作摘要按
  task 归档）、mappings（与意图映射表成对提交）；差分写 + 成对提交 + 版本告警。
  原 docs/09-state-store.md。
- **为何退役**：偏好学习（从用户编辑推测偏好）违背"相信用户决策"（用户编辑即终稿，
  不揣度）；映射随 §3 退役；工作摘要被边界档案（事实层 + 坐标层 + 类型化摘要）全面取代。
- **后继**：[09-state.md](09-state.md) 的四实体版本协议（卷宗 / 项目帧 / 边界档案 /
  优化产物）——协议骨架（source / 原子写 / 快照回滚）沿用。

## 5. 编排管道（task 内可并行子目标）

- **是什么**：task 内可分性预检（L0 文件重叠度）→ 拆子目标并行管道（共享公共前缀）→
  修改流汇回；三级采用层；默认关、门控开启。原 docs/13-orchestrator.md 全文。
- **为何退役（存档不报废）**：能力方向成立，但依赖公共前缀共享（§2 已退役）且独立于
  当前双核心主线——移入未来路线图，重启时按新架构重设计。
- **后继**：[00-overview.md](00-overview.md) 路线图"管道编排"条目。

## 6. 渲染转发提案（"完美转发"原文呈现工具）

- **是什么**：把工具结果以"原文呈现"方式转发给模型的提案及可行性评估；
  数据驱动结论 = 暂不立项。原 docs/14-render-forward.md 全文。
- **为何退役**：评估已完成、结论为否——属关闭的提案，非现行设计。
- **后继**：无。实证报告指针：reports/probe-parrot.md。

## 7. embedding 选型与内嵌运行时

- **是什么**：embedding 模型选型调研（能力面板 / 选型重验 / 插件内打包 lite 档：
  granite-97m-multilingual ONNX + 独立运行时，约 93MB + 81MB）与判别器 embedding 语义票
  实验全记录。原 docs/11-embedding.md 全文。
- **为何退役**：语义票机制整体退役；内嵌运行时成本（包体积）远超留存收益；
  `EmbeddingPort` 空壳已保留为回退链第 4 级（[05 §5](05-constitution.md)）。
- **后继**：回退链端口；选型结论供未来接入实现时取用（本节 git 全文）。

## 8. 页式 / 快照 / 补丁链 / CAS 文件工具蓝图

- **是什么**：自研文件读取治理——导航页/内容页页式读取、快照 + 补丁链（vN）、写前 CAS、
  页预算、深度冻结、读入即决；高置信自动注入前缀。原 docs/15 §2–§5。
- **为何退役**：DSH 原生文件工具已提供行分页 / 字节帽 / 五元组 CAS / read-before-edit
  （粒度事实见 [03 附录](03-shear.md)），自研栈与之并行 = 双工具栈覆盖缺口 + 维护负担；
  自动注入依赖 P 前缀包（§2）。
- **后继**：T0-R 读件修复（[03 §2.2](03-shear.md)）在原生工具上实现"读后写修复"；
  深度冻结原则收编入缓存纪律（[06 §5](06-cache.md)）；快照补丁链的重映射思想存活于
  边界装配双通道（[04 §2](04-compactor.md)，按需对原生 read meta 做行偏移重映射）。

## 9. N 系列「协商剪除」（语义层）——整体退役

- **是什么**：让消费工具结果的主模型顺手回一行标记（`CUT-OK`/`CUT-HOLD`）自证「已吸收」，插件据此
  剪除该轮调用 + 结果 + 思考。设计面 = N2 结论契约（结论 + 关键事实逐字 + 重取句柄，
  `SHEAR_NOTE_TEMPLATE` v1）、N3 影子模式（挂注记、只记账不剪）、N4 剪除执行、N5 三道闸门、N6 验收；
  配置 `shear.negotiate` 三态；两型 `context-economy/shear-negotiation-*` 事实；T-note 时机档。
- **为何退役（2026-09-09 用户裁定，账本 §71）**：真机只读回放 44 会话 / 5,032 条 tool/result →
  选样 633、实际挂出注记 68，**CUT-OK 0 / CUT-HOLD 0 / 无回复 100%**；叠加 N2 探针 0/134 ≈ 770 条
  样本零配合。结论：模型在干活时不会回应工具输出里的协议——语义剪除不能依赖模型回应。
- **后继**：**写时确定性剪除**（剪点必须在结果入账前定死 = T-entry，断裂成本 0；禁模型回应依赖、
  禁行为信号——都会改史断缓存，[03 §2](03-shear.md)、账本 §73）。N1 身份通道保留
  （`core/shear/classify.ts`，候选普查）。reasoning（思考）剪除为独立在研方向，见 [03 §2.1](03-shear.md)。
- **随附清理**：`core/shear/{negotiate,conclusion}.ts`、`shear.negotiate` 配置、`shear-negotiation-*` 事实、
  `T-note` 档、`CUT-OK`/`CUT-HOLD` 标记协议、预设 persona 协议段、`platform/tools.ts` `appendContent`
  （T-note 追加能力）、账本 `shearNoteAttached`/`thinkingCutTokens`、域 stats `notesAttached` 字段、
  `scripts/probe-n2.mjs`、`scripts/verify-p15{a,b}.mjs`。
- **全文**：`implement/archive/{00-master-N-series,N2-conclusion-contract,N3-shadow-mode}.md`（只读，本地保全）；
  git 历史 `docs/implement/{00-master,N2-conclusion-contract,N3-shadow-mode}.md`。

## 10. T-loop（工具思考后截断）

- **是什么**：模型消费完工具结果后，把该轮叙述/思考占位替换（stub）以省 token 的时机档。
- **为何退役（用户裁定，账本 §72）**：依赖「判断模型是否已消费结果」，而插件不是这个判断的权威；
  任何「等后续轮次再剪」都会在结果入前缀缓存之后改史 → 缓存断裂。插件只做工具输出结果的处理。
- **后继**：写时整形（T-entry）+ 机械超越/修复（T0/T0-R）；代码面 `ShearOp.stub-replace`、
  `T-loop` 档、`ShearPolicy.loopMaxConclusionChars` 已删除（`SHEAR_POLICY_VERSION` 2→3）。

## 11. W2 方向② 形态解析器（测试/编译器输出解析）

- **是什么**：为更多测试运行器/编译器输出（vitest/jest/pytest/cargo/go/tsc/包管理器…）做形态识别与
  严格 drop-list 剪除，以扩大 T-entry 写时整形覆盖。
- **为何关闭（用户裁定 2026-09-09，账本 §74）**：73 工具形态调研后实测——严格 drop-list 仅覆盖
  模型可见工具结果池的 **0.14%–0.29%**；宽 20+ 家族目录与仅 vitest 结果一致；语料上限 **0.44%**；
  唯一可安全丢的噪声类 = 测试运行器逐条 `✓` 行。旧口径的 18.9%/20.9% 是 90–99% 文件转储误报。
- **后继**：无（关闭）。评估记录 `implement/archive/W2c-output-shape.md`（只读）；W2 剩余方向 ① 结论型/
  事实型准入分层、③ 同结果内确定性去重见 [TODO.md](implement/TODO.md) §3。

## 12. R1–R4 工单与验收脚本封存

- **是什么**：R1–R4（P0–P21b）施工工单与其逐单验收脚本（`scripts/verify-p*.mjs`）。
- **为何封存**：R1–R4 已完成，工单转只读历史；其中 P15a/P15b 的验收面包含 T-note/T-loop 符号，
  随 §9/§10 退役而失效。
- **后继**：活机制的正典在 docs/00–13；活的验收脚本留在 `scripts/`（`verify-p16` run 冲刷、
  `verify-f9*` 压缩产物、`probe-n1` N1 分类器、`assert-structure` 结构断言）。失效脚本移入
  `scripts/archive/`（见其 README）；工单全文在 `implement/archive/`（含 R 总纲 `00-master.md`）。

## 13. 实验框架 evalground（封存）

- **是什么**：四旋钮对照实验平台（`experiments/evalground/`，臂表/任务集/评分卡/run 证据）。
- **为何封存（2026-09-06）**：平台直接 import 生产编译 lib，插件清退回模板态后依赖中断，
  `ground:assert`/`ground:verify`/`run-*`/`rejudge` 全部不可用。
- **后继**：`docs/08-experiment.md` 保留为历史方法学（不再是施工门禁）；实验结论已固化进 docs/02–04
  设计与常数；解封条件见 `experiments/evalground/SEALED.md`。`runs/`/`datasets/` 只读保全。

---

**退役裁定登记**：以上各节 + 历史快照迁档 + 文档全量重写的完整裁定记录 =
[ledger-history.md](ledger-history.md) §29.20；N 系列/T-loop/W2c 裁定见账本 §71/§72/§74。
