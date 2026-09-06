# P5 辅助调用端口（映射 R1；依赖 P2；尺寸 S）

> 状态：**已施工（commit `f48c51f`；落地过程已通过 `node scripts/verify-p5.mjs`、`npm run gate` 与 `DSH_CHECKOUT=G:/deepseek-harness npm run build`）**。
> 执行模式：**人工介入仅限必要时刻**（自动化检查无法判定、或触发 §6.7 停工上报时）。
> harness 接口核验、上下文组装检查等，凡能用 LLM 调用接口/脚本机械检查的，
> 一律自动化执行，不设逐项人工批准；最后一步按 §9 汇报。
> 前置完成面：P0 / P1 / P1.1 / P1.2 / P2 / P3 / P4 均已施工并合入 main；本单已执行完毕。
> 设计正典：[10 §1 H12](../10-wiring.md)（辅助 LLM 挂点）/
> [11 §2](../11-structure.md)（模块树 `platform/llm.ts` 行：`CeAuxPurpose` 单点适配 + purpose 路由 +
> usage/缓存观测回执）/
> [12 §1 C2](../12-platform-capabilities.md)（purpose 单点适配契约；cast 单点由 D 族断言锁定）/
> [07 §2/§5](../07-metrics.md)（辅助调用按 purpose 分账；usage 聚合形状）/
> [06 §4/§6](../06-cache.md)（缓存观测字段：`cacheReadTokens`/`cacheWriteTokens` 标准 usage 路径）。
> harness 符号清单：`ctx.llm`（`LlmRuntime`）/ `LlmRuntime.stream` / `'llm/stream'` waterfall /
> `GenerateOptions` / `TokenUsage` / `StreamChunk` / `LlmFailure`（`@deepseek-ai/dsh-llm`）。
> 逐条 grep 核验源见 §2.3；核验不符即停工上报。

## 1. 目标

让 `platform/llm.ts` 在 P1.2 已落锚的 C2 单点适配上补齐 H12 调用面：`streamCeLlm` 消费
`CeGenerateOptions` 并调用 `llm.stream({purpose})`，在首个 `usage` 流块到达时把
`TokenUsage` 映射为插件侧 `CeLlmUsage` 并经 `onUsage` 回执单次回调（含缓存观测字段）。
本单**只建端口、不发机制行为**：不接 index.ts、不建会话事件、不接 storage、不做任何判别/
断面/压缩编排；D6 结构断言把 llm 服务概念收口进 `src/platform/llm.ts`。

## 2. 输入

### 2.1 正典摘录（工单自足；与正典冲突以正典为准并停工上报）

- **10 §1 H12**：辅助 LLM = `llm.stream({purpose})`；判别/断面/压缩调用统一 purpose 标记
  （度量可区分 + 前缀对齐）；usage 回执入账。**宿主现仅 `'compaction'|'session-title'`**，
  插件自定义 purpose 经 `platform/llm.ts` 单点适配（[12 §1 C2](../12-platform-capabilities.md)），
  P5 补齐调用/usage 面。
- **11 §2 模块树**：`platform/llm.ts` = H12 辅助调用端口（`CeAuxPurpose` 单点适配 +
  purpose 路由 + usage/缓存观测回执）；platform 是唯一 `ctx` 触点；`core ↛ platform`。
- **12 §1 C2 闭合形态**：`platform/llm.ts` 定义 `CE_AUX_PURPOSES`（judge / optimize /
  compaction 三值）与 `CeGenerateOptions`；`toHarnessGenerateOptions` 是**唯一 cast 收窄点**。
  P5 的 `stream` 调用面消费 `CeGenerateOptions`，usage 回执按调用侧 purpose 记账——不依赖
  wire 回显。cast 单点由后续 D 族断言锁定（与 C1 的 D3 同构）。
- **07 §2 固定单价表口径**：辅助调用（判别/断面/压缩）按 purpose 分账（`llm.stream` usage
  回执）；单价缺失不猜价记 null。
