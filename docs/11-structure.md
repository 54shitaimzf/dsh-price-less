# 11 · 工程结构与搭建

> 本文是**实现结构单一事实源**——插件选什么形态、模块怎么切、状态分哪几轨、日志怎么
> 原生兼容、UI 壳怎么接线、按什么顺序搭。机制设计不在本文（02/03/04 为正典），
> 挂点地图在 [10](10-wiring.md)。
> 事实源三链：① 插件开发规范（dsh-super-injector 插件开发指南 + 脚手架模板：
> 四形态 / manifest / build 闭环 / 铁律）；② harness API 面（源码逐条核验，见 10 §1）；
> ③ 现有资产 = client/ 设置壳（零改动保留）+ docs/00–09 设计契约。
> 状态：**R4 完成**（P17 边界装配器已施工：`core/assemble/` 纯核 + `platform/files.ts` 盘上取真 H15 + `domains/assemble.ts` 装配域；
> 快照 [§42](ledger-history.md)/[§43](ledger-history.md)；**P17c 修正**：HT 软门 + 档案区 15K 硬帽 + 追加式链两形态 + 计数修复
> （快照 [§44](ledger-history.md)）；**P18 压缩调用纯核已施工**（快照 [§45](ledger-history.md)）；**P19 边界路径编排已施工**（`core/compress/{region,store}.ts` + `platform/{agent-step,meter}.ts` + `domains/compaction.ts` + `compression.*` 配置面；快照 [§46](ledger-history.md)）；**P20 压力路径 + 保险丝已施工**（`core/compress/{pressure,fuse}.ts` +
> `domains/compaction.ts` 压力折叠/紧急折叠 + `platform/{agent-step,meter,llm}.ts` 端口扩面 + `cordis.patch.yml` auto:false；
> 快照 [§47](ledger-history.md)）；**P20c 阀门修正**（压力阀门 = 0.35 × 主模型窗口 + 假定窗口/绝对安全网回退 + 主会话路由窗口探针；快照 [§48](ledger-history.md)）；**P21a 恢复编排已施工**（`core/restore/` 纯核 + `platform/agent-step.ts` H9 端口 + `domains/restore.ts` 恢复序 + `domains/restore-facts.ts`；快照 [§49](ledger-history.md)）；**P21b 全链验收已施工**（四触发次序闭合表 + 四道缓存断言〔[10 §6](10-wiring.md)〕进 CI：`tests/full-chain-order.spec.ts` + `tests/cache-invariants.spec.ts` + `scripts/verify-p21b.mjs` R4 出门门槛汇总；**验收发现并修正 2 处**——边界区间起点定位缺陷 / 陈旧 P15a 白名单；快照 [§50](ledger-history.md)）——**R4 完成**）。R1 平台面已完成（P0–P7 全部施工；首份 07 报表见 [ledger-history.md §31](ledger-history.md)）；**R2 判别域已完成**（P8/P9/P10/P11/P12/P13/P14a/P14b1/P14b2 全部施工；段末账本快照见 [ledger-history.md §32](ledger-history.md)；**P14c–P14f 修正**（判别链瘦身 / 断面产品契约 / ★ 结果复用 / 推理档设置，快照 §33/§35/§36/§37）已施工）；**R3 剪切域已完成**（P15a 纯核 + P15b 调度接线 + **P16 对话剪切**：`core/shear/run.ts` run 状态机/吸收证明/结论三档 + `domains/shear.ts` 整段 run 冲刷（H4 多节点 replace → notice 用户消息）/ G10 尾部窗 / 第四类事实 `shear-run-plan`；`shear.enabled` 默认 true，重启后生效；快照 §38–§41），§9。

## 0. 它解决什么问题（人话版）

搭插件最怕两件事：**接错缝**（监听不存在的事件、绕过官方协议改历史，harness 升级即碎）
和**切错块**（模块互相 import 成蛛网，升级要改一百处）。本文是施工图：形态选型、模块树、
数据面三轨、日志三纪律、UI 壳一根线接回、R0–R4 每步出门槛。原则三条：**只走官方缝**
（改史只有 surfaceOp replace 一条通道）、**纯核薄适配**（核心机制零 harness import，
适配层是唯一触点）、**一切落盘可复现**（LLM 产物先版本化再复用，会话事实可从日志回放重建）。

