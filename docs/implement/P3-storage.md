# P3 持久面（映射 R1；依赖 P1,P2；尺寸 M）

> 状态：**已施工（commit `ac15d73`；`node scripts/verify-p3.mjs` 输出 `P3 VERIFY PASS`，`npm run gate` 全绿，`DSH_CHECKOUT=G:/deepseek-harness npm run build` 通过）**。
> 设计正典：[09 §1–§6](../09-state.md)（双源结构 / 实体版本协议 / 恢复契约 / 回滚审计）/
> [11 §2–§3](../11-structure.md)（模块树 `platform/storage.ts` 行 + 三轨持久化）/
> [11 §8](../11-structure.md)（R1 出门门槛）/
> [12 §2–§3](../12-platform-capabilities.md)（ignorable 通道缺失时事实轨降级 KV 镜像；P3 事实镜像表）/
> [13 §3.6](../13-harness-plugin-spec.md)（`ctx.storageDomain.open(defineDomain({...}))` 核验源）/
> [07 §5](../07-metrics.md)（facts 源抽象：会话 ignorable 事件 ∨ KV 事实镜像）。
> harness 符号清单：`ctx.storageDomain` / `DomainFacility.open` / `defineDomain` / `domainTable` /
> `Domain` / `KvTable`（`@deepseek-ai/dsh-storage-domain`）；`DomainError`（`missing-key`/`closed` 语义）；
> 记录 schema 用 `zod`（harness storage-domain 正典：record schemas are zod）。逐条 grep 核验源见 §2.3。

## 1. 目标

把 [09](../09-state.md) 的 durable KV 面落成可用的 `platform/storage.ts`：
一个 `context_economy` storageDomain（四实体表 + 事实镜像表 + 快照表）、带 `source` 强制的
版本化写入（CAS）、快照回退（N=50）、审计读取；并在 `index.ts` 把事实镜像表接到
`platform/ignorable-channel.ts` 的 `setFactMirror` 接线上（经 `logger.ts` 的
`registerFactMirror` 单点，D3 边界不破）。本单**只建持久面、不发机制行为**：不订阅 pump、
不新增配置、不建新会话事件类型、不启动恢复编排（恢复序归 P21）。

## 2. 输入

### 2.1 正典摘录（工单自足；与正典冲突以正典为准并停工上报）

- **09 §1 双源结构**：durable KV = storageDomain（版本化表，backend 可换 json/sqlite），存
  卷宗 / 项目帧 / 边界档案 / 优化产物；会话事实 = ignorable 事件进 JSONL。KV 损毁可回放重建。
- **09 §2 协议**：各实体独立版本号；`schemaVersion` 全局结构版本；每次写入必须带
  `source`（task ID + 事件类型 + 证据），无来源写入拒绝；差分写（本单按单实体单记录写，
  不整库升版）；同实体同轮只允许一次提交（进程内互斥——由 harness Domain 单写链承接）；
  LLM 产物先版本化落盘再复用（P11/P14 消费本单时遵守）。
- **09 §4 恢复契约**：恢复序 项目帧→卷宗→边界档案→段状态机→度量缓存；每步 `restore/step`，
  失败 `restore/degraded`，完成 `restore/done`。**本单只提供恢复所需的读/回滚/审计原语，
  不编排恢复序**（P21）。
- **09 §5 回滚与审计**：每次提交保留快照（最近 N=50 版）；回滚 = 恢复快照 + 版本指针回退，
  记 `source: rollback@<version>`；审计接口返回全部提交（version / source / Δ 条数）；
  任何版本不一致触发 `version-mismatch` 告警事件（log-only）。**本单不建该事件类型**：
  P3 无 session 面（恢复时点才具备），`version-mismatch` 发射归 P21 恢复编排（见 §8.1）。
- **09 §6 验收**：无 source 写入被拒；同版本各实体哈希一致；回放确定；恢复演练（P21）；
  LLM 产物未落盘不被引用（P11/P14 验收）。
- **11 §2**：`platform/storage.ts` = H10 storageDomain 封装（四实体表声明、版本化读写、CAS）；
  `core ↛ platform`；platform 是唯一 `ctx` 触点（index.ts 装配根除外）。
