# P8 分划单位 + 稳定前缀（映射 R2；依赖 P3,P4,P2；尺寸 M）

> 状态：**已施工（commit `fa8fdab` + 真机接线修正 `037b413`；`node scripts/verify-p8.mjs` 输出 `P8 VERIFY PASS`）**。
> 当前完成情况：R1 平台面已完成——P0–P7 全部施工（P7 commit `5a8c8f2`）；P8 已施工（commit `fa8fdab`），R2 判别域进行中。
> 设计正典：[01 §3.5](../01-architecture.md)（分划单位正典）/
> [02 §2/§3/§6](../02-discriminator.md)（输入栈、段状态机、事件与度量）/
> [06 §2/§3/§4](../06-cache.md)（断裂成本、字节稳定三铁律、稳定前缀版本纪律）/
> [09 §2/§4](../09-state.md)（项目帧实体与恢复）/
> [10 §1 H13](../10-wiring.md)（技能目录挂点）/
> [11 §2/§4/§9](../11-structure.md)（模块树 `core/units.ts`、`core/prefix.ts` 行 + 依赖铁律 + 结构验收）/
> [12 §3](../12-platform-capabilities.md)（段状态机 KV 双源与事实源抽象）。
> harness 符号清单：本单**零新增直接 harness import**；间接消费的 `ctx.skills`/`skills/change`（P4 已核验）与
> `ctx.storageDomain`（P3 已核验）定义处见 §2.3。

## 1. 目标

落地 R2 判别域的两个纯核底座：**分划单位状态机**（`core/units.ts`，把 `task-boundary` /
`judge-verdict` 事实 fold 成 task 段序列）和**稳定前缀**（`core/prefix.ts`，技能目录快照
本地重声明同构类型 + 项目帧 vN + `prefixRebuildCause` + 字节稳定断言）。两核均为纯函数、
零 harness import；运行期接线只做一件事：在 `src/index.ts` 装配根用 P4 的
`watchSkillCatalog` 订阅技能目录变更，经 P3 的 `project_frame` 表做 **last-good 前缀重建**
（无项目帧时不创建，等 P13 init）。

## 2. 输入

### 2.1 正典摘录（工单自足；与正典冲突以正典为准并停工上报）

- **01 §3.5 分划单位**：task = 意图轴单位（意图归属 + 持续性强 + 改动范围较固定）；
  子task = 活动类型轴单位（不预先注册、无检测机制、无档案地位）；交换对 = 剪切层单位。
  task 闭合 = 信息趋于稳定的稳定点。P8 只做**意图轴 task 段状态机**，不越权做剪切/压缩单位。
- **02 §2 输入栈**：① 稳定前缀 = 技能目录（机械枚举，零 LLM）+ 项目最终目标（项目帧 vN）；
  ② 卷宗 = task 内全量用户消息（append-only）；③ prompt 压最尾。技能目录取
  name / description / whenToUse；清单是查表产物，永远不靠模型回忆。
- **02 §3 段状态机**：T0 open/close 与 LLM verdict（new-task → 段内切分：旧段闭合于前一条
  表面事件、新段以判定消息为段头）驱动段切换；`discriminator.auto=false` 时判别器不挂载；
  T0 天然优先（verdict 落在段起 seq 时 no-op）。
- **02 §6 事件与度量**：log-only 事件 `task-boundary`（段状态机边界事实）/`judge-verdict`；
  投影侧 `segmentsPerSession` / `taskSwitchRate`（定义见 [07 §0.5](../07-metrics.md)）。
- **06 §2/§3 断裂成本与字节稳定三铁律**：版本 bump 是受控断裂；同输入 → 同输出逐字节一致；
  稳定在前，动态在后；变更走版本。
- **06 §4 稳定前缀版本纪律**：稳定前缀 = 技能目录 + 项目最终目标；版本事件只有三种——
  技能装卸（`skill`）、项目帧修订（`frame`）、压缩域档案变更（`compaction`）；
  每次 bump 记 `prefixRebuildCount` 与重价体积 `prefixRebuildTokens`；
  bump 理由枚举 `{shear | compaction | note | skill | frame}` 入账。P8 只生产 `skill`
  理由（P13 产 `frame`，P19 产 `compaction`，`shear`/`note` 由后续域按需使用）。
- **09 §2 项目帧**：项目帧 vN = 项目最终目标 + 方面分解 + 技能目录快照；init 采集 = v1；
  项目帧修订 / 技能装卸 bump。每次写入必须带 `source`；同实体同轮只允许一次提交（CAS）。
- **10 §1 H13**：技能目录经 `ctx.skills` 官方注册表（`snapshot`/`get`；`skills/change`
  热更新）；目录 watch 由 harness skill-filesystem 提供者承担；P4 已施工 `watchSkillCatalog`。
- **11 §2 模块树**：`core/units.ts` = 分划单位状态机：task 段 fold、边界记录（01 §3.5 正典）；
  `core/prefix.ts` = 稳定前缀：技能目录快照 + 项目帧 vN、版本 bump 语义（02 §2/06 §4）。
  `core ↛ platform`；platform 是唯一 `ctx` 触点（index.ts 装配根除外）。
