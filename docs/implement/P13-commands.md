# P13 命令面 + init 项目帧（映射 R2；依赖 P8,P9,P11,P3,P12,P5；尺寸 M）

> 状态：**未执行（待施工）**。前序：P8 稳定前缀已施工（commit `fa8fdab` + fix `037b413`）；
> P9 卷宗纯核已施工（commit `78f33ad`）；P10 判据与对表纯核已施工（commit `e00fbd7` + fix `7d435b2`）；
> P11 星标断面纯核已施工（commit `9e5de9b` + 修正 `4a20d32`/`0b079b0`/`eb1d9b4`/`7595c43`）；
> P12 自动断面服务已施工（commit `6746c1b` + 文档回写 `579f42e`）。
> `node scripts/verify-p8.mjs`、`verify-p9.mjs`、`verify-p10.mjs`、`verify-p11.mjs`、`verify-p12.mjs`
> 均输出 PASS；`npm run gate` 绿。
> 本单交付命令面 `domains/commands.ts` 与 init 项目帧采集：注册 `/task`（open/close/status）、
> `/init`（propose/confirm/cancel/status）、`/optimize-prompt`（入口注册，完整断面由 P14b 接入），
> 发射 `context-economy/task-boundary` 事实，写入 `project_frame` v1（用户确认后）。
> 设计正典：[02 §2/§3](../02-discriminator.md)（项目帧 init 采集、T0 命令与 task-boundary 事实）/
> [09 §2](../09-state.md)（项目帧实体与版本协议）/
> [10 §1/§2](../10-wiring.md)（H8/H10/H14 挂点、命令面）/
> [11 §2/§5/§6](../11-structure.md)（模块树 `domains/commands.ts` + `core/init.ts`、对应律）/
> [P8 工单](P8-units-prefix.md) §2.4-1（`task-boundary` 事实契约）/
> [P11 工单](P11-optimize.md) §8.1（`/optimize-prompt` 命令处理复用 P11 核）/
> [P12 工单](P12-input.md) §8.1（T0 分工：P12 只记账不发射 `task-boundary`；P13 必须复用 `core/t0.ts`）。
> harness 符号清单：`ctx.inject(['commands','skills','llm'])` / `ctx.commands.register` /
> `session.snapshotEvents()` / `listSkillCatalog` / `streamCeLlm` / `emitCeFact` / `storageDomain`
> ——全部经既有 `platform/` 端口或类型注入消费，本单不新增直接 harness 运行时 import
> （`src/domains` 允许 import platform/core，以及 type-only 的 `@deepseek-ai/dsh-commands`）。

## 0. 前序落地审查结论（P8–P12）与本单必须吸收的要点

审查日期：2026-09-08。当前 R2 判别域 P8–P12 全部已施工，`git status` 干净，
P8–P12 五个 verify 脚本全部 PASS，`npm run gate` 全绿。与本单直接相关的落地形状如下：

1. **T0 解析已存在且必须复用**：`src/core/t0.ts` 的 `parseT0Command` 已能识别
   `/task close` 与 `/task <描述>`；P13 不得另写 T0 语义。命令处理器收到的是
   `rawInput`（命令名之后的原文），用 `parseT0Command('/task' + rawInput)` 即可复用。
2. **`task-boundary` 常量已有，但事实声明缺失**：`src/core/ledger/facts.ts` 已导出
   `TASK_BOUNDARY_FACT_TYPE = 'context-economy/task-boundary'`；但 `src` 内尚无
   `SessionEventMap`/`IgnorableSessionEventMap` 声明合并，因此当前 `emitCeFact` 的
   `CeFactType` 不含 `task-boundary`，P13 无法通过类型检查发射该事实。本单必须新建
   `src/domains/task-facts.ts` 补齐双侧声明合并（见 §3.1）。
3. **P8 已冻结 task-boundary 数据契约**：`data = { taskId: string; boundary?: 'open' | 'close';
   reason?: string }`；`boundary` 缺省 = `close`。`foldSegmentState` 对 T0 的处理：
   `open` 闭合当前段并开启新段；`close` 命名并闭合当前段，然后开启自动尾段。
   P13 只写事实、不碰 fold 逻辑。
4. **项目帧纯核已就绪**：`src/core/prefix.ts` 已导出 `createProjectFrame(goal, aspects, catalog)`、
   `projectFrameStorageKey(workspace)`、`renderStablePrefix`。P13 写入 `project_frame` 时必须
   复用 `projectFrameStorageKey`；写入表名 = `'project_frame'`，source.taskId = `'project-frame'`。
5. **技能目录端口已就绪**：`src/platform/skills.ts` 已导出 `listSkillCatalog(ctx)`；
   `catalog.complete === false` 或 `catalog === undefined` 时 P8 不创建项目帧（返回 null），
   P13 在 `/init confirm` 时也必须拒绝写入，等目录完整后再确认。
6. **LLM 端口已就绪但缺 init purpose**：`src/platform/llm.ts` 的 `CE_AUX_PURPOSES` 当前只有
   `context-economy-judge/optimize/compaction`。本单 init 提案需要新增
   `'context-economy-init'`（§3.3），并同步更新 `tests/llm-purpose.spec.ts` 的词汇冻结断言。
7. **命令服务可用形态已核验**：`@deepseek-ai/dsh-commands` 已安装，`ctx.inject(['commands'], cb)`
   取得注入上下文后调用 `commandsCtx.commands.register(definition)`，返回 unregister disposer；
   `CommandDefinition` 需 `name`（小写无斜杠）、`description`、可选 `input.hint`、
   `recordInput`、`handler`。本单不新增直接 harness 运行时 import（仅 type-only）。
