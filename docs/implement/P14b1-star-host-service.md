# P14b1 星标 host 断面服务 + RPC 桥端口（映射 R2；依赖 P14a,P11,P13,P6,P3；尺寸 M）

> 状态：**计划稿（下一未执行工单）**。前序：P14a 星标按钮 UI 已施工（client 侧 `createMockStarBridge()`）；
> P11 断面纯核（`core/optimize.ts`）、P12 自动断面、P13 命令面（`/optimize-prompt` 已注册但 handler 返回
> "完整断面由 P14b 接入后开放"）均已施工。
> 本单交付 **host 半边**：星标断面服务（装配输入栈 → H12 断面 → 双通道解析 → 预览态 → 用户确认后回填/产物落盘）
> **+ Connection RPC 桥端口**。**不实现 client 真实桥**（归 [P14b2](P14b2-star-live-bridge.md)）——本单完成后
> client 仍用 mock，UI 行为零变化，插件可正常加载。
> 设计正典：[02 §4](../02-discriminator.md)（手动断面五出口 / 双通道契约 / 门控 / 机械审计表）/
> [10 §1 H11](../10-wiring.md)（星标 → host 方法）/ [10 §4](../10-wiring.md)（时序 B）/
> [09 §2](../09-state.md)（优化产物 vN + 卷宗回填 vN+1）/ [07 §0.5](../07-metrics.md)（断面族字段）/
> [12 §2](../12-platform-capabilities.md)（事实发射只经 `emitCeFact`，机制零感知）/
> [11 §2](../11-structure.md)（platform 唯一触点层）/ [13 §3.11](../13-harness-plugin-spec.md)（本单新建：Connection RPC 桥）
> harness 符号核验源（本仓 checkout `82a5fd61a7` + 本地补丁分支，逐条已 grep 到定义处；找不到 = 停工上报）。

## 0. 与文档的偏差修正（本单必须吸收，执行者不得再自行裁量）

### 0.1 传输选型：**Connection 通用 RPC 通道**（取代 P14a §8.2 的"custom Typert Remote contribution"设想）

P14a §8.2 预留了"P14b 可通过 custom Typert Remote contribution 暴露给 client"。**本单否决该路线，改用
Connection 通用 RPC 通道**。理由（均已核验源码，不是偏好）：

| 候选 | 结论 | 依据 |
|---|---|---|
| Typert Remote（`@Remote` 装饰器 + host SRC fallback + client `$mount`） | **否决** | ① 外部插件没有 typert 生成器产物，只能走 host SRC fallback（`packages/api/gateway/src/index.ts:266-290,644-670`）——依赖装饰器标记 + **编译后 JS 形参名**，构建链脆弱；② client `$mount` 强制 **strict codec**（`packages/api/gateway/src/client/index.ts:709-720` 抛 `no strict codec`），必须手写 zod schema + `TypertRemoteNamespaceMap` 声明合并，且 zod 会打进 client bundle；③ 需新增一个 Cordis Service 键与 `@deepseek-ai/dsh-typert-protocol` peerDep |
| **Connection 通用 RPC 通道**（host `ctx.connection.rpc.handle` + client `ctx.connection.rpc.call`） | **采用** | ① 两侧都是官方公开接口（`HostConnectionRpc`/`ClientConnectionRpc`，`packages/client/connection/src/rpc.ts:138-162,220-234`）；② 零生成器、零 zod、零新服务键；③ channel 自带 Host/Origin trust + browser auth（`rpc-host.ts:158-182`）；④ 可离线 fake 测——harness 自身测试即先例（`packages/client/connection/tests/node-half.host.spec.ts:272-319`） |

**渠道定稿**：channel `'/context-economy'`，endpoint `'star.preview'` / `'star.apply'`（两者都满足
Connection 的 channel/endpoint 文法 `packages/client/connection/src/client/rpc.ts:12-13`）。

### 0.2 `optimize-run` 采用**两相单事件**（细化 docs/02 §7 的"全账"）

docs/02 §7 只列了事件名 `optimize-run`（星标断面全账）。本单把它细化为**同一事件类型的两相**：

- `phase: 'preview'`：断面跑完即发（**含 LLM 成本**）——取消预览也真实付费，成本不得漏记；
- `phase: 'applied'`：用户确认后发（回填/剪切落账）；
- 两相以 `previewId` 关联；`foldOptimizeRunFacts` 按 `previewId` 归并 ⇒ **一次断面恰一条 `OptimizeRecord`**，
  `optimizeCount` = 断面次数（含未确认），`optimizePromptTokens` 只取自 preview 相，`verdictBackfill`/`shearAtStar` 只取自 applied 相——无重复计数。

