# 11 · 工程结构与搭建

> 本文是**实现结构单一事实源**——插件选什么形态、模块怎么切、状态分哪几轨、日志怎么
> 原生兼容、UI 壳怎么接线、按什么顺序搭。机制设计不在本文（02/03/04 为正典），
> 挂点地图在 [10](10-wiring.md)。
> 事实源三链：① 插件开发规范（dsh-super-injector 插件开发指南 + 脚手架模板：
> 四形态 / manifest / build 闭环 / 铁律）；② harness API 面（源码逐条核验，见 10 §1）；
> ③ 现有资产 = client/ 设置壳（零改动保留）+ docs/00–09 设计契约。
> 状态：搭建中（P0/P1/P1.1/P1.2/P2/P3/P4/P5/P6 已施工；R1 未完，§9）。

## 0. 它解决什么问题（人话版）

搭插件最怕两件事：**接错缝**（监听不存在的事件、绕过官方协议改历史，harness 升级即碎）
和**切错块**（模块互相 import 成蛛网，升级要改一百处）。本文是施工图：形态选型、模块树、
数据面三轨、日志三纪律、UI 壳一根线接回、R0–R4 每步出门槛。原则三条：**只走官方缝**
（改史只有 surfaceOp replace 一条通道）、**纯核薄适配**（核心机制零 harness import，
适配层是唯一触点）、**一切落盘可复现**（LLM 产物先版本化再复用，会话事实可从日志回放重建）。

## 1. 形态与 manifest 基线（hybrid）

四形态（toolkit / daemon-loop / ui-panel / hybrid）里选 **hybrid**：host 半 = 事件驱动
（判别/剪切/压缩全是事件触发，**无 timer**——不用 daemon-loop 的轮询循环）；client 半 =
设置卡 + 星标按钮（`settings.plugin.item` / `conversation.view` 槽，壳已保留）。
注入即完整生效（host+client）、卸载即净。

**manifest 合规清单**（规范 vs 现状，R0 核对表）：

| 项 | 规范要求 | 现状 | 动作 |
|---|---|---|---|
| name/version | `@dsh-external/dsh-context-economy` / 0.0.1 | 一致 | — |
| peerDeps | 范围声明不硬编码版本 | cordis/dsh-settings/schemastery/dsh-session/dsh-llm/dsh-skill/dsh-storage-domain/dsh-compaction/dsh-commands 在（P1 补，P4 补 dsh-skill，P6 补 dsh-compaction/dsh-commands；junction 集随 build.sh） | **R1 补** `@deepseek-ai/dsh-tools`（剪切需要，P7），版本随 checkout 核对 |
| dsh.bundle.patch | `./cordis.patch.yml` | 在（P1.2：`files`+`exports` 收编，npm pack 可装配） | R4 加 compaction-basic `auto:false` 覆写（防双触发，[10 §1](10-wiring.md) 辨析③） |
| dsh.client.* | inject + platform + `exports["./client"]` | 全在 | — |
| 构建 | build.sh（DSH_CHECKOUT 探测 + junction 链接）→ tsc host → tsdown client | 在（P1.2：client/tsdown/react/@types/react/zod 链接补齐，干净环境可复现） | R1 起链接集随 peerDeps 扩 |
| 入口铁律 | `export name/inject/Config/apply`；一切资源注册挂 `ctx.effect`；waterfall 必须 `return next()` | 最小闭环在 | 全程遵守 |
| client 铁律 | `inject=['slots'…]` + register 必带 name；操作用完整包名 | 壳未动 | — |

开发闭环：`dev_scaffold_plugin` → 改代码 → `dev_build_plugin` → **每次注入前 `dev_self_test`**
→ `dev_inject_plugin`；构建通过才提交（AGENTS.md）。

## 2. 模块划分

**切分原则**：按"谁改变上下文、谁管理事实"切——执行主体 = 双核心 + 剪切层，其余是支撑面。