- **07 §5 回放管道**：usage 聚合来自 `assistant/message`（主模型）与 llm purpose 回执
  （辅助调用）。P5 只提供**回执形状**；按 purpose 入账的 fold 扩展归 P10/P11/P18。
- **06 §4/§6**：缓存观测字段读标准 usage 路径（`cacheReadTokens`/`cacheWriteTokens`，
  别名兜底在 fold 侧）；P5 端口必须原样保留这两个字段，不得改写/估算。
- **13 §3.5**：`ctx.llm` 服务与 `llm/stream` 的已核验事实面；P5 在此补 stream 调用与
  usage 回执（本文档实现后 §3.5 与落位表回写）。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/platform/llm.ts` | 57 行：`CE_AUX_PURPOSES` / `CeAuxPurpose` / `CePurpose` / `CeGenerateOptions` / `toHarnessGenerateOptions` / `CeLlmStreamService` / `resolveLlmService` | **改**（§3.1；净增 ≤150 行） |
| `tests/llm-purpose.spec.ts` | 41 行：C2 词汇冻结 / 单点收窄 / fail-lazy 服务解析 3 用例 | **追加**（§3.2；不重写存量断言） |
| `scripts/assert-structure.mjs` | 165 行，RULES 表到 D5 | **追加 D6**（§3.4） |
| `tests/assert-structure.spec.ts` | D1–D5 正/负样本 + 零位快照 | **追加 D6 正/负样本 + 快照**（§3.4） |
| `scripts/verify-p5.mjs` | 不存在 | **新**（§3.3；agent 自动化验收入口） |
| `package.json` | `peerDependencies['@deepseek-ai/dsh-llm'] = ">=0.1.3-alpha.1 <2"` | **只核验不修改**（已由 P1.2 落位；§4 步骤 2） |
| `scripts/build.sh` | 第 89 行 `link_pkg @deepseek-ai/dsh-llm packages/llm/llm` | **只核验不修改**（已由 P1.2 落位；§4 步骤 2） |
| `tsconfig.tests.json` | 已 include `tests/llm-purpose.spec.ts` | 零改动（追加在同一文件） |
| `src/index.ts` | 装配根 | **零改动**（P5 无运行期消费者；P10/P11/P18 起在 domains 侧消费） |

### 2.3 harness 符号核验源（只 grep 定义处，确认后准 import；找不到即停工上报）

| 符号 | 定义处（G:/deepseek-harness） | 本单用途 |
|---|---|---|
| `ctx.llm: LlmRuntime`（Context 合并） | `packages/llm/llm/src/index.ts:54-55` | 服务解析 |
| `'llm/stream'` waterfall（每次模型调用包裹） | `packages/llm/llm/src/index.ts:60-68, 71` | 不直接注册；确认 `llm.stream()` 已走 waterfall |
| `LlmRuntime.stream(options): AsyncIterable<StreamChunk>` | `packages/llm/llm/src/index.ts:1093-1104` | 被 `streamCeLlm` 调用 |
| `GenerateOptions`（`provider`/`model`/`messages` 必填） | `packages/llm/llm/src/types.ts:407-460` | `CeGenerateOptions` 宿主形状 |
| `GenerateOptions.purpose?: 'compaction' \| 'session-title'` | `packages/llm/llm/src/types.ts:442` | C2 单点 cast 对象 |
| `TokenUsage`（input/output/total/cacheRead/cacheWrite/reasoning） | `packages/llm/llm/src/types.ts:149-157` | usage 回执映射源 |
| `StreamChunk`（`usage` 块 / `finish` 块） | `packages/llm/llm/src/types.ts:371-396` | 透传流块；服务缺失时构造终止 `finish` |
| `LlmFailure`（message/code/status?/providerRetryAfterMs?/requestId?） | `packages/llm/llm/src/types.ts:40-51` | fail-lazy 终止块失败载荷 |

### 2.4 决策点记录（执行者不再自行裁量）

1. **peerDep 与 build 链接已存在**：`package.json` 与 `scripts/build.sh` 均已在 P1.2 落位
   `@deepseek-ai/dsh-llm`。P5 只核验两处（grep 命中即过），不重复添加；若核验发现缺失
   才补，且补法 = `peerDependencies` 加 `">=0.1.3-alpha.1 <2"` + build.sh 加
   `link_pkg @deepseek-ai/dsh-llm packages/llm/llm`。
2. **服务缺失 = fail-lazy 终止流**：`ctx.llm` 缺失时 `streamCeLlm` 不抛出，只 warn（若给
   logger）并 yield 一个 `{ type:'finish', reason:{ kind:'error', failure:{ code:'CE_LLM_UNAVAILABLE',
   message:'context-economy: llm service unavailable (fail-lazy)' } } }` 终止块；`onUsage` 不调用。
   调用侧（P10/P11/P18）据此走 fail-lazy（不判别/不断面/不压缩），本单不替调用侧做决策。
3. **onUsage 至多一次**：usage 块按协议应在 `finish` 前出现且至多一块；仍加 `usageSeen`
   守卫，重复 usage 块只回执第一次，块本身全部透传（不吞块、不重排）。
4. **usage 映射不做算术**：`toCeLlmUsage` 只做字段搬运；`totalTokens`/`cacheReadTokens`/
   `cacheWriteTokens`/`reasoningTokens` 在源为 `undefined` 时**省略键**（与 P2 `TokenUsageLike`
   可选字段同构）。缓存观测字段零改写（06 §4）。
5. **stream 错误不捕获**：harness `LlmRuntime.stream()` 会把 adapter 失败归一为终止
   `error`/`aborted` finish 块；中间件/嵌套调用/消费者错误仍抛出——`streamCeLlm` 原样透传
   与传播，不包 try/catch 吞错（吞错会破坏上游重试与诊断）。
6. **D6 收口范围**：只收 `ctx.llm` / `llm.stream` / `llm/stream` / `GenerateOptions` /
   `TokenUsage` / `StreamChunk` / `LlmRuntime` 七类 **H12 服务概念**。`ContentBlock`/
   `Message` 等 dsh-llm 内容词汇不属于 H12 收口范围（`src/platform/events.ts` 现有
   `ContentBlock` type import 不受影响，S1 继续单独管 core）。
7. **不建会话事件、不改 index.ts**：usage 回执先由调用侧（P10/P11/P18）经 facts/ledger
   记账；P5 端口不声明 `context-economy/*` 事件，也不在装配根注册任何消费者。

## 3. 产出

### 3.1 `src/platform/llm.ts`（改，净增 ≤150 行，总长 ≤200 行）

保留现有 7 个导出不变（可把 `resolveLlmService` 签名从 `Context` 放宽为
`Pick<Context, 'llm'>`——Context 可赋给该 Pick，既有测试无需改语义）。新增：

```ts
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
// （现有 import 行按需扩展，不新增运行时 import）

/** 插件侧 usage 回执（与 core/ledger TokenUsageLike 结构同构；可选键缺失时省略）。 */
export interface CeLlmUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 一次辅助调用的 usage 回执：调用侧 purpose + 请求路由 + 用量。 */
export interface CeLlmUsageReceipt {
  /** 与请求一致（宽化词汇：CE_AUX_PURPOSES 三值 ∪ 宿主两值）。 */
  purpose?: CePurpose
  provider: string
  model: string
  usage: CeLlmUsage
}

