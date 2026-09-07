# P7 工具端口（映射 R1；依赖 P1；尺寸 S）

> 状态：**已施工（工作树验收全绿；`node scripts/verify-p7.mjs` 输出 `P7 VERIFY PASS`；commit 见 git log）。**
> 设计正典：[10 §1 H6](../10-wiring.md)（剪切层挂点）/
> [11 §2](../11-structure.md)（模块树 `platform/tools.ts` 行：H6 post-execute 端口 +
> tools/execute 信号计量）/ [03 §2](../03-shear.md)（T-entry/T-note 语义归 P15a/P15b，本单只建端口）/
> [13 §3.9](../13-harness-plugin-spec.md)（tools 事件核验面，P6.1 顺延后编号）。
> harness 符号清单：`tools/execute` / `tools/post-execute`（waterfall）/
> `ToolDispatchExecution` / `ToolExecution` / `ToolExecutionResult` / `PostToolDecision`（`@deepseek-ai/dsh-tools`）；
> `ContentBlock`（`@deepseek-ai/dsh-llm`）。逐条 grep 核验源见 §2.3；核验不符即停工上报。

## 1. 目标

让 `platform/tools.ts` 成为 H6 的工具事件端口：注册 `tools/execute`（仅信号/计量，
永远 `return next()`）与 `tools/post-execute`（回调返回决定则短路，否则 `return next()`）；
提供 `replaceContent` / `appendContent` 两个内容决策构造器（覆盖 = T-entry、追加 = T-note）。
本单**只建端口、不发剪切行为**：不接 index.ts、不写会话事件、不调 history/storage/llm；
T-entry/T-note 的裁决逻辑归 P15a/P15b。

## 2. 输入

### 2.1 正典摘录（工单自足；与正典冲突以正典为准并停工上报）

- **10 §1 H6**：`tools/post-execute` accept `content` 覆盖 = T-entry 写时整形（落账前）；
  accept 追加 = T-note 贴注；surfaceOp replace 系列走 history 端口（P6），不由本单承担；
  `tools/execute` 仅作信号/计量 around-wrapper（不得改变结果）。
- **11 §2**：`platform/tools.ts` = H6 post-execute 端口（T-entry content 覆盖 / T-note 追加）
  + tools/execute 信号计量；platform 是唯一 `ctx` 触点；core 不 import harness。
- **03 §2**：T-entry / T-note 的业务判据、裁决动作、误剪反馈归剪切域（P15a/P15b）；
  本单只提供“能收到什么、能返回什么”的机械端口。
- **13 §3.9**（P6.1 顺延后）：`tools/execute` 与 `tools/post-execute` 都是 waterfall；
  `tools/execute` 返回值会经 `normalizeDispatchResult` 按 `value` 重新 render content，
  content-only 修改会丢——所以 T-entry 必须挂 `tools/post-execute`（P1.2 契约闭合）。