8. **P12 已具备事实回灌**：P13 发射的 `task-boundary` 会经 firehose 进入
   `facts/session-event`，P12 自动断面的 `factsBySession` 将自动分桶；P13 不需要也不允许
   直接向 P12 内部数组写数据。
9. **P12 遗留观察（不在本单处理，只记录）**：
   - `factsBySession` 未限制会话桶数量，长跑多会话时可能缓慢增长；P13 不消费该结构，
     但 P13 自己的 pending init 表必须设上限（§2.3 决策 6）。
   - `tests/input.spec.ts` 的会话隔离用例目前只断言去重计数，未断言“A 的 new-task 不串到 B”
     的完整行为；P13 的测试在命令面复用时按完整行为断言。

## 1. 目标

1. 在装配根以可选服务方式挂载命令面：`ctx.inject(['commands'], cb)`，注册三个命令：
   `/task`、`/init`、`/optimize-prompt`；服务缺失时插件其余功能不受影响。
2. `/task` 命令：`/task <描述>` 发射 `task-boundary{boundary:'open'}`；`/task close` 发射
   `task-boundary{boundary:'close'}`；`/task` 无参显示当前 task 状态（taskId、卷宗规模、标注）。
3. `/init` 命令：`/init <goal>` 经 LLM 整理成 `{goal, aspects}` 提案并暂存；
   `/init confirm` 在用户确认后写 `project_frame` v1；`/init cancel` 丢弃提案；
   `/init` 无参显示当前项目帧或引导 init。
4. `/optimize-prompt` 命令：注册命令入口；P13 只提供 `manualOptimize` 委托点，默认返回明确错误
   “P14b 未接入”；P14b 施工时传入真实 handler 即可复用同一命令入口。
5. 全程 fail-lazy：命令处理器任何异常只返回 `{kind:'error', text}`，不抛给命令框架；
   fact 发射只经 `emitCeFact`；KV 写只经 P3 `putEntity`；不直接 `session.append`。

## 2. 输入

### 2.1 正典摘录（工单自足；与正典冲突以正典为准并停工上报）

- **02 §2 项目帧**：项目最终目标 + 方面分解 + 技能目录快照；init 采集 = v1；
  采集走 init 过程：首次会话一次 LLM 整理 + **用户确认**，落项目帧 v1；修订经星标/设置，版本 +1。
- **02 §3 T0**：`/task <描述>`（open）/ `/task close`（close）→ 边界事实，判别器只记账；
  P12 只记账不发射 `task-boundary`（避免双发）；P13 发射该事实。
- **09 §2 项目帧**：写入必须带 `source`；同实体同轮只允许一次提交；init（用户确认）写 v1。
- **10 §2 命令面**：`/task <描述>`、`/task close`、`/task`（无参）、`/optimize-prompt`；
  `/compact` 非边界，P13 不注册（DSH 原生）。