### 0.3 剪切清单本阶段只落盘

docs/10 §4 时序 B 写"剪切清单 → H4 surfaceOp 执行"。**本单不执行**（R3 剪切域 P15b 才落调度），
只把 `SHEAR` 行写入优化产物 + 入 `optimize-run(applied)` 计数。执行者不得在 P14b1 调用 `platform/history.ts`。

### 0.4 用户编辑即终稿：apply 不因权威段缺失而拒绝

`missingAuthority` 是**给模型产出的告警**（预览弹层展示），不是用户编辑的校验门。宪法条文八
（相信用户决策）+ 失败默认保留：apply 只校验 `previewId` 存在与 `sessionId` 匹配，**不校验**
`editedProduct` 是否包含候选权威段。

### 0.5 `/optimize-prompt` = 预览形态（不自动回填）

命令面与星标共用同一 host 流程，但命令结果不是确认 UI。本单让 `/optimize-prompt` 只跑断面并把
产品文本 + 裁决摘要作为命令结果返回，**不写卷宗、不写产物、不改草稿**；回填只经星标弹层确认后触发。

## 1. 目标

在 host 半边落地一条可离线验证的星标管线：给定 `sessionId` + 草稿 `prompt`，
① 装配输入栈（稳定前缀 + 卷宗 + 当前 prompt + 候选权威段 + 技能目录）→ ② 单次 H12 断面
（`purpose='context-economy-optimize'`、`temperature=0`）→ ③ 双通道解析（产品 + 行式裁决）→
④ 返回与 `client/star/star-types.ts` 的 `StarPreviewData` 同构的 DTO；用户确认后
⑤ 卷宗回填 vN+1（`backfillDossier`，含 conflicts 计数）+ 优化产物 vN 落盘（含 judgeTable/shear 清单）
+ `optimize-run(applied)` 事实。全程 fail-lazy：任何一步失败都返回稳定错误码，**不写任何状态**。

## 2. 输入

### 2.1 正典摘录（工单自足）

- **02 §4 五出口**：A 优化后 prompt（自由文本，预览 diff → 用户确认 → 原地替换）；B 判别回填
  （卷宗 vN+1，落状态不落历史字节）；C task 边界只判断不执行；D 剪切清单（本单只落盘）；E 度量事件（log-only）。