- **D2**：`tools/execute` 的 waterfall 监听器必须 `return next()`；本单 `tools/execute`
  监听器恒 `return next()`（结构断言 D2 已覆盖，D8 补包边界）。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/platform/tools.ts` | 不存在 | **新**（§3.1） |
| `tests/tools.spec.ts` | 不存在 | **新**（§3.2，全部 fake） |
| `scripts/verify-p7.mjs` | 不存在 | **新**（§3.3） |
| `scripts/assert-structure.mjs` | RULES 到 D7 | 追加 D8（§3.4） |
| `tests/assert-structure.spec.ts` | 快照到 D7 | 补 D8 负/正样本 + 快照 |
| `package.json` | peerDependencies 无 dsh-tools | += `@deepseek-ai/dsh-tools`（范围声明） |
| `scripts/build.sh` | 无 dsh-tools 链接 | += `link_pkg @deepseek-ai/dsh-tools packages/core/tools` |
| `tsconfig.tests.json` | include 5 个测试文件 | += `tests/tools.spec.ts` |
| `src/index.ts` | 装配根 | **零改动**（P7 无运行期消费者；P15b 起在 domains 侧消费） |

### 2.3 harness 符号核验源（只 grep 定义处，确认后准 import；找不到即停工上报）

| 符号 | 定义处（G:/deepseek-harness） | 本单用途 |
|---|---|---|
| `'tools/execute'` waterfall | `packages/core/tools/src/index.ts:155` | around-wrapper 注册 |
| `'tools/post-execute'` waterfall | `packages/core/tools/src/index.ts:167` | 内容覆盖/追加注册 |
| `ToolExecution` | `packages/core/tools/src/index.ts:372` | post-execute 回调参数 |
| `ToolDispatchExecution` | `packages/core/tools/src/index.ts:384` | execute 回调参数 |
| `ToolExecutionResult` | `packages/core/tools/src/index.ts:573` | post-execute 结果类型 |
| `PostToolDecision` | `packages/core/tools/src/index.ts:590-598` | 决策返回类型 |
| `ContentBlock` | `packages/llm/llm/src/types.ts:124` | content 决策载荷 |
| `@deepseek-ai/dsh-tools` 包名/路径 | `packages/core/tools/package.json` | peerDep + build 链接 |

### 2.4 决策点记录

1. **execute 监听器永不短路**：`tools/execute` 只做信号/计量，hook 返回任何值都被忽略，
   监听器恒 `return next()`；hook 抛错 catch + warn 后仍 `return next()`（度量不得打断工具执行）。
2. **post-execute 短路规则**：hook 返回 `undefined`/`null` → `return next()`（接受原结果）；
   hook 返回 `PostToolDecision` → `return Promise.resolve(decision)` 短路后续监听器；
   hook 抛错 → catch + warn + `return next()`（失败默认保留）。
3. **决策构造器只做纯数据**：`replaceContent(content)` = `{ kind:'accept', content }`；
   `appendContent(result, extra)` = `{ kind:'accept', content: [...result.content, ...extra] }`。
   不做 T-entry/T-note 语义判断（P15a/P15b 负责）。
4. **D8 收口范围**：`tools/execute` / `tools/post-execute` / `PostToolDecision` /
   `ToolDispatchExecution` / `ToolExecutionResult` / `ToolExecution` / `@deepseek-ai/dsh-tools`
   只许出现在 `src/platform/tools.ts`。`ContentBlock` 不纳入（events.ts 已在用，D6 同款处理）。
5. **不建会话事件、不改 index.ts**：P7 端口无运行期消费者；P15b 起在 domains 侧装配。

## 3. 产出

### 3.1 `src/platform/tools.ts`（新，≤200 行）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Type-only：拉入 dsh-tools 的 Context/Events merge（tools/execute、tools/post-execute）。
import type {} from '@deepseek-ai/dsh-tools'
import type {
  PostToolDecision,
  ToolDispatchExecution,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'

export interface ToolPortHooks {
  /** tools/execute around-wrapper：仅信号/计量；返回值被忽略。 */
  onExecute?: (exec: ToolDispatchExecution) => void
  /** tools/post-execute：返回决策则短路；返回 void 则委托 next()。 */
  onPostExecute?: (exec: ToolExecution, result: Readonly<ToolExecutionResult>) => PostToolDecision | void
}

export interface ToolPortStats {
  executeSeen: number
  postExecuteSeen: number
  decisions: number
  listenerErrors: number
}

export interface ToolPort {
  dispose(): void
  stats(): ToolPortStats
}

/** T-entry 写时整形：覆盖 content 的 accept 决策。 */
export function replaceContent(content: ContentBlock[]): PostToolDecision

/** T-note 贴注：在既有 content 后追加的 accept 决策（不动原块）。 */
export function appendContent(result: Readonly<ToolExecutionResult>, extra: ContentBlock[]): PostToolDecision

export function createToolPort(
  ctx: Pick<Context, 'on'>,
  hooks?: ToolPortHooks,
  logger?: { warn: (...args: unknown[]) => void },
): ToolPort
```

**实现语义（逐字照抄；冲突以正典为准停工）：**

1. `createToolPort` 注册两个监听器并返回 disposer；disposer 幂等（重复调用 no-op）。
2. `tools/execute` 监听器：
   - `stats.executeSeen++`；
   - `try { hooks?.onExecute?.(exec) } catch (e) { stats.listenerErrors++; logger?.warn(...) }`；
   - **恒 `return next()`**。
3. `tools/post-execute` 监听器：
   - `stats.postExecuteSeen++`；
   - 无 `hooks.onPostExecute` → `return next()`；
   - `try` 中调用 hook；返回 `undefined`/`null` → `return next()`；
   - 返回对象（`PostToolDecision`）→ `stats.decisions++` 并 `return Promise.resolve(decision)`；
   - hook 抛错 → `stats.listenerErrors++`、warn、`return next()`。
4. `replaceContent`/`appendContent`：纯函数；输出新对象与新数组（不引用输入数组）；
   `appendContent` 使用 `[...result.content, ...extra]`。
5. 模块注释按 docs/05 §6：平面 L0；回退链步数 1（失败默认保留——异常只 warn 并委托 next）；
   审查清单：不 import core、不 `.append(`、无 timer、无网络。