## 1. 形态与 manifest 基线（hybrid）

四形态（toolkit / daemon-loop / ui-panel / hybrid）里选 **hybrid**：host 半 = 事件驱动
（判别/剪切/压缩全是事件触发，**无 timer**——不用 daemon-loop 的轮询循环）；client 半 =
设置卡 + 星标按钮（`settings.plugin.item` / `conversation.input.right` 槽，壳已保留）。
注入即完整生效（host+client）、卸载即净。

**manifest 合规清单**（规范 vs 现状，R0 核对表）：

| 项 | 规范要求 | 现状 | 动作 |
|---|---|---|---|
| name/version | `dsh-price-less` / 0.0.1 | 一致 | — |
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
│  ├─ tools.ts       # H6 post-execute 端口（T-entry content 覆盖，W2 保守准入）+ tools/execute 信号计量；签名经 getTools 注入（F1）
│  ├─ llm.ts         # H12 辅助调用端口（CeAuxPurpose 单点适配 + purpose 路由 + usage/缓存观测回执）
│  ├─ storage.ts     # H10 storageDomain 封装（四实体表声明、版本化读写、CAS）
│  ├─ skills.ts      # H13 技能目录枚举 + watch（稳定前缀原料 + 引用守卫查表）
│  ├─ agent-step.ts  # H2 步准入端口（agent/pre-step 唯一收口；P19a，D14）
│  ├─ meter.ts       # H7 计量端口（ctx.tokenMeter 影子价同源；P19b，D15）
│  ├─ logger.ts      # ctx.logger('context-economy') + ignorable 自定义事件发射
│  ├─ star-bridge.ts # H11 星标 Connection RPC 桥端口（channel/端点/信封/错误码；P14b1）
│  └─ diag-sink.ts   # 诊断落盘：ctx.logger.exporter() → 插件 logs/ JSONL（P1.1，agent 自审入口）
├─ core/             # 纯核（零 harness import：事件/会话类型本地重声明，结构性兼容）
│  ├─ units.ts       # 分划单位状态机：task 段 fold、边界记录（01 §3.5 正典）
│  ├─ dossier.ts     # 卷宗：append-only 累积、标注、回填、边界清空（02 §2）
│  ├─ judge.ts       # 判据组装：L1 缓存键（幂等护栏）/ 对表影子记账（只算不拦）/ LLM prompt 渲染
│  ├─ optimize.ts    # 星标断面：输入栈装配、双通道解析、行级容错、四道机械闸（02 §4）
│  ├─ prefix.ts      # 稳定前缀：技能目录快照 + 项目帧 vN、版本 bump 语义（02 §2/06 §4）
│  ├─ init.ts        # init 项目帧采集：prompt v1 渲染与 fail-lazy 解析（02 §2）
│  ├─ shear/         # 剪切纯核（已施工：types/t0r/tool/run/ledger/index，P15a+P15b+P16；classify = N1 身份分类器；协商线 N2/N3 已退役，账本 §71）（03）
│  ├─ compress/      # 两模式压缩 prompt 组装 + 产物 schema 校验 + 共享消费模块 + compress-run 调用账本（04 §2/§3；P18）
│  │                 #   + region.ts 区间逐字节转写 + store.ts 档案区（只追加/硬帽/内容寻址缓存；P19a）
│  │                 #   + pressure.ts 压力触发/检查点/折叠区转写（P20a）+ fuse.ts 保险丝地板（P20b）
│  │                 #   + fact-leak.ts 摘要事实泄漏机械扫描（F9：path/version/quote/command/code/number，只计数）
│  ├─ assemble/      # 装配器（P17 已施工；F9 v2）：坐标链 vN 重映射、热尾双通道取真 + 消息单元、
│  │                 #   Zipf 预算分配 + 份额帽 + 配额丢弃、总述/分步零指针 + 热尾指向档案 vN 渲染 + 共享事务原语 +
│  │                 #   HT 软门 + 档案硬帽/单调追加守卫 + paths.ts 路径相对化（F10：短 ID 表退役）（04 §1/§2/§3/§6）
│  ├─ meter/         # token 估算纯核（F8a，04 §5）：对齐 DSH token-meter/estimate.ts 结构模型（块/角色价 + 递归块价），密度改两桶（CJK 1.5 / 其余 2.9 字符/token）+ token→字符反解 + 标定比
│  └─ ledger/        # 度量 fold：从事件流计算 07 字段（纯函数，回放 = 同输入同账）
├─ domains/          # 编排面（组合 core × platform，按开关装配）
│  ├─ input.ts       # 判别域：自动断面服务（T0→L1→LLM→fail-lazy；对表影子记账；三分类搭车）
│  ├─ commands.ts    # 命令面：/task、/init、/optimize-prompt 注册与委托（10 §2）
│  ├─ star.ts        # 星标断面 host 服务：输入栈装配 → 断面 → 预览态 → 确认后回填/产物（10 §4 时序 B；P14b1）
│  ├─ optimize-facts.ts # optimize-run 两相事实声明合并 + fold（07 §0.5；P14b1）
│  ├─ shear.ts       # 剪切域（已施工：工具档 P15b + run 冲刷/误剪反馈 P16；协商线已退役，账本 §71）
│  ├─ compaction.ts  # 压缩域：边界路径编排（H2 触发 → 调用 → 装配 → 缩水校验 → 档案 vN → 事务；P19b）
│  │                 #   + 压力折叠（H3 wire 锚定触发 / 选缝 / 检查点 / 断路器；P20a）+ 保险丝紧急折叠与溢出接管（P20b）
│  │                 #   （恢复编排 = 独立文件 restore.ts，P21a）
│  ├─ restore.ts     # 恢复编排（P21a）：H9 session-start → 09 §4 恢复序（项目帧快照回退 / 卷宗日志重放写回 /
│  │                 #   档案与产物降级 / 段状态机与度量重算）→ restore-* 事实
│  ├─ restore-facts.ts # 恢复三类 ignorable 事实声明合并（P21a）
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

