# P14c 判别链瘦身 + ★ 断面修复（映射 R2 修正；依赖 P14b2；尺寸 M）

> 状态：**已施工**。前序：P14a/P14b1/P14b2 已施工；真机反馈两处问题（★ 点空转仍花钱、机械层形同虚设）。
> 设计正典：[02 §3/§4](../02-discriminator.md)（决策链 / 手动断面门控）/ [11 §2](../11-structure.md)（模块树）/
> [07 §0.5](../07-metrics.md)（判别族与断面族度量）/ [13 §3.10–3.11](../13-harness-plugin-spec.md)（client 桥 / Connection RPC）。

## §0 触发与实测依据

真机现象：重启后点 ★，两次预览都返回原文、`productChars: 0`，但各消耗一次完整 LLM 调用
（input 344/352、output 919/3073 token）。根因链：`discriminator.auto=false` → 卷宗零写入 →
`isDossierShort` 恒真 → 产品层被跳过。**机械层与 ★ 同时失效。**

先量化再决策（数据源：159 条历史用户消息 / 41 会话 + 356 条真实判别记录 `judge-records.jsonl`）：

| 层 | 实测命中率 | 结论 |
|---|---|---|
| L0 延续词表（整句 = 延续词） | **0.6–1.9%** | 省不下调用 → **删** |
| L1 精确缓存（键含 seq） | 跨消息 0%（仅防重复投递） | 降级为幂等护栏，不再计成本级 |
| 对表·旧宽松（关键词 OR 签名） | 9.0%，精确率 **93.8%**（2 条 new-task 被误判延续） | 无声错误 → 改保守 |
| 对表·新保守打分 | **7.9%**，精确率 **96.4%**（1 条误判） | 保留 |

历史旁证：[ledger-history §17](../ledger-history.md) Phase A 实测 L0-continue 拦截率 1.2%，当时结论是
"保留为极窄免费通道"；本次以"省不下调用即负资产"为准绳推翻该保留决定。

## §1 决策一：删除 L0 延续词表

- `core/judge.ts` 删除 `L0_CONTINUE_WORDS` / `matchL0Continue` / `stripL0Text`；极短判据
  （`TRIVIAL_MESSAGE_MAX_CHARS` / `normalizeMessageText` / `isTrivialMessage`）落在 `core/dossier.ts`。
- `domains/input.ts` 决策链改为 **T0 → L1（重复投递护栏）→ 对表 → LLM → fail-lazy**。
- **账本兼容**：`JudgeTrigger` 保留 `l0-continue`、`JudgeLedger.l0CaptureRate` 保留（历史事实仍可 fold；
  ledger-history 只增不改）；新事实不再产生该 trigger。
- 删除代价：1.9% 的消息改走 LLM（实测单次判别 $0.00023，即每千条多花约 $0.004）。

## §2 决策二：对表层保守打分

`matchJudgeTable` 由"关键词 OR 签名即命中"改为打分制：

| 特征 | 分值 |
|---|---|
| 文件签名命中（≥2 字符） | 2 |
| **具体**关键词（≥4 字符，或 ≥3 字符的标识符——含数字/分隔符，如 `p14b` / `star.ts`） | 2 |
| **泛**关键词（2–3 字符中文词，如"插件""优化"） | 1 |
| **命中门槛** | **≥ 2** |

语义：一条路径或一个具体词足以短路；两条泛词共现也可；**单条泛词一律出表走 LLM**。
方向性理由：机械误判"延续"是无声错误（边界漏切且无复核），多问一次模型只是多花一次钱。
常量：`JUDGE_TABLE_HIT_SCORE` / `_SIGNATURE_SCORE` / `_SPECIFIC_KEYWORD_SCORE` / `_GENERIC_KEYWORD_SCORE` / `_MIN_KEYWORD_CHARS`。

## §3 决策三：★ 唯一门控 = 本次提示词极短

- 删除产品层的短卷宗门控（`OPTIMIZE_GATE_DEFAULTS` / `isDossierShort` 不再参与 ★；函数保留供统计）。
- 新门控 `isTrivialOptimizePrompt` = `isTrivialMessage`：去标点空白后 < 4 字符 → **零调用短路**
  （不调 LLM、不计数、不发事实、不写盘；host 返回 `CE_STAR_BAD_REQUEST`）。
