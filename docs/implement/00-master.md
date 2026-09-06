# implement · 施工总纲（P0–P21 工单制）

> 本族是**施工计划，不是设计正典**。设计唯一正典 = `docs/00–11`；工单与正典冲突时停工上报，
> 以正典为准。全部工单完成后本族整体归档（git 历史即存档）。
> 执行模型：每份工单（`P<NN>-<slug>.md`）= 一次 **flash 级模型自主完成并自主验收**的施工单元；
> 验收全部机械化（命令 + 测试断言），无主观判断项。阶段映射与出门门槛 = [11 §8](../11-structure.md)。

## 0. 它解决什么问题（人话版）

设计文档写清了"该是什么"，但直接丢给廉价模型施工会翻车在三处：**猜 API**（harness 没这个
接口它也敢编）、**做设计**（文档留的口子它自己拍板）、**验不了**（"看起来对了"就算完）。所以
把 R0–R4 拆成 22 份工单：每份大小一顿饭功夫、输入输出写死、验收是一条条能跑的命令。
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
   工单列出本阶段符号清单，执行者必须逐条 grep 到**定义处**才准 import；找不到 = 停工上报，
   禁止按记忆或推测书写接口。
4. **结构铁律**（P0 起以 `scripts/assert-structure.mjs` 固化进 CI 断言，逐步启用）：
   `core/` 零 harness import（含类型）；改史调用只出现在 `platform/history`；自定义会话
   事件全部 `ignorable:true`（类型级测试）；模板在前、实例参数在后。
5. **禁区（零接触）**：`experiments/**`（2026-09-06 起**封存**：旧实验管线依赖清退前生产
   lib 编译产物，随残留清空中断——`runs/**` 实验证据与 `datasets/` 资产只读保全，解封条件
   见 `experiments/evalground/SEALED.md`；R3/R4 门对照实验随机制落地重建实验面后按
   [08](../08-experiment.md) 组织）、`datasets/`、`reports/`、`scripts/attic/`、
   `docs/00–11` 设计正文与 `ledger-history.md`/`legacy.md`、
   凭证类文件（凭据只存 homedir，永不进仓库）。
6. **mock 优先**：platform 端口的单测全部走 fake 实现（无网络、无真模型）；真实调用只在
   工单明示的集成点出现。
7. **度量先行**（AGENTS 硬规则）：每个机制工单第一步 = 先落 `docs/07` 对应字段的最小
   可回放记账，再写机制本体。
8. **UI 壳不变量**：`client/` 壳（Card/controller/components/theme/mascot）零结构改动；
   配置扩展只经 `field-model.ts` ↔ `config.ts` 对应律双扩，`tests/field-model.spec.ts`
   既有断言只增不减。

## 3. 阶段总表（P0–P21，映射 R0–R4）

尺寸：**S** = 单文件 ≤150 行净增 + spec；**M** = 2–4 文件 ≤400 行净增 + spec；
**L** = 工单内必须拆分两份。