- **10 §1 H14**：`context-economy/*` 事实只经 `emitCeFact` 发射（ignorable 通道，降级 KV 镜像）。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/core/t0.ts` | `parseT0Command` | 复用；不修改 |
| `src/core/prefix.ts` | `createProjectFrame` / `projectFrameStorageKey` / `renderStablePrefix` / `ProjectFrameBody` | 复用；不修改 |
| `src/core/ledger/facts.ts` | `TASK_BOUNDARY_FACT_TYPE` / `factsFromSessionEvents` | 复用；不修改 |
| `src/core/units.ts` | `foldSegmentState` / `TaskBoundaryFactData` / `JudgeVerdictFactData` | 复用；不修改 |
| `src/core/dossier.ts` | `dossierStorageKey` / `foldDossierLedger` / `DossierBody` | 复用；不修改 |
| `src/platform/llm.ts` | `streamCeLlm` / `CE_AUX_PURPOSES` / `CeGenerateOptions` | **改**：`CE_AUX_PURPOSES` 增 `'context-economy-init'`（§3.3） |
| `src/platform/skills.ts` | `listSkillCatalog` / `SkillCatalogSnapshot` | 复用；不修改 |
| `src/platform/logger.ts` | `emitCeFact` / `ceLogger` | 复用；不修改 |
| `src/platform/storage.ts` | `ContextEconomyStorage` / `ENTITY_TABLES` | 复用；不修改 |
| `src/domains/judge-facts.ts` | 声明合并先例（judge 三事实） | 参照其形态新建 task-facts；不修改 |
| `src/index.ts` | 装配根 | **改**：命令面挂载（§3.6） |
| `tests/llm-purpose.spec.ts` | purpose 词汇冻结断言 | **改**：三值变四值（§3.9） |
| `tsconfig.tests.json` | include 列表 | 增 `tests/commands.spec.ts` |
| `docs/implement/00-master.md` | P13 行 | 实现后回写 `已施工 commit <hash>`；先补工单链接 |

### 2.3 决策点记录（执行者不再自行裁量）

1. **命令名与定义冻结**：
   - `task`：`description='任务边界'`，`input.hint='<描述> / close / 无参查看'`，`recordInput=true`；
   - `init`：`description='初始化项目帧'`，`input.hint='<项目目标> / confirm / cancel / 无参查看'`，`recordInput=true`；
   - `optimize-prompt`：`description='优化当前 prompt'`，`input.hint=''`，`recordInput=false`（断面输入由 P14b 从卷宗/编辑器取，不记录命令行文本）。
   命令名必须小写无斜杠；`optimize-prompt` 含连字符合法（COMMAND_NAME 正则允许）。
2. **T0 命令语义（P13 端）**：
   - `rawInput` 为命令名后原文（含前导空白）。`parseT0Command('/task' + rawInput)`：
     `boundary:'close'` → close；`boundary:'open'` → open；`boundary:null` → 无参 status。
   - 若 `rawInput` 为 `/task close extra` 之类不合法输入，`parseT0Command` 返回 null；
     P13 按 status 处理会显示任务状态并附带“用法提示”。（不新增额外解析分支。）
3. **task-boundary 发射契约**：
   - `open`：先 `segments = foldSegmentState(facts)`，`taskId = 'task-' + (segments.segments.length + 1)`；
     `data = { taskId, boundary:'open', reason: parsed.description }`。
   - `close`：`taskId = segments.segments.at(-1)!.taskId`；
     `data = { taskId, boundary:'close', reason:'/task close' }`。
   - 发射只经 `emitCeFact(session, TASK_BOUNDARY_FACT_TYPE, data, logger)`；发射后命令返回成功文本。
4. **task status 语义**：`foldSegmentState(facts)` 取最后段 taskId；读
   `storage.getEntity('dossier', dossierStorageKey(taskId))`；无记录显示空卷宗。
   显示：`taskId`、消息数、文本总长、三分类标注计数（来自 `foldDossierLedger`）、卷宗版本。
5. **`facts` 来源**：命令处理器从 `session.snapshotEvents()` 读取会话事件，过滤
   `context-economy/*` 后经 `factsFromSessionEvents` 转成 `LedgerFact[]`；不维护命令面自有事实桶。
   若 `session.snapshotEvents` 缺失（测试/极旧宿主），按空事实处理（status = task-1）。
6. **init 提案流程**：
   - `/init <goal>`：goal trim 后非空且 ≤ 500 字符。若 `project_frame` 已存在 → error；
     否则调 `streamCeLlm(llmCtx, {provider,model,messages:[...], purpose:'context-economy-init',
     temperature:0})`，解析 `{goal, aspects}`；成功后将提案写入
     `pendingInit: Map<sessionId, {goal, aspects, time}>`（上限 32，FIFO 淘汰最旧会话）。
     返回提案文本与 `/init confirm` / `/init cancel` 提示。
   - `/init confirm`：取当前会话 pending；无 pending → error。调 `listSkillCatalog(skillsCtx)`；
     `catalog === undefined || catalog.complete === false` → error（等目录完整）。用
     `createProjectFrame(goal, aspects, catalog)` 生成 v1；`putEntity('project_frame',
     projectFrameStorageKey(workspace), body, {taskId:'project-frame', eventType:'init-frame',
     evidence:{goal, aspectCount: aspects.length}}, {baseVersion:0})` 写入。成功后清 pending 并返回成功文本。
   - `/init cancel`：清 pending 并返回成功。
   - `/init` 无参：读 `project_frame`；存在 → 显示 goal/aspects/version；不存在 → 引导
     `/init <项目目标>`。
   - 已存在项目帧时 `/init <goal>` 返回 error（修订经星标/设置，不在本单）。
7. **init LLM 模型路由**：复用 P12 的 `resolveJudgeModel`？不——init 是另一域，但模型路由策略
   相同：`config.discriminator.provider/model` 覆盖，缺省
   `{provider:'deepseek-official', model:'deepseek-v4-flash-vision-exp'}`。P13 在
   `src/domains/commands.ts` 内实现 `resolveInitModel(config)`（同构逻辑，不复用 P12 内部符号，
   避免命令面与自动断面服务耦合）。调用参数：
   `messages:[{role:'user', content:[{type:'text', text: rendered}]}]`，`purpose:'context-economy-init'`，
   `temperature:0`；文本流只拼 `text-delta`；`finish` 非 `stop` 视为失败。
8. **/optimize-prompt 委托点**：`mountCommandFace` 接收可选
   `manualOptimize?: (session: Session, rawInput: string) => CommandResult | Promise<CommandResult>`。
   P13 默认不传 → handler 返回 `{kind:'error', text:'/optimize-prompt 入口已注册；完整断面由 P14b 接入后开放。'}`。
   P14b 施工时传入真实 handler（同一命令入口，不再重复注册）。
9. **facts/session-event 透传已存在**：P13 不修改 `platform/events.ts`；发射的 `task-boundary`
   自然进入 P12 的 `factsBySession`。
10. **可选服务纪律**：`commands`/`skills`/`llm` 全部经 `ctx.inject` 子 fiber 取得；命令面挂载
    在 storage 打开成功后；`commands` 缺失则无命令面，`skills`/`llm` 缺失时 `/init` 返回
    明确的“服务不可用”错误，`/task` 不受影响。
11. **verify-p13 轻量化**：只跑一次完整 gate + P12/P8/P9 专项 grep + P13 专项扫描。

## 3. 产出

### 3.1 `src/domains/task-facts.ts`（新，≤80 行）

```ts
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { TASK_BOUNDARY_FACT_TYPE } from '../core/ledger/facts.ts'
import type { TaskBoundaryFactData } from '../core/units.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'context-economy/task-boundary': TaskBoundaryFactData // ignorable
  }
  interface IgnorableSessionEventMap {
    'context-economy/task-boundary': TaskBoundaryFactData // ignorable
  }
}

export interface TaskBoundaryCommand {
  boundary: 'open' | 'close'
  taskId: string
  reason?: string
}

export function buildTaskBoundaryData(cmd: TaskBoundaryCommand): TaskBoundaryFactData {
  return { taskId: cmd.taskId, boundary: cmd.boundary, ...(cmd.reason === undefined ? {} : { reason: cmd.reason }) }
}

export { TASK_BOUNDARY_FACT_TYPE }
```