- **12 §3 降级语义**：`task-boundary`（段状态机日志真源）在 ignorable 通道缺失时降级为
  KV 事实镜像 + 段状态机 KV 双源（P8）；KV 损毁 → 当作新 task 重新分段。因此 `core/units.ts`
  只消费 `LedgerFact[]` 事实源抽象（P2 已定义），**不得**感知通道来源。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/core/ledger/facts.ts` | `TASK_BOUNDARY_FACT_TYPE`、`factsFromSessionEvents` | 复用；不修改 |
| `src/core/ledger/fold.ts` | `foldCommon` 用 `1 + task-boundary 事实数` 算 `taskCount` | **改**：换用 `foldSegmentState`（§3.3） |
| `src/core/ledger/types.ts` | `LedgerFact`/`LedgerSessionEvent` | 复用；不修改 |
| `src/platform/skills.ts` | `watchSkillCatalog`、`SkillCatalogSnapshot` | 复用；不修改 |
| `src/platform/storage.ts` | `openContextEconomyStorage`、`ContextEconomyStorage` | 复用；不修改 |
| `src/index.ts` | 装配根 | **改**：加稳定前缀 watch 接线（§3.4） |
| `scripts/assert-structure.mjs` | RULES 表 | 本单**不追加规则**（现有 S1/D4/D5 已覆盖边界；如真实树断言出现预期外 fail 先停工） |
| `tsconfig.tests.json` | include 列表 | 增 `tests/units.spec.ts`、`tests/prefix.spec.ts`、`tests/prefix-wiring.spec.ts` |
| `docs/implement/00-master.md` | P8 行 | 实现后回写 `已施工 commit <hash>` |

### 2.3 harness 符号核验源（只 grep 定义处，确认后准 import；找不到即停工上报）

| 符号 | 定义处（G:/deepseek-harness） | 本单用途 |
|---|---|---|
| `ctx.skills: SkillRegistry` | `packages/skill/skill/src/index.ts:286-288` | 经 P4 `watchSkillCatalog` 间接消费 |
| `'skills/change'` 事件 | `packages/skill/skill/src/index.ts:290-299` | 同上 |
| `ctx.storageDomain` | `packages/storage/storage-domain/src/*`（P3 已核验 §2.3） | 经 P3 `openContextEconomyStorage` 间接消费 |
| `@deepseek-ai/dsh-skill` / `@deepseek-ai/dsh-storage-domain` 包导出 | `packages/skill/skill/package.json` / `packages/storage/storage-domain/package.json` | build 链接与 typecheck |

核验动作：执行者必须逐条 `grep -n` 到定义处；本单新增文件不得出现任何
`@deepseek-ai/*` import（core 零 harness import，S1 断言）。`src/index.ts` 只 import
`watchSkillCatalog`（platform/skills）与 `openContextEconomyStorage`（platform/storage），
不直接 import harness 包。

### 2.4 决策点记录（执行者不再自行裁量）

1. **`task-boundary` 事实数据契约（P8 冻结）**：`data = { taskId: string; boundary?: 'open' |
   'close'; reason?: string }`；`boundary` 缺省 = `'close'`（向后兼容 P2 既有 fixture
   `{taskId:"task-1"}`）。P13 命令面、P12 自动断面必须按此契约发射；P8 只读不写该事实。
2. **`judge-verdict` 事实最小契约（P8 冻结状态机所需字段）**：`data = { verdict: string;
   anchorSeq?: number; taskId?: string }`；仅 `verdict === 'new-task'` 且 `anchorSeq` 为
   正整数时驱动切分。P10/P12 的完整 judge-verdict 数据可多于该字段，状态机只取这三个键。
3. **每一条 `task-boundary` 事实 = 一次段切换**（P2 口径的显式化）：`boundary:'open'` =
   闭合当前段并开启以 `taskId` 命名的段；`boundary:'close'` = 用 `taskId` 命名并闭合当前段，
   然后开启自动尾段（taskId = `task-<n>`，n = 已闭合段数 + 1）。这样 P2 fixture 的
   `1 + 闭口数` 口径不变（`taskCount` 仍为 2）。
4. **`taskSwitchRate` 操作化**：`(taskCount - 1) / max(1, stepStartCount)`——step 即 round
   （P2 决策点①），单位 = 每 step 的 task 切换数；无 step 时退化为 `taskCount - 1`。
5. **P8 不创建项目帧**：无 `project_frame` 记录时，技能目录 watch 只记录 `info` 级诊断
   （"prefix unavailable until init frame"），不写 KV；项目帧 v1 创建归 P13（用户确认后）。
6. **last-good 目录策略**：`catalog === undefined`（技能服务缺失/失败）或
   `catalog.complete === false`（provider 部分失败）且已有项目帧 → **保持现有前缀不 bump**；
   无项目帧 → 返回 `null` 等 P13。实现为 `reconcileProjectFrame` 的返回语义（§3.2）。
7. **`prefixRebuildTokens` 记账口径**：取**重建后完整稳定前缀**的 token 估算
   （`estimateTokens(renderedPrefix, charsPerToken)`，charsPerToken 缺省 1.5）——这是
   "重价体积"的保守上界（变更点在头部，变更后体积 ≈ 全量前缀）。本口径写入 P8 测试冻结。
8. **P8 不新增 `context-economy/*` 事实名**：docs/09 §1 / docs/11 §3 事实清单未列
   `prefix-rebuild` 事件；`prefixRebuild*` 从 `project_frame` 实体审计（P3
   `putEntity`/`auditEntity`）记账。若执行中认定 docs/07 §5 "全部字段可从会话 JSONL 回放"
   必须覆盖 `prefixRebuild*`，属正典冲突 → 停工上报，不自行扩事实名。
9. **同构类型本地重声明**：`core/prefix.ts` 的 `SkillCatalogEntry`/`SkillCatalogSnapshot`
   与 `platform/skills.ts` 结构完全一致，但**不得** import platform（P4 §8.1 已预告）。
10. **技能目录是可选能力，走 `ctx.inject(['skills'])` 子 fiber**：主插件不导出
    `inject=['skills']`（避免 headless 无技能服务时主插件整体 PENDING）；watch 在
    storage 打开后经 `ctx.inject(['skills'], cb)` 启动，skills 缺失时 watch 不启动、
    插件其余功能照常。真机失败复盘见 §3.4 注。

## 3. 产出

### 3.1 `src/core/units.ts`（新，≤150 行）

```ts
import type { LedgerFact } from '../ledger/types.ts'
import { TASK_BOUNDARY_FACT_TYPE } from '../ledger/facts.ts'

/** 判别 verdict 事实名（ignorable 事件；S3 窗口纪律：本行附近须保留 ignorable 字样）。 */
export const JUDGE_VERDICT_FACT_TYPE = 'context-economy/judge-verdict'

export interface TaskBoundaryFactData {
  taskId?: string
  boundary?: 'open' | 'close'
  reason?: string
}

