# 项目定位

dsh-price-less：DSH 的**全自动上下文管理工具**——双核心
（优化判别器 `docs/02` / 压缩器 `docs/04`）+ 四层防御（交换对剪切 `docs/03` /
task 边界压缩+热尾 / 35% 窗口比例压力路径 / 防溢出保险丝）+ 五条节约理念（缓存复用 / 软件架构经验
提取 / 无关内容剪枝 / 执行路线确定化 / 多做·相信用户决策·必要才探索，正典 `docs/05 §1`）。
宪法与回退链在 `docs/05`，缓存纪律 `docs/06`，状态协议 `docs/09`。
完整设计在 `docs/`，本文件只给可执行的高信号指令。

**现状**：R1 平台面**已完成**——P0（零位断言：`scripts/assert-structure.mjs` + `npm run assert`/`gate`）→
P1（事件面：`platform/events.ts` H1/H7 firehose → 异步旁路队列 + `platform/logger.ts` 事实发射端口）→
P1.1（诊断落盘 sink）→ P1.2（地基修补与契约闭合）→ P2（度量底座 `core/ledger`）→
P3（持久面 `platform/storage.ts`）→ P4（技能目录 `platform/skills.ts`）→ P5（辅助调用
`platform/llm.ts`）→ P6（改史端口 `platform/history.ts`：H4 surfaceOp replace +
H5 compaction 事务 + 配对平衡守卫）→ P7（工具端口 `platform/tools.ts`：H6 tools/post-execute
content 覆盖/追加 + tools/execute 信号计量）全部施工；首份 07 报表见
`docs/ledger-history.md` §31；**R2 判别域已完成**（P8–P13 纯核/编排 + P14a 星标 UI + P14b1 host 断面服务/Connection RPC 桥端口 +
P14b2 真实桥与时序 B；**P14c 修正**（判别链瘦身 + ★ 断面修复：删 L0、对表影子记账（只算不拦）、★ 门控改为
"本次提示词极短"、上下文读会话事件；快照 = `docs/ledger-history.md` §33）；**P14d 修正**（断面产品契约：
关键事实保真 + 大胆重写 + 禁标签/元注释、候选段事实级预抽、元注释机械剥离入账、推理档做成设置项（默认跟随模型默认）、
弹层删 diff 且确认即发送（无"已发送"提示）；★ 结果复用（同 prompt 二次点击只展开）；快照 = §35 / §36 / §37））；**R3 剪切域已完成**——P15a 纯核 + P15b 调度接线 + **P16 对话剪切**（`core/shear/run.ts` run 状态机/吸收证明/结论三档 + `domains/shear.ts` 整段 run 冲刷（H4 多节点 replace → notice 用户消息）/G10 尾部窗/第四类事实 `shear-run-plan`（含 ★ CLASS 回填）；`shear.enabled` 默认 true，**重启后生效**；快照 §38–§41；机械路径激活 = 开 `discriminator.auto` 或 ★ 产出 `SHEAR`/`CLASS` 行）。**R4 压缩域已完成**——P17 边界装配器已施工（`core/assemble/` 双通道坐标 + 版本补丁链重映射 + 贪心停机 + 地板/兜底 + 共享事务原语；`platform/files.ts` **H15 盘上取真**；`domains/assemble.ts` 装配域 + `assemble-run` 事实；快照 §42/§43；**P17c 修正**：HT 软门 + 档案区 15K 硬帽纯核 + 追加式链两形态 + 丢弃归因，快照 §44；**不触发压缩**——触发/档案 vN/卷宗清空归 P19）；**P18 压缩调用纯核已施工**（`core/compress/`：两模式 prompt 组装〔模板在前/清单在尾/零预算泄漏/机制 A 续传〕+ 产物 schema 校验〔仅解析/schema 校验 fatal；缝两校验〕+ 共享消费模块〔四触发次序闭合表〕+ `compress-run` 调用账本〔`compressionCall*` fold 路径打通，生产者 = P19/P20a〕；**零调用零接线**，快照 §45）；**P19 边界路径编排已施工**
（`core/compress/{region,store}.ts` 区间转写 + 档案区〔只追加 + 15K 硬帽 + 内容寻址缓存〕；`platform/agent-step.ts` H2 收口〔D14〕；
`platform/history.ts` `commitCheckpoint` 官方 summary+checkpoint 紧邻提交；`platform/meter.ts` 影子价同源〔D15〕；
`domains/compaction.ts` 闭合发现 → 单次调用 → 缩水校验〔replace 前置，重试 1〕→ 档案 vN → 事务替换 → T-boundary 补账；
`compression.*` 配置六字段 + client 同步；快照 §46；**需重启加载新构建**，live `compress-run` 当前 = 0）。
**P20 压力路径与保险丝已施工**（`core/compress/{pressure,fuse}.ts`：绝对阈值 + 比例 fallback / 断路器 3 / 压力档重试 2 /
检查点渲染 / 折叠区材料转写 / 地板 0.8×窗口；`domains/compaction.ts`：wire 锚定触发 → 选缝 → 检查点 + 保留区逐字 →
缩水校验 → 档案 checkpoint → 事务，以及地板以上/溢出码紧急折叠 + `agent/request-error` retry；
`platform/{agent-step,meter,llm}.ts` 端口扩面〔H3 收口 D14 扩面〕；`cordis.patch.yml` 声明 compaction-basic `auto:false`
（**U16 更正：声明在、但作用不到生效实例**，见下文 U16 与账本 §87）；
快照 §47；**需重启加载新构建**，live `pressure-fired` 当前 = 0）。**P20c 阀门修正**（用户裁定：压力阀门 = `compression.pressureRatio`（默认 **0.35**）× **主模型上下文窗口**；窗口缺失 → 假定窗口 `domainTokens` → 绝对安全网 `thresholdTokens`；窗口探针取主会话路由 `readSessionModel`；保险丝紧急折叠可越过断路器〔硬上限 +3〕；快照 §48）。**P21a 恢复编排已施工**（`core/restore/` 纯核〔步序/实体审计/卷宗日志重放/双源等价/`restoreDegraded` fold〕+ `platform/agent-step.ts` H9 端口 `onAgentSessionStart`〔D16 收口；apply 同步注册 + pending 缓冲〕+ `domains/restore.ts` 恢复序〔`firstLiveSeq>0` 才跑、同会话幂等、零模型零改史〕+ `domains/restore-facts.ts`：09 §4 顺序 = 项目帧快照回退 / 卷宗日志重放写回 / 边界档案与优化产物只降级 / 段状态机与度量缓存纯函数重算，三类 `restore-step|restore-degraded|restore-done` ignorable 事实；快照 §49）。**P21b 全链验收已施工**（`tests/full-chain-order.spec.ts` 四触发次序闭合表〔边→边/边→压/压→边/压→压〕+ 域侧交错 e2e + 层隔离；`tests/cache-invariants.spec.ts` 四道缓存断言〔10 §6：前缀性质/同版本逐字节/同 purpose 模板前缀/档案只追加〕；`scripts/verify-p21b.mjs` R4 出门门槛汇总；**验收发现并修正 2 处**——`runBoundary` 起点定位缺陷〔多闭合段积压卡死〕/ `verify-p15a` 陈旧白名单；度量可视化 = 加分项不做；快照 §50）——**R4 完成**。`platform/`（十四文件）是唯一 harness 触点层。**现行基线 = B+（2026-09-10 用户裁定）**：上游 `origin/master` @ `c291e7961a`（**0.1.5-rc.2**）**+ 重放本仓的 ignorable 补丁**（harness 分支 `bplus-0.1.5` @ `f0dc41471c`）——跟主线 **且** 保住事实轨的会话日志真源。上一代基线 A（`feat/ignorable-logintent-alpha2`，alpha.2）**已不受支持**。replace `surfaceOp` 端点键名的**单一事实源 = `src/core/ledger/types.ts` 的 `REPLACE_OP_ENDPOINT_KEYS`**（读写两侧共用；`platform/history.ts` 另配双向编译期锚 `ReplaceOpAnchor`——上游再改端点名即 typecheck 红，**不得靠改断言消红**）。测试替身的线格式解读统一走 `tests/replace-op.ts`，**新写替身必须复用**。**升级 harness 前先读 [`docs/14-upstream-upgrade.md`](docs/14-upstream-upgrade.md)**（可复现步骤 + 8 条接触面清单 + 验收 + 回滚）；不可锚的 cast 与上游弃用面台账在 `docs/legacy.md §14/§15`；账本 §80/§81/§82。
**2026-09-10 五路审查修复战役 U1–U13 全部落地**：U8–U13（提交 `9ca139c`/`80493fe`/`dc671df`/`14172a0`/`7c14e3d`/`82af4a4`）
= 判别/辅助调用模型**去硬编码**（无路由跳过判别 + `CE_JUDGE_NO_ROUTE`）/ 永久封禁族（段锚 + 重试预算 2 + 孤儿事务自愈）/
屏障与超时族（`streamCeLlm` 硬超时 + drain 按会话分桶 + settle 超时闩）/ 口径计量族 8 项 / 存储恢复族 3 项 / P3 五项；
快照 **§82**（含两处偏离工单的理由与实测依据）。**构建产物级冒烟 = `npm run smoke:lib`（27 项，升级后必跑）**，
跑在 `lib/` 上（src 层 vitest 全绿也照样漏构建/链接漂移）。**harness 接触面**（ignorable 通道是否闭合）
由 **`npm run probe:channel`** 守（`scripts/probe-channel.mjs`：探测 + 真 Session 回环 + 存储契约正反证；
2026-09-11 新增——此前 `docs/14 §4` 误称 `smoke:lib` 已覆盖，实测零匹配）。
**取代路线的构建产物级探针 = `npm run probe:provider`**（`scripts/probe-provider.mjs`，11 项：preset 换行的
静态面 + 包 `exports` 解析 + `CompactionEngine` **模块实例同一** + 根 realm **无泄漏** + 缝从 isolate 组内
可解析 + 官方 8 字段映射 + decline/busy/拒绝；2026-09-11 新增——这条路线的前提全都不在 `src/` 层）。
**重建 + 重启一条命令**：`pwsh -File scripts\rebuild-and-run.ps1`（重链重编译 → gate → smoke:lib →
probe:channel → probe:provider → 停旧宿主 → `pnpm dsh web`）。
`context-economy/*` 事实发射依赖 harness ignorable
通道——**通道契约与降级设计 = `docs/12-platform-capabilities.md`（正典）**：通道当前为本仓
harness checkout 的本地实现（上游共识形态，待合并），插件经运行期探测自动适配，通道缺失时
事实轨降级 KV 镜像、账本口径不变；**checkout 升级后跑 `npm test` 自检（回环用例即通道测试）**。
**2026-09-11 原地 B+ 完成**：harness 主 checkout 已**原地**切到 B+（`bplus-0.1.5` @ `f0dc41471c`，
临时 worktree `G:\dsh-bplus-wt` 已移除，插件 28 个 junction 全指 `G:\deepseek-harness`）；
构建产物级回环探针读数 = **`emitted` + `ignorable:true` + v3 存储契约放行**（透传已闭合）。
**会话与 storages 已是格式 v3（最高迁移包 `session-format-v2-to-v3`）→ 切换基线时不要清空/挪走
`~/.dsh/sessions` 与 `~/.dsh/storages`**（旧 runbook 的"清空 v2 会话"建议已作废并改正）。
**判别器 v5（用户裁定 2026-09-11）= task 粒度收紧**：task 锚在**功能/模块/产物**这一级，
**不锚仓库/项目**——"都在同一个仓库/插件里"不构成同一 task。v4 的对象枚举（文件/模块/项目/产物）
与"或同类目标"是**并列洞**，模型挑"项目"这层即可把整仓一天算作一个 task（真机 `session-6ef03ab9`：
150 条消息只出 2 条 `new-task` 且全在事件窗外 → 边界压缩零触发）。v5 落点：定义改功能点锚、
规则 6 去掉"项目/代码库"并写明"仓库名/项目名/产品名不是工作对象"、规则 5 补"同一仓库内推进
另一件功能 = 换意图"、**新增粒度自检**（给 target 起功能级名字，不同即 `new_task`；"这个插件/
这个项目"判不合格）、continue 尾巴禁止以"都在同一个仓库"放行；判据模板 = 
`datasets/prompt-discriminator-v2.4.txt`（与 `core/judge.ts` 同源断言）。代价（已确认接受）：
闭合 task 变多 → compress 调用次数上涨。快照 **§83**。
**U15 热尾申报 ID 契约（2026-09-11，真机首例边界压缩复盘）**：边界压缩**已真机跑通**
（`session-ed9fe428` 02:57，`compress-run` layer=boundary outcome=ok；宿主 02:51 重启后
ignorable 通道闭合、事实进 JSONL 而非只长 `fact_mirror`）。但**热尾整体退化为位置兜底**：
模型申报的 10 条热尾 100% 被拒——清单旧渲染 `[id] 名称 …` 让模型把方括号一起抄进 `unitId`
→ 判 `unknown-unit` → 装配器退回"区间末尾原文逐字搬运"（产物 **95.3% 是原文切片**，含 10 条
`[tool-call]` JSON 噪声）。修法：`renderUnitList` **行首第一个词即 `unitId`**（去包裹）+
`core/assemble/gate.ts normalizeUnitId`（剥一层成对包裹作双保险）+ prompt 抄写纪律 +
`droppedHotTailBadDecl`/`droppedHotTailUnknownUnit` **分列落账**（只记合并数不可诊断：
`assemble-run` 看到的已是门禁过滤后的空数组，恒 0）。`COMPRESS_PROMPT_VERSION` 3→4。快照 **§85**。
**U16 孤儿锁与原生 provider 并存（2026-09-11，真机复盘 + 用户问"混用后果"）**：全量重放 13 会话的压缩协议
（配对/孤儿/ID 不匹配/未闭合）**全为 0**，但追查组合层时翻出两处结构缺陷。**① `cordis.patch.yml` 的
`compaction-basic auto:false` 不生效**：profile 补丁链 = base → web-app → dsh-price-less，而
`web-app/cordis.patch.yml:427-428` 已把 profile 树的 compaction-basic `disabled: true`，我们的 config 覆写
落在**禁用行**上；真正生效的是 **agent preset** 的 `isolate: {compaction: true}` 组内实例
（`presets/standard/agent.cordis.yml:138-156`，无 config ⇒ `compaction-basic/src/config.ts:95`
`auto: config.auto ?? true`），由 agent-presets **运行期单独挂载**，不在补丁链上。此前"13 会话 0 次自动
原生压缩 ⇒ 补丁生效"是**混淆推断**——真因是**阈值差**（原生 0.8×窗口=800K vs 本插件 0.35×窗口=350K，
实测 `contextWindow=1000000`/`thresholdTokens=350000`/wireTokens 峰值 423036）。**② 孤儿锁两条缺陷**：
(a) `platform/history.ts` 的 `scanActiveCompaction` 忽略 `session/end-seed`——而 harness 官方语义是种子边界
**作废**在途事务（`compaction/src/invariant.ts` 的 trace + `compaction-basic/src/region.ts:307-319` 的
`latestEndSeedSeq > startSeq`），旧实现使上一生命周期残留把会话压缩**永久瘫痪**；
(b) `domains/assemble.ts` 的 `closeOrphanCompaction` 无条件闭合它发现的任何未闭合标记，而"单线程同步窗口内
不存在真并发"的注释前提**已被证伪**（原生 provider 括号跨一次摘要 await，且其自动档一直注册在同一步准入
waterfall 上）⇒ 会把并行 provider 的**在途**事务关掉，对方收尾即撞 harness 不变式
（`compaction/src/invariant.ts:246`）；这不是"手动开 auto 才响"，而是**延迟触发**。修法：`scanActiveCompaction`
认 `session/end-seed`；新增 `CE_TXN_ID_PREFIX`/`ceTxnId` 唯一构造点（`core/assemble/txn.ts`）；
`closeOrphanCompaction` **只闭合自家前缀**的残留，异己一律不碰、如实返回 `TXN_ACTIVE`。**取代原生压缩的
正确形态**（修正初判）：`ctx.compaction` 作用域隔离且 `command-compact` 在**同组**解析它 ⇒ host 平面实现
**不被解析**；必须走 preset 授权路径（复制 standard → 同组内去掉 compaction-basic、保留 command-compact、
加入本插件薄 provider entry → 默认预设指向新 id），可行性见 `boot/app-boot/tests/config-reload.spec.ts:399-438`。
快照 **§87**。**U17 取代路线已落地（2026-09-11）**：`platform/compaction-port.ts`（服务缝：host 平面
`contextEconomy` 面的形状 + 名字唯一构造点，零运行时 harness 依赖）+ `platform/provider-entry.ts`
（薄 provider = `dsh-price-less/provider` 的 default export，`CompactionEngine` 子类：`compactNow` 用
`agent.runMaintenance` 包住并委派回 host 压缩域、`compactIfNeeded` 恒 `null`、`compactRegion` 明确拒绝）+
`apply()` 里 `ctx.provide` 发布该面；`presets/price-less/agent.cordis.yml` 的 compaction 组已换行
（`compaction-basic` → `dsh-price-less/provider`，`command-compact`/`tool-result-pruner` 保留）。
**D7 因此有第二个具名放行面**（`platform/provider-entry.ts`：服务缝触点，一个事件都不写）；
验收 = `npm run probe:provider`（11 项，构建产物级：包 exports 解析 / 模块实例同一 / 根 realm 无泄漏 /
缝从 isolate 组内可解析 / 8 字段映射）。**默认预设已由用户裁定指向 `price-less`**（2026-09-11；
`~/.dsh/settings.yaml`，备份 `settings.yaml.bak-preset-standard`）——改默认预设**必须**先取得用户确认；
装 preset 用 `npm run preset:install`，漂移用 `npm run preset:check` 看（主目录那份是手装输入，不随包更新）。
**U17④ 压缩进度提示**：宿主在每次压缩的**模型调用**前后各发一条 `context-economy/compact-progress`
（ignorable；`start`/`end` 由同一 `try/finally` 成对 ⇒ 异常也不漏；缓存命中零调用 ⇒ 零进度），
浏览器侧 `conversation.input.dock` 的进度条按"最后一条是 start"渲染"压缩中…"、`end` 到达即消失
（`client/compaction-progress.ts` 纯核 fold + 观察源，数据源 = `ctx.sessions.binding(id).eventSource`
——**不新增宿主→浏览器推送通道**）。跨半边靠同一事实名字面耦合（client 禁 import host src，S4），
漂移是**静默**的 ⇒ 由 `smoke:lib` 的 3 项跨半边契约在产物层守（27 项）。
快照 **§90**。
client/ 设置壳**全保留**（星标按钮 +
度量可视化按 `docs/11 §5` 接线）；**R1–R4 工单已封存**至 `docs/implement/archive/`
（历史记录，只读）；**N 系列「协商剪除」（语义层）已整体退役**（账本 §71；遗留登记 `docs/legacy.md` §9），原总纲与 N2/N3 工单封存于 `docs/implement/archive/`
（**N1 ✅ 身份通道**〔`core/shear/classify.ts` + `platform/tools.ts` 描述符 + `scripts/probe-n1.mjs`；探针报告 N1 §9〕→ **N2 ✅ 结论契约**（探针：工具内容内注记配合率 **0/134** → 通道待激活）→ **N3 影子模式（已退役，账本 §71）**（历史：`core/shear/negotiate.ts` 纯核 + 两型 ignorable 事实 + `shear.negotiate` 三态 + 通道 A+C）；**2026-09-09 真机复盘修复 F1–F5**（H6 端口 `ctx.tools` 未 inject 空转 → F1 修；边界压缩加 60s 判词屏障 F2；诊断日志去重 F4；档案渲染结论先行+标签 F5a；**F3 工作区隔离已落地**（`domains/workspace.ts` 唯一键源 = 会话 `header.cwd`；快照 §70）/ F5b 路径相对化已由 **F9e** 落地〔每档案条目带 root + 相对化 + 短 ID 表〕；
快照 §60）→ **F9 压缩产物重构**（F9a 区间权威 + F9b schema v2 + F9c 热尾事实载体 + F9d 双预算/存储 v2/
单调守卫 + F9e 路径压缩；快照 §62–§66）→ **F10 契约 v3**（总分零指针 + 热尾指向档案 + 档案只存总分 +
错误不进热尾；快照 §69）→ **F11/F12/F13 真机复盘修正**（列表类命令不剪 / 影子模式零字节〔注记只记事实〕/
判别器 v4 任务定义〔同一工作对象或同类目标持续改进；子task 不分流〕；快照 §70）→ **N 系列协商线退役**（真机 44 会话 / 633 选样 / 68 挂注记 → **CUT-OK 0 / CUT-HOLD 0 / 无回复 100%**，叠加 N2 探针 0/134；`shear.negotiate` 配置 + `core/shear/{negotiate,conclusion}.ts` + 两型 `shear-negotiation-*` 事实 + 账本协商段 + T-note 标记协议 + 预设 persona 协议段全部删除；N1 分类器保留；快照 §71）→ **写时确定性剪除方向**（剪点必须在结果入账前定死 = T-entry；禁模型回应依赖、禁行为信号〔缓存断裂〕；T-entry 准入收紧为**过程日志白名单**：失败/数据查询/列表原文保留，账本 §73）），核心纪律：core 零 harness import、改史唯一通道 = surfaceOp replace +
sourceEventSeqs、自定义会话事件必须 ignorable:true、LLM 产物先版本化落盘再复用。诊断日志
落盘插件根 `logs/context-economy.log`（JSONL、2 MiB 滚动，agent 自审直接 Read/grep 该文件；
`docs/11 §4③`）。
实验框架 `experiments/evalground/` **封存**（2026-09-06：旧管线依赖清退前生产 lib 编译产物，随残留清空中断；`runs/` 证据与 `datasets/` 资产只读保全，解封条件见 `evalground/SEALED.md`。**实验结论已固化进 docs/02–04 设计，R3/R4 不再组织对照实验**）。

