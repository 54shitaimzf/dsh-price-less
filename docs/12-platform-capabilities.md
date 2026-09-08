# 12 · 平台能力契约（harness 本地通道与降级）

> 域定义：**插件对 harness 原生能力的全部额外假设，登记于一处**——每条通道为什么必须存在、
> 以什么形态实现、官方未提供时如何降级、官方提供后如何原子删除。
> 状态：通道 2 条——C1 ignorable 写入（本地实现待上游合并；能力探测与降级已固化于
> `platform/ignorable-channel.ts`，D3 结构断言锁定单元边界）；C2 辅助调用 purpose
> 标记（插件侧类型适配，`platform/llm.ts` 单点收窄；P1.2 契约锚 + P5 调用面已施工）。

## 0. 它解决什么问题（人话版）

插件对宿主的每一分"额外假设"都是升级风险：假设散落在代码和文档各处，谁也说不清"我们到底
改了 harness 什么、不改会怎样、哪天能删"。本文把这类假设收进一份契约：**通道按条登记**
（需求来源 / 为什么只能修在宿主侧 / 实现形态 / 现状），**降级按表定义**（失效方向永远朝
用户数据安全侧），**删除按清单执行**（上游合并后一次原子提交，机制代码零改动）。
它同时回答两个问题：别人没打补丁的 harness 上插件会怎样？我们什么时候、删什么？

## 1. 通道清单

### C1 · ignorable 写入通道

**需求来源**：[09 §1](09-state.md) 会话事实轨要求 `context-economy/*` log-only 事件进会话
JSONL（账本可回放、KV 只是加速缓存）。插件事件类型按构造在 harness 生成词表
`KNOWN_SESSION_EVENT_TYPES` 之外，而读侧 fail-closed——未知类型且信封无 `ignorable: true`
则整条日志拒读（`session-persistence/src/storage-contract.ts:75`）。因此信封级标记是唯一兼容缝。

**为什么只能修在 harness 侧**（排除记录，防重走弯路）：`Session.append` 是唯一信封生产者
（`core/session/src/index.ts:699`），补丁前没有任何参数能写入该字段；绕过 append 直改日志
破坏 append-only 契约（[10 §1](10-wiring.md) 辨析②）；自挂持久化 backend 补盖会使盘上表示
与进程内读者分叉；借道已知事件类型污染语义；事件名注册制已被上游以"读侧组合依赖"为由否决
（`.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`）。
读侧、JSONL 持久化、wire 传输三侧本就支持该字段——缺的只有写入参数。

**实现形态**（上游社区共识，#5463/#5474 谱系）：非 surface 事件 opts 接受
`LogIntent { ignorable: true }`，且类型须声明合并进 `IgnorableSessionEventMap`（**append 侧
编译闸——该 map 只活在写入侧，读取永不查它**，不重新引入组合依赖）；运行期拒绝 surface 事件
携带标记、拒绝非 true 值；append 现场对未知无标记类型去重告警（loud-write）；拒读文案指向
仓外插件事件。读侧严格性保持原样。

**现状（诚实记录）**：本仓 harness checkout 已实现，并已在 **0.1.3-alpha.2** 上按社区形态重放
（分支 `feat/ignorable-logintent-alpha2`，commit `2fa55bc741`，base `82a5fd61a7` = tag
`dsh-v0.1.3-alpha.2`；原始系列 `04cba8f394` + `a3c0a8bc02` + `ea04b581a5` 基于 alpha.1，
随版本切换掉出装配栈后于 2026-09-08 重放）。验收：session 包 81 测试 + 持久化/工具目录
360 测试全绿，api-catalog / persistence-catalog 重生成校验过，插件侧 226 测试全绿。
上游 `origin/master` `c389f96bf3` 仍未开放写入参数（官方仅保留读侧字段，
`.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`）
——插件按 §2 探测自动适配；**宿主需重启**才加载重建后的 lib。

### C2 · 辅助调用 purpose 标记（插件侧类型适配，不修 harness）

**需求来源**：[10 §1 H12](10-wiring.md) 要求判别 / 断面 / 压缩 / init 辅助调用统一 purpose 标记，
度量按 purpose 分账（[07 §5](07-metrics.md)）。

**宿主现状（已核验）**：`packages/llm/llm/src/types.ts:442` 的 `GenerateOptions.purpose`
仅 `'compaction' | 'session-title'`，且 interface 属性**不能**经声明合并宽化（TS2717，
后声明属性类型必须一致）。`llm-deepseek` adapter 只对这两个值有特殊策略；未知 purpose
不会改变 wire 请求形状，只进入 `prepareExtensions` 的 request 事实。

**闭合形态（P1.2 锚 / P5 已施工；P13 增 `context-economy-init`）**：`platform/llm.ts` 定义 `CE_AUX_PURPOSES`（judge /
optimize / compaction / init 四值）与 `CeGenerateOptions = Omit<GenerateOptions,'purpose'> &
{ purpose?: CePurpose }`；`toHarnessGenerateOptions` 是**唯一 cast 收窄点**。P5 已施工：`streamCeLlm` 消费 `CeGenerateOptions`，usage 回执按调用侧 purpose 记账——不依赖 wire
回显。cast 单点由 D6 断言锁定（与 C1 的 D3 同构）。

