# Eval Ground 使用说明

真实·封闭·可一键评测的任务场地：插件发布审计器 relaudit（fixture）+ 8 个固定任务 +
机械/代码主观（盲评）双轨评分（人工轨已退役）+ 反作弊。

## 目录

```
fixtures/relaudit/    只读模板（样例插件包 + 审计规则 + 前端面板 + 全量 spec 测试）
answers/              黄金钥匙（golden-bugs.json / golden-fix.mjs / golden-docs/）——模型不可达
tasks/                8 个固定任务（提示词 + 机械断言 + rubric 等级锚点）
lib/                  评测驱动（workspace/tools/runner/gateway/mech/judge/score/report/human-packet）
runs/<runId>/         每次运行：workspace + transcript.jsonl + scorecard.json + human-sheet.csv
scripts/make-tgz.mjs  样例产物 tarball 生成器（确定性）
```

## 命令

```bash
npm run ground:reset        # 一键重置：清空 runs/ + 删临时 + 重建 tgz + 三态验证（跑完即干净基线）
npm run ground:check        # 三态验证（黄金/空白/作弊）+ 稳定性 —— ALL PASS 为绿的基线
npm run ground:assert       # 474 项离线断言：工具守卫 / run 白名单 / judge 双形态解析 / REVIEW 匹配 / 打分 / 压缩 / 臂表 / 评审 / 封闭世界 / diff
npm run ground:verify       # 工具链快速验证（scripted，零 API）
node lib/staticify.mjs <workspace> <out.html>   # 把面板页面打包成自包含静态 HTML（无 server 直开）
node scripts/probe-cache.mjs            # 网关前缀缓存探测（V1 前置 ≈$0.01，批 0/批 1 前跑）
node bin/run-one.mjs --task=T4            # 单任务跑一次（真实 API，静默后台）
node bin/run-one.mjs --task=T4 --model=mimo-v2.5   # 指定执行模型（最便宜档 mimo-v2.5）
node bin/run-all.mjs --tasks=T1,T4 --reps=2 --arms=native-auto,self-s2-orig   # 臂矩阵 + Δ 汇总（可选 --budget=USD 硬上限）
node bin/rejudge.mjs --run=runs/<runId>   # 仅重跑 judge（judge 提示词/解析器改动后不回滚 executor）
npm run batch-report                # 批次报告：任务×臂表 + 三账本成本 + 预注册假设对照
（人工评审已退役：human:review/评审单仅作 legacy 存档工具，不再参与评分）
```

## 评分

- 机械分：干净模板测试重跑 × 验收断言 × 允许范围（零 LLM；不采信模型自报）；review 型任务的 `report-match` 为**连续覆盖分**，非"达标即满分"
- 代码主观：glm-5.3-flash 盲评（judge 经一致性验证后维持 GLM；执行者当前批次 hy3），5 级锚点，多采样取中位，维度 = 每任务 rubric 定权；review 型含 `grounded`「证据落地」＋ golden 缺陷参照注入
- 主观评判（`lib/subjective.mjs`）：资深 reviewer 盲评 overallQuality/wouldShip/overReport/realExtras，**不入总分**；`score.assemble` 的 `beyondGolden` 奖励真实超额发现，**总分可超过 100**
- **人工轨迹已退役**（2026 审批）：human 权重并入 judge（track.human=0）；`human:review`/评审单保留为 legacy 存档工具
- 反作弊：路径守卫 + 命令白名单 + tests/package.json 篡改检测 + 干净重跑 + data 伪造检测
  + judge 必答 antiCheat 维度；测试读取 = 合规（提示词明示）
- 结论只做相对：执行者/judge 各自固定（执行者默认 hy3，judge 默认 glm-5.3-flash；可 --model= 换；同批次固定不换）、同提示词、臂间 Δ，无绝对宣言

## 校准（历史批次：deepseek 执行 + glm-5.3-flash judge；现在批次执行者换 hy3、judge 维持 glm-5.3-flash，非同一口径）