export interface CeLlmStreamHooks {
  /** usage 块首次到达时单次回调；无 usage 不回调。 */
  onUsage?: (receipt: CeLlmUsageReceipt) => void
  /** fail-lazy 诊断通道；未提供时仅以终止块表达失败（不静默）。 */
  logger?: { warn: (...args: unknown[]) => void }
}

/** TokenUsage → CeLlmUsage 纯映射；可选字段缺失时省略键；零算术、零估算。 */
export function toCeLlmUsage(usage: TokenUsage): CeLlmUsage

/**
 * 辅助 LLM 调用端口：resolveLlmService → toHarnessGenerateOptions → llm.stream。
 * 服务缺失：warn + yield CE_LLM_UNAVAILABLE 终止块（fail-lazy，不抛）。
 * usage 回执：首个 usage 块触发 hooks.onUsage 一次；流块全部原样透传。
 */
export function streamCeLlm(
  ctx: Pick<Context, 'llm'>,
  options: CeGenerateOptions,
  hooks?: CeLlmStreamHooks,
): AsyncIterable<StreamChunk>
```

**实现语义（逐字照抄；冲突以正典为准停工）：**

1. `resolveLlmService` 签名放宽为 `(ctx: Pick<Context, 'llm'>) => CeLlmStreamService | undefined`；
   行为不变（`return ctx.llm`）。
2. `toCeLlmUsage(usage)`：返回新对象；`inputTokens`/`outputTokens` 原样；
   `totalTokens`/`cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens` 仅在 `!== undefined`
   时带键，值原样；不做 `Number()` 归一、不做求和。
3. `streamCeLlm` 为 async generator：
   - `const service = resolveLlmService(ctx)`；`service == null` 时：
     `hooks?.logger?.warn('context-economy: llm service unavailable (fail-lazy)')`，然后
     `yield { type:'finish', reason:{ kind:'error', failure:{ message:'context-economy: llm service unavailable (fail-lazy)', code:'CE_LLM_UNAVAILABLE' } } }`，
     `return`。
   - `service` 存在时：`for await (const chunk of service.stream(toHarnessGenerateOptions(options)))`；
     若 `chunk.type === 'usage' && !usageSeen`：置 `usageSeen=true` 并调用
     `hooks?.onUsage?.({ purpose: options.purpose, provider: options.provider, model: options.model, usage: toCeLlmUsage(chunk.usage) })`；
     随后 `yield chunk`（usage 块本身也透传）。
   - 不 try/catch 包裹 `service.stream` 迭代；不 `setTimeout`/`setInterval`；不 `.append(`；
     不 import `core/**`、`dsh-session`、`dsh-storage`。
4. 注释区按 docs/05 §6 更新：平面 L0（类型适配 + 流透传 + 回执；无模型无机制逻辑）；
   审查清单注明 cast 仅 `toHarnessGenerateOptions`、本文件不发起机制调用（编排归
   P10/P11/P18）。

### 3.2 `tests/llm-purpose.spec.ts`（追加，净增 ≤120 行，总长 ≤180 行）

**不重写存量 3 用例**；仅扩展 import 与追加以下用例组（fake stream 全部手写 async generator，
零 cordis 运行时 import）：

1. **toCeLlmUsage 全字段**：源含 6 字段 → 目标 6 字段全等；输出为新对象（改输出不影响源）。
2. **toCeLlmUsage 最小字段**：源仅 `{inputTokens,outputTokens}` → 目标无
   `totalTokens`/`cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens` 键（
   `Object.hasOwn` 断言）。
3. **streamCeLlm 透传 + 单次回执**：fake service 依次 yield `text-delta`、`usage`、`finish`；
   收集到数组：三块全透传（`toStrictEqual`）；`onUsage` 恰一次，receipt 含
   `purpose:'context-economy-optimize'`、`provider`、`model`、`usage` 全字段；回调发生在
   usage 块到达时（收集数组在回调时长度为 2）。
4. **streamCeLlm custom purpose 进入宿主面**：fake service 捕获收到的 `GenerateOptions`；
   断言 `purpose === 'context-economy-compaction'`（证明经 `toHarnessGenerateOptions` 单点
   cast 原样进入宿主调用）。
5. **streamCeLlm 服务缺失 fail-lazy**：`resolveLlmService` 返回 undefined（ctx `{}`）；
   收集到恰一个 `finish` 块且 `reason.kind === 'error'`、`failure.code === 'CE_LLM_UNAVAILABLE'`；
   `onUsage` 未调用；logger.warn 恰一次。
6. **streamCeLlm 重复 usage 只回执一次**：fake stream yield 两个 usage 块 + finish；
   `onUsage` 恰一次（第一个）；两个 usage 块都透传。
7. **streamCeLlm 无 usage 不回执**：fake stream 只 yield `finish`；`onUsage` 未调用；
   流正常结束。
8. **类型兼容**：`const u: CeLlmUsage = { inputTokens: 1, outputTokens: 2 };`
   `const like: TokenUsageLike = u; expect(like.inputTokens).toBe(1)`（`TokenUsageLike`
   type import from `../src/core/ledger/types.ts`——测试侧可跨层，不违反 S1）。

### 3.3 `scripts/verify-p5.mjs`（新，≤120 行；agent 自动化验收入口）

流程（任一 FAIL 立即非 0 退出并打印清单）：

1. **前置核验**：`package.json` peerDependencies 含 `@deepseek-ai/dsh-llm` 且为范围声明；
   `scripts/build.sh` 含 `link_pkg @deepseek-ai/dsh-llm packages/llm/llm`；`grep -Rn "as GenerateOptions" src`
   仅命中 `src/platform/llm.ts`。
2. **构建**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`（checkout 不存在 → SKIP
   不判 FAIL）→ 非 0 即 FAIL。
3. **门禁**：`npm run typecheck`、`npm run typecheck:client`、`npm run typecheck:tests`、
   `npm test`、`npm run assert` 五段依次执行，任一非 0 即 FAIL（等价于 `npm run gate` +
   `npm run typecheck:tests`，分开跑便于定位）。
4. **确定性**：`node scripts/assert-structure.mjs --json` 连跑两次 diff 为空；输出含
   `"D6": { "status": "pass" }`（JSON 解析后断言）。
5. **D6 收口扫描**（JS RegExp `/(ctx\.llm|llm\/stream|llm\.stream|\bGenerateOptions\b|\bTokenUsage\b|\bStreamChunk\b|\bLlmRuntime\b)/`，
   扫描 `src/**/*.ts`）：命中文件集合必须恰为 `['src/platform/llm.ts']`；
   `grep -Rn "as GenerateOptions" src` 仅命中 `src/platform/llm.ts`。
6. **端口纯净 grep**（`src/platform/llm.ts` 期望 0 命中）：
   `\.append(`、`setInterval(`、`fetch(`、`http.get`、`axios`、`readFile`、`watchFile`、
   `chokidar`、`from '../core`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-storage-domain`。
7. **行数预算**：`src/platform/llm.ts ≤200`、`tests/llm-purpose.spec.ts ≤180`、
   `scripts/verify-p5.mjs ≤120`（`wc -l`）。
8. **D6 快照**：`grep -n "D6: 'pass'" tests/assert-structure.spec.ts` ≥1 命中；
   `grep -n "id: 'D6'" scripts/assert-structure.mjs` ≥1 命中。
9. 打印 `P5 VERIFY PASS` 或失败清单。

### 3.4 `scripts/assert-structure.mjs` 追加 D6（引擎零改动）

```js
{ id: 'D6', canon: 'docs/10 §1 H12 + docs/11 §2 + docs/12 §1 C2',
  appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'),
  check: (f) => /(ctx\.llm|llm\/stream|llm\.stream|\bGenerateOptions\b|\bTokenUsage\b|\bStreamChunk\b|\bLlmRuntime\b)/.test(f.text)
    && f.path !== 'src/platform/llm.ts'
    ? [{ message: 'llm service concepts must only appear in platform/llm.ts (H12 辅助调用端口收口, docs/10 §1 H12)' }]
    : [] }
```

`tests/assert-structure.spec.ts`：
- 负样本：`src/domains/a.ts` 出现 `ctx.llm.stream(...)` → issue；`src/platform/events.ts`
  出现 `import type { GenerateOptions } from '@deepseek-ai/dsh-llm'` → issue（events.ts 只可
  继续用 `ContentBlock`，D6 不拦）。
- 正样本：`src/platform/llm.ts` 出现 `ctx.llm`、`llm.stream`、`GenerateOptions`、
  `TokenUsage`、`StreamChunk` → 0 issue；`src/platform/events.ts` 只出现 `ContentBlock` → 0 issue。
- 真实树零位快照增 `D6:'pass'`。

### 3.5 文档回写（实现后执行）

- `docs/implement/00-master.md`：P5 行已于计划期先行回写（链接本工单 + peerDep/build
  表述修正，§2.4 决策 1）；执行后只补 `已施工 commit <hash>`。
- `docs/13-harness-plugin-spec.md`：§3.5 更新为已施工事实——`streamCeLlm` 签名与语义、
  `CeLlmUsageReceipt`/`toCeLlmUsage`、服务缺失终止块；§5 落位表 `src/platform/llm.ts` →
  `已施工（P5）`。
- `docs/11-structure.md`：状态行补 `P5`（`P0/P1/P1.1/P1.2/P2/P3/P4/P5 已施工；R1 未完`）。
- `docs/10-wiring.md`：状态行补 H12；H12 行末 “P5 补齐调用/usage 面” 改为
  “P5 已施工：`platform/llm.ts` `streamCeLlm` + usage 回执”。
- `docs/12-platform-capabilities.md`：C2 “闭合形态（P1.2 锚 / P5 实现）” 标注
  `已施工（P5）`；§4 验收清单中 C2 项标注 `streamCeLlm 落位，D6 锁定 cast 单点`。
- `AGENTS.md` **不改**（现状段与 R1 进度统一在 R1 里程碑验收回写；P5 单点不改全局指令）。

## 4. 实现要点（每步独立可验证；顺序执行）

1. **核验 harness**（§2.3）：逐条 grep 到定义处，确认 `ctx.llm`/`stream`/`GenerateOptions`/
   `TokenUsage`/`StreamChunk`/`LlmFailure` 行号与语义一致；不一致停工上报。
2. **核验 peerDep + build 链接**（§2.4 决策 1）：`grep -n '"@deepseek-ai/dsh-llm"' package.json`
   与 `grep -n "link_pkg @deepseek-ai/dsh-llm" scripts/build.sh` 各 ≥1 命中；缺失才补。
3. **改 `src/platform/llm.ts`**（§3.1）→ `npm run typecheck` 绿（typecheck:client 不受影响，
   但步骤 7 一并跑）。
4. **追加 `tests/llm-purpose.spec.ts`**（§3.2）→ `npm test` 绿（既有 3 用例不回归 + 新增组全绿）。
5. **追加 D6**（§3.4）→ `npm run assert` 绿；更新 `tests/assert-structure.spec.ts` 快照与
   正/负样本 → `npm test` 绿。
6. **写 `scripts/verify-p5.mjs`**（§3.3）→ `node scripts/verify-p5.mjs` 输出 `P5 VERIFY PASS`。
7. **全链自验**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`；`npm run typecheck`；
   `npm run typecheck:client`；`npm run typecheck:tests`；`npm test`；`npm run assert`；
   `node scripts/assert-structure.mjs --json` 双跑 diff 空。
8. 对照 §5 清单逐条打勾；全部满足后执行 §3.5 文档回写，再进 §7。

## 5. 验收（全机械 + agent 自动化检查）

- [ ] `node scripts/verify-p5.mjs` 输出 `P5 VERIFY PASS`（§3.3 九组全过）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0（build.sh 已链接 `@deepseek-ai/dsh-llm`）
- [ ] `npm run typecheck && npm run typecheck:client && npm run typecheck:tests && npm test && npm run assert` 全绿
- [ ] `tests/llm-purpose.spec.ts`：存量 3 用例 + 新增 8 用例全绿（vitest 输出可见，总 11 用例）
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次逐字节一致（diff 为空）；零位快照含 `D6:pass`
- [ ] `grep -Rn "as GenerateOptions" src` 仅命中 `src/platform/llm.ts`（cast 单点锁定，docs/12 §4）
- [ ] D6 反向扫描：JS RegExp `/(ctx\.llm|llm\/stream|llm\.stream|\bGenerateOptions\b|\bTokenUsage\b|\bStreamChunk\b|\bLlmRuntime\b)/` 扫 `src/**/*.ts`，命中文件集合恰为 `['src/platform/llm.ts']`
- [ ] `grep -R "\.append(\|setInterval(\|fetch(\|http.get\|axios\|readFile\|watchFile\|chokidar\|from '../core\|@deepseek-ai/dsh-session\|@deepseek-ai/dsh-storage-domain" src/platform/llm.ts`
      无命中（零 append / 零 timer / 零网络 / 零 core import / 零其他平台域 import）
- [ ] `git diff tests/field-model.spec.ts tests/skills.spec.ts tests/storage.spec.ts tests/events-pump.spec.ts` 为空（既有测试零改动；仅 `llm-purpose.spec.ts` 与 `assert-structure.spec.ts` 按 §3.2/§3.4 追加）
- [ ] 行数预算：`src/platform/llm.ts ≤200`、`tests/llm-purpose.spec.ts ≤180`、`scripts/verify-p5.mjs ≤120`（`wc -l`）
- [ ] `git diff --cached` 为空（无暂存改动；提交前工作树与暂存区一致）

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **只补调用面，不发起机制调用**：P5 不判断、不断面、不压缩；`streamCeLlm` 是纯端口。
   任何调用编排（何时调、purpose 选哪个、失败后怎么办）归 P10/P11/P18。
2. **零 index.ts 改动**：P5 无运行期消费者；装配根接线从 P10 起由 domains 侧消费端口。
3. **零会话事件**：不声明 `context-economy/*` 事件；usage 回执入账由后续机制工单经
   P2 fold 扩展 + facts/logger 发射完成。
4. **fail-lazy 方向**：服务缺失只产出 `CE_LLM_UNAVAILABLE` 终止块 + warn；不抛、不重试、
   不降级为伪调用（主模型绝不被辅助调用替代）。
5. **D6 只管 H12 服务概念**：不把 `ContentBlock`/`Message` 纳入（events.ts 需要）；也不拦
   `CeGenerateOptions`/`toHarnessGenerateOptions` 等插件侧符号（域层可 import 这些本地类型）。
6. **测试不重写存量断言**：`tests/llm-purpose.spec.ts` 既有 3 用例保持原文语义；只允许
   扩展 import 与 describe 追加（P1.2 文件头已注明追加约定）。
7. **停工上报触发器**：① §2.3 核验签名与设计不符；② `llm.stream` 在 checkout 中不是
   `AsyncIterable<StreamChunk>`（例如需要 callbacks/返回 Promise）；③ D6 负样本暴露
   `src/platform/events.ts` 现有 `ContentBlock` import 被误伤且正则无法精确收口；④ 行数
   预算超限且无法精简；⑤ 任何未覆盖决策点。上报带证据（命令 + 输出 + file:line）。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p5): 辅助调用端口——llm.stream({purpose}) 透传 + usage/缓存回执 + D6 收口`
- 账本快照：**本单不需要**（端口无机制改动；R1 段末随 P7 出首份 07 报表快照，见总纲 §4）。
- 汇报（**本单最后一步，执行者必须完成**）：按 §9 向用户报告修改内容、功能实现与文档对应表。

## 8. 对接面（P5 如何被后续计划消费）与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式（P5 提供） |
|---|---|
| P10 判据与对表 | `streamCeLlm(ctx, options, { onUsage })`；purpose 传 `'context-economy-judge'`；`onUsage` 把 `CeLlmUsageReceipt` 喂给 P2 fold 扩展面按 purpose 分账（judgeLLMUsage） |
| P11 星标断面 | purpose `'context-economy-optimize'`；usage 回执记 `optimizePromptTokens{in,out}`；缓存字段进 cost 恒等式 |
| P12 自动断面服务 | 经 P10 判断链路消费；P5 不直接面向 P12 |
| P18 压缩调用 | purpose `'context-economy-compaction'`；usage 回执记 `compressionCallCount` 与成本段 |
| P21b 全链验收 | 缓存四断言之“辅助调用 = 上一次请求真前缀 + 新短尾”由后续机制使用 `CeGenerateOptions` 组装；P5 保证调用侧 purpose 与 usage 回执不依赖 wire 回显 |

### 8.2 对后续计划的修正（随本计划先行回写 `docs/implement/00-master.md`）

| 行 | 原表述/依赖 | 修正为 | 理由 |
|---|---|---|---|
| P5 | “补 peerDep `dsh-llm` + build 链接” | peerDep/build 链接已由 P1.2 落位；P5 只核验（§2.4 决策 1） | 当前 `package.json` 与 `scripts/build.sh` 已含 dsh-llm；避免重复施工 |
| P5 | 依赖 P2 | 不变 | usage 回执形状与 P2 `TokenUsageLike` 同构；fold 扩展归 P10/P11/P18 |
| P10/P11/P18 | 依赖列含 P5 | 不变 | 三者经 `streamCeLlm` 消费；按 purpose 分账的 fold 扩展在各自动工单落地，P5 不抢先 |
| P6/P7 | — | 不变 | P5 不触碰 history/tools；R1 剩余 P6/P7 按原序 |
| 总纲依赖主干 | `P1→P2→P5` | 不变 | 无新边；P5 不改 index.ts、不产生新依赖 |
| docs/10 H12 行 | “P5 补齐调用/usage 面” | 已施工表述 | 进度回写，非设计改动 |
| docs/13 §3.5 | “P5 在此补 stream 调用与 usage 回执” | 已施工表述 + 签名/语义 | 事实层回写，后续工单直接引用 |

## 9. 汇报模板（本单最后一步）

执行者在全绿后向用户报告，必须包含：

1. **修改内容**：列出新增/改动文件与行数；`tests/assert-structure.spec.ts` 仅 D6 样本与
   快照变化；`tests/llm-purpose.spec.ts` 仅追加不重写；`package.json`/`build.sh` 零改动。
2. **功能实现**：`streamCeLlm` 的透传与 fail-lazy 终止块；`toCeLlmUsage` 字段映射与
   缓存观测保留；`onUsage` 单次回执；`CE_LLM_UNAVAILABLE`；D6 收口；verify-p5 结果。
3. **与文档对应表**：

| 功能 | 代码 | 文档 |
|---|---|---|
| H12 辅助调用端口（llm.stream({purpose})） | `streamCeLlm` | docs/10 §1 H12；docs/11 §2 llm.ts 行 |
| C2 purpose 单点适配 | `toHarnessGenerateOptions`（既有）+ `streamCeLlm` 消费 `CeGenerateOptions` | docs/12 §1 C2 |
| usage/缓存观测回执 | `toCeLlmUsage` / `CeLlmUsageReceipt` / `onUsage` | docs/07 §2/§5；docs/06 §4/§6 |
| fail-lazy 服务缺失 | `streamCeLlm` 终止块 `CE_LLM_UNAVAILABLE` | docs/05 回退链 + 总纲铁律 6 |
| D6 llm 概念收口 | `scripts/assert-structure.mjs` D6 | docs/10 §1 H12；docs/12 §4 |
| 自动化验收 | `scripts/verify-p5.mjs` | 总纲 §2 铁律 2 + §5 全机械验收 |

4. **后续计划修正已回写**：§8.2 的 P5 行 peerDep/build 表述、docs/10 H12、docs/13 §3.5
   是否已核对 `docs/implement/00-master.md` 与对应文档。