## Build

- 干净环境先装 devDeps（内部 @deepseek-ai 包仍由 build.sh 链接 checkout）：
  `npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund --no-package-lock`。
- `DSH_CHECKOUT=G:/deepseek-harness npm run build` —— junction 链接 checkout 依赖后 tsc 编译 host，
  随后 tsdown 编译 client（UI 壳），产物 `lib/`；build.sh 现在同时补齐 client/tsdown/react/
  @types/react/zod 链接（P1.2，干净归档可复现）。
  **Windows 注意**：PATH 上的 `bash` 是 `C:\Windows\system32\bash.exe`（WSL），`npm run build` 会挂在
  `set: pipefail`。用 `& 'C:\Program Files\Git\bin\bash.exe' scripts/build.sh`，或
  `npm config set script-shell "C:\Program Files\Git\bin\bash.exe"`。
- **换 harness 版本**：照 [`docs/14-upstream-upgrade.md`](docs/14-upstream-upgrade.md) 走
  （可复现步骤 + 接触面清单 + 验收 + 回滚），切换用 `scripts/promote-bplus.ps1`。
  升级后 **`DSH_CHECKOUT` 指向新 checkout 重跑 build.sh**，否则 junction 还指着旧树。
- 改完代码必须构建通过才提交；每单验收第一行 = `npm run gate`（P0 冻结四段：typecheck +
  typecheck:client + test + assert；P1 起 `npm run typecheck:tests` 单独跑——类型级词汇派生守门）；
  `npm run assert` = 结构断言（M/S/D 规则，工单推进时追加规则 + 更新零位快照）。