workspace 隔离（F3）：按**会话 `header.cwd`** 分域（缺失回落进程 cwd），项目级实体键含 workspace 标识；键站点统一走 `domains/workspace.ts`，禁止各域各自 `process.cwd()`。

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
- **星标按钮**：`conversation.input.right` 槽注册 → 真实桥 = Connection RPC `/context-economy`
  （`client/star/star-bridge.ts` → `src/platform/star-bridge.ts`，[13 §3.11](13-harness-plugin-spec.md)）→
  host 断面方法（时序 B，[10 §4](10-wiring.md)）→ 预览弹层（P14d：删 diff，裁决折叠）→
  确认后 `setDraft` + `submit()` **直接发送**。
- **度量消息列表可视化**（加分项，R3+）：client 渲染 `context-economy/*` 会话事件为
  消息流内轻量条目（剪除了多少、压缩了什么——用户可见可审计）。
- 模型路由：`MODEL_PRESET_ROUTES` + `session.modelCatalog()`（H11 remote）+
  revision fence（controller 已实现，零改动）。
- **辅助调用模型路由（U8，2026-09-10）**：**无内置默认模型**。`discriminator.provider`/`model`
  两项齐全 → 用配置；否则跟随会话当前模型（最近一次 `request/header`）；二者皆无（**会话首条消息**）
  → 判别**跳过**并发 `judge-error{code:'CE_JUDGE_NO_ROUTE'}` + `judge-recorded{trigger:'error-fallback'}`，
  从第二条消息起自动跟随；★ 回 `CE_STAR_NO_MODEL`，`/init` 回明确指引，压缩两路径复用
  `llm-unavailable`（瞬态，第二条消息即自愈）。**原硬编码 `deepseek-v4.1-flash-expires-on-0910`
  已删除**（按命名即 0910 到期，且"插件猜模型名"本身是漂移源）。