**失效方向**：宿主不识别自定义 purpose 时行为 = 普通辅助调用（无特殊 header/thinking
策略），度量仍由插件本地记账；最坏损失是观测标签，不是用户数据。**不降级、不补丁、
不静默**——适配层常量即可观测。

**删除/演进清单**：上游宽化 `GenerateOptions.purpose` union 后，删 `platform/llm.ts`
本地宽化类型与 `toHarnessGenerateOptions`（保留 P5 调用/usage 面），跑 `npm run gate`。

## 2. 能力探测、耦合铁律与删除清单

- **探测**：只读、零副作用、进程级记忆一次——读补丁导出的**结构化运行时能力常量**
  `SESSION_LOG_INTENT = 1`（harness commit `ea04b581a5`）；vanilla 构建无此导出（读得
  `undefined`）。**不解析实现源码文本**：minify/混淆/改名安全，能力标记由补丁显式声明。
  测试可经 `ignorableChannelAvailable(api?)` 注入假能力源。**不经配置**：无开关、
  无设置面，删除时无残留。
- **耦合铁律（本契约的承重条）**：探测、发射路由、镜像降级**全部居于可删除单元
  `platform/ignorable-channel.ts` + `platform/logger.ts` 的 emitCeFact 发射路径**（后者上游合并后
  仅一行改直连）；机制代码（core/domains，P9+ 起的发射方）只经 `emitCeFact` 端口发射，**对模式
  零感知**——端口签名在通道存在与否两种世界里完全一致。D3 结构断言锁定单元边界：概念 token
  越出两个单元文件即红。诊断落盘 sink（`platform/diag-sink.ts`，[11 §4](11-structure.md) 纪律③）
  不属于本单元、亦不引用单元内任何符号——两单元可独立整删。
- **降级模式**：通道缺失 → 事实写入 KV 镜像（P3 事实镜像表接线前 = blocked：warn + 计数）；
  镜像写入失败 → blocked。一切失败 warn + 计数，**绝不外溢、绝不静默**（[11 §4](11-structure.md) 纪律③）。
- **删除清单（上游合并发版后，一次原子提交完成）**：
  ① 删 `src/platform/ignorable-channel.ts`；
  ② `logger.ts` 的 `emitCeFact` 改回直连 `session.append(type, data, { ignorable: true })`（一行）；
  ③ 删 P3 事实镜像表接线（表体可留作审计或一并删）；
  ④ 删 D3 断言规则条目（含零位快照同步）；
  ⑤ 跑 `npm run gate` + harness-session 回环确认。
  机制代码零改动——这就是解耦的机械证明。
- **升级自检**：checkout 升级后跑 `npm test` 即可——`tests/harness-session.spec.ts` 的回环
  用例（emitCeFact → append → 信封 ignorable → validateStoredEvents 放行）就是通道测试本身。
  红 = 通道缺失 = 自动进入 §3 降级（行为仍正确，仅事实轨镜像化），按需重新应用补丁或等上游。

## 3. 降级语义（通道缺失时）

| 事实项 | 降级形态 | 失效方向 |
|---|---|---|
| `judge-*` / `task-boundary`（段状态机日志真源） | KV 事实镜像 + 段状态机 KV 双源（P8）；KV 损毁 → 当作新 task 重新分段（[09 §4](09-state.md) 原生失效语义） | 安全——判别冷启动重新积累，不丢用户数据 |
| `optimize-run` / `shear-applied` / `pressure-fired` / `restore/*`（运行账） | KV 事实镜像；KV 损毁 → 该族账目变暗（不可重算） | 观测层 |
| **主上下文管理（剪切/压缩/优化回填）** | **零影响**——行为全部走 harness 词表内原生事件（surfaceOp replace / compaction/*），会话恢复的原生 fold 重演与通道无关 | 无 |

- **缓解设计**（各工单编写时展开）：P2 账本 fold 的**事实源抽象**（`facts = 会话 ignorable
  事件 ∨ KV 事实镜像`——同一 fold、同输入同账，[07 §5](07-metrics.md)）；P3 事实镜像表；
  降级可见化（warn + stats，绝不静默）。
- **净效果**：账本受损仅出现于「无通道 ∧ KV 损毁」**双重故障**同时发生，后果是重新积累而非
  数据损坏；随上游合并自动消失。

## 4. 验收标准

- [ ] D3 断言进 `npm run assert`：通道概念 token 出现在单元文件之外即红（含正/负样本用例）；
- [ ] 探测双侧测试：patched-sim → emitted（append 携带 `{ignorable:true}`）；vanilla-sim →
       blocked，注册镜像后 → mirrored；
- [ ] 回环 spec 常绿 = 升级自检（§2）；
- [ ] core/domains 零通道概念引用（D3 的反向即本条，新增发射方工单验收时 grep 复核）；
- [ ] C2：`toHarnessGenerateOptions` 是 `as GenerateOptions` 唯一 cast 点（grep 断言），
      `CeGenerateOptions` 可携带四值自定义 purpose（`npm run typecheck:tests`）；`streamCeLlm` 落位，D6 锁定 cast 单点；
- [ ] 删除演练：按 §2 清单在分支执行删除 → `npm run gate` 全绿且机制文件 diff 为空。