| run | task | mech | judge | total | 成本(USD) | 备注 |
|---|---|---|---|---|---|---|
| T0-ground-mtgqz6m3 | 只读 | 100 | — | 100 | 0.004 | 纪律否决通过 |
| T1-ground-mtgr0565 | 审查 | 100 | 100 | 90 | 0.056 | 9/9 命中 0 误报；glm-5.3-flash×3 重评 |
| T2-ground-mtgr8lxz | 文档 | 100 | 100 | 80 | 0.053 | glm-5.3-flash×3 重评 |
| T3-ground-mtgrq0q9 | 前端 | 75 | 73 | 52 | 0.012 | 漏做 sev-filter（copyFixSnippet 已做）；rubric 已含 codeQuality/architecture |
| T4-ground-mtgrsukx | 后端 | 100 | 89 | 96 | 0.020 | glm-5.3-flash×3 中位（correctness4/integration5/codeQuality4/architecture5/scope5） |
| T5-ground-mtgrwkpj | 文案 | 100 | 82 | 56 | 0.004 | 注意"2026-13-05"伪造日期扣到 accuracy 3 |
| T6-ground-mtgrzfev | 手册 | 100 | 84 | 76 | 0.011 | 步骤2预期输出与预置失败测试矛盾 |
| T7-ground-mtgs4wld | 长链路 | 100 | 97 | 94 | 0.332 | 三阶段 65 全绿；glm-5.3-flash×3 中位（finalState5/codeQuality5/architecture4/process5/scope5） |

| run | task | mech | judge | total | 成本(USD) | 备注 |
|---|---|---|---|---|---|---|
| T0-ground-mtgqz6m3 | 只读 | 100 | — | 100 | 0.004 | 纪律否决通过 |
| T1-ground-mtgr0565 | 审查 | 100 | 100 | 90 | 0.056 | 9/9 命中 0 误报；glm-5.3-flash×3 重评 |
| T2-ground-mtgr8lxz | 文档 | 100 | 100 | 80 | 0.053 | glm-5.3-flash×3 重评 |
| T3-ground-mtgrq0q9 | 前端 | 75 | 73 | 52 | 0.012 | 漏做 sev-filter（copyFixSnippet 已做）；rubric 已含 codeQuality/architecture |
| T4-ground-mtgrsukx | 后端 | 100 | 89 | 96 | 0.020 | glm-5.3-flash×3 中位（correctness4/integration5/codeQuality4/architecture5/scope5） |
| T5-ground-mtgrwkpj | 文案 | 100 | 82 | 56 | 0.004 | 注意"2026-13-05"伪造日期扣到 accuracy 3 |
| T6-ground-mtgrzfev | 手册 | 100 | 84 | 76 | 0.011 | 步骤2预期输出与预置失败测试矛盾 |
| T7-ground-mtgs4wld | 长链路 | 100 | 97 | 94 | 0.332 | 三阶段 65 全绿；glm-5.3-flash×3 中位（finalState5/codeQuality5/architecture4/process5/scope5） |

合计 8 任务 ≈ $0.49（T7 占 2/3——54 步 × 232 万输入 token，无界历史成本被量化，E1/E2 的靶心）。
6 个人类维度待评：`npm run human:review`（存档在 `human-sheets/`，`npm run human:sheets` 重新生成）。

协议要点：网关 opencode zen 同源（执行者默认 hy3、judge 默认 glm-5.3-flash，可 --model= 换；同批次固定）；judge（bands 渲染 5分/4分… 修复 + 双形态 JSON 解析 + 一致性自纠 + 多采样中位）；代码类任务 rubric 必含 codeQuality + architecture（断言 J1 强制）；写面按任务 ALLOW 前置白名单；run 白名单经 runAllowed（含穿越硬拒）；npm 经 cmd.exe 包装（Windows）；面板任务 prompt 内嵌产品交付约束（单文件离线 + 打开即渲染 + file:// 可用），静态化保真闸门兜底——不向模型暴露任何"评测/校验"元语言；**压缩域实验**（四旋钮方法论 + task=架构单位 + DSH-native vs task-partitioned 对照）见 `EXPERIMENT.md`（设计级单一事实源），压缩域按**任务尺度标定**（≈峰值上下文，非裸模型窗口）；**上下文窗口硬截断**（仅防溢出安全阀，非压缩域逻辑）：`runner.mjs` 全臂兜底，超窗（`contextWindow × truncatePct`）重建消息表（保留 system+task+尾部、丢最旧），不罚分、只记 `hard-truncate` 事件供审计，低于 floor 完全 no-op；human 维度为绝对 0–5，经 `npm run human:review` 引导会话录入（CSV 仅供内部存储，无需打开）。