## Test

- 每个机制（判别/星标断面/剪切/压缩）必须能在 `docs/07-metrics.md` 的协议里被观测；
- 改动前后必须留账本快照（`docs/07-metrics.md` 现行口径；历史快照档 = `docs/ledger-history.md`，
  只增不改），否则改动不算完成；账本快照 = 纯回放管道产出，不依赖实验批。
- **不再组织对照实验（2026-09 定）**：实验结论已固化进 `docs/02–04` 设计与常数；
  R3/R4 验收 = 机械断言 + 07 账本回放 + 真机冒烟（`docs/implement/archive/00-master.md` §4）。
  `docs/08` 与 `experiments/evalground/` 封存为历史方法学，正文不改，如将来重建实验面再启用。
- 插件侧 vitest：设置壳不变量（`tests/field-model.spec.ts`）+ P0 冒烟/断言自测
  （`apply-smoke` / `assert-structure`）+ P1 事件面（`events-pump` / `ce-logger` /
  `harness-session` 真集成）；机制测试以回放/注入/确定性为主，不做臂对照（`docs/08` 已封存为历史方法学，不再作为施工门禁）。
- **压缩域标定常数（实验结论 + P20c 用户裁定）**：压力阀门 = `pressureRatio`（默认 **0.35**）
  × 主模型上下文窗口；窗口缺失 → 假定窗口 `domainTokens=125K`（2026-09 实测峰值 233K 标定）
  → 绝对安全网 `thresholdTokens=100K`；`retainTokens=10K`（边界热尾）；**F9 双预算**：
  档案区 `archiveCapTokens=10K`（**只计总分**；与热尾分列）；产物（F10 契约 v3）= 总述（≤80 字零事实）
  + 分步（≤120 字/条，**零指针**）+ 热尾（头指档案 vN + `▸n` 逐字内容，事实载体；**错误信息不进**；