- client 同口径镜像（`client/star/star-model.ts: TRIVIAL_PROMPT_MAX_CHARS`）用于**按钮禁用 + tooltip 说明原因**；
  两侧常量由 `tests/star-transport.spec.ts` 断言不漂移。
- 输入预算钳制改为始终生效（不再因"短卷宗"跳过）；输出段契约恒为严格两段。

## §4 决策四：★ 上下文改从会话事件读（与 auto 开关解耦）

- 新增 `platform/events.ts: readSessionUserMessages(session)`：按输入面五条件扫描 `snapshotEvents()`，
  返回会话内真实用户消息（seq/time/text）。
- `domains/star.ts` 组装上下文 = 会话事件 ∩ 当前 task 段（`segment.startSeq`）− 极短消息；
  KV 卷宗只提供既有**标注**，不再充当消息来源。挂载/重启/auto 关闭都不再丢历史。
- DTO 修订：`short: boolean` → `historyCount: number`（两侧 + 校验器 + 测试同步；端点与错误码不变）。
- 预览弹层：`historyCount === 0` 时提示"无历史素材：仅基于当前提示词与项目帧优化"。
- 事实载荷：保留 `short`（语义修订为"无历史素材"）并新增可选 `historyCount`（旧账本可 fold）。

## §5 交付物

| 文件 | 改动 |
|---|---|
| `src/core/judge.ts` | 删 L0；打分制 `matchJudgeTable` + `judgeKeywordScore` |
| `src/core/dossier.ts` | 极短判据（`normalizeMessageText` / `isTrivialMessage` / 常量） |
| `src/core/optimize.ts` | 去短卷宗门控；`historyCount`；`isTrivialOptimizePrompt`；预算钳制恒开 |
| `src/platform/events.ts` | `readSessionUserMessages` |
| `src/domains/input.ts` | 决策链瘦身；L1 语义注释 |
| `src/domains/star.ts` | 极短短路；会话事件组装；DTO/事实字段 |
| `src/domains/optimize-facts.ts` | `historyCount?` |
| `client/star/*` | 四角星勾线图标；禁用判据 + tooltip/aria；DTO 字段；`STAR_NO_CONTEXT_NOTICE` |
| `scripts/verify-p14c.mjs` | 历史回放验收（新增） |

## §6 验收

```
npm run gate                  # typecheck + typecheck:client + test + assert（251 用例）
npm run typecheck:tests
npm run build                 # host + client
node scripts/verify-p14c.mjs  # 末行 P14C VERIFY PASS
```

`verify-p14c.mjs` 用真实历史量四件事：① 极短过滤率（2.5%）；② 删 L0 的反事实代价（1.9%）；
③ 对表保守打分安全性（对 354 条真实 verdict 回放：命中 7.9%、误判 new-task 1 条、精确率 96.4%）；
④ ★ 上下文可得性（当前会话 19 条真实用户消息，旧实现恒为 0）。

## §7 风险与回退

- **风险**：4 字符阈值会禁用"提交/落盘"这类 2 字指令的 ★。放宽需同时改 `TRIVIAL_MESSAGE_MAX_CHARS`
  （host）与 `TRIVIAL_PROMPT_MAX_CHARS`（client），漂移断言会拦住只改一侧。
- **风险**：对表在真实表下命中率可能仍偏低。**够格线**：真机运行后若 `tableHitRate` < 5%，
  连对表层一起删（届时决策链 = T0 → LLM → fail-lazy）。
- **回退**：回退 = revert 本提交；账本事实向后兼容（旧事实照常 fold）。

## §8 后续对接

- **P15a 剪切域**：本单不涉及剪切；`optimize_artifact.shear` 仍是剪切清单来源。
- **R2 出门验收**：人工项改为"首次点击即产出产品"（不再是"点空转"）。
- **docs/07 度量**：`l0CaptureRate` 标注为历史口径；新增 `historyCount` 可观测。
