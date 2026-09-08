# N2 · 结论契约与协商模板 v2

> **状态**：**已施工**（2026-09-09；模板按 §4 草案落地，事实类上限由探针标定，见 §10）。
> **依赖**：N1 ✅（[`N1-identity-and-eligible.md`](N1-identity-and-eligible.md) §9 探针）。**总纲**：[`00-master.md`](00-master.md) §2/§3/§6。
> **正典**：[`docs/03 §2.1`](../03-shear.md)（T-note 协商语义）· [`docs/06 §2`](../06-cache.md)（断裂成本）· [`docs/05 §1`](../05-constitution.md)（字节稳定）。

## §1 目标

把"剪除后到底保留什么"从一句结论升级为**可解析、可校验、字节稳定**的三件套契约：

1. **结论**：一句话说清"用完了什么、得到什么"；
2. **关键事实逐字**：后续会用到的路径 / 数值 / 版本 / 引号内文字，逐字保留；
3. **重取句柄**：需要原文时如何再拿到（命令 / 文件+窗口 / 调用摘要）。

本单**只产出纯核与模板**，不挂注记（挂注记 = N3），不动刀（动刀 = N4）。

## §2 输入（N1 实测约束）

N1 探针（44 会话 / ≥2KB 2,160 条）给 N2 定下三条硬约束：

| 事实 | 对 N2 的要求 |
|---|---|
| cuttable 的 basis = `name` 402（64.3%）+ `command` 223（35.7%），`signature` **0** | 契约必须同时覆盖 **程序化结论**（run_code）与 **终端判定输出**（bash/pwsh），不能只按文件类设计 |
| never 判据 top：corpus 553 / truncated 374 / error-output 339 | 契约**不必**承载代码全文 / 被截断内容 / 错误诊断（这些已在 N1 被否决） |
| `signature` 可剪 = 0 | 契约的**校验强度**决定 N4 能否把 `command`/`name` 升上来 → 事实保真是唯一杠杆 |

## §3 交付物

1. **纯核契约**（`src/core/shear/conclusion.ts`）：

   ```ts
   export const SHEAR_CONCLUSION_VERSION = 2
   export const SHEAR_CONCLUSION_TEMPLATE: string          // 字节稳定、零动态拼接
   export function negotiationNote(): string               // = SHEAR_CONCLUSION_TEMPLATE

   export interface ParsedConclusion {
     readonly marker: 'ok' | 'hold' | 'none'
     readonly conclusion?: string
     readonly facts: readonly string[]
     readonly handle?: string
     readonly complete: boolean                            // 三件套齐全
     readonly raw?: string                                 // 命中行原文（账本）
   }
   export function parseConclusion(replyText: string): ParsedConclusion

   export function extractKeyFacts(text: string): readonly string[]
   export function verifyConclusion(original: string, parsed: ParsedConclusion):
     { readonly ok: boolean; readonly missing: readonly string[] }
   ```

2. **单测**（`tests/shear-conclusion.spec.ts`）：解析容错 / 三件套缺件 / 事实抽取 / 保真校验 / 字节稳定。

3. **保留 v1**：`types.ts` 的 `SHEAR_NOTE_TEMPLATE`（v1）**常量不动**（历史回放用）；v2 是新协商唯一模板，N3 起由分类器命中项使用。

## §4 模板 v2（草案，待用户拍板）

**唯一模板常量**（模板在前、零实例参数；中性叙述、无插件标签——带外原则）：

```
（本结果较长。若你已从中得出结论，请在本次回复最后一行给出：
CUT-OK: 结论〈一句话〉｜事实〈路径/数值/版本/引号内文字，逐字，分号分隔〉｜重取〈再拿到原文的最小句柄〉
若后续仍需原文，请改为输出 CUT-HOLD:〈原因〉。不要为此额外调用工具。）
```

**设计要点**：

- **单行三件套**：用 `｜` 分隔，模型可一次写完；解析器只认**最后一条非空行**（前文可正常回答任务）。
- **重取句柄由模型写**：终端类 = 原命令；`run_code` = `description` 或首行摘要；文件类 = `path#Lx-Ly`（文件类在 N1 已是 never，句柄只为兜底）。
- **零机制标签**：不出现"缓存""剪除""插件"等词，只描述模型能理解的动作（"原始日志将被剪除、只保留你给出的结论"是必要告知，保留）。
- **失败方向**：无标记 / 解析失败 / 三件套不全 → 一律按 `hold` 处理（保留原文）。

## §5 解析规则（纯核，确定性）

| 步 | 规则 |
|---|---|
| 1 | 取 `replyText` 的最后一条**非空行**（`\n` 切分后从尾扫描） |
| 2 | 去首尾空白与前导 `-*`；标记匹配 `/^CUT-(OK|HOLD)\s*[:：]/i` |
| 3 | `CUT-HOLD` → `marker:'hold'`；`CUT-OK` → 按 `｜` / `\|` 切三段 |
| 4 | 段内识别前缀 `结论` / `事实` / `重取`（可缺省）；`事实` 按 `；` / `;` 切数组 |
| 5 | 无标记 → `marker:'none'`（等价 hold）；`结论` 缺 → `complete:false` |

**禁**：正则回溯灾难（模板短、行短，逐段 `split` 即可）；不解析前文；不做语义判断。

## §6 事实保真（`extractKeyFacts` / `verifyConclusion`）

**抽取**（纯正则，去重保序，**类上限** + 总上限 **12** 条；优先级 = 带单位数值 → 版本 → 校验值引号 → 路径）：