## 6. 装配开关与默认态

| 开关 | 默认 | 域 | 语义 |
|---|---|---|---|
| `discriminator.auto` | false | 判别 | 自动断面总开关（boolean）；false=不挂载零成本 / true=发 verdict 接入投影；**星标通道常在，不受此开关门控**（观察模式已取消，2026-09） |
| `discriminator.reasoningEffort` | 空（跟随模型默认） | 判别/断面 | 辅助调用（自动判别 / ★）推理档（adapter 词汇 off/low/medium/high/max）；**默认不覆盖**——关闭思考可能明显影响任务边界判断与改写质量；模型未声明所选档时自动回退为跟随（P14f） |
| `shear.enabled` | true | 剪切 | 工具剪切 + 对话剪切总开关（分层可再关 T0-R）；**P15b 落位、P16 复用**（host `config.ts` ↔ client `field-model.ts`，设置卡可关） |
| `compression.boundary` | true | 压缩 | task 边界压缩（**P19 已落位**：H2 闭合触发 → 调用 → 装配 → 缩水校验 → 档案 vN → 事务替换；关闭 = 零行为） |
| `compression.pressure` | true | 压缩 | 压力路径 + 保险丝（**P20/P20c 已落位**：wire 锚定触发阈 = `pressureRatio`（默认 0.35）× 主模型窗口〔缺失 → 假定窗口 → 绝对安全网〕→ 检查点 + 保留区逐字 + 断路器；地板 = 0.8×模型窗口的紧急折叠〔可越过断路器，硬上限 +3〕+ `request-error` 溢出接管；关闭 = 零行为） |
| `compression.pressureRatio` | 0.35 | 压缩 | 压力阀门比例（**P20c 落位**：模型能力在窗口约 35% 后下降；不变量 `0 < ratio < 0.8`，违例整块回退设计值） |
| `compression.domainTokens` / `retainTokens` / `thresholdTokens` | 125K / 10K / 100K | 压缩 | 标定（[04 §5](04-compactor.md)；**P19 落位 + P20c 改义**）：`domainTokens` = 模型未声明窗口时的**假定窗口**；`retainTokens` = 边界热尾预算；`thresholdTokens` = **末位绝对安全网**；`retain < threshold` 违例自动回退设计值 |
| `compression.archiveCapTokens` | 10K | 压缩 | 档案区硬上限（只计总分；热尾单列）；超限截断最老条目（[04 §6](04-compactor.md)；**P19 落位 + F9d/F10 改值**） |

关闭任一层其余功能完整；`cordis.patch.yml` 已覆写 compaction-basic `auto:false`（**P20b 落位**：自动压力与溢出恢复唯一提供者 = 本插件，防双触发）。

## 7. 提示词与工具资产登记

> **零即设计**：模型可见面保持最小 = 请求缓存稳定的根据（tools 数组不耦合）。

| 资产 | 形态 | 设计落位 |
|---|---|---|
| 模型可见工具（tools 数组） | **恒 0**——全层走官方缝（H2/H4/H6）；无任何结果内协议文本（协商线已退役，账本 §71） | [03 §2.1](03-shear.md) |
| 主模型系统提示词 | **恒 0**——知识出口唯一 = 优化后 prompt（用户确认后可见替换） | [01 §4](01-architecture.md) |
| 辅助调用提示词（purpose 标记，主模型不可见） | 判别判据（版本化 + datasets 同源断言）· 星标断面 prompt · 压缩器 prompt（边界/压力两模式；版本化常量 + 字节稳定断言，P18）· 机械摘句规则（对表打分非 LLM） | 02/03/04 各域 |
| 斜杠命令 | `/task` 系列（Tier-0 边界）· `/optimize-prompt`（星标命令形态） | [10 §2](10-wiring.md) |
| 预设 | **提供 1 个**：`presets/price-less/`（价格低耗）——输出措辞纪律 + **固定 native 呈现**（`tool-presentation` 行）；`node scripts/install-preset.mjs` 装到 `$DSH_HOME/.agent-presets/` | 11 §7 |
| client 工具 | 设置卡壳 + 星标按钮 + 度量消息列表可视化 | 本文 §5 |