**语义**：只做声明合并与数据构造；不发射事实、不 import 运行期 harness。`buildTaskBoundaryData`
必须返回新对象，字段只在 `reason` 存在时携带（与 P8 契约 `{taskId,boundary?,reason?}` 对齐）。

### 3.2 `src/core/init.ts`（新，≤160 行；core 零 harness/platform import）

```ts
export const INIT_PROMPT_VERSION = 1
export const INIT_PROMPT_HEAD = '你是项目帧采集器。…（冻结：输入用户给出的项目目标，输出 JSON）'
export const INIT_PROMPT_OUTPUT = '输出（仅 JSON，无其他文本）：\n{"goal":"<原目标，可润色但不得改变意图>","aspects":["方面1","方面2"]}'

export interface InitProposal { goal: string; aspects: string[] }

export function clampInitGoal(goal: string, maxChars?: number): string
export function renderInitPrompt(goal: string): string
export function parseInitOutput(raw: string): InitProposal | null
```

**语义（实现必须逐字照抄；冲突以正典为准停工）：**

1. `clampInitGoal`：trim；空串返回 `''`；超过 500 字符时截断为头 500 字符（不做中缀省略，因为
   这是命令输入不是 prompt 实例；确定性优先）。
2. `renderInitPrompt`：`INIT_PROMPT_HEAD + '\n\n<用户项目目标>\n' + clamped + '\n\n' + INIT_PROMPT_OUTPUT`。
   字节稳定；模板在前、实例在后。
3. `parseInitOutput`：与 P10 `parseJudgeLlmOutput` 同构的 fail-lazy 解析：去代码围栏、`JSON.parse`；
   `goal` 必须为非空 string（trim 后 ≤ 500）；`aspects` 必须为 string 数组，每项 trim 后非空且 ≤ 80，
   去重后最多 8 项；任一不合法 → `null`。返回 `{goal: trimmed, aspects: deduped}`。
4. 零外部状态；不 import platform/harness；不抛错。

### 3.3 `src/platform/llm.ts`（改，净增 ≤5 行）

- `CE_AUX_PURPOSES` 由三值改为四值（新增 `'context-economy-init'`）：
  `'context-economy-judge' | 'context-economy-optimize' | 'context-economy-compaction' | 'context-economy-init'`。
- 其余不修改。

### 3.4 `src/domains/commands.ts`（新，≤340 行）

```ts
import type { Session } from '@deepseek-ai/dsh-session'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import { parseT0Command } from '../core/t0.ts'
import { factsFromSessionEvents, TASK_BOUNDARY_FACT_TYPE } from '../core/ledger/facts.ts'
import { foldSegmentState } from '../core/units.ts'
import { createProjectFrame, projectFrameStorageKey, type ProjectFrameBody } from '../core/prefix.ts'
import { dossierStorageKey, foldDossierLedger, type DossierBody } from '../core/dossier.ts'
import { streamCeLlm, type CeGenerateOptions } from '../platform/llm.ts'
import { emitCeFact } from '../platform/logger.ts'
import { listSkillCatalog } from '../platform/skills.ts'
import type { EventPump? no —— 不依赖 pump }
import type { ContextEconomyStorage } from '../platform/storage.ts'
import type { Config as ConfigShape } from '../config.ts'
import type { CeLogger } from '../platform/events.ts'
import { renderInitPrompt, parseInitOutput, clampInitGoal } from '../core/init.ts'
import { buildTaskBoundaryData } from './task-facts.ts'

export interface CommandFaceDeps {
  commandsCtx: Pick<Context, 'commands'>
  storage: ContextEconomyStorage
  getConfig: () => ConfigShape
  logger: CeLogger
  workspace?: string
  now?: () => number
  skillsCtx?: Pick<Context, 'skills' | 'logger'>
  llmCtx?: Pick<Context, 'llm'>
  manualOptimize?: (session: Session, rawInput: string) => CommandResult | Promise<CommandResult>
  emitFact?: (session: Session, type: string, data: unknown, logger?: CeLogger) => void
}

export interface CommandFace {
  dispose(): void
  stats(): { pendingInits: number; taskCommands: number; initCommands: number; optimizeCommands: number }
}

export function resolveInitModel(config: ConfigShape): { provider: string; model: string }
export function mountCommandFace(deps: CommandFaceDeps): CommandFace
```

**语义（实现必须逐字照抄；冲突以正典为准停工）：**

1. **注册**：`mountCommandFace` 在 `deps.commandsCtx.commands` 上注册 `task`、`init`、
   `optimize-prompt` 三个 `CommandDefinition`；`register` 返回的 disposer 全部保存，
   `dispose()` 时逆序调用。注册顺序 = `task`、`init`、`optimize-prompt`。
2. **fact 发射单点**：`const emit = deps.emitFact ?? emitCeFact`。`task`/`init` 所有事实发射
   只经 `emit`（默认 `emitCeFact`），不得直接 `session.append`。
3. **sessionId**：优先 `session.header?.id`，缺省 `String(session.id ?? 'session')`；与 P12 同口径。
4. **facts 读取**：`const events = session.snapshotEvents?.() ?? []`；过滤
   `context-economy/*` 后经 `factsFromSessionEvents` 转 `LedgerFact[]`。实现时必须对
   `snapshotEvents` 缺失做防御（按空数组处理）。