| 类别 | 模式 | 类上限 |
|---|---|---|
| 带单位数值 | `\b\d+(?:\.\d+)?\s*(?:ms|s|KB|MB|GB|tests?|files?|lines?|tokens?|%)\b` | 6 |
| 版本 | `\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b` | 2 |
| 校验值引号 | 引号内**纯十六进制哈希** / **全大写判定词**（短字面量与人类句子丢弃） | 2 |
| 路径 | `[A-Za-z0-9_./\\-]+\.(ts|tsx|js|mjs|cjs|json|md|sh|yml|yaml|py|css|html|toml)` | 4 |

> **实测修正（§10 探针）**：初版"路径优先 + 引号全收"在真实候选上首 12 条被 `quoted 5147 / path 1358` 淹没，
> **87.8% 候选顶到 12 条上限**。改为类上限后：0 条 12.3% / 1–3 条 17.4% / **4–6 条 56.6%** /
> 7–11 条 12.5% / 12 条 1.1%——**中位数 ≈ 4 条**，校验可行。

**校验**：`extractKeyFacts(original)` 的每一条都必须出现在 `parsed` 的**结论 + 事实 + 重取**全文里
（路径/版本大小写不敏感、空白折叠）；缺一条 → `ok:false` + `missing` 列表 → **N3 记 hold，N4 不剪**。

**已知保守面**（如实申报）：上限 12 条是启发式；原文关键事实超过 12 条时只校验前 12 条；模型换词重述
（如把 `552 tests` 写成"全部通过"）会被判缺 → 偏 hold（失败方向正确，代价是少剪）。

## §7 验收

- `npm run gate` 绿 + `npm run typecheck:tests` 绿。
- 结构断言：`core/shear/conclusion.ts` 零 harness/platform import（S1 覆盖）+ 零时钟/随机（D10 覆盖）。
- 单测：模板字节稳定（两次调用逐字节相等、含版本号断言）；`CUT-OK` 三件套齐全 / 缺件 / 全角冒号 / 前导 `-` / 非末行命中；
  `CUT-HOLD` / 无标记 / 空回复；事实抽取四类各 ≥1 例；保真校验缺一即 false；上限 12 条生效。
- **不挂注记、不改史**：本单零行为变更（纯核 + 常量）。

## §8 尺寸预算

**S–M**：`core/shear/conclusion.ts` ~180 行 + `tests/shear-conclusion.spec.ts` ~150 行 + `types.ts` 常量引用（不改 v1）。

## §9 与旧设计的关系 / 待拍板

| # | 事项 | 现状 |
|---|---|---|
| 1 | **模板措辞**（§4 草案） | **已按草案落地**（用户"继续将 N2 落地"即拍板）；若影子期配合率过低，优先改通道而非改措辞 |
| 2 | v1 `SHEAR_NOTE_TEMPLATE` | 保留常量（历史回放）；N3 起新协商只用 v2 |
| 3 | 事实类上限（6/2/2/4） | **已由 §10 探针标定**（中位数 4 条）；若影子期 hold 率过高，再降 |
| 4 | `complete` 的用途 | N3 只记账（`complete:false` 记 hold）；N4 要求 `complete && verify.ok` |

**下一步**：N3 影子模式（挂 v2 注记 + 解析 + 只记账不剪）；**通道激活是 N3 的前置**，见 §10。

## §10 施工记录与探针报告（2026-09-09）

**交付**：`src/core/shear/conclusion.ts`（模板 v2 + 解析 + 事实抽取 + 保真校验 + `judgeConclusion`）·
`src/core/shear/index.ts`（导出 classify/conclusion）· `tests/shear-conclusion.spec.ts`（15 用例）·
`scripts/probe-n2.mjs`（只读探针）。

**验收**：`npm run gate` 绿（**583 用例 / 55 文件**）· `npm run typecheck:tests` 绿 · build 绿 ·
D1–D17 + M/S 全 PASS · 探针零写零网络。

**探针读数**（44 会话 / 可剪候选 **625 条**，平均 **7,102 B/条**）：

| 项 | 数值 |
|---|---|
| 事实条数（类上限后） | 0 条 **12.3%** / 1–3 条 17.4% / **4–6 条 56.6%** / 7–11 条 12.5% / 12 条 1.1% |
| 首 12 条类别构成（类上限前） | quoted 5,147 / path 1,358 / version 364 / number 220 |
| **注记后紧跟的回复** | **134 条 → 给出标记 0 条（0.0%）** |
| 历史 assistant 回复 | 4,974 条，含标记 1 条（且不在末行） |
| 配对保真 | 1 对，三件套齐全 0，保真通过 0 |

**关键结论（决定 N3 走向）**：

1. **事实类上限是必须的**：构建/测试日志里路径与短引号字面量极多，不设类上限则 87.8% 候选顶满 12 条，
   校验不可行；类上限后中位数降到 **4 条**，校验可行（§6 已按此修正）。
2. **`number` 事实只覆盖 26% 候选**（74% 候选 0 个带单位数值）——因为可剪候选里 `run_code` 占 64%，
   其输出是路径/文本而非测试计数；**结论契约不能只靠数字，路径必须保留 4 条**。
3. **⚠ 通道是死的：134 次注记后的回复，0 次配合（0.0%）**。原因明确——注记贴在**工具结果内容**里，
   而 DSH 系统提示把工具输出里的指令标记为**不可信**（"untrusted plugin output"，明确要求忽略）。
   历史 4,974 条回复里只有 1 条带标记，也印证这一点。
   → **N3 的第一交付物不是影子模式，而是"通道激活"**：必须先让消费模型愿意回应协商注记，
   否则影子模式收不到任何样本。方案见 [`N3-shadow-mode.md`](N3-shadow-mode.md) §2。