export interface JudgeVerdictFactData {
  verdict?: string
  anchorSeq?: number
  taskId?: string
}

export type SegmentSwitchReason = 'implicit-open' | 't0-open' | 't0-close' | 'verdict-new-task' | null

export interface TaskSegment {
  taskId: string
  startSeq: number | null
  endSeq: number | null
  closed: boolean
  switchReason: SegmentSwitchReason
}

export interface SegmentState {
  segments: TaskSegment[]
  taskCount: number
  segmentsPerSession: number
  taskSwitchRate: number
}

export interface SegmentFoldOptions {
  stepStartCount?: number
  sessionFirstSeq?: number
  sessionLastSeq?: number
}

export function foldSegmentState(facts: LedgerFact[], options?: SegmentFoldOptions): SegmentState
```

**语义（实现必须逐字照抄；冲突以正典为准停工）：**

1. **事实归一**：从 `facts` 中取两类事实——`TASK_BOUNDARY_FACT_TYPE`（数据按
   `TaskBoundaryFactData` 解析）与 `JUDGE_VERDICT_FACT_TYPE`（数据按 `JudgeVerdictFactData`
   解析）。任务边界事实（T0）的切换序 = `fact.seq ?? fact.time`；judge-verdict 的切换序 =
   `data.anchorSeq`（不是 fact.seq——判的是 anchorSeq 那条消息）。两类事实混合后按
   `(切换序, 优先级, time, data JSON)` 升序排序；优先级 T0 先于 verdict（T0 天然优先）。
2. **初始段**：恒有一条初始段 `taskId = 'task-1'`、`startSeq = options.sessionFirstSeq ??
   首个切换序 ?? null`、`closed=false`、`switchReason=null`（若有 sessionFirstSeq 则记
   `'implicit-open'`）。
3. **T0 open 事实**（`boundary === 'open'`）：闭合当前段于 `switchSeq`（`endSeq=switchSeq`、
   `closed=true`、`switchReason='t0-open'`）；开启新段 `taskId = fact.taskId ?? 'task-' + n`、
   `startSeq = switchSeq`、`switchReason='t0-open'`。
4. **T0 close 事实**（`boundary !== 'open'`，含缺省）：若 `fact.taskId` 存在，先把当前段
   命名为 `fact.taskId`（P2 fixture 语义：close 事实命名被闭合的段）；闭合当前段于
   `switchSeq`（`switchReason='t0-close'`）；开启自动尾段 `taskId = 'task-' + n`、
   `startSeq = switchSeq`、`switchReason='t0-close'`。n = 已闭合段数 + 1。
5. **verdict new-task 事实**：仅 `data.verdict === 'new-task'` 且
   `Number.isInteger(data.anchorSeq)` 且 `anchorSeq > 0` 时参与切分；若 `anchorSeq <=
   当前段.startSeq`（verdict 落在段起 seq，含 T0 刚开的新段）→ **no-op**（T0 天然优先）。
   否则闭合当前段于 `anchorSeq - 1`（"旧段闭合于前一条表面事件"的机械近似；P10/P12 接入
   真实事件面后可升级为精确表面事件 seq），`switchReason='verdict-new-task'`；开启新段
   `taskId = data.taskId ?? 'task-' + n`、`startSeq = anchorSeq`、`switchReason='verdict-new-task'`。
6. **收尾**：所有切换处理完后，当前段 `endSeq = options.sessionLastSeq ?? null`、入列。
7. **指标**：`taskCount = segments.length`；`segmentsPerSession = segments.length`；
   `taskSwitchRate = (taskCount - 1) / max(1, stepStartCount ?? 0)`。
8. **确定性**：同输入同输出；函数不读写外部状态、不排序不必要字段之外的数据。

### 3.2 `src/core/prefix.ts`（新，≤180 行）

```ts
import { estimateTokens } from '../ledger/fold.ts'

export const PREFIX_REBUILD_CAUSES = ['shear', 'compaction', 'note', 'skill', 'frame'] as const
export type PrefixRebuildCause = (typeof PREFIX_REBUILD_CAUSES)[number]

export interface SkillCatalogEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
}

export interface SkillCatalogSnapshot {
  readonly skills: readonly SkillCatalogEntry[]
  readonly complete: boolean
}

export interface ProjectFrameBody {
  goal: string
  aspects: string[]
  skillCatalog: SkillCatalogSnapshot
}

export interface ProjectFrameRecord {
  version: number
  body: ProjectFrameBody
}

export interface PrefixReconcileResult {
  rebuilt: boolean
  fromVersion: number | null
  version: number
  cause: PrefixRebuildCause
  body: ProjectFrameBody
  renderedPrefix: string
  prefixTokens: number
}

export interface PrefixRebuildRecord {
  fromVersion: number | null
  version: number
  cause: PrefixRebuildCause
  prefixTokens: number
}

export interface PrefixMetrics {
  prefixRebuildCount: number
  prefixRebuildTokens: number
  prefixRebuildCause: Record<PrefixRebuildCause, number>
}