```
src/
├─ index.ts          # 装配根：apply(ctx,config) —— 开关装配、fiber 注册、恢复编排入口
├─ config.ts         # Config schema + defaults（settings 卡同源）
├─ settings.ts       # H8 接线：installSection（UI 卡挂载前提）
├─ platform/         # 适配面（唯一 harness 触点；升级只改这里）
│  ├─ events.ts      # H1 firehose 订阅 → 进程内领域事件（异步队列旁路，§5 纪律②）
│  ├─ history.ts     # H4/H5 改史端口：surfaceOp replace + compaction 事务 + prune 计价
│  ├─ tools.ts       # H6 post-execute 端口（T-entry content 覆盖 / T-note 追加）+ tools/execute 信号计量
│  ├─ llm.ts         # H12 辅助调用端口（CeAuxPurpose 单点适配 + purpose 路由 + usage/缓存观测回执）
│  ├─ storage.ts     # H10 storageDomain 封装（四实体表声明、版本化读写、CAS）
│  ├─ skills.ts      # H13 技能目录枚举 + watch（稳定前缀原料 + 引用守卫查表）
│  ├─ logger.ts      # ctx.logger('context-economy') + ignorable 自定义事件发射
│  └─ diag-sink.ts   # 诊断落盘：ctx.logger.exporter() → 插件 logs/ JSONL（P1.1，agent 自审入口）
├─ core/             # 纯核（零 harness import：事件/会话类型本地重声明，结构性兼容）
│  ├─ units.ts       # 分划单位状态机：task 段 fold、边界记录（01 §3.5 正典）
│  ├─ dossier.ts     # 卷宗：append-only 累积、标注、回填、边界清空（02 §2）
│  ├─ judge.ts       # 判据组装：L0 词表 / L1 缓存键 / 对表层 / LLM prompt 渲染（模板在前）
│  ├─ optimize.ts    # 星标断面：输入栈装配、双通道解析、行级容错、四道机械闸（02 §4）
│  ├─ prefix.ts      # 稳定前缀：技能目录快照 + 项目帧 vN、版本 bump 语义（02 §2/06 §4）
│  ├─ shear/         # 剪切纯核：run 状态机 + 工具 janitor + T-note 协商 + T0/T0-R 规则（03）
│  ├─ compress/      # 两模式压缩 prompt 组装 + 产物 schema 校验 + 共享消费模块（04）
│  ├─ assemble/      # 装配器：热尾双通道取真、贪心停机、stub 续传/折叠（04 共享机制）
│  └─ ledger/        # 度量 fold：从事件流计算 07 字段（纯函数，回放 = 同输入同账）
├─ domains/          # 编排面（组合 core × platform，按开关装配）
│  ├─ input.ts       # 判别域：自动断面服务（T0→L0→L1→对表→LLM→fail-lazy；三分类搭车）
│  ├─ shear.ts       # 剪切域：时机调度（四档）+ run 冲刷 + 误剪反馈
│  ├─ compaction.ts  # 压缩域：边界触发（H2）+ 压力触发（H3）+ 断路器 + 事务编排（H5）
│  └─ restore.ts     # 恢复编排：启动回放（H9）→ KV/日志双源核对 → 降级清单（09 §4）
└─ client/           # 产品面（壳已保留，零结构改动）：Card/controller/components/field-model
```

**依赖铁律**：`domains → core + platform`；`core ↛ platform`（反向禁止，CI 断言）；
platform 是唯一 `ctx` 触点（index.ts 装配根除外）；client 只经 settings/remote 面
（H8/H11），不直接摸会话。

## 3. 数据面：三轨持久化