**v4**：仅当内容不能自证位置时加 `相对路径@vN:lines` 定位标注，`pointerOverheadTokens` 只对这类条目计费）——
  档案落盘正文 = 仅总分，热尾每次压缩直接抛弃（档案不因事实漂移失效）；热尾配额 Zipf `1/i` + 份额帽
  `hotTailMaxShare=0.4`（防缩水打回）；估计器 = **两桶密度**
  （CJK 1.5 / 其余 2.9 字符/token；结构模型对齐 DSH `token-meter/estimate.ts`，`core/meter/estimate.ts`）；不变量 `retain < thresholdTokens`、`0 < pressureRatio < 0.8`。**触发器语义**：task 边界
  自动触发 = `agent/pre-step` 发现 `status==='closed' && !compactedTaskIds` 的 task 就压
  （`docs/10` 时序 A），不是 `trigger.tokenThreshold`（那是 DSH 压力/溢出触发）。
  **A/F2（2026-09-11，真机复盘）**：主路径改为读**步准入载荷 `messages`**（本步即将落会话的用户消息，
  此刻还没有 seq）→ `preJudge` 按文本判 → `new-task` 即调 `onBoundaryBeforeStep` 压**当前开放段**
  （区间右端 = 表面尾，因新消息尚未提交）——这才压在**新任务第一条模型调用之前**。旧实现只按会话
  seq 建 `settle` 屏障，而 harness 在 pre-step 返回之后才 `append('user/message')`（agent-loop
  `agent.ts` L289→L302→L375）⇒ 屏障**恒空转**：实测判词落地时首步思考早已产出，压缩被推到第二步
  并阻塞 62.6s。`userTexts` 过滤口径与输入面五条件**逐条对齐**（`source.kind==='user'`，
  否则 AGENTS/插件注入的同型消息会被误判为新任务）。