5. **task handler**：
   - `full = '/task' + invocation.rawInput`；`parsed = parseT0Command(full)`；
   - `facts` 与 `segments = foldSegmentState(facts)` 仅在有事实或 status 时计算一次；
   - `parsed.boundary === 'open'`：`nextTaskId = 'task-' + (segments.segments.length + 1)`；
     `emit(session, TASK_BOUNDARY_FACT_TYPE, buildTaskBoundaryData({boundary:'open', taskId: nextTaskId, reason: parsed.description}), logger)`；
     返回 `{kind:'success', text:'已开启任务 ' + nextTaskId + '：' + parsed.description}`；
   - `parsed.boundary === 'close'`：`currentTaskId = segments.segments.at(-1)!.taskId`；
     `emit(..., {boundary:'close', taskId: currentTaskId, reason:'/task close'})`；
     返回 `{kind:'success', text:'已闭合任务 ' + currentTaskId}`；
   - `parsed.boundary === null`（status）：读 dossier 并返回状态文本（见 §2.3 决策 4）。
6. **init handler**：
   - 解析 `rawInput`：trim 后为 `''` → status；`'confirm'` → confirm；`'cancel'` → cancel；
     其余 → propose。`/init confirm extra` 等一律按 propose 处理（goal 为 `confirm extra`）——
     因为 `confirm`/`cancel` 是完整词，不允许带额外参数；实现用 `raw === 'confirm'` 精确匹配。
   - propose：`clampInitGoal` 后空 → error。`project_frame` 已存在 → error。
     `llmCtx === undefined` → error `'LLM 服务不可用，无法初始化项目帧'`。
     `resolveInitModel(getConfig())` 取 provider/model；`renderInitPrompt(goal)`；
     `streamCeLlm(llmCtx, {provider, model, messages:[{role:'user', content:[{type:'text',
     text: rendered}]}], purpose:'context-economy-init', temperature:0}, {onUsage: noop, logger})`
     收流拼文本；`finish` 非 `stop` 或 `parseInitOutput` 为 null → error。
     成功后写 `pendingInit`（FIFO 上限 32）；返回提案文本。
   - confirm：`pendingInit.get(sid)` 无 → error。`skillsCtx === undefined` 或
     `listSkillCatalog` 返回 `undefined`/`complete:false` → error。`createProjectFrame` →
     `storage.putEntity('project_frame', projectFrameStorageKey(workspace), result.body,
     {taskId:'project-frame', eventType:'init-frame', evidence:{goal, aspectCount: aspects.length}},
     {baseVersion:0})`。成功清 pending；CAS 失败/已存在 → error。
   - cancel：清 pending → success。
   - status：读 `project_frame`；存在显示版本/目标/方面/技能目录快照技能数；不存在引导 propose。
7. **optimize-prompt handler**：`deps.manualOptimize` 存在则委托
   `deps.manualOptimize(invocation.agent.session, invocation.rawInput)`；否则返回
   `{kind:'error', text:'/optimize-prompt 入口已注册；完整断面由 P14b 接入后开放。'}`。
8. **零阻塞与 fail-lazy**：命令 handler 可为 async，但不得有 timer；所有异常 catch 后返回
   `{kind:'error', text: '命令执行失败：' + message}`；不抛给命令框架。
9. **统计**：`stats()` 返回 `pendingInits`、`taskCommands`、`initCommands`、`optimizeCommands`
   三个命令的累计调用次数；纯计数，不参与度量 fold（度量账本不记命令次数）。

### 3.5 `src/index.ts`（改，净增 ≤40 行）

- 在 storage 打开成功后，将现有 `ctx.inject(['skills'], ...)` 与 `ctx.inject(['llm'], ...)`
  的局部 ctx 外提为 `let skillsCtx: Context | undefined` / `let llmCtx: Context | undefined`；
  两个 inject 回调内分别赋值后再启动原有 watch / auto。
- 新增 `let stopCommands: (() => void) | undefined`；在 `ctx.inject(['llm'], ...)` 之后增加：
  ```ts
  ctx.inject(['commands'], (commandsCtx) => {
    if (disposed) return
    stopCommands = mountCommandFace(commandsCtx as Context, {
      storage: opened,
      getConfig,
      logger: ceLogger(commandsCtx),
      workspace: process.cwd().replaceAll('\\', '/'),
      skillsCtx,
      llmCtx,
    }).dispose
  })
  ```
- 外层 disposer 在 `stopSkillWatch?.()` / `stopAuto?.()` 旁增加 `stopCommands?.()`。
- 保持 `commands`/`skills`/`llm` 全部为可选服务；缺任一服务时对应功能缺失但不影响其余。

### 3.6 `tests/commands.spec.ts`（新，≤360 行；全部 fake，零 cordis 运行时 import）

用例（九组，命名含 `command` 或 `init`）：

1. **task-facts 声明**：`buildTaskBoundaryData` 返回新对象且 `reason` 缺省不携带；
   type-level 断言 `SessionEventMap['context-economy/task-boundary']` 可赋值。
2. **init 纯核**：`clampInitGoal` 超长截断；`renderInitPrompt` 字节稳定；`parseInitOutput`
   合法 JSON、坏 JSON、aspects 超 8 项/空项/超 80 字 → 预期行为。
3. **/task open**：fake session 带 0 条事实 → 发射 `task-boundary{boundary:'open',
   taskId:'task-2'}`；返回成功文本含 task-2。`emitFact` 用 spy。
4. **/task close**：fake session 事实含 1 条 open(task-2) → 发射
   `task-boundary{boundary:'close', taskId:'task-2'}`；返回成功文本含 task-2。