| # | 工单 | 映射 | 新增/改动 | 依赖 | 尺寸 |
|---|---|---|---|---|---|
| P0 | 工程零位核对（已施工 commit `274e37d`） | R0 | manifest 差距核对（[11 §1](../11-structure.md) 表逐项）；`scripts/assert-structure.mjs` 断言骨架（暂全过）+ `npm run assert` | — | S |
| P1 | 事件面接线（已施工 commit `1ed5419` + 翻转 `28351b3`；harness LogIntent 补丁 `04cba8f394`） | R1 | `platform/logger.ts` + `platform/events.ts`（H1 firehose → 异步旁路队列；[10 §1](../10-wiring.md) H1/H7） | P0 | S |
| P1.1 | 诊断落盘 sink（P1 追记，已施工） | R1 | `platform/diag-sink.ts`（`ctx.logger.exporter()` → 插件 `logs/context-economy.log` JSONL，agent 自审面，零 harness 改动；[11 §4](../11-structure.md) 纪律③追记） | P1 | S |
| P2 | 度量底座 | R1 | `core/ledger/`（07 通用族 fold 纯函数 + fixture 回放"同输入同账"断言；**facts 源抽象**：会话 ignorable 事件 ∨ KV 事实镜像，[12 §3](../12-platform-capabilities.md)） | P1 | M |
| P3 | 持久面 | R1 | `platform/storage.ts`（H10 defineDomain 四实体表 + CAS + 快照回退；**+ 事实镜像表**（降级态，[12 §3](../12-platform-capabilities.md)）；[09 §2](../09-state.md) 协议） | P0 | M |
| P4 | 技能目录端口 | R1 | `platform/skills.ts`（H13 `SKILL.md` 枚举 + watch + 引用守卫查表接口） | P0 | S |
| P5 | 辅助调用端口 | R1 | `platform/llm.ts`（H12 `llm.stream({purpose})` + usage/缓存回执）；补 peerDep `dsh-llm` + build 链接 | P2 | S |
| P6 | 改史端口 | R1 | `platform/history.ts`（H4 surfaceOp replace + `sourceEventSeqs` 协议 + H5 事务对 + 配对平衡守卫，fake session 测试） | P1 | M |
| P7 | 工具端口 | R1 | `platform/tools.ts`（H6 around-wrapper `next()` 进 body + post-execute 追加）；补 peerDep `dsh-tools` | P1 | S |
| P8 | 分划单位 + 稳定前缀 | R2 | `core/units.ts`（[01 §3.5](../01-architecture.md) 状态机）+ `core/prefix.ts`（技能目录快照 + 项目帧 vN；`prefixRebuildCause`；字节稳定断言，[02 §2](../02-discriminator.md)/[06 §4](../06-cache.md)） | P3,P4 | M |
| P9 | 卷宗 | R2 | `core/dossier.ts`（append-only / 三分类标注 / 回填 / 边界清空；02 §2） | P3,P8 | M |
| P10 | 判据与对表 | R2 | `core/judge.ts`（L0 词表 / L1 缓存键 / 对表层；tableHitRate 入账；fail-lazy） | P9,P5 | M |
| P11 | 星标断面 | R2 | `core/optimize.ts`（输入栈装配 / 双通道解析 / 行级容错 / 四道机械闸，02 §4）+ 断面 prompt 资产版本化落盘 | P8,P9,P5 | M |
| P12 | 自动断面服务 | R2 | `domains/input.ts`（T0→L0→L1→对表→LLM→fail-lazy 决策链，LLM 主路径渲染 task 内全量卷宗 [02 §2](../02-discriminator.md)；`discriminator.auto` off/observe/active 门控） | P10 | M |
| P13 | 命令面 + init 项目帧 | R2 | `/task` 系列 + `/optimize-prompt`（[10 §2](../10-wiring.md)）+ init 帧采集交互（用户确认，[02 §2](../02-discriminator.md)） | P8,P9,P11 | M |
| P14 | 星标按钮 UI | R2 | H11 `conversation.view` 槽注册 + controller 扩展 + 预览 diff 弹层（复用壳基建）+ 确认/编辑=终稿；时序 B 端到端（mock 断面；剪切清单本阶段只落盘记账） | P11,P13,P6 | M |
| P15 | 工具剪切 | R3 | `core/shear/` 工具半边 + `domains/shear.ts` 调度（[03 §2](../03-shear.md)：四档时机 / ToolContextLifecycle 谓词 / T-note 协商 / T0-R 三硬规则） | P6,P7,P12 | M |
| P16 | 对话剪切 | R3 | run 状态机 + 吸收证明触发 + 结论三档 + 带外标志 + run 冲刷 H4（03 §3）；**03 §8 探针前置在本单内立起** | P15 | M |
| P17 | 边界装配器 | R4 | `core/assemble/`（[04 §2](../04-compactor.md)：事实层冻结 / 坐标层 vN / 热尾双通道取真 / 贪心停机）+ 共享事务原语（04 §1） | P6,P8,P9 | L（拆纯核/接线两份） |
| P18 | 压缩调用 | R4 | `core/compress/`（边界/压力两模式 prompt 组装 + 产物 schema 校验；模板在前 + datasets 同源断言，04 §7） | P5,P9 | M |
| P19 | 边界路径编排 | R4 | `domains/compaction.ts` 边界触发（H2 闭合发现 → 时序 A：装配→档案 vN（[04 §6](../04-compactor.md) 15K 硬帽截断 + `archiveTruncate` 入账）→卷宗清空→T-boundary 搭车） | P17,P18,P2 | M |
| P20 | 压力路径 + 保险丝 | R4 | 时序 C：wire 锚定计量（估计器 `CHARS_PER_TOKEN=1.5` 校准，04 §5）+ 检查点/断路器 + hard-truncate no-op 语义 + `request-error` 接管；`cordis.patch.yml` 加 compaction-basic `auto:false` | P19 | M |
| P21 | 恢复编排 + 全链验收 | R4 | `domains/restore.ts`（H9 恢复序，[09 §4](../09-state.md)：KV 损毁→日志回放重建演练）+ 四触发次序验收 + 四道缓存断言（[10 §6](../10-wiring.md)）进 CI；度量消息列表可视化（加分项，[11 §5](../11-structure.md)） | P19,P20 | M |

依赖主干（其余见各行"依赖"列）：

```text
P0 ─┬─ P1 ─┬─ P2 ─ P5 ─┐
    │      ├─ P6 ────────┤
    │      └─ P7 ─┐      │
    ├─ P3 ─ P8 ─ P9 ─ P10 ─ P12 ─ P15 ─ P16
    │      └────────┴─ P11 ─ P13 ─ P14
    └─ P4 ─ P8                │
P17(P6,P8,P9) ─ P19(P17,P18,P2) ─ P20 ─ P21
P18(P5,P9)
```

平台通道横切（[docs/12](../12-platform-capabilities.md) 正典）：ignorable 发射通道缺失时事实轨
降级 KV 镜像——P2 事实源抽象 / P3 事实镜像表 / P8 段状态机 KV 双源 / P21 可视化读事实源抽象，
各工单编写时按 docs/12 展开。降级实现整体居于 `platform/ignorable-channel.ts`（D3 断言锁定
单元边界，机制代码零感知），上游合并后按 docs/12 §2 清单原子删除。

## 4. 里程碑验收（R 门，单工单之外）

每个 R 段最后一单完成后，按 [11 §8](../11-structure.md) 出门门槛逐条核验，并执行：

1. **账本快照**（AGENTS 硬规则）：改动前后各留一份 07 报表（回放管道产出），入
   `docs/ledger-history.md` 追记（只增不改）；
2. **缓存四断言**（[10 §6](../10-wiring.md)）：R2 起每次里程碑必跑；
3. **结构断言**：`npm run assert` 全绿（core 零 import / 改史归口 / ignorable / UI 不变量）；
4. **对照实验**：按 [08](../08-experiment.md) 臂表组织首批 run（R3/R4 门必做；评测模型与
   批次纪律按 AGENTS.md 硬规则，runs 证据零接触）。

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

- [ ] §3 表 22 行与 [11 §8](../11-structure.md) R0–R4 内容逐行对得上（无漏项、无新增设计）；
- [ ] 每行依赖列构成 DAG（无环）；
- [ ] 尺寸全部 S/M（L 已注明拆分）；
- [ ] 工单模板含 harness 符号核验位与停工上报条款。