- **02 §4 门控**：卷宗太短 → 产品层跳过，只回填裁决（`isDossierShort` + `renderOptimizePrompt` 的 `short` 语义已实现）。
- **02 §4 机械审计**：权威段逐字保留检查 = 纯机械包含性 diff（`checkAuthoritySpans`）；技能名引用守卫 = 目录查表（`parseOptimizeOutput` 已按 `validateSkillName` 丢行）。
- **02 §4 失败语义**：默认不动（不回填、不替换、不剪）。
- **10 §4 时序 B**：host 方法 → H12 断面 → 双通道解析 → client 渲染 diff → 用户确认/编辑（=终稿）→ 执行回填与落盘 → `optimize-run` 入账。
- **09 §2**：优化产物 vN = 用户确认版 prompt + 行式裁决记录；卷宗回填 = vN+1 终审；每次写入必须带 `source`。
- **07 §0.5 断面族**：`optimizePromptTokens{in,out}` · `verdictBackfill{count,conflicts}` · `shearAtStar{pairs,tokens}`。
- **12 §2**：事实只经 `emitCeFact` 发射，机制代码对通道零感知；事件类型必须 `ignorable`。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/core/optimize.ts` | `renderOptimizePrompt` / `parseOptimizeOutput` / `extractAuthorityCandidates` / `checkAuthoritySpans` / `clampOptimizePrompt` / `foldOptimizeLedger` / `OptimizeRecord` / `OptimizeVerdict` | **只读复用**（不改 P11 纯核） |
| `src/core/dossier.ts` | `backfillDossier` / `foldDossierLedger` / `isDossierShort` / `dossierStorageKey` / `sessionScopedTaskId` / `createDossier` | 只读复用 |
| `src/core/prefix.ts` | `projectFrameStorageKey` / `ProjectFrameBody` | 只读复用 |
| `src/core/units.ts` | `foldSegmentState`（当前 taskId） | 只读复用 |
| `src/core/ledger/facts.ts` | `factsFromSessionEvents` | 只读复用 |
| `src/platform/llm.ts` | `streamCeLlm` / `CeGenerateOptions` / `CeLlmUsage` | 只读复用（`purpose` 四值已含 `context-economy-optimize`） |
| `src/platform/logger.ts` | `emitCeFact` / `ceLogger` / `CeFactType` | 只读复用 |
| `src/platform/skills.ts` | `listSkillCatalog` | 只读复用 |
| `src/platform/storage.ts` | `ContextEconomyStorage` / `EntitySource` / `optimize_artifact` 表 | 只读复用 |
| `src/domains/commands.ts` | `CommandFaceDeps.manualOptimize`（已预留） | **改**：接线 `manualOptimize`（+≤15 行） |
| `src/domains/input.ts` | `readJudgeTable`（读 `optimize_artifact:latest:<ws>.judgeTable`） | 只读对齐——**本单是该表的第一个写者**，写出的 `judgeTable` 形状必须被它接受 |
| `src/index.ts` | 装配根（storage 打开 → skills/llm/commands 子 fiber） | **改**：接线 sessions+connection 子 fiber（+≤45 行） |
| `client/star/*`、`client/index.ts` | P14a mock 桥 | **本单零改动**（真实桥归 P14b2） |
| `scripts/assert-structure.mjs` | RULES M1–M5/S1–S5/D1–D8 | **改**：追加 D9（+规则条目） |
| `tests/assert-structure.spec.ts` | 负/正样本 + 零位快照 | **改**：D9 样本 + 快照加 `D9: 'pass'` |
| `scripts/build.sh` | 依赖链接清单 | **改**：补 `@deepseek-ai/dsh-client-connection` 链接 |

### 2.3 harness 核验源（符号 → 定义处；找不到即停工上报）

| 符号 | 定义处 | 用途 |
|---|---|---|
| `Context.connection: HostConnectionHandle`（host 面 merge） | `packages/client/connection/src/rpc-host.ts:52-57` | 读 host Connection 服务 |
| `HostConnectionService.rpc` getter（owner-scoped） | `packages/client/connection/src/rpc-host.ts:79-86` | 取 `HostConnectionRpc` |
| `HostConnectionRpc.handle(channel, handler)` | `packages/client/connection/src/rpc.ts:138-162` | 注册 `/context-economy` 通道 |
| `ConnectionRpcHandler = (endpoint, payload, signal) => Promise<ConnectionRpcResult<unknown>>` | `packages/client/connection/src/rpc.ts:99-104` | handler 签名 |
| `ConnectionRpcResult<T> = {ok:true,value} \| {ok:false,error:{code,message,details}}` | `packages/client/connection/src/rpc.ts:24-27` | 返回信封 |
| `register(owner, channel, handler)`（trust + browser auth + prefix WebRoute） | `packages/client/connection/src/rpc-host.ts:158-182` | 路由语义（**owner = connection 的 ctx**，故 disposer 必须由本插件自行持有） |
| channel/endpoint 文法 `^\/[A-Za-z0-9._~-]+$` / `^[A-Za-z0-9_$.-]+$` | `packages/client/connection/src/rpc.ts:32-33` | 命名约束 |
| 专用 RPC 通道先例测试 | `packages/client/connection/tests/node-half.host.spec.ts:272-319` | 语义/卸载证明 |
| `SessionStore.get(id)` | `packages/core/session/src/index.ts:1187-1189` | sessionId → live Session |
| `Session.snapshotEvents()` | `packages/core/session/src/index.ts:622` | 读会话事实（当前 taskId） |
| （**否决路线**的核验源）Gateway SRC fallback | `packages/api/gateway/src/index.ts:266-290,644-670` | §0.1 依据 |
| （**否决路线**的核验源）client `$mount` strict codec 强制 | `packages/api/gateway/src/client/index.ts:709-720` | §0.1 依据 |

**类型面策略（重要）**：`@deepseek-ai/dsh-client-connection` 的根 d.ts 会级联引用
`dsh-host-webserver`/`dsh-credentials`/`dsh-attachment`（均未链接）。因此：

- `platform/star-bridge.ts` 只从 **源文件子路径** `@deepseek-ai/dsh-client-connection/src/rpc.ts`
  `import type { ConnectionRpcHandler, ConnectionRpcResult }` 做**编译期结构锚**（该文件只依赖 `@deepseek-ai/dsh-brand`，已链接，零级联）；
- `ctx.get('connection')` 的最小结构面（`StarConnectionFace`）**本地重声明**在端口文件内（仿 core 本地重声明纪律），
  由 `src/index.ts` 在装配点做**唯一一次**取值收窄（`ctx.get` 返回 `any`，无需 `as`，但注释必须写明收窄意图）。
- **回退（仅在 tsc 拒绝上述子路径导入时启用，并在 §8.2 记录）**：删掉该 type-only 导入，仅保留本地结构声明 +
  类型级互赋断言（`type _AssertHandler = StarRpcHandler extends ConnectionRpcHandler ? true : never` 无法成立时改为
  在 `tests/star-host.spec.ts` 用 fake 捕获 handler 做运行时形状断言）；真实信封一致性由 P14b2 隔离 home 冒烟
  （对 `/context-economy/star.preview` 发真实 POST）兜底。**不得**为此链接 webserver/credentials/attachment。

### 2.4 决策点（执行者不得再自行裁量）

1. **渠道/端点定稿**：`channel='/context-economy'`、`preview='star.preview'`、`apply='star.apply'`。
2. **信封**：host 返回 `ConnectionRpcResult`；`ok:true` 的 `value` = 业务 DTO；`ok:false` 的 `error.code` 取
   `STAR_BRIDGE_CODES`（下表）。业务失败与传输失败同层表达，client 无需二次判别 `ok`。
3. **错误码表（冻结）**：
   `CE_STAR_BAD_REQUEST`（payload 形状非法）· `CE_STAR_UNKNOWN_ENDPOINT` · `CE_STAR_NO_SESSION`（sessionId 解析不到 live Session）·
   `CE_STAR_LLM_FAILED`（非 stop 结束 / 流异常）· `CE_STAR_PARSE_FAILED`（`parseOptimizeOutput` 无产品且无裁决）·
   `CE_STAR_UNKNOWN_PREVIEW`（previewId 不存在或跨会话）· `CE_STAR_STORAGE_FAILED`（putEntity 失败）·
   `CE_STAR_INTERNAL`（handler 抛出）· `CE_STAR_UNAVAILABLE`（**client 侧**：无 connection 服务/网络失败）。
4. **预览态**：host 内存 `Map<previewId, PendingPreview>`，容量 `STAR_PREVIEW_LIMIT = 32`（插入序淘汰，无 timer）；
   previewId 形如 `<sessionId>#<taskId>#<dossierVersion|0>#<seq>`（进程内单调 `seq`，确定性可断言）。
5. **apply 幂等**：同一 `previewId` 二次 apply → `ok:true` + `text` 注明"已应用（重复提交）"，**不重复写盘/发事实**（`stats().reapplies` 计数）。
6. **两相事实**：`optimize-run(phase='preview')` 在断面跑完（无论成功失败）即发；`optimize-run(phase='applied')` 在两次 `putEntity` 都成功后发。
7. **产物形状**（`optimize_artifact` 键 `optimize_artifact:latest:${workspace}`，必须被 `domains/input.ts:readJudgeTable` 接受）：
   `{ judgeTable: { version: n(≥1), aspects: string[], fileSignatures: string[], keywords: string[] }, product, verdicts: {kind,summary}[], shear: {startSeq,endSeq,note}[], keptSpanIndexes: number[], taskId, sessionId, previewId, appliedAt }`；
   `judgeTable.version = (上一版?.judgeTable?.version ?? 0) + 1`。
8. **不新增配置**：星标通道常在，不受 `discriminator.auto` 门控；本单不改 `config.ts` / `field-model.ts`。
9. **不改 client**：P14b1 期间 `client/index.ts` 继续 `createMockStarBridge()`。

## 3. 产出

### 3.1 `src/platform/star-bridge.ts`（新，≤170 行；唯一 connection 触点）

- 常量：`STAR_BRIDGE_CHANNEL`、`STAR_PREVIEW_ENDPOINT`、`STAR_APPLY_ENDPOINT`、`STAR_BRIDGE_CODES`。
- 结构面（本地重声明，附注释说明来源与 §2.3 策略）：
  ```ts
  export interface StarRpcFailure { readonly code: string; readonly message: string; readonly details: object }
  export type StarRpcResult =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: StarRpcFailure }
  export type StarRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<StarRpcResult>
  export interface StarConnectionFace { readonly rpc: { handle(channel: string, handler: StarRpcHandler): () => Promise<void> } }
  ```
  并对 `StarRpcHandler`/`StarRpcResult` 做**编译期结构断言**（类型别名与 `ConnectionRpcHandler`/`ConnectionRpcResult` 互赋性检查，任一处不兼容即 `npm run typecheck` 红）。
- 业务 handler 契约：
  ```ts
  export interface StarBridgeHandlers {
    preview(payload: { sessionId: string; prompt: string }): Promise<StarBridgeOutcome<StarPreviewDto>>
    apply(payload: { sessionId: string; previewId: string; editedProduct: string }): Promise<StarBridgeOutcome<{ text?: string }>>
  }
  export type StarBridgeOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string }
  ```
- `export function registerStarBridge(connection: StarConnectionFace, handlers: StarBridgeHandlers, logger?: CeLogger): () => Promise<void>`：
  注册通道；按 endpoint 分派；payload 形状校验失败 → `CE_STAR_BAD_REQUEST`；未知 endpoint → `CE_STAR_UNKNOWN_ENDPOINT`；
  handler 抛错 → 捕获 + `logger.warn`（**只记 code，不记 payload 内容**——prompt 是用户数据）+ `CE_STAR_INTERNAL`；
  返回的 disposer 直接转交 `connection.rpc.handle` 的 disposer（**注意 owner 是 connection 的 ctx，必须由装配点持有并卸载**）。
- 纯校验函数 `parsePreviewPayload` / `parseApplyPayload`（可单测，零副作用）。
- `signal` 参数**不消费**（本单断面不可中断；客户端断开由连接层处理），注释说明。

### 3.2 `src/domains/star.ts`（新，≤280 行；编排面，零 harness 运行时 import）

- DTO（与 `client/star/star-types.ts` **同构但独立声明**——client 不得 import src、src 不得 import client）：
  ```ts
  export interface StarVerdictView { readonly kind: string; readonly summary: string }
  export interface StarMissingAuthority { readonly index: number; readonly text: string }
  export interface StarPreviewDto {
    readonly previewId: string
    readonly originalPrompt: string
    readonly product: string | null
    readonly verdicts: readonly StarVerdictView[]
    readonly missingAuthority: readonly StarMissingAuthority[]
    readonly droppedLines: number
    readonly ctxTokens: number
    readonly short: boolean
  }
  ```
- `export interface StarHostDeps { storage; getConfig; logger; workspace?; now?; skillsCtx?; llmCtx?; resolveSession?: (id: string) => Session | undefined; emitFact?; }`
- `export function mountStarHost(deps): StarHost`，`StarHost = { preview(input: {sessionId,prompt}): Promise<StarBridgeOutcome<StarPreviewDto>>; apply(input: {sessionId,previewId,editedProduct}): Promise<StarBridgeOutcome<{text?:string}>>; stats(): {...}; dispose(): void }`
- 流程（fail-lazy，任一步失败返回错误码且**零写盘**）：
  1. `resolveSession` → `CE_STAR_NO_SESSION`；
  2. `readFacts`（`factsFromSessionEvents(session.snapshotEvents())`）→ `foldSegmentState` → `sessionScopedTaskId`；
  3. 读卷宗（无则 `createDossier`）+ 项目帧（`projectFrameStorageKey(workspace)`）+ 技能目录（`listSkillCatalog(skillsCtx)`）；
  4. `renderOptimizePrompt({ projectFrame, dossier, prompt, catalog })` → `streamCeLlm(llmCtx, { purpose:'context-economy-optimize', temperature:0, ... })`；
     `onUsage` 收 `CeLlmUsage`；非 `stop` 结束 → `CE_STAR_LLM_FAILED`；
  5. `parseOptimizeOutput(raw, dossier, catalog, extractAuthorityCandidates(prompt))`；
     `product === null && verdicts.length === 0` → `CE_STAR_PARSE_FAILED`（仍发 preview 事实，带 `errorCode`）；
  6. `checkAuthoritySpans(product ?? '', candidates, keptSpanIndexes)` → `missingAuthority`；
  7. 存 pending（§2.4-4/5/6）+ 发 `optimize-run(preview)` + 返回 DTO；
  8. `apply`：取 pending（无 → `CE_STAR_UNKNOWN_PREVIEW`）→ 重读卷宗 → `backfillDossier` → `putEntity('dossier', ...)`
     → 组产物 `putEntity('optimize_artifact', ...)` → 发 `optimize-run(applied)` → 标记已应用 → 返回 `{ok:true, text}`。
     `putEntity` 失败 → `CE_STAR_STORAGE_FAILED`（已成功的前一步不回滚；**顺序 = 卷宗 → 产物**，卷宗是主状态）。
- 纯导出（可单测）：`summarizeVerdict(v: OptimizeVerdict): StarVerdictView`、`buildPreviewDto(...)`、`buildArtifactBody(...)`。
- `stats()`：`{ previews, applies, reapplies, pending, llmFailures, parseFailures, storageFailures }`。

### 3.3 `src/domains/optimize-facts.ts`（新，≤130 行）

- 声明合并（`SessionEventMap` + `IgnorableSessionEventMap`，两处均带 `// ignorable` 注释）：
  `'context-economy/optimize-run': OptimizeRunFactData`。
- `export const OPTIMIZE_RUN_FACT_TYPE = 'context-economy/optimize-run'`
- ```ts
  export interface OptimizeRunFactData {
    phase: 'preview' | 'applied'
    previewId: string
    taskId: string
    sessionId: string
    at: number
    // preview 相
    short?: boolean; ctxTokens?: number; productChars?: number; verdictCount?: number
    droppedLines?: number; keptSpanCount?: number; missingAuthorityCount?: number
    shearPairs?: number; shearTokens?: number; latencyMs?: number
    llmUsage?: { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
    errorCode?: string
    // applied 相
    backfillCount?: number; backfillConflicts?: number
  }
  ```
- `export function foldOptimizeRunFacts(facts: readonly OptimizeRunFactData[]): OptimizeLedger`：
  按 `previewId` 归并 → `OptimizeRecord[]` → `foldOptimizeLedger`（`optimizeCount` = distinct previewId；
  usage 取 preview 相；backfill/shear 取 applied 相；无 applied 的记录计 0）。

### 3.4 接线（改）

- `src/index.ts`（净增 ≤45）：在 storage 打开成功后追加
  `ctx.inject(['sessions','connection'], (bridgeCtx) => { ... mountStarHost(...) → registerStarBridge(...) ... })`；
  在子 fiber 卸载时先 `starHost.dispose()` 再 `await stopStarBridge?.()`；`stopCommands` 前把
  `manualOptimize` 传给 `mountCommandFace`（命令形态 = 预览，不写盘）。
- `src/domains/commands.ts`（净增 ≤15）：新增可选 dep `manualOptimize` 的实现方（本单在 index 传入），
  `optimizeHandler` 已预留委托点——**不得**在 commands.ts 内 import `domains/star.ts`（避免环）；
  命令形态的实现放在 `src/index.ts` 的闭包（`starHost.preview(...) → CommandResult`）。

### 3.5 结构断言 D9（改）

`scripts/assert-structure.mjs` 追加：

```js
{ id: 'D9', canon: 'docs/10 §1 H11 + docs/11 §2 + docs/13 §3.11', appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'), check: (f) =>
  /(ctx\.connection|connection\.rpc|ConnectionRpcResult|ConnectionRpcHandler|HostConnectionRpc|ClientConnectionRpc|@deepseek-ai\/dsh-client-connection)/.test(f.text)
    && f.path !== 'src/platform/star-bridge.ts' && f.path !== 'src/index.ts'
    ? [{ message: 'connection RPC bridge concepts must only appear in src/platform/star-bridge.ts (index.ts wiring allowed, docs/13 §3.11)' }]
    : [] },
```

`tests/assert-structure.spec.ts`：负样本（`src/domains/star.ts` 出现 `ctx.connection` → issue；`src/platform/events.ts` 出现 `ConnectionRpcResult` → issue）、
正样本（`src/platform/star-bridge.ts` 全 token → 0 issue；`src/index.ts` 接线 → 0 issue）、零位快照追加 `D9: 'pass'`。

### 3.6 `tests/star-host.spec.ts`（新，≤380 行；零网络、零真模型）

必须覆盖（每条一个 `it`）：
1. 全量断面：fake session/dossier/项目帧/技能目录 + fake `llm.stream` 返回合法双通道文本 →
   `preview` 返回 `ok:true`，DTO 字段逐项断言（product/verdicts/droppedLines/ctxTokens/short=false/missingAuthority）；
2. 门控：短卷宗 → `short=true` 且 `product===null`（只回填裁决）；
3. 解析失败：LLM 输出乱码 → `CE_STAR_PARSE_FAILED`，且**零 `putEntity`**；
4. 非 stop 结束 → `CE_STAR_LLM_FAILED`，零 `putEntity`；
5. 无 live session → `CE_STAR_NO_SESSION`（**未调用 LLM**）；
6. `apply` 正常：卷宗回填（`by:'backfill'`）+ `conflicts` 计数（预置一条冲突 auto 标注）+ 产物 `judgeTable` 形状被 `readJudgeTable` 接受 + 事实两相各一条且 `previewId` 相同；
7. `apply` 未知 previewId / 跨会话 → `CE_STAR_UNKNOWN_PREVIEW`；
8. `apply` 幂等：二次 apply 不新增 `putEntity`、不新增事实，`stats().reapplies===1`；
9. 产物版本递增：第二次断面 apply 后 `judgeTable.version` 从 1 → 2；
10. `foldOptimizeRunFacts`：preview×2（其一无 applied）→ `optimizeCount=2`、tokens 只计一次、backfill 只计 applied 那条；
11. `summarizeVerdict` 八种 kind 的行文 + 长度钳制；
12. pending 容量：第 33 个预览淘汰最旧（`stats().pending===32`）。

### 3.7 `scripts/verify-p14b1.mjs`（新，≤190 行；仿 verify-p13 骨架）

0. `scripts/build.sh` 含 `@deepseek-ai/dsh-client-connection` 链接行（grep）；
1. 正向 grep：端口常量三值、`registerStarBridge`、`mountStarHost`、`foldOptimizeRunFacts`、
   `optimize-run` 在 `SessionEventMap`/`IgnorableSessionEventMap` 两个窗口内、`readJudgeTable` 兼容形状字段名；
2. 反向扫描：`src/domains/star.ts` 不得出现 `.append(`、`session/event`、`ctx.`、`setInterval(`、`fetch(`、`@deepseek-ai/dsh-session` 运行时 import；
   `src/core/**` 无 harness import（S1 已覆盖，此处再 grep 一次显式可见）；`client/star/*` 与 `client/index.ts` 在 P14b1 期间零 `connection` 引用；
3. `npm run gate` + `npm run typecheck:tests`；
4. `assert-structure --json` 双跑字节一致 + `D9` 状态为 `pass`；
5. build：优先 `C:/Program Files/Git/bin/bash.exe scripts/build.sh`（`DSH_CHECKOUT` 传入；WSL bash 会因 CRLF 失败，见 P14a 备注），失败再退 `npm run build`；
6. lib 新鲜度：`lib/platform/star-bridge.js` 存在且含 `star.preview`；`lib/domains/star.js` 含 `mountStarHost`；
7. 行数预算（§5 表）；
8. 打印 `P14b1 VERIFY PASS` / 失败清单，exit 0/1。

### 3.8 `scripts/build.sh`（改）

在 client 依赖链接区追加 `link_pkg @deepseek-ai/dsh-client-connection packages/client/connection`
（**类型锚所需**；§2.3 策略保证不级联链接 webserver/credentials）。

## 4. 实现要点（顺序执行，每步独立可验）

0. 先提交工作区遗留的两处文档状态更新（`docs/12`、`docs/13`，上一轮审查产物），单独一笔 `docs:` 提交，保持本单 diff 干净。
1. 建 `src/domains/optimize-facts.ts` → `npm run typecheck` 绿（声明合并 + fold）。
2. 建 `src/platform/star-bridge.ts` → `npm run typecheck` 绿（结构锚 + 校验函数）。
3. 建 `src/domains/star.ts` → `npm run typecheck` 绿。
4. 接线 `src/index.ts` + `src/domains/commands.ts` → `npm run typecheck` 绿。
5. 加 D9 + 断言样本 + 零位快照 → `npm run assert` 绿、`npm test -- tests/assert-structure.spec.ts` 绿。
6. 写 `tests/star-host.spec.ts` → `npm test` 绿、`npm run typecheck:tests` 绿。
7. 写 `scripts/verify-p14b1.mjs` → `node scripts/verify-p14b1.mjs` PASS。
8. 构建：`DSH_CHECKOUT=G:/deepseek-harness` + Git bash 跑 `scripts/build.sh`（host tsc + client tsdown）→ exit 0。
9. 回写文档（§8 表）→ 再跑一次 `npm run gate`。

## 5. 验收（全机械）

- [ ] `node scripts/verify-p14b1.mjs` 输出 `P14b1 VERIFY PASS`
- [ ] `npm run gate` exit 0（typecheck + typecheck:client + test + assert）
- [ ] `npm run typecheck:tests` exit 0
- [ ] `npm test` exit 0（含 `tests/star-host.spec.ts` 12 用例与 `tests/assert-structure.spec.ts` 的 D9 样本）
- [ ] `npm run assert` exit 0 且规则表含 `D9 pass`（`node scripts/assert-structure.mjs | grep '^D9'`）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness "C:/Program Files/Git/bin/bash.exe" scripts/build.sh` exit 0
- [ ] `grep -n "connection" client/star/* client/index.ts` 无命中（本单 client 零改动）
- [ ] `grep -n "\.append(\|session/event\|ctx\." src/domains/star.ts` 无命中
- [ ] `grep -n "ctx.connection\|connection.rpc" src --include=*.ts -r` 只命中 `src/platform/star-bridge.ts` 与 `src/index.ts`
- [ ] 行数预算：`star-bridge.ts ≤170`、`star.ts ≤280`、`optimize-facts.ts ≤130`、`tests/star-host.spec.ts ≤380`、`verify-p14b1.mjs ≤190`
- [ ] 净增预算：`src/index.ts ≤+45`、`src/domains/commands.ts ≤+15`
- [ ] `package.json` 新增 `@deepseek-ai/dsh-client-connection` peerDep（范围写法）且 `scripts/build.sh` 有对应链接行
- [ ] 文档回写清单（§8.2）全部落笔

## 6. 禁区与注意

1. **不改 P11 纯核**：`src/core/optimize.ts` 零改动；summary/产物组装在 `domains/` 内完成。
2. **不改 client**：`client/**` 本单零 diff（真实桥是 P14b2）。
3. **不执行剪切**：不得 import `platform/history.ts`、不得 `surfaceOp`。
4. **不写会话历史**：本单只写 KV（卷宗/产物）+ 发 ignorable 事实；`.append(` 只出现在 `platform/{history,logger,ignorable-channel}.ts`（S2）。
5. **fail-lazy**：任何失败路径 `putEntity` 调用数为 0；`apply` 的两笔写按"卷宗 → 产物"顺序，前一步失败即中止。
6. **隐私**：端口日志只记 endpoint/code/耗时，**不得**记录 prompt 或 product 文本。
7. **停报触发器**：`HostConnectionRpc.handle` 签名、`ctx.sessions.get`、`ConnectionRpcResult` 形状与 §2.3 不符 → 以 checkout 源码为准**停工上报**，不得自行改 harness。

## 7. 完成动作

- commit（验收全绿后）：`feat(p14b1): 星标 host 断面服务——Connection RPC 桥端口 + 双通道预览/回填 + optimize-run 两相事实`
- 账本快照：**本单不需要**（P14b2 真机端到端后随 R2 出门快照一并入 `docs/ledger-history.md` §32）。
- 汇报（**本单最后一步，必须完成**）：按 §9 报告。

## 8. 对接面与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式 |
|---|---|
| P14b2 | 按 §3.1 冻结的 channel/endpoint/payload/DTO 写 client 真实桥；契约测试断言两侧常量逐字相等 |
| P13 `/optimize-prompt` | 本单已接线（预览形态）；P14b2 真机验证命令输出 |
| P15b 工具剪切 | 从 `optimize_artifact.shear` 读剪切清单执行（本单只落盘） |
| P21b 全链验收 | `optimize-run` 两相事实 + `foldOptimizeRunFacts` 作为断面族回放口径 |

### 8.2 对后续计划的修正（**本单完成时回写**）

| 计划/文档 | 原表述 | 修正 |
|---|---|---|
| 00-master §3 P14b 行 | 单条 P14b | **拆为 P14b1 + P14b2**（本单已同步改写总表与依赖图） |
| P14a §8.2 | "可通过 custom Typert Remote contribution 暴露给 client" | **改为 Connection RPC 通道**（§0.1 依据） |
| docs/10 §1 H11 行 | "星标 → host 方法（时序 B）" | 补注：host 方法经 Connection RPC 通道 `/context-economy`（`star.preview`/`star.apply`），端口 = `platform/star-bridge.ts` |
| docs/10 §4 时序 B | "剪切清单 → H4 surfaceOp 执行" | 补注：P14b 阶段只落盘记账，执行归 P15b |
| docs/11 §2 模块树 | 无 `platform/star-bridge.ts` / `domains/star.ts` 行 | 追加两行（含 `domains/optimize-facts.ts`） |
| docs/11 §9 状态行 | "P14b 待接真实 bridge" | 改为 "P14b1 已施工（host 断面服务 + RPC 桥端口）；P14b2 待接真实桥" |
| docs/13 | 无 Connection RPC 桥章节 | 新增 §3.11（§2.3 核验源表 + 信封/错误码 + 否决路线依据），§5 落位表加 `platform/star-bridge.ts` |
| docs/12 | — | **不改**（本单零本地补丁；connection 是官方能力，归 docs/13 事实层） |

## 9. 汇报模板（本单最后一步）

1. 修改文件与净增行数（`src/index.ts`、`src/domains/commands.ts` 明确）；
2. 功能：RPC 端口（channel/端点/信封/错误码）、断面服务（门控/双通道/预览态/回填/产物）、两相事实与 fold、D9 断言；
3. 文档对应表：端口↔docs/13 §3.11；断面↔docs/02 §4；回填/产物↔docs/09 §2；事实↔docs/07 §0.5 + docs/12 §2；
4. 后续修正：§8.2 各行的落笔情况；P14b2 的输入契约是否与本单冻结值一致（差异必须列出）。