export function projectFrameStorageKey(workspace: string): string
export function normalizeSkillCatalog(catalog: SkillCatalogSnapshot): SkillCatalogSnapshot
export function renderStablePrefix(body: ProjectFrameBody): string
export function createProjectFrame(goal: string, aspects: string[], catalog: SkillCatalogSnapshot): PrefixReconcileResult
export function reconcileProjectFrame(
  current: ProjectFrameRecord | undefined,
  catalog: SkillCatalogSnapshot | undefined,
  cause: PrefixRebuildCause,
): PrefixReconcileResult | null
export function foldPrefixMetrics(records: PrefixRebuildRecord[]): PrefixMetrics
```

**语义：**

1. **projectFrameStorageKey**：`project_frame:${workspace}`（workspace 由 index 传
   `process.cwd()` 并统一 `\` → `/`；P13 init 必须复用同一函数，不得另写键）。
2. **normalizeSkillCatalog**：按 `name` 码点升序排序；每条复制为
   `{ name, description, ...(whenToUse === undefined ? {} : { whenToUse }) }`；
   输出全新对象与数组（不引用输入）；`complete` 透传。
3. **renderStablePrefix**（字节稳定模板，P8 冻结；测试锁黄金字节）：
   ```text
   [项目最终目标]
   <goal>

   [方面分解]
   - <aspect 每行一条；无方面时输出 (无)>

   [技能目录]
   - <name>: <description>                  （whenToUse 缺省）
   - <name>: <description> (whenToUse: <whenToUse>)
   ```
   末行带 `\n`；技能目录先经 `normalizeSkillCatalog` 排序；无技能时输出 `(无)`。
4. **createProjectFrame**：`version=1`、`fromVersion=null`、`cause='frame'`、body 为
   `{ goal, aspects, skillCatalog: normalizeSkillCatalog(catalog) }`、`renderedPrefix` 与
   `prefixTokens=estimateTokens(renderedPrefix)` 同步计算。P13 复用本函数创建 v1。
5. **reconcileProjectFrame**：
   - `current === undefined` → 返回 `null`（P8 不创建项目帧，等 P13）；
   - `catalog === undefined` 或 `catalog.complete === false` → **last-good**：返回
     `rebuilt:false`、`fromVersion=current.version`、`version=current.version`、
     `body=current.body`、`renderedPrefix=renderStablePrefix(current.body)`、
     `prefixTokens=estimateTokens(renderedPrefix)`；
   - 否则构造 `nextBody = { goal: current.body.goal, aspects: current.body.aspects,
     skillCatalog: normalizeSkillCatalog(catalog) }`；若
     `renderStablePrefix(nextBody) === renderStablePrefix(current.body)` → 返回
     `rebuilt:false`（同上，版本不变）；否则返回 `rebuilt:true`、
     `fromVersion=current.version`、`version=current.version+1`、`body=nextBody`、
     `renderedPrefix` 与 `prefixTokens` 同步计算、`cause=cause`。
6. **foldPrefixMetrics**：`prefixRebuildCount = records.length`；
   `prefixRebuildTokens = Σ prefixTokens`；
   `prefixRebuildCause` = 每个 cause 的计数（缺省 0）。纯函数，同输入同账。

### 3.3 `src/core/ledger/fold.ts`（改，净增 ≤8 行）

把 `taskCount` 来源从 P2 闭口计数切换为段状态机真实 task 数：

```ts
import { foldSegmentState } from '../units.ts'
// 删除 import 中的 countFactsOfType / TASK_BOUNDARY_FACT_TYPE（如不再使用）