5. **/task status**：预置 dossier v3（两条消息）→ `/task` 无参返回文本含 `task-1`、`2` 条、
   卷宗版本 3；不发射事实。
6. **/init propose + confirm**：fake llm 输出 `{"goal":"g","aspects":["a","b"]}`；
   fake skills 返回 `{skills:[], complete:true}`；propose 成功 → confirm 写
   `project_frame:ws` v1 且 body 为 `createProjectFrame` 结果；`pendingInit` 清空；
   project_frame 已存在时再次 propose 返回 error。
7. **/init 守卫**：无 pending confirm → error；`skillsCtx` 缺失 → error；
   `listSkillCatalog` 返回 `complete:false` → error；LLM 坏 JSON → error。
8. **/optimize-prompt 委托**：未传 `manualOptimize` → error；传入 fake handler → 返回其返回值，
   且 `optimizeCommands` 计数 +1。
9. **dispose 与计数**：三个命令各调一次后 `stats()` 计数正确；`dispose()` 逆序 unregister
   （fake registry 记录删除顺序）。

### 3.7 `tests/llm-purpose.spec.ts`（改）

- `CE_AUX_PURPOSES` 断言改为四值（新增 `'context-economy-init'`）。

### 3.8 `scripts/verify-p13.mjs`（新，≤160 行；agent 自动化验收入口，轻量模式）

流程（确定性输出，exit 0/1；**只跑一次完整 gate**）：

1. **前序专项门（轻量）**：
   - `src/core/t0.ts` 含 `parseT0Command`；
   - `src/core/prefix.ts` 含 `createProjectFrame` / `projectFrameStorageKey`；
   - `src/core/ledger/facts.ts` 含 `TASK_BOUNDARY_FACT_TYPE` / `factsFromSessionEvents`；
   - `src/platform/llm.ts` 含 `streamCeLlm` 与 `context-economy-init`；
   - `src/domains/input.ts` 含 `mountAutoDiscriminator`（P12 基线）。
2. **build（有 checkout 则构建；缺 checkout 记录 SKIP 继续）**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`。
3. **一次完整门禁**：`npm run gate` 非 0 即 FAIL；`npm run typecheck:tests` 非 0 即 FAIL。
4. **断言确定性**：`node scripts/assert-structure.mjs --json` 连跑两次，diff 非空即 FAIL。
5. **反向扫描（期望 0 命中）**：
   - `src/core/init.ts`：`@deepseek-ai/`、`from 'cordis`、`platform/`、`ctx\.`、`session.append`、
     `context-economy/`、`fetch(`、`http.get`、`axios`；
   - `src/domains/commands.ts`：`session.append`（事实发射只经 `emitCeFact`/注入 emit）、
     `ctx.on('session/event')`、`setInterval(`、`fetch(`、`http.get`、`axios`；
   - `src/domains/task-facts.ts`：不得出现 `emitCeFact` 调用、`session.append`。
6. **正向扫描（期望 ≥1 命中）**：
   - `src/domains/commands.ts`：`mountCommandFace` / `parseT0Command` /
     `TASK_BOUNDARY_FACT_TYPE` / `foldSegmentState` / `createProjectFrame` /
     `projectFrameStorageKey` / `streamCeLlm` / `listSkillCatalog` / `commands.register`；
   - `src/domains/task-facts.ts`：`context-economy/task-boundary` 同时出现在
     `SessionEventMap` 与 `IgnorableSessionEventMap` 窗口；
   - `src/core/init.ts`：`renderInitPrompt` / `parseInitOutput`；
   - `src/platform/llm.ts`：`context-economy-init`；
   - `src/index.ts`：`mountCommandFace`、`ctx.inject(['commands']`；
   - `tests/commands.spec.ts`：`describe('command face` 或 `describe('init`。
7. **lib 新鲜度检查**：`lib/index.js` 存在且含 `mountCommandFace` 或 `context-economy-init`，
   且不含 `export const inject = ['commands']`（可选服务纪律）。
8. **行数预算**：`src/domains/task-facts.ts ≤80`、`src/core/init.ts ≤160`、
   `src/domains/commands.ts ≤340`、`tests/commands.spec.ts ≤360`、
   `scripts/verify-p13.mjs ≤160`；`src/index.ts` 净增 ≤40；`src/platform/llm.ts` 净增 ≤5；
   `tests/llm-purpose.spec.ts` 净增 ≤5。
9. 打印 `P13 VERIFY PASS` 或失败清单，exit 0/1。

### 3.9 `tsconfig.tests.json`（改）

`include` 数组追加 `"tests/commands.spec.ts"`。

### 3.10 文档回写（实现后执行）

- `docs/implement/00-master.md`：P13 行标 `已施工 commit <hash>`；R2 状态行改为
  `P8/P9/P10/P11/P12/P13 已施工`。
- `docs/11-structure.md`：模块树补 `core/init.ts` 与 `domains/commands.ts` 行；状态行同步。
- `docs/10-wiring.md` §2 命令面：补 `/init` 行（P13 计划内扩展，实施后回写）。
- 不动 `docs/00–11` 其他设计正文、`datasets/`、`reports/`、`scripts/attic/`。

## 4. 实现要点（每步独立可验证；顺序执行）

### 阶段 0：基线确认（不重跑 verify 全量）