- **11 §3**：durable 真源四实体；事实镜像表是通道缺失时的降级真源（[12 §3](../12-platform-capabilities.md)）。
- **12 §2–§3**：降级模式 = 通道缺失 → 事实写入 KV 镜像（P3 事实镜像表接线前 = blocked：
  warn + 计数）；镜像写入失败 → blocked；一切失败 warn + 计数，绝不外溢、绝不静默。
  P2 已定义 `facts = 会话 ignorable 事件 ∨ KV 事实镜像`，同一 fold 同输入同账。
- **13 §3.6**：`ctx.storageDomain: DomainFacility`；`defineDomain(spec)` 字段
  `name`/`version`/`layout?`/`compatibleVersions?`/`invalidRecords?`/`global?`/`tables`；
  `open(spec)` 路由 backend、开 KV unit、按表 zod 校验记录、构造 `Domain`；调用者持有 handle
  并负责 close（通常作为 `ctx.effect` disposer）。`Domain.table(name)` 返回 `KvTable`
  （`get`/`entries`/`keys`/`size`/`put`/`delete`/`update`；`update` 对 missing key 抛
  `DomainError('missing-key')`）。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/platform/ignorable-channel.ts` | `setFactMirror(mirror)` 接线点、`FactMirror` 类型、`emitFact` 路由 | 只读引用（经 logger 单点）；**不改本文件** |
| `src/platform/logger.ts` | `ceLogger` / `emitCeFact` | 加 `registerFactMirror`（≤10 行）：`setFactMirror` 的 logger 面 |
| `src/index.ts` | `apply` 装配根 | 加 storage 装配（`ctx.inject(['storageDomain'])` + `ctx.effect(async…)`，fail-lazy） |
| `src/platform/storage.ts` | 不存在 | **新**：持久面全部内容（§3.1） |
| `src/core/ledger/types.ts` | `LedgerFact = { type; seq?; time; data }` | 只读（测试 type-level 等价）；**storage.ts 不 import core**（platform 不依赖 core 的实现纪律） |
| `scripts/build.sh` | `link_pkg` 集 | 加 `@deepseek-ai/schemastery` / `@deepseek-ai/dsh-storage` / `@deepseek-ai/dsh-storage-domain` 三条链接（§3.4） |
| `package.json` | peerDependencies | 加 `@deepseek-ai/dsh-storage-domain` 与 `zod`（均范围声明，不硬编码） |
| `scripts/assert-structure.mjs` | RULES 表 | 追加 D4（storage 概念收口，§3.5） |
| `tests/assert-structure.spec.ts` | 零位快照 | 补 D4 负/正样本 + 快照 `D4:'pass'` |
| `tsconfig.tests.json` | include 两个类型级 spec | 增 `tests/storage.spec.ts`（类型级等价断言需进 typecheck:tests） |
| `tests/storage.spec.ts` | 不存在 | **新**（§3.3） |
| `scripts/verify-p3.mjs` | 不存在 | **新**（§3.6） |

### 2.3 harness 符号核验源（只 grep 定义处，确认后准 import；找不到即停工上报）

| 符号 | 定义处（G:/deepseek-harness） | 本单用途 |
|---|---|---|
| `defineDomain` / `domainTable` / `DomainSpec` / `TableValueOf` | `packages/storage/storage-domain/src/spec.ts:107-160` | 声明 `context_economy` 域与五张表 |
| `DomainFacility.open`（reserve 域名 → backend 路由 → kv.open → loadAll → zod parse → Domain） | `packages/storage/storage-domain/src/index.ts:100-140` | 开域流程与错误语义 |
| `Domain` / `KvTable`（`get`/`entries`/`keys`/`size`/`put`/`delete`/`update`） | `packages/storage/storage-domain/src/domain.ts:97-139` | 表读写面；`update` missing-key 抛 `DomainError('missing-key')` |
| `DomainError` | `packages/storage/storage-domain/src/error.ts:34` | 错误识别（closed/missing-key 等） |
| `UNIT_NAME_RE` | `packages/storage/storage/src/backend.ts:10`（`/^[a-z][a-z0-9_]*$/`） | 域名/表名合法性（`context_economy` 合规） |
| `DomainChanged` 事件 | `packages/storage/storage-domain/src/events.ts:11-36` | 本单不订阅，仅知道写后 emit（审计后续可加） |
| zod record schema 正典 | `packages/storage/storage-domain/src/spec.ts:1-13`（record schemas are zod） | 表 schema 用 zod |

## 3. 产出

### 3.1 `src/platform/storage.ts`（新，≤300 行）

**导出面：**

```ts
export const CE_STORAGE_DOMAIN = 'context_economy'
export const CE_STORAGE_SCHEMA_VERSION = 1
export const CE_STORAGE_SPEC = defineDomain({ ... })  // 域声明（表集合见下）
export const ENTITY_TABLES = ['dossier','project_frame','boundary_archive','optimize_artifact'] as const
export type EntityTableName = (typeof ENTITY_TABLES)[number]
export const SNAPSHOT_LIMIT = 50