// 原：const taskCount = Math.max(1, 1 + countFactsOfType(facts, TASK_BOUNDARY_FACT_TYPE))
// 新：
const segmentState = foldSegmentState(facts, {
  stepStartCount: eventCounts.stepStart,
  sessionFirstSeq: events[0]?.seq,
  sessionLastSeq: events.at(-1)?.seq,
})
const taskCount = segmentState.taskCount
```

**验收口径**：`tests/ledger-fold.spec.ts` 现有 fixture 断言必须保持全绿（P2 同输入同账不回退）。

### 3.4 `src/index.ts`（改，净增 ≤60 行；改后总长 ≤145 行）

在装配根加稳定前缀 watch 接线（只在 storageDomain 打开成功后启动；无 storage 或无项目帧
均不写 KV）：

```ts
import { watchSkillCatalog, type SkillCatalogSnapshot } from './platform/skills.ts'
import {
  projectFrameStorageKey,
  reconcileProjectFrame,
  type ProjectFrameBody,
  type ProjectFrameRecord,
} from './core/prefix.ts'
```

`PROJECT_FRAME_TABLE` 常量在 index 文件内定义（`platform/storage.ts` 不导出该字面量）：
`const PROJECT_FRAME_TABLE = 'project_frame' as const`（与 `ENTITY_TABLES` 对齐，零修改 storage.ts）。

接线函数（放在 index 文件内，不新增 platform 文件）：

```ts
function startStablePrefixWatch(ctx: Context, storage: ContextEconomyStorage): () => void {
  const log = ceLogger(ctx)
  const key = projectFrameStorageKey(process.cwd().replaceAll('\\', '/'))
  return watchSkillCatalog(ctx, (catalog: SkillCatalogSnapshot | undefined) => {
    try {
      const stored = storage.getEntity(PROJECT_FRAME_TABLE, key)
      const current: ProjectFrameRecord | undefined = stored == null
        ? undefined
        : { version: stored.version, body: stored.body as ProjectFrameBody }
      const result = reconcileProjectFrame(current, catalog, 'skill')
      if (result == null) {
        log.info('context-economy: prefix unavailable until init frame (skill watch active, no project_frame yet)')
        return
      }
      if (!result.rebuilt) return
      void storage.putEntity(
        PROJECT_FRAME_TABLE,
        key,
        result.body,
        {
          taskId: 'project-frame',
          eventType: 'prefix-rebuild',
          evidence: {
            cause: result.cause,
            fromVersion: result.fromVersion,
            toVersion: result.version,
            prefixTokens: result.prefixTokens,
          },
        },
        { baseVersion: stored?.version ?? 0 },
      ).catch((e: unknown) => {
        log.warn('context-economy: project frame rebuild failed (contained, fail-lazy)', e instanceof Error ? e.message : String(e))
      })
    } catch (e) {
      log.warn('context-economy: project frame reconcile failed (contained, fail-lazy)', e instanceof Error ? e.message : String(e))
    }
  })
}
```

装配变更：

1. **不设主插件级 `export const inject = ['skills']`**：`skills` 是稳定前缀的**可选能力**，
   主插件不得因技能服务缺失而整体 PENDING（headless 无 skills 时事件面/存储面/设置卡仍须可用）。
2. 在 `openContextEconomyStorage(...).then((opened) => { ... })` 内、`storage = opened` 之后，
   通过 `ctx.inject(['skills'], (skillsCtx) => { ... })` 启动技能 watch：
   ```ts
   ctx.inject(['skills'], (skillsCtx) => {
     if (disposed) return
     stopSkillWatch = startStablePrefixWatch(skillsCtx as Context, opened)
   })
   ```
   `skillsCtx` 是 skills 注入子 fiber 的 context，`watchSkillCatalog`/`listSkillCatalog`
   在它上面读取 `ctx.skills` 是合法的（与 `ctx.inject(['storageDomain'])` 同模式）。
3. `let stopSkillWatch: (() => void) | undefined` 定义在 storage effect 闭包顶部；
   disposer 中按序执行：`stopSkillWatch?.()` → `registerFactMirror(undefined)` →
   `await storage?.close()`。
4. 不使用 timer、不直接监听 `skills/change`（watch 已由 P4 封装）、不 import core 之外的新
   harness 包。

> **真机失败记录（dsh web 2026-09-07）与修正**：首版 P8 在 index 直接
> `startStablePrefixWatch(ctx, opened)` 并靠 `export const inject = ['skills']` 读 `ctx.skills`，
> 真机报 `cannot get property "skills" without inject`（`listSkillCatalog` → `watchSkillCatalog`
> → `startStablePrefixWatch`）。根因有两点：① `dsh web` 加载 `main` 指向的 `lib/index.js`，
> 源码新增的 `inject` 导出未重建进 lib 即运行，属**陈旧 lib**；② 即便 lib 重建，把 `skills`
> 设为主插件硬依赖也不正确——headless 无技能服务时主插件会被整体 PENDING。因此本版改为
> **lib 必须重建 + 动态 `ctx.inject(['skills'])` 子 fiber**：主插件不声明 skills 依赖，
> 技能服务可用时 watch 自动启动，不可用时插件其余功能照常（fail-lazy 方向不变）。

### 3.5 `tests/units.spec.ts`（新，≤220 行；全部 fake 事实与事件，零 cordis 运行时 import）

用例（九组，命名含 `foldSegmentState`）：

1. **无事实**：1 段、`taskId='task-1'`、`taskCount=1`、`segmentsPerSession=1`、`taskSwitchRate=0`。
2. **P2 兼容**：一条 close 事实 `{taskId:'task-1', seq:14}` + `stepStartCount=2` →
   2 段；首段 `taskId='task-1'` 且 `endSeq=14`、`closed=true`；尾段 `taskId='task-2'`；
   `taskCount=2`；`taskSwitchRate=(2-1)/2=0.5`。
3. **T0 open**：`{boundary:'open', taskId:'task-build', seq:5}` → 首段闭合于 5；新段
   `taskId='task-build'`、`startSeq=5`、`switchReason='t0-open'`。
4. **T0 close 缺 taskId**：`{seq:9}` → 首段 `taskId='task-1'` 闭合于 9；尾段 `task-2`。
5. **verdict new-task**：`{type:'context-economy/judge-verdict', data:{verdict:'new-task',
   anchorSeq:10, taskId:'task-verify'}}` → 首段 `endSeq=9`；新段 `taskId='task-verify'`、
   `startSeq=10`、`switchReason='verdict-new-task'`。
6. **verdict 非 new-task**：`{verdict:'continue', anchorSeq:10}` → 不切分（1 段）。
7. **T0 优先**：先 T0 open 于 seq 10，再 verdict `anchorSeq=10` → verdict no-op，仅 T0 切换生效。
8. **确定性**：同一输入连跑 3 次 `JSON.stringify(foldSegmentState(...))` 逐字节一致。
9. **foldCommon 集成**：用 `tests/fixtures/ledger/session-events.json` + `mirror-facts.json`
   调 `foldCommon`，断言 `taskCount=2` 且其余字段与既有 expected 一致（回归 P2 口径）。

### 3.6 `tests/prefix.spec.ts`（新，≤220 行；全部纯函数）

用例（十组，命名含 `renderStablePrefix` 或 `reconcileProjectFrame`）：

1. **黄金字节**：给定固定 body，`renderStablePrefix` 输出与冻结字符串逐字节相等（含排序、
   whenToUse 有无、`(无)` 分支、末尾 `\n`）。
2. **确定性**：同一 body 连跑 3 次逐字节一致；技能条目乱序输入 → 输出一致（排序生效）。
3. **normalizeSkillCatalog**：排序、复制、不引用输入（改输入不影响输出）、`complete` 透传。
4. **projectFrameStorageKey**：`projectFrameStorageKey('d:/x') === 'project_frame:d:/x'`。
5. **createProjectFrame**：`version=1`、`fromVersion=null`、`cause='frame'`、`renderedPrefix`
   含 goal 与技能名、`prefixTokens=estimateTokens(renderedPrefix)`。
6. **reconcile 无 current**：返回 `null`（不创建）。
7. **reconcile 同目录**：`rebuilt=false`、版本不变、字节不变。
8. **reconcile 目录变更**：`rebuilt=true`、`version=2`、`renderedPrefix` 字节变化、
   `prefixTokens>0`。
9. **reconcile last-good**：`catalog=undefined` → `rebuilt=false`；`catalog.complete=false` →
   `rebuilt=false`（均保持 current.body 原字节）。
10. **foldPrefixMetrics**：给定 3 条记录（skill/frame/skill）→ count=3、tokens 求和、
    cause 计数 `{skill:2, frame:1, compaction:0, note:0, shear:0}`。

### 3.7 `tests/prefix-wiring.spec.ts`（新，≤240 行；fake ctx + fake storageDomain）

复用 `tests/storage.spec.ts` 的 FakeTable/FakeDomain 最小实现（同文件复制，≤100 行）。
fake ctx 需提供：`logger`（可调用 named logger）、`effect`（收 disposer）、
`inject(deps, cb)`（**须同时处理两条依赖路径**：`['storageDomain']` → 提供含
`storageDomain`/`effect`/`logger` 的 storageCtx；`['skills']` → 用根 ctx 调 cb，
以匹配 index 的 `ctx.inject(['skills'])` 子 fiber 模式）、
`on('skills/change')`（记录监听器供测试 emit）、`skills`（`snapshot` 返回可变目录；
缺 skills 的 harness 用 `withSkills:false` 构造）。
用例（五组）：

1. **无项目帧不创建**：apply 后 flush microtasks；断言 `project_frame` 表无记录；
   `skills/change` 监听器已注册（watch 活跃）。
2. **已有项目帧 + 首刷同目录**：预置 `project_frame` v1（body 含 catalog A）；apply 后 flush；
   断言版本仍 1、无新快照。
3. **skills/change 触发 bump**：emit `skills/change`（snapshot 切到 catalog B）；flush；
   断言 `project_frame` 记录 `version=2`、`body.skillCatalog` 为 B、`source.eventType=
   'prefix-rebuild'`、`source.evidence.cause='skill'`。
4. **卸载净**：执行 disposers 后再 emit；断言版本保持 2；重复 dispose no-op。
5. **无 skills 服务时主插件仍可用**：`withSkills:false` 构造 harness；apply 后 flush；
   断言 storageDomain 已打开（`fact_mirror` 表存在）、无 `skills/change` 监听器、
   `project_frame` 无记录、apply 不抛错（headless 兼容）。

### 3.8 `scripts/verify-p8.mjs`（新，≤120 行；agent 自动化验收入口）

流程（全部确定性输出，exit 0/1）：

1. `DSH_CHECKOUT=G:/deepseek-harness npm run build`——checkout 目录不存在 → 打印
   `SKIP build (checkout missing)` 继续；存在但失败 → FAIL。
2. `npm run gate` → 非 0 即 FAIL。
3. `node scripts/assert-structure.mjs --json` 连跑两次，diff 非空即 FAIL。
4. grep/扫描组（期望 0 命中）：
   - `src/core/units.ts`、`src/core/prefix.ts`：`@deepseek-ai/`、`from 'cordis`、
     `platform/`、`ctx\.`、`session.append`、`setInterval(`、`emitCeFact`。
   - `src/index.ts`：`skills/change`（watch 封装在 P4，index 不直接监听）、
     `export const inject = ['skills']`（主插件不得把可选技能服务设为硬依赖）。
