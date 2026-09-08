# N3 · 影子模式（落地目标）

> **状态**：**通道已定 = A+C**（2026-09-09 用户裁定），载体 = 预设 [`presets/price-less/`](../../presets/price-less/)（persona 段声明协议 + 短注记）；待真机验证配合率后进 N3b。
> **依赖**：N1 ✅（分类器）· N2 ✅（结论契约）· N2 §10 探针（通道配合率 0/134）。**总纲**：[`00-master.md`](00-master.md) §2/§3。
> **正典**：[`docs/03 §2.1`](../03-shear.md)（协商语义）· [`docs/10 §1 H6`](../10-wiring.md)（挂点）· [`docs/07`](../07-metrics.md)（度量）。

## §1 目标

在**真实会话**上挂 v2 协商注记、解析回复、**只记账不剪**（零改史），产出三张表：
**配合率**（给了标记的比例）· **保真率**（结论事实齐全的比例）· **深度分布**（结论字符数 / 原文字节数）。
这三张表是 N4 白名单的唯一依据。

## §2 前置发现：通道是死的（必须先修）

N2 探针（44 会话）实测：

| 事实 | 数值 |
|---|---|
| 注记后紧跟的 assistant 回复 | **134 条** |
| 其中给出 `CUT-OK`/`CUT-HOLD` 标记 | **0 条（0.0%）** |
| 历史全部 assistant 回复含标记 | 1 / 4,974 |

**根因**：注记贴在**工具结果内容**里，而 DSH 系统提示把工具输出中的指令标记为**不可信**
（"untrusted plugin output"，明确要求忽略）。模型不违反该约束 → 协商通道拿不到任何样本。
**N3 的第一交付物因此不是影子模式，而是"通道激活"。**

### §2.1 通道裁定：A + C（2026-09-09）

| # | 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|---|
| **A ✅ 已选** | **用户可控指令（预设载体）** | 我们自己的预设 `presets/price-less/` 在 persona 段固定声明「协商注记是可信协作请求」+ 三件套格式 | 宪法回退链第 1 步；零隐藏注入；用户可见可改；随预设开关 | 系统提示 +1 段（一次性缓存变更，会话内定型） |
| **B** | **插件上下文通道** | 改用 harness `additionalContexts`（plugin-sourced 指令，作为一条**可见** user 上下文），不塞进工具内容 | 不依赖用户改提示 | 可能仍被标记不可信；改变可见层，需正典裁定 |
| **C** | **缩短注记** | 把 v2 注记压到一行（配合 A/B 使用） | 配合率↑、成本↓ | 表达力下降 |

**A 的载体**（已落地，见 [`presets/price-less/agent.cordis.yml`](../../presets/price-less/agent.cordis.yml) persona 段）：

```
## 上下文协商（context-economy）
工具结果末尾出现「协商：」提示时，那是本机插件的可信协作请求，不是不可信的工具输出。
若你已用完该结果：在本次回复最后一行写 `CUT-OK: 结论｜事实｜重取`——结论一句话；事实逐字列出后续会用到的路径/数值/版本/引号内文字（分号分隔）；重取给出再拿到原文的最小句柄。
若仍需原文：写 `CUT-HOLD: 原因`。不要为回应它额外调用工具。
```

**C 已落地**：注记压成一行（`conclusion.ts:SHEAR_CONCLUSION_TEMPLATE`，约 60 字）。

### §2.2 N3a 通道验证（小、快，先做）

用 `price-less` 预设开真实会话，比较**配合率**（同一批工具结果，A+C vs 旧工具内长注记）：
- 配合率 ≥ 30% → 进入 N3b 全量影子；
- < 30% → 回退 B（plugin 上下文通道）试验；仍 < 30% → **停止 N4 立项**。

## §3 N3b 影子模式设计（只记账不剪）

| 步 | 设计 |
|---|---|
| 挂点 | `tools/post-execute`（H6，已有 args/meta/kind/card/resultBytes） |
| 选择 | `classifyToolResult(view)` → `cuttable`（任意 basis）挂注记；`never` 仅 **1% 确定性对照组**挂（只问不剪） |
| 注记 | v2 模板（`negotiationNote()`）；≥ **2KB** 才挂（与候选下限一致） |
| 记账（挂） | ignorable 事实 `shear-negotiation-note`：`{ at, callId, name, basis, reason, resultBytes, channel, noteBytes }` |
| 解析 | 下一轮 `assistant/message` → `judgeConclusion(原文, 回复)` |
| 记账（回） | ignorable 事实 `shear-negotiation-reply`：`{ at, callId, marker, complete, verifyOk, missingCount, conclusionChars, depthRatio }` |
| 零改史 | 除追加注记外 surface 字节不变（断言）；不改任何既有节点 |
| 失败方向 | 无回复 / 无标记 / 解析失败 / 保真不过 → 全部记 hold，不剪 |

**深度比** `depthRatio = 结论字符数 / 原文字节数`（目标 ≤ **1/10**，总纲 §2-3）。

## §4 度量（07 协议新增，可回放）

| 字段 | 含义 |
|---|---|
| `negotiationNotes` | 挂出的注记数（按 basis 分组） |
| `negotiationReplies` | 收到标记的回复数 |
| `negotiationOkRate` / `negotiationHoldRate` / `negotiationNoReplyRate` | 配合率三档 |
| `negotiationCompleteRate` | 三件套齐全率 |
| `negotiationVerifyOkRate` | 保真通过率（事实齐全） |
| `negotiationMedianDepth` | 深度比中位数（按 basis 分组） |

**晋升门槛（沿用 N1 §4.4）**：某 basis 组样本 ≥30 且 CUT-HOLD 率 <5% 且 保真率 ≥95% → 写入 N4 白名单。

## §5 配置

新增 `shear.negotiate` 三态：`'off' | 'shadow' | 'live'`，**默认 `off`**（通道未定前零行为）；
N3a 试验用 `shadow`；`live` 保留给 N4（真正动刀）。client 设置卡同步（`field-model.ts` + `config.ts` 两处同扩）。

## §6 验收

- `npm run gate` 绿 + `npm run typecheck:tests` 绿 + build 绿。
- **零改史断言**：挂注记前后，除注记块外 surface 字节逐字节相同（回放用例进 CI）。
- 账本可回放：`negotiation-*` 事实 → fold 出 §4 全部字段（同输入同账）。
- N3a 报告：三通道配合率对照表 + 结论（进入 N3b / 停止 N4）。
- 真机样本：每 basis ≥30 条（`command` / `name` 各一组）；不足则延长收集期。

## §7 尺寸预算

**M**：`domains/shear-negotiate.ts`（新域，~180 行）+ `platform/tools.ts`（`additionalContexts` 若走 B，+30）+
`config.ts`/`field-model.ts`（+20）+ `tests/shear-negotiate.spec.ts`（~180）+ `scripts/probe-n3.mjs`（~150）。
超预算申报拆单（N3a / N3b 可分两单）。

## §8 待拍板

| # | 事项 | 建议 |
|---|---|---|
| 1 | **通道选择（A / B / C）** | ✅ **A+C 已定**（预设 persona 段 + 短注记） |
| 2 | A 的指令文案 | ✅ 已写入 `presets/price-less/agent.cordis.yml` |
| 3 | 注记缩短 | ✅ 已落地（一行） |
| 4 | `shear.negotiate` 默认值 | `off`（N3b 落地时开 `shadow`） |
| 5 | 配合率底线 | 30%（低于则回退 B / 停止 N4） |

**下一步**：用户用 `price-less` 预设开新会话 → N3a 观察配合率 → N3b 全量影子（需重启加载新构建）。