- **上下文窗口硬截断（仅防溢出安全阀）**：独立于压缩域逻辑，平时 no-op；只做防溢出，
  不是压缩域标定（结论见上一条）。

## Architecture

- 平面分层：L0 确定性规则 → L1 结构（模型打辅助）→ L2 模型最小断面（`docs/01`）。
- 分划单位（正典 `docs/01 §3.5`）：task = 意图轴单位（围绕**同一个功能/模块/产物**的持续努力，**粒度锚功能点、不锚仓库**；**闭合 = 区间信息稳定点，边界压缩时机的根据**）；子task = 活动类型轴单位（构建/审查…，压缩分结构单位，无检测机制/无档案地位）；交换对 = 剪切层微削单位（连续同类交换构成 run）。判别器只守意图轴，剪切层只动交换对。
- 状态分层：会话（历史/工具结果）/ task（卷宗 vN、优化产物 vN）/ 项目（项目帧 vN、边界档案 vN）——单一事实源与版本协议在 `docs/09`。
- 可见性（docs/01 §4）：**无隐藏注入段**——可见层 = 优化后 prompt（用户预览确认）+ 用户指令原文（权威段）+ 剪除/压缩的结论落位物；插件内部标志（run 范围、行式裁决）**不进模型视野**（带外原则，docs/03 §3）。
- 工程结构：platform 适配 / core 纯核（零 harness import）/ domains 编排 / client 壳——模块树与搭建序 = `docs/11`。