5. grep/扫描组（期望 ≥1 命中）：
   - `foldSegmentState` 在 `src/core/units.ts` 与 `src/core/ledger/fold.ts`；
   - `renderStablePrefix` 在 `src/core/prefix.ts` 与 `tests/prefix.spec.ts`；
   - `watchSkillCatalog`、`projectFrameStorageKey`、`ctx.inject(['skills']` 在 `src/index.ts`。
6. **lib 新鲜度检查**：`lib/index.js` 必须存在，且不含 `export const inject = ['skills']`、
   且含 `ctx.inject(['skills']`——防止 `dsh web` 加载陈旧 lib（真机失败复盘，见 §3.4 注）。
7. 行数预算：`src/core/units.ts ≤150`、`src/core/prefix.ts ≤180`、
   `tests/units.spec.ts ≤220`、`tests/prefix.spec.ts ≤220`、
   `tests/prefix-wiring.spec.ts ≤240`、`scripts/verify-p8.mjs ≤120`；
   `git diff --numstat src/index.ts` 净增 ≤60。
8. 测试名抽查：`grep -n "describe('foldSegmentState" tests/units.spec.ts`、
   `grep -n "describe('renderStablePrefix" tests/prefix.spec.ts`、
   `grep -n "describe('prefix wiring" tests/prefix-wiring.spec.ts` 各 ≥1。
9. 打印 `P8 VERIFY PASS` 或失败清单，exit 0/1。

### 3.9 `tsconfig.tests.json`（改）

`include` 数组追加：

```json
"tests/units.spec.ts",
"tests/prefix.spec.ts",
"tests/prefix-wiring.spec.ts"
```

### 3.10 文档回写（实现后执行）

- `docs/implement/00-master.md`：P8 行标 `已施工 commit <hash>`；R1 完成记录下方追加
  `> R2 进行中：P8 已施工（分划单位状态机 + 稳定前缀 + 技能 watch 接线）`。
- `docs/11-structure.md` 状态行：`R1 平台面已完成` 后补 `R2 判别域进行中（P8 units/prefix 已施工）`。
- 若实现过程中发现 §2.4 决策点与正典不一致而停工，先更新本文件状态再上报，不提交半成品。

## 4. 实现要点（每步独立可验证；顺序执行）

1. **核验 harness**（§2.3）：逐条 grep 到定义处；本单无新增直接 import，核验通过即可进行下一步。
2. **写 `src/core/units.ts`**（§3.1）→ `npm run typecheck` 绿（core 零 harness import，S1 不红）。
3. **写 `tests/units.spec.ts`**（§3.5）→ `npm test` 绿（九组用例）。
4. **改 `src/core/ledger/fold.ts`**（§3.3）→ `npm test` 绿（既有 ledger-fold 断言不回退）。
5. **写 `src/core/prefix.ts`**（§3.2）→ `npm run typecheck` 绿。
6. **写 `tests/prefix.spec.ts`**（§3.6）→ `npm test` 绿（十组用例）。
7. **改 `src/index.ts`**（§3.4）→ `npm run typecheck` 绿；`npm test` 中 `tests/apply-smoke.spec.ts`
   既有断言必须零改动全绿（storageDomain 缺失路径不新增 disposer）。
8. **写 `tests/prefix-wiring.spec.ts`**（§3.7）→ `npm test` 绿（四组用例）。
9. **改 `tsconfig.tests.json`**（§3.9）→ `npm run typecheck:tests` 绿。
10. **写 `scripts/verify-p8.mjs`**（§3.8）→ `node scripts/verify-p8.mjs` 输出
    `P8 VERIFY PASS`。