1. `grep -n "parseT0Command" src/core/t0.ts` 命中。
2. `grep -n "createProjectFrame\|projectFrameStorageKey" src/core/prefix.ts` 命中。
3. `grep -n "TASK_BOUNDARY_FACT_TYPE\|factsFromSessionEvents" src/core/ledger/facts.ts` 命中。
4. `grep -n "mountAutoDiscriminator" src/domains/input.ts` 命中。
5. `node scripts/verify-p12.mjs` 输出 `P12 VERIFY PASS`。
6. 任一失败 → 停工上报。

### 阶段 1：P13 本体

1. **声明与纯核先行**：新建 `src/domains/task-facts.ts`、`src/core/init.ts`；
   改 `src/platform/llm.ts` 增 `context-economy-init`；改 `tests/llm-purpose.spec.ts`。
   → `npm run typecheck` / `npm run typecheck:tests` 绿；
   `npx vitest run tests/llm-purpose.spec.ts tests/commands.spec.ts`（commands 尚未存在时可先跑 llm-purpose）。
2. **写 `src/domains/commands.ts`**（§3.4）→ `npm run typecheck` 绿
   （domains → core + platform 合规；`commands` 仅 type-only import）。
3. **接线 `src/index.ts`**（§3.5）→ `npm run typecheck` 绿；
   `grep -n "mountCommandFace" src/index.ts` 命中；`grep -n "ctx.inject(\['commands'\]" src/index.ts` 命中。
4. **写 `tests/commands.spec.ts`**（§3.6）→ `npx vitest run tests/commands.spec.ts --pool=threads` 绿。
5. **改 `tsconfig.tests.json`**（§3.9）→ `npm run typecheck:tests` 绿。
6. **写 `scripts/verify-p13.mjs`**（§3.8）→ `node scripts/verify-p13.mjs` 输出 `P13 VERIFY PASS`。
7. **全链自验**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`；`npm run gate`；
   `node scripts/assert-structure.mjs --json` 双跑 diff 空。
8. 对照 §5 清单逐条打勾；全部满足后执行 §3.10 文档回写，再进 §7。

## 5. 验收（全机械 + agent 自动化检查）

- [ ] `node scripts/verify-p13.mjs` 输出 `P13 VERIFY PASS`（§3.8 九组全过）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0（P13 新文件进 lib/ 编译；checkout 缺失时脚本 SKIP 且不判 FAIL）
- [ ] `npm run gate` exit 0（typecheck + typecheck:client + vitest + assert 四段全绿）
- [ ] `npm run typecheck:tests` exit 0（`tests/commands.spec.ts` 进 include）
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次输出逐字节一致（diff 为空）
- [ ] `tests/commands.spec.ts` §3.6 九组用例齐全且绿（vitest 输出可见）
- [ ] `tests/llm-purpose.spec.ts` 更新后绿（`CE_AUX_PURPOSES` 四值）
- [ ] `grep -n "session.append" src/domains/commands.ts src/domains/task-facts.ts` 无命中
      （事实发射只经 `emitCeFact`/注入 emit）
- [ ] `grep -n "ctx.on('session/event'" src/domains/commands.ts` 无命中
- [ ] `grep -n "from '@deepseek-ai/dsh-commands'" src/domains/commands.ts` 仅 type-only（若为
      `import type` 或 `import type {}` 通过；运行时 import 不通过）
- [ ] `grep -n "export const inject = \['commands'\]" src/index.ts` 无命中（可选服务纪律）
- [ ] `git diff --numstat -- src/index.ts` 净增 ≤40；`src/platform/llm.ts` 净增 ≤5；
      `tests/llm-purpose.spec.ts` 净增 ≤5
- [ ] 行数预算：`src/domains/task-facts.ts ≤80`、`src/core/init.ts ≤160`、
      `src/domains/commands.ts ≤340`、`tests/commands.spec.ts ≤360`、`scripts/verify-p13.mjs ≤160`

**agent 介入的自动化验证说明**：本单有真实接线面（index/commands/llm/skills）。`verify-p13.mjs`
为自动化主入口；真机宿主检查（`dev_self_test` / `dev_build_plugin` / `dev_inject_plugin` /
宿主日志无 `cannot get property "commands" without inject`）在阶段 1 第 7 步之后尽量执行，
不可用则记录 SKIP 并在汇报中说明。

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **命令服务只走 `ctx.inject`**：不新增 `export const inject = ['commands']`；命令面挂载在
   storage 打开成功后；commands/skills/llm 缺失时对应功能缺失但插件其余功能照常。
2. **T0 语义零重复**：P12 已对 `/task` 文本记账（trigger t0），P13 只发射 `task-boundary`，
   不发射 `judge-recorded`，不修改 `core/t0.ts`。
3. **不直接 `session.append`**：所有事实只经 `emitCeFact`（或测试注入的 emit spy）；
   `task-boundary` 必须同时进 `SessionEventMap` 与 `IgnorableSessionEventMap`。
4. **不重复注册 `/compact`**：`/compact` 是 DSH 原生命令，P13 不注册、不拦截。
5. **不修改 P8/P9/P11/P12 纯核**：本单只新增与接线，不改既有 core 文件（`platform/llm.ts`
   的 purpose 扩展是唯一例外）。
6. **项目帧写入纪律**：`source.taskId='project-frame'`、`eventType='init-frame'`；
   CAS `baseVersion:0`；写前读盘防重；`createProjectFrame` 返回的 body 不得原地修改。
7. **init 不绕过用户确认**：LLM 提案必须经 `/init confirm` 才落盘；`/init <goal>` 只提案不写 KV。
8. **pending init 有界**：FIFO 上限 32；超过淘汰最旧会话，禁止无界增长。
9. **fail-lazy 方向**：命令处理器异常只返回 error result；不抛给命令框架；不重试 LLM。
10. **停工上报触发器**：① 基线 grep 不过；② `ctx.commands.register` 实际签名与
    `@deepseek-ai/dsh-commands` 不符；③ `SessionEventMap` 声明合并无法通过 typecheck:tests；
    ④ `streamCeLlm` 不接受新 purpose（类型面）；⑤ 行数预算超限且无法精简；⑥ 任何未覆盖决策点。
    上报带证据（命令 + 输出 + file:line）。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p13): 命令面 + init 项目帧——/task 边界事实、/init 提案确认落盘、/optimize-prompt 入口`