## Conventions

- **确定性优先**（宪法 `docs/05`）：能观测的用日志（`tool/call`、`tool/result`、`user/message`），能计算的用规则，能查表的用版本号；模型只碰语义核心（选择/压缩/意图）。
- **字节稳定**：进入请求的每个字节必须可复现（同输入→同输出）；任何 LLM 产物的复用必须先版本化落盘。模板在前、实例参数在后。
- 进入模型的每一 token 都必须通过两道审查：① 它不是可确定计算的；② 缺了它模型会猜错。
- 优化产物 = **关键事实逐字保真 + 其余大胆重写**：路径/版本数值/引号内文本/约束与合规词句逐字保留；
  结构按"目标 → 交付物与验收 → 约束 → 执行路径"自然成文，禁止分节标签与元注释（"原样保留用户提示词"之类）。
- 执行路径钉"决策点"、软化"顺序"（条件化，如"若 A 不存在则走 B"），只引用本会话当前装配的工具集与已安装技能（引用守卫查表）。
- **失败默认保留**：剪除不成不动刀（判据不成立/解析失败/超时 → 不剪、不替换、不回填），失败方向永远朝用户数据安全侧。
- **相信用户决策**：Tier-0 一票算数；星标回填即终审；预览确认即生效；用户编辑即终稿。

## Workflow

- 新功能：先立度量（docs/07 字段能观测）→ 再看挂点（docs/10 事件流）→ 写逻辑 → 构建 → 账本快照（不做对照实验）。
- 每个模块的 TODO 必须引用对应 `docs/0X-*.md` 文件；模块注释按 `docs/05 §6` 合规自证模板（平面/回退链步数/审查清单/度量）。

## Don't

- 不要用 agent/skill 单独实现任何机制（回退链在 docs/05 §3）：先走"用户可控指令 → 代码分支 → 机械匹配 → 本地 embedding → 极小本地模型"。
- 不要做隐藏注入段；不要让插件内部标志进入模型视野（带外原则）。
- 不要让优化产物改写掉权威段；用户编辑即终稿，不要建学习存储揣度编辑意图。
- 不要让模型自造坐标、自报数字（选坐标不造坐标；热尾/装配零转写零算术）。
- 不要做中段独立剪除（断裂成本公式 docs/06 §2）；老调用对只许 T-boundary 搭车。
- 不要重复指令：同一规则只写在一个文档/文件里（本文件与 `docs/` 各司其职）。