### 3.2 `tests/tools.spec.ts`（新，≤180 行；全部 fake）

手写 fake ctx：`on(name, listener)` 记录监听器并返回 disposer；`emit(name, ...args)` 触发
监听器。Fake `next` 返回可识别结果。用例（七组）：

1. **注册与卸载**：`createToolPort` 注册 `tools/execute` 与 `tools/post-execute`；
   `dispose()` 后两监听器均被移除；重复 dispose no-op。
2. **execute 仅信号/计量**：hook 被调且收到 exec；监听器返回 `next()` 的 Promise 结果；
   hook 返回假值/抛错均不影响 `next()` 被调与结果透传。
3. **post-execute 无决策委托 next**：hook 返回 `undefined` → `next()` 被调且返回其决策。
4. **post-execute 有决策短路**：hook 返回 `{ kind:'accept', content: [...] }` →
   `next()` 未被调；监听器返回该决策（Promise 解包后相等）。
5. **post-execute hook 抛错委托 next**：warn 恰一次；`next()` 被调。
6. **replaceContent / appendContent**：`replaceContent` 产出 accept+content；
   `appendContent` 保留原 content 顺序追加；输出数组不与输入共享引用（改输出不影响输入）。
7. **stats 计数**：多次 emit execute/post-execute/决策后 `stats()` 数值正确。

### 3.3 `scripts/verify-p7.mjs`（新，≤100 行；agent 自动化验收入口）

1. `DSH_CHECKOUT=G:/deepseek-harness npm run build`（checkout 不存在 → SKIP）→ 非 0 即 FAIL。
2. `npm run typecheck` / `typecheck:client` / `typecheck:tests` / `test` / `assert` 五段，
   任一非 0 即 FAIL。
3. `node scripts/assert-structure.mjs --json` 连跑两次 diff 为空；解析后 `D8.status === 'pass'`。
4. D8 反向扫描（JS RegExp 同 D8）扫 `src/**/*.ts`：命中集合恰为 `['src/platform/tools.ts']`。
5. `grep -Rn "as GenerateOptions" src` 仅命中 `src/platform/llm.ts`（D6 基线不回归）；
   `grep -Rn "session.append" src/platform/tools.ts` 无命中（零会话写入）。
6. 端口纯净 grep（`src/platform/tools.ts` 期望 0 命中）：
   `\.append(`、`setInterval(`、`fetch(`、`http.get`、`axios`、`readFile`、`watchFile`、
   `chokidar`、`from '../core`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-storage-domain`。
7. 行数预算：`src/platform/tools.ts ≤200`、`tests/tools.spec.ts ≤180`、
   `scripts/verify-p7.mjs ≤100`。
8. 打印 `P7 VERIFY PASS` 或失败清单。

### 3.4 `scripts/assert-structure.mjs` 追加 D8（引擎零改动）

```js
{ id: 'D8', canon: 'docs/10 §1 H6 + docs/11 §2 + docs/13 §3.9',
  appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'),
  check: (f) => /(tools\/execute|tools\/post-execute|PostToolDecision|ToolDispatchExecution|ToolExecutionResult|\bToolExecution\b|@deepseek-ai\/dsh-tools)/.test(f.text)
    && f.path !== 'src/platform/tools.ts'
    ? [{ message: 'tool event concepts must only appear in platform/tools.ts (H6 工具端口收口, docs/10 §1 H6)' }]
    : [] }
```

`tests/assert-structure.spec.ts`：
- 负样本：`src/domains/a.ts` 出现 `ctx.on('tools/post-execute', ...)` → issue；
  `src/platform/events.ts` 出现 `import type { ToolExecution } from '@deepseek-ai/dsh-tools'` → issue。
- 正样本：`src/platform/tools.ts` 出现 `tools/execute`、`tools/post-execute`、
  `PostToolDecision`、`ToolExecution` → 0 issue；
  `src/platform/events.ts` 只出现 `ContentBlock` → 0 issue（D8 不拦 content 词汇）。
- 真实树零位快照增 `D8:'pass'`。

### 3.5 依赖与文档回写（实现后执行）

- `package.json` peerDependencies += `"@deepseek-ai/dsh-tools": ">=0.1.3-alpha.1 <2"`。
- `scripts/build.sh` += `# P7：工具端口（H6 tools/execute + post-execute）` 与
  `link_pkg @deepseek-ai/dsh-tools packages/core/tools`。
- `tsconfig.tests.json` include += `tests/tools.spec.ts`。
- `docs/implement/00-master.md`：P7 行标 `已施工 commit <hash>` + 链接本工单；§3 表计数
  不变（P7 已在 30 行内）；R1 主干状态见 §7 后里程碑。
