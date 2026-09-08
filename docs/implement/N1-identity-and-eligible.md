# N1 · 工具身份通道与可剪集合

> **状态**：未开工（N 系列首单）。
> **依赖**：无（R1–R4 已封存）。**总纲**：[`00-master.md`](00-master.md) §2/§3。
> **正典**：[`docs/03 §2`](../03-shear.md)（四档时机 + 生命周期谓词）· [`docs/06 §2`](../06-cache.md)（断裂成本）·
> [`docs/11 §7`](../11-structure.md)（资产登记）· `docs/13 §3.9`（H6 挂点）。

## §1 目标

把"这条工具结果属于哪一类"从**猜命令字符串**升级为**读 DSH 工具签名**，并产出可剪 / 永不剪 / 需分流的机械分类器。
**本单只读、只分类、不剪**（剪除归 N4）。

## §2 三条通道（均已核实存在）

| 通道 | 来源 | 现状 |
|---|---|---|
| 调用参数 | `ToolExecution.arguments`（解析后 JSON） | **我们丢掉了**（`toToolResultView` 未取；`callOf` 置空） |
| 工具签名 | `ctx.tools.get(name, exec.agent)` → `presentCall(args).kind` / `presentResult(args,result).card` | **未使用** |
| 结构化载荷 | `ToolExecutionResult.meta`（`output.presentationMeta` 投影，已落账） | **未使用** |

**已核实的声明覆盖**（harness 原生工具）：`read` kind=read / card=read + meta；`write`/`edit` card=diff；
`str_replace_editor` 按子命令 view=read / create·str_replace=diff；`grep`/`glob` kind=search / card=search + meta；
`web_search` kind=search / card=web；`web_fetch` kind=fetch / card=web；`read_image` kind=read + meta；
`bash`/`pwsh` card=terminal（`presentResult` 拆出 `output` + `exitCode`）；`run_code` kind=execute，**故意无 presentResult/meta**；
`todo_write` kind=other；`job_output` kind=read；`ask_user_question` 无声明。

## §3 交付物

1. **平台描述符**（`src/platform/tools.ts`）：`ToolResultView` 增 `args` / `meta` / `kind` / `card`；
   `ctx.tools.get(name, exec.agent)` + `presentCall` 取值；**任何异常 → 降级为只有 name**（fail-lazy，不得打断工具执行）。
   优先用 `result.meta`（已算好）；`presentResult` 仅在必要时调（大结果有投影成本）。
2. **纯核分类器**（`src/core/shear/classify.ts`）：输入纯描述符 → 输出 `'cuttable' | 'never' | 'needs-command'`。
3. **只读探针**（`scripts/probe-n1.mjs`）：在真实会话回放上统计签名覆盖率与分类分布（**无写、无网络**）。

## §4 分类规则

| 判据（按序） | 结论 |
|---|---|
| `kind ∈ {edit, delete, move}` 或 `card='diff'` | **never**（改史） |
| `card='read'` 或 `kind='read'` 且载荷是文件内容 | **never**（项目代码事实） |
| `card='web'` 或 `kind ∈ {fetch, search}` | **never**（外部事实） |
| `card='search'`（grep/glob 命中/路径） | **never**（代码事实；由压缩层回收） |
| 工具名 `run_code`（无签名） | **cuttable**（程序化结论；需 N2 结论契约） |
| `card='terminal'`（bash/pwsh） | **needs-command** → 拆段分流（副作用 / 已截断 / 结论型 / 语料型 / 未知） |
| 其余（无声明、认不出） | **never** |

**拆段分流**（仅 `terminal`）：按 `; && || |` 与换行拆段，逐段判定，**整条取最保守段**；
任一段命中副作用表或"已被 head/tail/wc 截断"→ 整条 `never`。

## §5 验收

- `npm run gate` 绿 + `npm run typecheck:tests` 绿。
- `node scripts/probe-n1.mjs` 产出：签名覆盖率（有 kind / 有 card / 有 meta 的占比）、
  三类分类分布、`terminal` 子类分布；**零写零网络**。
- 新增结构断言：`core/shear/classify.ts` 零 harness import（S1 既有规则覆盖）；
  `platform/tools.ts` 仍是唯一取 harness 工具类型的文件（D 规则）。
- 单测：分类器每类 ≥1 用例；异常降级用例；`terminal` 拆段取最保守用例。

## §6 尺寸预算

预估 **M**（2–4 文件 / ≤400 净行）：`platform/tools.ts` +40 / `core/shear/classify.ts` ~120 /
`platform/agent-step.ts` 0 / 探针 ~150（脚本不计 src 净行）。超预算须在 §8 申报拆单。

## §7 风险与回退

| 风险 | 处置 |
|---|---|
| 工具不声明签名（第三方） | 降级 `needs-command` 或 `never`；不假设存在 |
| `get(name, scope)` scope 取错（多 preset） | 必须传 `exec.agent`；取不到 → 降级 |
| `presentResult` 成本 | 优先 `meta`；`presentResult` 只在无 meta 时调 |
| harness 版本漂移 | 防御性解析；未知 shape → `never` |
| bash 无 meta | 走命令拆段；**建议向上游提**：bash 投影 `exitCode`/`spillPath` 进 meta |