新资产先进本表再写码。

## 8. 搭建路径（R0–R4，每阶段门槛 = 度量先行）

| 阶段 | 内容 | 出门门槛 |
|---|---|---|
| **R0 骨架核对** | manifest 差距清零（§1 表）；inject 声明定稿；`dev_self_test` 全链路 | 注入/重载/卸载净；typecheck×2 + vitest 绿 |
| **R1 平台面** | platform 七端口（含 skills）+ settings 域 + `core/ledger` 空转（只记账，不发行为） | 账本字段能从 JSONL 回放；ignorable 断言过 |
| **R2 判别域** | core/{units,dossier,judge,optimize,prefix,init} + domains/{input,commands} + init 项目帧 + 星标按钮（H11） | 边界 F1 / 判别成本 / tableHitRate / optimizePromptTokens 入账；`auto` 开关可用（默认关）；星标端到端（断面→预览→确认→回填） |
| **R3 剪切域** | core/shear + domains/shear（工具剪切四档 + 对话 run 冲刷）——**P15a + P15b + P16 全部施工**（快照 §38/§39/§40/§41），**R3 关门** | cut*/shear*/tableRepair/questionBacklogDepth/cutMisfireDetected 全部入账（P16 补齐后三字段）；阈值常数按既有实验结论初值落位（[03 §8](03-shear.md)，不做对照实验） |
| **R4 压缩域（完成）** | core/{compress,assemble,restore} + domains/{compaction,restore}：边界装配 → 压力路径 → 保险丝 → 恢复编排；验收按四种触发次序组织（**P17** 装配器 §42/§43 + **P17c** §44 / **P18** 调用纯核 §45 / **P19** 边界路径 §46 / **P20+P20c** 压力与保险丝 §47/§48 / **P21a** 恢复编排 §49 / **P21b** 全链验收 §50） | hotTail*/pressure*/archiveTruncate 入账；强制重读率经 07 账本真机观测；`auto:false` 协调生效；**四触发次序 + 四道缓存断言进 CI** |
| R5+ | 路线图条目（[00 §11](00-overview.md)） | 各条目自设门槛 |
| **N 系列（已退役）** | **协商剪除（语义层）**：N1 身份通道 ✅ 保留（`core/shear/classify.ts`）；**N2/N3/N4/N5 协商线整体退役**（真机 0/770 配合率；账本 §71）。后续语义剪除方向 = **写时确定性**（不得依赖模型回应，不得等行为信号——都会改史/断缓存），见 [03 §2.1](03-shear.md) | — |

施工分解：R0–R4 细化为 P0–P21b 工单（flash 级自主执行粒度，验收全机械），**已封存**至
[implement/archive/00-master.md](implement/archive/00-master.md)（历史只读）；N 系列总纲与
N2/N3 工单已随协商线退役封存于 `implement/archive/`（遗留登记 [legacy.md](legacy.md) §9）。

## 9. 结构验收（进 CI）

- [ ] core/ 零 harness import（含类型——本地重声明，lint 断言）；
- [ ] 改史调用只出现在 platform/history（grep 断言；surfaceOp + sourceEventSeqs 协议走查）；
- [ ] 自定义会话事件全部 `ignorable:true`（类型级测试）；
- [ ] 装配器确定性：同输入同装配字节（贪心停机 / 坐标重放回归）；
- [x] 恢复演练：KV 损毁 → 日志回放重建，`restore-degraded` 记账（**P21a 施工**：`core/restore/` 纯核 + `domains/restore.ts`；verify-p21a 32 checks）；
- [ ] 关闭任一层（shear/boundary/pressure）其余功能完整；
- [ ] UI 壳不变量（field-model.spec：组壳 / 保留 spec / Config 一致性）。