- `docs/11-structure.md`：状态行补 P7（`...P6/P7 已施工；R1 待里程碑验收`）。
- `docs/10-wiring.md`：状态行补 H6（H2/H3/H9 仍设计态）。
- `docs/13-harness-plugin-spec.md`：§3.9 更新为已施工事实（`createToolPort` 签名与
  T-entry/T-note 决策构造器）；§5 落位表 `src/platform/tools.ts` → 已施工（P7）。
- `AGENTS.md`/`README.md`：R1 里程碑验收时统一回写（见 §7 后），P7 不单改。

## 4. 实现要点（每步独立可验证；顺序执行）

1. **核验 harness**（§2.3）：逐条 grep 到定义处，确认 `tools/execute`/`tools/post-execute`
   签名与 `PostToolDecision` 形状；不一致停工上报。
2. **改 package.json + build.sh**（§3.5）→ `DSH_CHECKOUT=G:/deepseek-harness npm run build` 绿。
3. **写 `src/platform/tools.ts`**（§3.1）→ `npm run typecheck` 绿。
4. **写 `tests/tools.spec.ts`**（§3.2）→ `npm test` 绿（新增七组用例）。
5. **追加 D8**（§3.4）→ `npm run assert` 绿；更新 `tests/assert-structure.spec.ts` 快照与
   正/负样本 → `npm test` 绿。