| 轨 | 载体 | 内容 | 失效语义 |
|---|---|---|---|
| 配置 | settings 服务 | Config 用户层（revision fence 防并发丢写） | provider 原子写 |
| **durable 真源** | storageDomain KV（H10） | 四实体：卷宗 / 项目帧（含技能目录快照）/ 边界档案 / 优化产物（[09 §2](09-state.md) 协议） | 回退上一版本（快照） |
| 会话事实 | 自定义 **ignorable 事件**进会话 JSONL（§5 纪律①） | `task-boundary`、`judge-*`、`optimize-run`、`shear-applied`、`pressure-fired`、`restore/*`（全 log-only） | **可回放重建**（KV 只是加速缓存，损毁 = 重放日志重建）；通道缺失时降级 KV 镜像（[12 §3](12-platform-capabilities.md)，失效方向不变） |

workspace 隔离：按 cwd 分域，项目级实体键含 workspace 标识。

## 4. 日志面：原生日志兼容三纪律

1. **自定义会话事件必须 `ignorable:true`**（`SessionEventMap` 声明合并）——否则旧版 harness
   拒读新日志（fail-closed）。`context-economy/*` 全家 log-only：只记账、可回放、零副作用。
2. **firehose 消费走异步旁路**：`session/event` 同步 post-commit 派发、监听器异常只 warn
   不外溢——平台层把重活（判别/断面/压缩）投递进自有队列，**永不阻塞 append**
   （fail-lazy 铁律的接线形态）。
3. **诊断走 `ctx.logger('context-economy')`**；运营事实一律进会话事件而非 stdout——
   保证"从落盘日志完整重建插件行为"可审计。诊断另经公开导出面 `ctx.logger.exporter()` 落盘
   插件根 `logs/context-economy.log`（JSONL，2 MiB 封顶滚动 1 份，`CE_DIAG_DIR` 可重定向；
   `platform/diag-sink.ts`）——agent 无需 console 即可 Read/grep 自审（P1.1）。

附：**本插件不注册 system-prompt 注入**（宪法：无隐藏注入段，知识出口可见）；
提示词纪律——静态模板在前、实例参数在后，严禁动态拼接。

## 5. UI 壳接线（保留资产 ↔ 新架构）

- 挂载链：`settings.ts` installSection（H8）→ client `settings.plugin.item` 槽（H11）→
  Card/controller/components 壳（**零改动**）→ **`field-model.ts` 是唯一载荷入口**。
- 对应律：`ECONOMY_FIELD_SPECS` ↔ Config 字段一一对应（扩配置 = Config + field-model
  两处同扩，测试断言一致性）。配置面（§6）按此重填。
- **星标按钮**：`conversation.view` 槽注册 → host 断面方法（时序 B，[10 §4](10-wiring.md)）
  → 预览 diff 弹层（复用壳的 popover/fixed 弹层基建）。
- **度量消息列表可视化**（加分项，R3+）：client 渲染 `context-economy/*` 会话事件为
  消息流内轻量条目（剪除了多少、压缩了什么——用户可见可审计）。
- 模型路由：`MODEL_PRESET_ROUTES` + `session.modelCatalog()`（H11 remote）+
  revision fence（controller 已实现，零改动）。

## 6. 装配开关与默认态

| 开关 | 默认 | 域 | 语义 |
|---|---|---|---|
| `discriminator.auto` | false | 判别 | 自动断面总开关（boolean）；false=不挂载零成本 / true=发 verdict 接入投影；**星标通道常在，不受此开关门控**（观察模式已取消，2026-09） |
| `shear.enabled` | true | 剪切 | 工具剪切 + 对话剪切总开关（分层可再关 T-note / T0-R） |
| `compression.boundary` | true | 压缩 | task 边界压缩 |
| `compression.pressure` | true | 压缩 | 压力路径（`pressureRatio=0.4` × 压缩域窗口） |
| `compressionDomain` / `retainTokens` / `thresholdTokens` | 125K / 10K / 100K | 压缩 | 压缩域标定（[04 §5](04-compactor.md) 硬规则；`retain < threshold` 校验强制） |
| `archiveCapTokens` | 15K | 压缩 | 档案区硬上限；超限截断最老条目（[04 §6](04-compactor.md)） |