export interface EntitySource { taskId: string; eventType: string; evidence: unknown }
export interface EntityRecord { schemaVersion: number; version: number; source: EntitySource; body: unknown }
export interface FactMirrorRecord { type: string; seq?: number; time: number; data: unknown }

export class StorageError extends Error { code: 'SOURCE_REQUIRED' | 'CAS_MISMATCH' | 'ROLLBACK_TARGET_NOT_FOUND' }
export class CasMismatchError extends StorageError { ... }

export interface ContextEconomyStorage {
  getEntity(table, key): EntityRecord | undefined
  putEntity(table, key, body, source, options?: { baseVersion?: number }): Promise<EntityRecord>
  rollbackEntity(table, key, targetVersion: number): Promise<EntityRecord>
  auditEntity(table, key): EntityRecord[]          // 当前记录 + 快照记录按 version 升序、去重
  listFactMirror(): FactMirrorRecord[]             // 按 key 升序
  writeFactMirror(type: string, data: unknown): void // 同步入队；durable 失败异步 warn + 计数
  stats(): { factMirrorCount: number; factMirrorDurabilityErrors: number; entityCounts: Record<EntityTableName, number> }
  close(): Promise<void>
}

export async function openContextEconomyStorage(
  ctx: Pick<Context, 'storageDomain'>,
  options?: { logger?: CeLogger; now?: () => number },
): Promise<ContextEconomyStorage>
```

**域声明（zod 表 schema）：**

| 表名 | value schema | 说明 |
|---|---|---|
| `dossier` | `entityEnvelopeSchema` | 卷宗 vN（body 由 P9 定义） |
| `project_frame` | `entityEnvelopeSchema` | 项目帧 vN（body 由 P13 定义） |
| `boundary_archive` | `entityEnvelopeSchema` | 边界档案 vN（body 由 P17/P19 定义） |
| `optimize_artifact` | `entityEnvelopeSchema` | 优化产物 vN（body 由 P11/P14 定义） |
| `fact_mirror` | `factMirrorRecordSchema` | 事实镜像（[12 §3](../12-platform-capabilities.md) 降级真源） |
| `entity_snapshots` | `entitySnapshotSchema` | 快照/审计（[09 §5](../09-state.md)） |

```ts
const entityEnvelopeSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  source: z.object({ taskId: z.string(), eventType: z.string(), evidence: z.unknown() }),
  body: z.unknown(),
})
const factMirrorRecordSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative().optional(),
  time: z.number(),
  data: z.unknown(),
})
const entitySnapshotSchema = z.object({
  entityType: z.string(), entityKey: z.string(),
  record: entityEnvelopeSchema, savedAt: z.number(),
})
```

**公式/语义（实现必须逐字照抄；冲突以正典为准停工）：**

1. `openContextEconomyStorage`：`await ctx.storageDomain.open(CE_STORAGE_SPEC)`；失败不外溢
   （由 index.ts 捕获 fail-lazy）；成功后返回实现体。`now` 注入默认 `Date.now`（测试确定性）。
2. **source 强制**：`putEntity` 在写前检查 `source.taskId` 与 `source.eventType` 均为
   非空字符串（trim 后），否则抛 `StorageError('SOURCE_REQUIRED')`；`evidence` 任意。
3. **CAS 版本语义**：`baseVersion` 缺省 = `0`。
   - `baseVersion === 0`：仅创建——`table.get(key) !== undefined` → `CasMismatchError`；新记录 `version = 1`。
   - `baseVersion > 0`：`current === undefined || current.version !== baseVersion` →
     `CasMismatchError`；新记录 `version = baseVersion + 1`。
   - 新记录 = `{ schemaVersion: CE_STORAGE_SCHEMA_VERSION, version, source, body }`。
   - 更新前若 `current !== undefined`：先把 `current` 写入 `entity_snapshots`
     （key = `JSON.stringify([table, current.version, key])`），再 `table.put(key, next)`；
     快照写失败则中止（不落新版本）。随后 `pruneSnapshots` 保持该实体快照 ≤ `SNAPSHOT_LIMIT`。
4. **回滚**：`rollbackEntity(table, key, targetVersion)`：
   - `current === undefined` → 抛错；`targetVersion === current.version` → 返回 current。
   - `targetVersion < 1 || targetVersion > current.version` → 抛错。
   - 从 `entity_snapshots` 找 `entityType===table && entityKey===key && record.version===targetVersion`
     的最新一条；找不到 → `StorageError('ROLLBACK_TARGET_NOT_FOUND')`。
   - 先把 current 写入快照（审计）；再 `table.put(key, { schemaVersion, version: targetVersion,
     source: { taskId:'rollback', eventType:'rollback', evidence:{ fromVersion:current.version,
     toVersion:targetVersion } }, body: snapshot.record.body })`。
   - 版本指针回退后**允许**版本号复用（[09 §5](../09-state.md)「版本指针回退」原文语义）。
5. **审计**：`auditEntity(table, key)` = 当前记录（若有）+ 全部匹配快照记录，按 `record.version`
   升序、同版本取最新 `savedAt`；返回纯数据（调用方不得原地改）。
6. **事实镜像**：`writeFactMirror(type, data)`：
   - `time = now()`；key = `JSON.stringify([type, time, mirrorSeq++])`（`mirrorSeq` 进程内计数，
     防同毫秒同 type 覆盖；重启后 `now()` 单调推进不会碰撞）。
   - 记录 = `{ type, time, data }`（无 `seq`——通道缺失时发射方无 seq；`seq` 为可选字段）。
   - `void table.put(key, record).catch(e => { stats.factMirrorDurabilityErrors++; logger?.warn(...) })`；
     同步不抛（emitFact 的 FactMirror 是同步接口）。**durable 失败记
     `factMirrorDurabilityErrors` 并 warn，绝不静默**；P3 不改变 `emitFact` 的
     `mirrored/blocked` 判定（同步入队即 mirrored，异步落盘失败在 storage 侧可见）。
7. **关闭**：`close()` 调用 `domain.close()`；之后写操作拒绝（Domain 语义）。
8. **零 import 纪律**：`storage.ts` 不 import `core/**`（`FactMirrorRecord` 与 `LedgerFact`
   的结构等价由 `tests/storage.spec.ts` 的 type-level 断言证明，见 §3.3-⑨）。

### 3.2 `src/platform/logger.ts` 改动（≤10 行净增）

```ts
import { emitFact, factModeStats, setFactMirror, type FactMirror } from './ignorable-channel.ts'
export function registerFactMirror(mirror: FactMirror | undefined): void {
  setFactMirror(mirror)
}
```

D3 允许 logger.ts 引用 `setFactMirror`（可删除单元内）；`index.ts` 只经 `registerFactMirror`
接线，不出现 D3 概念 token。

### 3.3 `tests/storage.spec.ts`（新，≤280 行；全部 fake，零 cordis 运行时 import）

手写 `FakeKvTable` / `FakeDomain`（仿 `KvTable`：Map + `put`/`update`/`delete`/`entries`；
`update` 对 missing key 抛错；`close` 幂等）。用例（九组）：

1. **域声明合法**：`CE_STORAGE_DOMAIN === 'context_economy'`；`CE_STORAGE_SPEC` 通过
   `defineDomain`（不抛）；表名集合 = 4 实体 + `fact_mirror` + `entity_snapshots`。
2. **无 source 拒绝**：`putEntity('dossier','k',{}, {taskId:'',eventType:'x',evidence:null})`
   抛 `SOURCE_REQUIRED`；`eventType` 空白同。
3. **创建 v1**：`putEntity('dossier','k',{a:1}, src)` → `{schemaVersion:1, version:1,
   source:src, body:{a:1}}`；`getEntity` 可见；`entityCounts.dossier === 1`。
4. **CAS 创建冲突**：再以 `baseVersion:0` put 同 key → `CAS_MISMATCH`；记录仍 v1。
5. **CAS 更新 + 快照**：`baseVersion:1` put → v2；`auditEntity` 返回 v1 快照 + v2 当前，
   按版本升序；`entity_snapshots` 中快照 `record.version===1`。
6. **CAS 版本冲突**：`baseVersion:1` 再 put → `CAS_MISMATCH`；记录仍 v2（写不穿透）。
7. **回滚**：建 v1→v2→v3 后 `rollbackEntity('dossier','k',1)` → 当前 `version===1` 且 body
   回到 v1；`source.eventType==='rollback'`；`rollbackEntity` 到当前版本 no-op；目标版本不存在
   抛 `ROLLBACK_TARGET_NOT_FOUND`；审计仍能看到 v2/v3 快照（回滚前已存）。
8. **事实镜像**：注入 `now: () => 1234`，`writeFactMirror('context-economy/task-boundary',
   {x:1})` → `listFactMirror()` 恰一条 `{type:'context-economy/task-boundary', time:1234,
   data:{x:1}}`（`seq` 缺省）；两条同 type 同 time 不互相覆盖（key 含 `mirrorSeq`）。
9. **type-level 等价**：`FactMirrorRecord extends LedgerFact` 且 `LedgerFact extends
   FactMirrorRecord`（双向结构等价；编译期断言，运行期占位）。

### 3.4 `scripts/build.sh` 改动（≤10 行净增）

在 host 依赖链接区（`dsh-session-persistence` 之后）加：

```bash
link_pkg @deepseek-ai/dsh-storage packages/storage/storage
link_pkg @deepseek-ai/dsh-storage-domain packages/storage/storage-domain
```

`@deepseek-ai/schemastery` 不需要在插件根重复链接：`dsh-storage-domain` 包内
`node_modules/@deepseek-ai/schemastery` 已链接 checkout `vendor/schemastery`（Node/TS 按
包局部解析），build.sh 根链接 `schemastery` 供本插件 `src/config.ts` 使用。

`zod` 已由 `link_store_pkg zod` 链接（P1.2）；本单起 host lib 直接 `import z from 'zod'`，
因此 `package.json` peerDependencies 增加（均不硬编码精确版本）：
`"@deepseek-ai/dsh-storage-domain": ">=0.1.3-alpha.1 <2"`、`"zod": "^4.4.3"`。

### 3.5 `scripts/assert-structure.mjs` 追加 D4（引擎零改动）

```js
{ id: 'D4', canon: 'docs/09 §1/§2 + docs/11 §2 + docs/13 §3.6',
  appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'),
  check: (f) => /(ctx\.storageDomain|storageDomain|defineDomain|domainTable)/.test(f.text)
    && f.path !== 'src/platform/storage.ts' && f.path !== 'src/index.ts'
    ? [{ message: 'storageDomain/defineDomain/domainTable must only appear in platform/storage.ts (index.ts wiring allowed, docs/09 §1)' }]
    : [] }
```

`tests/assert-structure.spec.ts`：负样本 `src/domains/a.ts` 出现 `ctx.storageDomain.open` →
issue；正样本 `src/platform/storage.ts` 与 `src/index.ts`（`ctx.inject(['storageDomain'])`）→
0 issue；真实树零位快照增 `D4:'pass'`。

### 3.6 `scripts/verify-p3.mjs`（新，≤120 行；agent 自动化验收入口）

Node 内置模块 + `spawnSync`，只跑命令/扫描，不替代测试。流程：

1. `DSH_CHECKOUT=G:/deepseek-harness npm run build`（先 build 再 gate——storage 域依赖
   `@deepseek-ai/dsh-storage-domain` 需 build.sh 链接；`DSH_CHECKOUT` 可覆盖，目录不存在 →
   打印 SKIP 并注明原因，不判 FAIL）→ 非 0 即 FAIL。
2. `npm run gate` → 非 0 即 FAIL。
3. `node scripts/assert-structure.mjs --json` 连跑两次，输出 diff 非空即 FAIL（确定性）。
4. grep 组（期望 0 命中）：
   - `grep -R "from '@deepseek-ai\|from \"@deepseek-ai\|from 'cordis\|from \"cordis\|/platform/" src/core/ledger`（P2 核心保持零 import）
   - `grep -R "fetch(\|http.get\|axios" src/platform/storage.ts tests/storage.spec.ts`
   - `grep -R "setInterval(" src/platform/storage.ts`
   - `grep -R "\.append(" src/platform/storage.ts`（storage 不写会话日志）
   - `grep -R "from '\.\./core\|from \"\.\./core\|from '../core\|from \"../core" src/platform/storage.ts`
     （storage 不依赖 core；等价性由测试 type-level 证明）
   - `grep -R "from '@deepseek-ai/dsh-storage'" src`（本单只准 import `dsh-storage-domain`，
     不直接摸 backend）
5. 行数预算：`src/platform/storage.ts ≤300`、`tests/storage.spec.ts ≤280`、
   `scripts/verify-p3.mjs ≤120`；超限即 FAIL。
6. `grep -n "D4" scripts/assert-structure.mjs tests/assert-structure.spec.ts` 各至少 1 命中
   （D4 真进引擎与自测，防空转）。
7. 打印 `P3 VERIFY PASS` 或失败清单，exit 0/1。

### 3.7 文档回写

- `docs/implement/00-master.md`：P2 行标注已施工（commit `38e3af3`）；P3 行依赖列
  `P0` → `P1,P2` 并链到本文件；P13/P14/P19/P21 行依赖列补 `P3`（理由见 §8.2）。
- `docs/implement/P2-ledger-base.md` 状态行：计划态 → 已施工（commit `38e3af3`）。

## 4. 实现要点（每步独立可验证；顺序执行）

1. **核验 harness**（§2.3）：逐条 grep 到定义处，确认签名与 P3 设计一致；不一致停工上报。
2. **改 build.sh + package.json**（§3.4）→ `DSH_CHECKOUT=G:/deepseek-harness npm run build` 绿。
3. **写 `src/platform/storage.ts`**（§3.1）→ `npm run typecheck` 绿。
4. **改 `src/platform/logger.ts`**（§3.2）→ typecheck 绿。
5. **改 `src/index.ts`**（§3.1 接线语义）：
   - 顶部加 `import type {} from '@deepseek-ai/dsh-storage-domain'`（拉入 `Context.storageDomain` 服务键合并，
     只用于类型面；D4 允许 index 出现 storageDomain 概念）。
   - `ctx.inject(['storageDomain'], (storageCtx) => { ... })`，回调内 `storageCtx.effect(async () => ...)`。
   - `openContextEconomyStorage(storageCtx, { logger: ceLogger(storageCtx) })` 成功 →
     `registerFactMirror((type, data) => { storage.writeFactMirror(type, data) })`；
     返回 disposer：先 `registerFactMirror(undefined)` 再 `await storage.close()`。
   - 开域失败 → `registerFactMirror(undefined)` + `warn('context-economy: storage domain unavailable (contained, fail-lazy)', ...)`，
     返回 no-op disposer。→ `npm run typecheck` 绿。
6. **写 `tests/storage.spec.ts`**（§3.3）→ `npm test` 绿（新增 9 组用例）。
7. **追加 D4**（§3.5）→ `npm run assert` 绿；更新 `tests/assert-structure.spec.ts` 快照与负/正样本
   → `npm test` 绿。
8. **写 `scripts/verify-p3.mjs`**（§3.6）→ `node scripts/verify-p3.mjs` 全 PASS。
9. **全链自验**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`；`npm run gate`；
   `node scripts/assert-structure.mjs --json` 双跑 diff 空。
10. 对照 §5 清单逐条打勾；全部满足后执行 §3.7 文档回写，再进 §7。

## 5. 验收（全机械 + agent 自动化检查）

- [ ] `node scripts/verify-p3.mjs` 输出 `P3 VERIFY PASS`（§3.6 七组全过）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0（build.sh 链接 storage 三包）
- [ ] `npm run gate` exit 0（typecheck + typecheck:client + vitest + assert 四段全绿）
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次输出逐字节一致（diff 为空）；
      零位快照含 `D4:pass`
- [ ] `tests/storage.spec.ts`：§3.3 九组用例齐全且绿（vitest 输出可见）
- [ ] type-level 等价断言绿：`FactMirrorRecord` ↔ `LedgerFact` 双向结构等价（§3.3-⑨）
- [ ] `grep -R "from '@deepseek-ai/dsh-storage'" src` 无命中（不直接摸 backend）
- [ ] `grep -R "\.append(" src/platform/storage.ts` 无命中（持久面不写会话日志）
- [ ] `grep -R "fetch(\|http.get\|axios" src/platform/storage.ts tests/storage.spec.ts scripts/verify-p3.mjs`
      无命中（spawn 本地命令不算网络）
- [ ] `git diff tests/field-model.spec.ts tests/apply-smoke.spec.ts tests/events-pump.spec.ts`
      为空（既有测试零改动；assert-structure.spec 只按 P3 追加 D4 样本/快照）
- [ ] 行数预算：`src/platform/storage.ts ≤300`、`tests/storage.spec.ts ≤280`、
      `scripts/verify-p3.mjs ≤120`（`wc -l`）

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **storage.ts 不 import `core/**`**：`FactMirrorRecord` 是 `LedgerFact` 的结构复制；
   等价性由测试 type-level 断言证明。违反会引入 `platform → core` 反向依赖（模块树不许可的
   实现耦合）。
2. **不建会话事件类型**：P3 不声明任何 `context-economy/*` SessionEventMap 合并；`version-mismatch`
   发射归 P21（恢复时才有 session 面）。本单只接事实镜像，不发射事实。
3. **不改 `ignorable-channel.ts`**：探测/路由/降级语义 P1 已冻结；P3 只经 `logger.ts` 的
   `registerFactMirror` 接 `setFactMirror`。D3 边界不破。
4. **CAS 读-改-写窗口**：`putEntity` 的 get 与 put 之间无 `await`（同步检查后立即入写链），
   单线程内原子；调用方必须 `await putEntity` 串行化对同一 key 的写（后续工单纪律）。
5. **body 类型故意为 `z.unknown()`**：实体内容 schema 归 P9/P11/P13/P17 等机制工单；
   后续收窄 body 时允许走 `compatibleVersions` + 新 domain version，禁止在 P3 猜测实体字段。
6. **事实镜像异步 durable 失败**：同步入队即计 `mirrored`（`emitFact` 现状），异步落盘失败
   在 storage 侧计 `factMirrorDurabilityErrors` 并 warn——**绝不静默**；若后续要严格把异步
   失败回写为 `blocked`，需单开 P3.1 改 `FactMirror` 为可异步接口，P3 不做。
7. **停工上报触发器**：① §2.3 核验签名与设计不符；② build.sh 链接 storage 三包后
   `npm run typecheck` 仍无法 resolve；③ `openContextEconomyStorage` 与 harness Domain
   语义冲突（如 `update` missing-key 行为变化）；④ 行数预算超限且无法精简；⑤ 任何未覆盖
   决策点。上报带证据（命令 + 输出 + file:line）。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p3): 持久面——storageDomain 四实体表 + CAS/快照回滚 + 事实镜像表接线`
- 账本快照：**本单不需要**（本单产出的是存储**管道**，不是机制改动；R1 段末随 P7 完成后
  出首份 07 报表快照，见总纲 §4）。
- 汇报（**本单最后一步，执行者必须完成**）：按 §9 向用户报告修改内容、功能实现与文档对应表。

## 8. 对接面（P3 如何被后续计划消费）与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式（P3 提供） |
|---|---|
| P8 分划单位 + 稳定前缀 | 段状态机 KV 双源（[12 §3](../12-platform-capabilities.md)）经 `getEntity/putEntity` 读写 `project_frame` 快照；CAS 保证帧版本 bump 不被并发覆盖 |
| P9 卷宗 | `dossier` 表 append/回填走 `putEntity`（baseVersion = 当前 vN → vN+1）；边界清空 = `delete` 或由 P19 调用方按档案事务处理 |
| P11 星标断面 | `optimize_artifact` 表先版本化落盘再复用（[09 §2](../09-state.md) 协议 5）；行式裁决记录随 body 一起写 |
| P13 命令面 + init 项目帧 | `project_frame` v1 创建：`putEntity('project_frame', workspaceKey, frameBody, {taskId, eventType:'init-frame', ...})` |
| P14 星标按钮 UI | 用户确认终稿 → `optimize_artifact` 写入 + `dossier` 回填（P9 面）；`rollbackEntity` 在预览放弃/重做时可选 |
| P17/P19 边界装配/编排 | `boundary_archive` 写入走 `putEntity`；档案堆只追加（[10 §6](../10-wiring.md) 断言4）；硬帽截断 = 新版本写入 |
| P20 压力路径 + 保险丝 | 检查点/断路器状态（如需要持久）走 `putEntity` 版本化；无直接表（暂用 `boundary_archive` 之外的新表需 P20 单列决策，不在 P3 猜测） |
| P21 恢复编排 + 全链验收 | `auditEntity`/`rollbackEntity`/`listFactMirror` 是恢复序原语；`restore/*` 事实发射、`version-mismatch` 发射归 P21；恢复演练 = 09 §6 |

### 8.2 对后续计划的修正（随本计划先行回写 `docs/implement/00-master.md`）

| 行 | 原依赖 | 修正为 | 理由 |
|---|---|---|---|
| P3 | P0 | **P1,P2** | 事实镜像接线经 P1 `logger/ignorable-channel`；`FactMirrorRecord`↔`LedgerFact` 等价断言依赖 P2 |
| P12 | P10 | **P10,P3** | 自动断面逐消息追加卷宗 `dossier`（docs/02 §2/§3） |
| P13 | P8,P9,P11 | **P8,P9,P11,P3** | init 项目帧写 `project_frame`（docs/09 §2/§4） |
| P14 | P11,P13,P6 | **P11,P13,P6,P3** | 星标确认写 `optimize_artifact` + 回填卷宗（时序 B，docs/10 §4） |
| P19 | P17,P18,P2 | **P17,P18,P2,P3** | 边界归档写 `boundary_archive`（时序 A，docs/10 §3） |
| P21 | P19,P20 | **P19,P20,P3** | 恢复编排直接读/回滚四实体表（docs/09 §4） |

**句柄获取铁律（P3 审查补充，2026-09-06）**：`context_economy` 域在 `index.ts` 开域后
由 P3 的 `ContextEconomyStorage` 句柄统一服务；后续工单**不得**自行调用
`openContextEconomyStorage`（域名全局唯一，重复 open 会被 harness 拒为 `already-open`）。
消费方式 = 在 `index.ts` 的 `openContextEconomyStorage(...).then(opened => ...)` 装配回调内，
把 `opened` 作为参数传给 domain 工厂；domain 工厂签名建议为
`(ctx, deps: { storage: ContextEconomyStorage; ... }) => disposer`。

总纲 §3 依赖主干图补注：`P2 ─ P3`（P3 依赖列已含 P2）；上述行新增依赖均从较早节点指向
较晚节点，DAG 性保持。

## 9. 汇报模板（本单最后一步）

执行者在全绿后向用户报告，必须包含：

1. **修改内容**：列出新增/改动文件与行数；`tests/assert-structure.spec.ts` 仅 D4 样本与快照变化。
2. **功能实现**：`context_economy` 域声明；四实体表 + 事实镜像表 + 快照表；source 强制；
   CAS 版本写入；快照回滚（N=50）；审计读取；`index.ts` 事实镜像接线与 fail-lazy；
   verify-p3 自动化检查结果。
3. **与文档对应表**：

| 功能 | 代码 | 文档 |
|---|---|---|
| storageDomain 四实体表声明 | `src/platform/storage.ts` `CE_STORAGE_SPEC` | docs/09 §2；docs/11 §2 storage.ts 行 |
| source 强制 + 版本化写（CAS） | `putEntity` | docs/09 §2 协议 2/3 |
| 快照回滚 + 审计 | `entity_snapshots` + `rollbackEntity`/`auditEntity` | docs/09 §5 |
| 事实镜像表（通道缺失降级真源） | `fact_mirror` + `writeFactMirror` + `index.ts` 接线 | docs/12 §2–§3；docs/07 §5 事实源抽象 |
| H10 封装（open/close/表句柄） | `openContextEconomyStorage` | docs/13 §3.6；docs/10 §1 H10 |
| D4 storage 概念收口 | `scripts/assert-structure.mjs` D4 | docs/09 §1；docs/11 §2 |
| 自动化验收 | `scripts/verify-p3.mjs` | 总纲 §2 铁律 2 + §5 全机械验收 |

4. **后续计划修正已回写**：§8.2 的依赖修正是否已写入 `docs/implement/00-master.md`。