6. **写 `scripts/verify-p7.mjs`**（§3.3）→ `node scripts/verify-p7.mjs` 输出 `P7 VERIFY PASS`。
7. **全链自验**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`；`npm run gate`；
   `npm run typecheck:tests`；`node scripts/assert-structure.mjs --json` 双跑 diff 空。
8. 对照 §5 清单逐条打勾；全部满足后执行 §3.5 文档回写，再进 §7。

## 5. 验收（全机械 + agent 自动化检查）

- [ ] `node scripts/verify-p7.mjs` 输出 `P7 VERIFY PASS`
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0（build.sh 已链接 dsh-tools）
- [ ] `npm run typecheck && npm run typecheck:client && npm run typecheck:tests && npm test && npm run assert` 全绿
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次逐字节一致；零位快照含 `D8:pass`
- [ ] `tests/tools.spec.ts` 七组用例齐全且绿（vitest 输出可见）
- [ ] D8 反向扫描命中集合恰为 `['src/platform/tools.ts']`
- [ ] `grep -Rn "session.append\|\.append(" src/platform/tools.ts` 无命中（零会话写入）
- [ ] `grep -Rn "from '../core\|@deepseek-ai/dsh-session\|@deepseek-ai/dsh-storage-domain\|setInterval(\|fetch(\|http.get\|axios\|readFile\|watchFile\|chokidar" src/platform/tools.ts`
      无命中
- [ ] `git diff tests/llm-purpose.spec.ts tests/history.spec.ts tests/skills.spec.ts tests/storage.spec.ts` 为空（既有测试零改动；仅 `tools.spec.ts` 与 `assert-structure.spec.ts` 按本单追加）
- [ ] 行数预算：`src/platform/tools.ts ≤200`、`tests/tools.spec.ts ≤180`、`scripts/verify-p7.mjs ≤100`（`wc -l`）
- [ ] `git diff --cached` 为空（提交前工作树与暂存区一致）

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **execute 不短路**：`tools/execute` 监听器恒 `return next()`；hook 只读 exec，不得
   修改 exec.signal 以外的任何字段（本端口不提供修改面）。
2. **post-execute 不替代裁决**：端口只转发 hook 决策；T-entry/T-note 的业务判据归
   P15a/P15b，P7 不得内置任何剪切规则。
3. **零 index.ts 改动**：P7 无运行期消费者；装配根接线从 P15b 起由 domains 侧消费。
4. **零会话事件**：不声明 `context-economy/*` 事件；工具剪切度量归 P15b/P2 fold 扩展。
5. **D8 只管工具事件概念**：`ContentBlock` 不纳入（events.ts 需要）；也不拦
   `acceptWithContent` 等插件侧符号。
6. **停工上报触发器**：① §2.3 核验签名与设计不符；② `tools/post-execute` 监听器返回
   普通对象不被 waterfall 接受（需 `Promise.resolve` 包裹）；③ D8 负样本暴露
   `src/platform/events.ts` 现有 `ContentBlock` import 被误伤且正则无法精确收口；④ 行数
   预算超限且无法精简；⑤ 任何未覆盖决策点。上报带证据（命令 + 输出 + file:line）。

## 7. 完成动作与 R1 里程碑交接

- commit（单笔，验收全绿后）：
  `feat(p7): 工具端口——tools/post-execute content 覆盖/追加 + tools/execute 信号计量 + D8 收口`
- 账本快照：**本单不需要**（端口无机制改动；R1 段末账本快照见下）。
- 汇报（**本单最后一步，执行者必须完成**）：按 §9 向用户报告修改内容、功能实现与文档对应表。

**P7 是 R1 平台面最后一单**。P7 验收通过后，按 `docs/implement/00-master.md` §4 执行
R1 里程碑验收（不并入本单 commit）：
1. `npm run gate` + `node scripts/verify-p7.mjs` 全绿（本单已做）；
2. **账本快照**：改动前后各留一份 07 报表（纯回放管道产出），入 `docs/ledger-history.md`
   追记（只增不改）；
3. **结构断言**：`npm run assert` 全绿（core 零 import / 改史归口 / ignorable / UI 不变量 /
   D1–D8 收口）；
4. **R1 出门门槛核对**：按 `docs/11 §8` R1 行逐条打勾（账本字段能从 JSONL 回放；ignorable
   断言过；platform 七端口齐）；
5. 回写 `AGENTS.md`/`README.md` 现状段为 “R1 已完成，R2 判别域待开工”。

## 8. 对接面（P7 如何被后续计划消费）与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式（P7 提供） |
|---|---|
| P15a 工具剪切纯核 | 只依赖 P2；其裁决结果（T-entry/T-note 动作）由 P15b 经 P7 端口执行 |
| P15b 工具剪切调度 | `createToolPort(ctx, { onExecute, onPostExecute })`：`onExecute` 记信号/计量；
  `onPostExecute` 根据 P15a 判据返回 `replaceContent`（T-entry 写时整形）或
  `appendContent`（T-note 贴注）；短路决策进入 harness `tools/post-execute` 瀑布 |
| P16 对话剪切 | 不经 P7（走 P6 history 端口做 surfaceOp replace） |
| P21b 全链验收 | `tools/execute` 信号/计量与 `tools/post-execute` 决策计数作为工具剪切账本原料 |

### 8.2 对后续计划的修正（随本计划先行回写 `docs/implement/00-master.md`）

| 行 | 原表述/依赖 | 修正为 | 理由 |
|---|---|---|---|
| P7 | 无工单链接 | 链接 `P7-tools.md` | 工单已立 |
| P7 | 依赖 P1 | 不变 | 不依赖 P2–P6；tools 端口与 events 同层 |
| P15b | 依赖 `P15a,P6,P7,P12,P2` | 不变 | P7 按计划供给 post-execute 端口；P15b 仍依赖 P6 做 surfaceOp replace |
| docs/13 tools 节 | §3.8（P6 前编号） | §3.9（P6.1 顺延后） | P6.1 新增 §3.8 dsh-compaction |
| R1 里程碑 | 未显式列入 P7 | P7 完成后按总纲 §4 执行 R1 出门验收 | P7 是 R1 最后一单 |

## 9. 汇报模板（本单最后一步）

1. **修改内容**：列出新增/改动文件与行数；`tests/assert-structure.spec.ts` 仅 D8 样本与
   快照变化；既有测试零改动。
2. **功能实现**：`createToolPort` 注册/卸载/统计；`tools/execute` 信号计量不短路；
   `tools/post-execute` 决策短路与异常委托；`replaceContent`/`appendContent` 决策构造器；
   D8 收口；verify-p7 结果。
3. **与文档对应表**：

| 功能 | 代码 | 文档 |
|---|---|---|
| H6 工具事件端口 | `src/platform/tools.ts` | docs/10 §1 H6；docs/11 §2 tools.ts 行 |
| post-execute content 覆盖/追加 | `replaceContent` / `appendContent` | docs/10 §1 H6；docs/13 §3.9 |
| execute 仅信号/计量 | `createToolPort` execute 监听器恒 `return next()` | docs/10 §1 H6 |
| 失败默认保留 | 异常 catch + warn + `return next()` | docs/11 §4 纪律②③；docs/05 回退链 |
| D8 工具概念收口 | `scripts/assert-structure.mjs` D8 | docs/10 §1 H6；docs/11 §2 |
| 自动化验收 | `scripts/verify-p7.mjs` | 总纲 §2 铁律 2 + §5 全机械验收 |

4. **R1 里程碑交接**：P7 完成后是否已按 §7 执行 R1 出门验收（账本快照/结构断言/门槛核对）。