- 账本快照：**本单不需要**（R2 出门时随 P14b 出 07 快照，见总纲 §4）。
- **最后步骤（必须完成）**：按 §9 向用户报告修改内容、功能实现与文档对应表；未汇报视为本单未完成。

## 8. 对接面（P13 如何被后续计划消费）与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式（P13 提供） |
|---|---|
| P12 自动断面 | P13 发射的 `task-boundary` 经 firehose 进入 P12 `factsBySession`；P12 无需修改 |
| P14a 星标按钮 UI | 不需要命令面；但 P13 的 `/optimize-prompt` 命令与星标按钮共用 P14b 的 `manualOptimize` 委托点 |
| P14b 星标 host 方法 | 施工时实现 `manualOptimize(session, rawInput)` 并传入 `mountCommandFace`；无需重复注册命令 |
| P19 边界路径编排 | `/task close` 已闭合任务并写 `task-boundary`；P19 消费 fold 后的 closed 段触发边界压缩/归档 |
| P21a/P21b 恢复与全链验收 | `task-boundary` 事实经会话日志回放；P13 不维护自有事实桶，恢复无新增状态 |

### 8.2 对后续计划的修正（本计划先行记录，实现后回写总纲）

| 行 | 原依赖 | 修正为 | 理由 |
|---|---|---|---|
| P13 | P8,P9,P11,P3,P12 | **P8,P9,P11,P3,P12,P5** | init 提案复用 P5 `streamCeLlm`，且 P13 扩展 `platform/llm.ts` 的 `context-economy-init` purpose |
| P14b | P14a,P11,P13,P6,P3 | 不变（但正文必须写：`/optimize-prompt` 与星标按钮统一走 `manualOptimize(session, rawInput)` 委托点，P13 已注册命令入口） | 避免 P14b 重复注册 `/optimize-prompt` 或与命令面双入口不一致 |
| P12 | P10,P3,P8,P9 | 不变 | P12 已施工；P13 只向既有事实流发射 `task-boundary` |

### 8.3 对既有审查发现的处理（本计划落实）

1. **task-boundary 声明缺口**：P13 新建 `task-facts.ts` 补齐双侧声明合并；在 P13 verify 中
   作为正向扫描必查项。
2. **init 服务可选性**：`skills`/`llm` 缺失时 `/task` 仍可用；`/init` 返回明确错误文案；
   verify 反向扫描锁定不出现 `export const inject=['commands']`。
3. **P12 会话隔离测试缺口**：P13 的测试在命令面用 `snapshotEvents` 独立 fold，不受 P12 内部
   factsBySession 影响；P13 测试补上“事实按会话隔离”的命令面侧断言（§3.6 用例 4/5）。

## 9. 汇报模板（本单最后一步）

执行者在全绿后向用户报告，必须包含：

1. **修改内容**：列出新增/改动文件与行数；明确 `src/index.ts`、`src/platform/llm.ts`、
   `tests/llm-purpose.spec.ts` 的净增行数与改动点；P13 commit 单独列出。
2. **功能实现**：
   - `domains/task-facts.ts`：`task-boundary` 声明合并与数据构造；
   - `core/init.ts`：init prompt v1 渲染与 fail-lazy 解析；
   - `domains/commands.ts`：`/task` open/close/status、`/init` propose/confirm/cancel/status、
     `/optimize-prompt` 委托点；
   - `src/index.ts`：commands 可选服务挂载与卸载；
   - `platform/llm.ts`：`context-economy-init` purpose 扩展；
   - `tests/commands.spec.ts` 九组用例与 `scripts/verify-p13.mjs` 结果。
3. **与文档对应表**：

| 功能 | 代码 | 文档 |
|---|---|---|
| `/task open/close` 命令 | `mountCommandFace` task handler | docs/10 §2；docs/02 §3 T0 |
| `task-boundary` 事实 | `task-facts.ts` + `emitCeFact` | docs/02 §6；docs/09 §1；P8 工单 §2.4-1 |
| `/task` 状态 | `foldSegmentState` + `foldDossierLedger` | docs/02 §3；docs/09 §2；P8/P9 工单 |
| init 提案 LLM | `renderInitPrompt` + `streamCeLlm(purpose:'context-economy-init')` | docs/02 §2；docs/10 §1 H12；P5 工单 |
| 用户确认后写项目帧 v1 | `createProjectFrame` + `putEntity('project_frame', …)` | docs/02 §2；docs/09 §2；P8 工单 §8.1 |
| `/optimize-prompt` 入口 | `manualOptimize` 委托点 | docs/10 §2；P11 工单 §8.1；P14b 对接 |
| 自动化验收 | `scripts/verify-p13.mjs` | 总纲 §2 铁律 2 + §5 全机械验收 |

4. **后续计划修正已回写**：§8.2 的 P13 补 P5、P14b 统一 `manualOptimize` 委托点、P13 事实声明
   补齐是否已核对并落笔。