关闭任一层其余功能完整；`cordis.patch.yml` 在 R4 加 compaction-basic `auto:false`。

## 7. 提示词与工具资产登记

> **零即设计**：模型可见面保持最小 = 请求缓存稳定的根据（tools 数组不耦合）。

| 资产 | 形态 | 设计落位 |
|---|---|---|
| 模型可见工具（tools 数组） | **恒 0**——全层走官方缝（H2/H4/H6）；唯一例外通道 = T-note 注记贴在工具结果内容内（非 schema） | [03 §2.1](03-shear.md) |
| 主模型系统提示词 | **恒 0**——知识出口唯一 = 优化后 prompt（用户确认后可见替换） | [01 §4](01-architecture.md) |
| 辅助调用提示词（purpose 标记，主模型不可见） | 判别判据（版本化 + datasets 同源断言）· 星标断面 prompt · 压缩器 prompt（边界/压力两模式）· T-note 注记模板 · 机械摘句规则（L0 非 LLM） | 02/03/04 各域 |
| 斜杠命令 | `/task` 系列（Tier-0 边界）· `/optimize-prompt`（星标命令形态） | [10 §2](10-wiring.md) |
| 预设 | **不提供**（首批预设候选见 [00](00-overview.md) 路线图：预设开发结合系统提示词改造） | 路线图 |
| client 工具 | 设置卡壳 + 星标按钮 + 度量消息列表可视化 | 本文 §5 |

新资产先进本表再写码。

## 8. 搭建路径（R0–R4，每阶段门槛 = 度量先行）

| 阶段 | 内容 | 出门门槛 |
|---|---|---|
| **R0 骨架核对** | manifest 差距清零（§1 表）；inject 声明定稿；`dev_self_test` 全链路 | 注入/重载/卸载净；typecheck×2 + vitest 绿 |
| **R1 平台面** | platform 七端口（含 skills）+ settings 域 + `core/ledger` 空转（只记账，不发行为） | 账本字段能从 JSONL 回放；ignorable 断言过 |
| **R2 判别域** | core/{units,dossier,judge,optimize,prefix} + domains/input + init 项目帧 + 星标按钮（H11） | 边界 F1 / 判别成本 / tableHitRate / optimizePromptTokens 入账；`auto` 开关可用（默认关）；星标端到端（断面→预览→确认→回填） |
| **R3 剪切域** | core/shear + domains/shear（工具剪切四档先行：T-entry + T0/T0-R；对话 run 次之） | cut*/shear*/tableRepair 字段入账；误剪反馈闭环；阈值常数按既有实验结论初值落位（[03 §8](03-shear.md)，不做对照实验） |
| **R4 压缩域** | core/{compress,assemble} + domains/compaction：边界装配 → 压力路径 → 共享消费模块；验收按四种触发次序组织 | hotTail*/pressure*/archiveTruncate 入账；强制重读率经 07 账本真机观测；`auto:false` 协调生效 |
| R5+ | 路线图条目（[00 §11](00-overview.md)） | 各条目自设门槛 |

施工分解：R0–R4 细化为 P0–P21b 工单（flash 级自主执行粒度，验收全机械），总纲与工单见
[implement/00-master.md](implement/00-master.md)。

## 9. 结构验收（进 CI）

- [ ] core/ 零 harness import（含类型——本地重声明，lint 断言）；
- [ ] 改史调用只出现在 platform/history（grep 断言；surfaceOp + sourceEventSeqs 协议走查）；
- [ ] 自定义会话事件全部 `ignorable:true`（类型级测试）；
- [ ] 装配器确定性：同输入同装配字节（贪心停机 / 坐标重放回归）；
- [ ] 恢复演练：KV 损毁 → 日志回放重建，`restore/degraded` 记账；
- [ ] 关闭任一层（shear/boundary/pressure）其余功能完整；
- [ ] UI 壳不变量（field-model.spec：组壳 / 保留 spec / Config 一致性）。