11. **全链自验**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`；`npm run gate`；
    `node scripts/assert-structure.mjs --json` 双跑 diff 空。
12. 对照 §5 清单逐条打勾；全部满足后执行 §3.10 文档回写，再进 §7。

## 5. 验收（全机械 + agent 自动化检查）

- [ ] `node scripts/verify-p8.mjs` 输出 `P8 VERIFY PASS`（§3.8 九组全过）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0（P8 新文件进 lib/ 编译）
- [ ] `npm run gate` exit 0（typecheck + typecheck:client + vitest + assert 四段全绿）
- [ ] `npm run typecheck:tests` exit 0（新增三份 spec 进 include）
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次输出逐字节一致（diff 为空）
- [ ] `tests/units.spec.ts` §3.5 九组用例齐全且绿；`tests/prefix.spec.ts` §3.6 十组用例齐全且绿；
      `tests/prefix-wiring.spec.ts` §3.7 五组用例齐全且绿（vitest 输出可见）
- [ ] `grep -R "@deepseek-ai/\|from 'cordis\|from \".*platform" src/core/units.ts src/core/prefix.ts`
      无命中（core 零 harness/platform import；S1 反向）
- [ ] `grep -R "ctx\.\|session.append\|setInterval(\|emitCeFact" src/core/units.ts src/core/prefix.ts`
      无命中（纯核零触点、零 timer、零事实发射）
- [ ] `grep -n "skills/change" src/index.ts` 无命中（watch 封装在 P4，不直接监听）
- [ ] `grep -n "export const inject = \['skills'\]" src/index.ts` 无命中；`grep -n "ctx.inject(\['skills'\]" src/index.ts`
      至少 1 命中（可选技能服务走子 fiber 注入，主插件不硬依赖 skills）
- [ ] `grep -n "export const inject = \['skills'\]" lib/index.js` 无命中；`grep -n "ctx.inject(\['skills'\]" lib/index.js`
      至少 1 命中（lib 新鲜度——dsh web 加载 main 指向的 lib，不重建 lib 必复现真机失败）
- [ ] `git diff tests/apply-smoke.spec.ts tests/events-pump.spec.ts tests/field-model.spec.ts`
      为空（既有测试零改动；assert-structure.spec 本单不改；prefix-wiring.spec 为本单新增）
- [ ] 行数预算：`src/core/units.ts ≤150`、`src/core/prefix.ts ≤180`、
      `tests/units.spec.ts ≤220`、`tests/prefix.spec.ts ≤220`、
      `tests/prefix-wiring.spec.ts ≤240`、`scripts/verify-p8.mjs ≤120`（`wc -l`）

**agent 介入的真实宿主检查（在机械验收全绿后执行；不可用则记录 SKIP，不作为 P8 出门失败）**：

- [ ] `dev_self_test` 全 PASS（注入器自检；仅当准备执行真实注入时必跑）
- [ ] `dev_build_plugin /d/deepseek-plugin` 产出 tgz（打包链路含新 core 文件）
- [ ] `dev_inject_plugin /d/deepseek-plugin` 注入成功（宿主运行中才可执行）
- [ ] `dev_plugin_status` 显示 `dsh-price-less` 已装配且 fiber 状态正常
- [ ] 宿主日志/`logs/context-economy.log` 中可见 `prefix unavailable until init frame`
      （技能 watch 已激活、无项目帧不创建——P8 预期行为，非错误）

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **core 零 harness import**：`core/units.ts`/`core/prefix.ts` 不得出现任何
   `@deepseek-ai/*` 或 `cordis` import；技能目录类型本地重声明（P4 §8.1 预告）。
2. **不新增事实名**：P8 不声明 `context-economy/prefix-rebuild` 等新事件；`prefixRebuild*`
   走 `project_frame` 审计（§2.4-8）。
3. **不创建项目帧**：无 `project_frame` 时只诊断不写 KV；v1 创建归 P13（用户确认后）。
4. **last-good 优先**：技能目录 `undefined`/`complete=false` 且已有帧 → 不 bump；
   禁止用不完整目录覆盖好目录。
5. **零 timer**：技能目录变更只由 `skills/change` 事件驱动（P4 已封装）；index 不直接
   监听、不轮询。
6. **CAS 写保护**：`putEntity` 必须带 `{ baseVersion: current.version }`；CAS 失败
   （并发 bump）由 catch 承接并 warn，不重试、不外溢（fail-lazy）。
7. **lib 必须与 src 同步重建**：`dsh web`/注入器加载 `main` 指向的 `lib/index.js`；
   改完 src 后未 `npm run build` 即启动真机会加载陈旧 lib（本次真机失败主因之一）。
   `scripts/verify-p8.mjs` 已加 lib 新鲜度检查。
8. **不改 P2 fixture**：`tests/fixtures/ledger/**` 与 `tests/ledger-fold.spec.ts`
   现有断言零改动；`foldCommon` 换 taskCount 来源后必须原样绿。
9. **停工上报触发器**：① §2.3 核验签名与设计不符；② `foldSegmentState` 语义无法同时满足
   P2 fixture 与 docs/02 §3；③ `reconcileProjectFrame` 与 P3 `putEntity` 的 source/CAS
   语义无法对齐；④ 行数预算超限且无法精简；⑤ 任何未覆盖决策点。
   上报带证据（命令 + 输出 + file:line）。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p8): 分划单位状态机 + 稳定前缀——core/units.ts fold + core/prefix.ts 字节稳定 + 技能 watch 接线`
- 账本快照：**本单不需要**（P8 非 R2 末单；R2 出门时随 P14b 出 07 快照，见总纲 §4）。
- 汇报（**本单最后一步，执行者必须完成**）：按 §9 向用户报告修改内容、功能实现与文档对应表。

## 8. 对接面（P8 如何被后续计划消费）与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式（P8 提供） |
|---|---|
| P9 卷宗 | `foldSegmentState` 给出当前 task 段与 `taskId`；卷宗按 taskId 追加、边界清空（02 §2） |
| P10 判据与对表 | `judge-verdict` 事实数据契约（§2.4-2）由 P8 冻结状态机所需字段；P10 发射完整 judge-verdict 时保持该三键语义 |
| P11 星标断面 | `core/prefix.ts` 的 `renderStablePrefix`/`createProjectFrame` 供断面输入栈装配复用；引用守卫技能目录用 P4 查表 + P8 同构类型 |
| P12 自动断面 | `on('input/user-message')` 事件喂给 `foldSegmentState`（u≥1 首条隐式开段已由状态机表达）；`taskSwitchRate` 投影入账 |
| P13 命令面 + init 项目帧 | `createProjectFrame` 创建 v1；T0 命令发射 `task-boundary` 事实必须符合 §2.4-1 契约；项目帧键必须用 `projectFrameStorageKey` |
| P14b 星标 host 方法 | 输入栈装配调用 `renderStablePrefix`；帧修订后调用 `reconcileProjectFrame(current, catalog, 'frame')` |
| P19 边界路径编排 | 档案追加/截断触发前缀 bump 时，以 `cause='compaction'` 调用 `reconcileProjectFrame`（或复用 P8 fold 口径记账） |
| P21a 恢复编排 | `project_frame` 恢复后，用 `listSkillCatalog` + `reconcileProjectFrame` 做只读校验；段状态机从 facts 重放（09 §4） |

> 消费提示：`listSkillCatalog`/`watchSkillCatalog` 内部会读 `ctx.skills`；后续工单若没有把
> `skills` 声明为插件级依赖，必须先经 `ctx.inject(['skills'], cb)` 取得注入子 context 再调用，
> 不得直接在主插件 ctx 上调用（本次 `dsh web` 真机失败的教训，见 §3.4 注）。

### 8.2 对后续计划的修正（本计划先行记录，实现后回写总纲）

| 行 | 原依赖 | 修正为 | 理由 |
|---|---|---|---|
| P8 | P3,P4,P2 | 不变 | 本计划已按总纲现状执行；无新增依赖 |
| P9 | P3,P8 | 不变 | 但 P9 需显式消费 `foldSegmentState` 的 `taskId`（原行未写，P9 工单展开时补进正文） |
| P10 | P9,P5,P2 | **P9,P5,P2,P8** | P10 发射 `judge-verdict` 需与 P8 冻结的 `{verdict,anchorSeq,taskId}` 契约对齐（虽然主路径经 P9 传递，但契约源在 P8） |
| P12 | P10,P3 | 不变 | P12 消费 `foldSegmentState`；u≥1 首条隐式开段由 P8 表达（P1 工单 §8 已预告） |
| P13 | P8,P9,P11,P3 | 不变 | P13 必须复用 `projectFrameStorageKey` 与 `createProjectFrame`（本计划 §3.2 契约） |
| P14b | P14a,P11,P13,P6,P3 | 不变 | P14b 输入栈装配复用 `renderStablePrefix`（原行未写，P14b 工单展开时补进正文） |

总纲 §3 依赖主干图无需改边（P8 仍为 P3/P4/P2 后继；P10 新增的 P8 契约依赖是**数据契约**
而非施工顺序依赖，但建议在 P10 工单正文列 P8 为"契约前置"）。

**本次审查修正（2026-09-07 dsh web 真机失败后，已落实）**：

- `src/index.ts` 取消主插件级 `export const inject = ['skills']`；改为 storage 打开后
  `ctx.inject(['skills'], cb)` 启动 watch——`skills` 降级为可选能力，headless 无技能服务时
  主插件不再整体 PENDING（§2.4-10、§3.4）。
- `tests/prefix-wiring.spec.ts` 的 fake `inject` 同时处理 `['storageDomain']` 与 `['skills']`
  两条路径；§3.7 用例增至五组（新增无 skills 服务可用性用例）。
- `scripts/verify-p8.mjs` 新增 lib 新鲜度检查与 `ctx.inject(['skills']` 正/反向扫描，
  防止陈旧 lib 再次以 `cannot get property "skills" without inject` 形式失败。

## 9. 汇报模板（本单最后一步）

执行者在全绿后向用户报告，必须包含：

1. **修改内容**：列出新增/改动文件与行数；`src/index.ts` 净增行数；`tsconfig.tests.json`
   include 增量；明确既有测试与 P2 fixture 零改动。
2. **功能实现**：
   - `core/units.ts`：`foldSegmentState` 的 T0 open/close、verdict new-task、T0 优先、
     首条隐式开段语义；`segmentsPerSession`/`taskSwitchRate` 公式；确定性。
   - `core/prefix.ts`：技能目录同构类型本地重声明；`renderStablePrefix` 黄金字节；
     `reconcileProjectFrame` 的 last-good / 版本 bump / `prefixRebuildTokens` 口径；
     `foldPrefixMetrics`。
   - `src/index.ts`：`watchSkillCatalog` 接线、无项目帧不创建、CAS 写保护、卸载顺序。
   - `scripts/verify-p8.mjs` 与全部验收结果（含 `P8 VERIFY PASS`）。
   - agent 真实宿主检查结果（`dev_build_plugin`/`dev_inject_plugin`/`dev_plugin_status`；
     不可用则报告 SKIP）。
3. **与文档对应表**：

| 功能 | 代码 | 文档 |
|---|---|---|
| 分划单位状态机（task 段 fold） | `src/core/units.ts` `foldSegmentState` | docs/01 §3.5；docs/02 §3 |
| T0/verdict 段切换契约 | `TaskBoundaryFactData`/`JudgeVerdictFactData` | docs/02 §3/§6 |
| `taskCount` 真实来源切换 | `src/core/ledger/fold.ts` | docs/implement/P2-ledger-base.md §8.1 |
| 稳定前缀 = 技能目录 + 项目帧 | `src/core/prefix.ts` `renderStablePrefix` | docs/02 §2；docs/06 §4 |
| 字节稳定三铁律 | `renderStablePrefix` + `reconcileProjectFrame` 同版本 no-op | docs/06 §3 |
| 版本 bump 与 `prefixRebuildCause` | `reconcileProjectFrame`/`foldPrefixMetrics` | docs/06 §4；docs/07 §0.5 |
| 技能目录 watch 接线 | `src/index.ts` `startStablePrefixWatch` | docs/10 §1 H13；docs/11 §2 |
| last-good 降级 | `reconcileProjectFrame` `complete=false`/`undefined` 分支 | docs/12 §2/§3 |
| 自动化验收 | `scripts/verify-p8.mjs` | 总纲 §2 铁律 2 + §5 全机械验收 |

4. **后续计划修正已回写**：§8.2 的 P10 契约前置与 P9/P14b 正文补注是否已核对
   `docs/implement/00-master.md` 并落笔。
