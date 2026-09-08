# 13 · DSH 插件规范与接口审查（可复用参考）

> 定位：**harness 插件开发的外部契约单一参考**——把散落在 G:/deepseek-harness 源码/文档里的
> 插件规范、装配格式、可用接口逐条核验后收拢成一份可直接引用的文档。本文不是设计正典的替代，
> 而是 docs/00–12 之外“harness 现状是什么”的事实层；正典冲突时以 docs/00–11 为准，harness
> 事实冲突时以源码为准。
>
> 审查对象：`G:/deepseek-harness`（当前 checkout `82a5fd61a7` = tag `dsh-v0.1.3-alpha.2` + 本地补丁分支 `feat/ignorable-logintent-alpha2@2fa55bc741`；2026-09-06 首审基于 `ea04b581a5`/`0.1.3-alpha.1`，2026-09-08 P14a client 面增补，2026-09-08 ignorable 补丁在 alpha.2 重放）。
> 当前插件：`dsh-price-less`（`D:/deepseek-plugin`，P14a 已施工；R2 判别域 P8–P13 + P14a 完成）。
> 使用方式：后续工单（P2 起）凡涉及 harness API，先查本文 §3/§4 的“核验源”列；表中未列的符号
> 仍按总纲铁律逐条 grep 到定义处才准 import。

## 0. 一句话结论

DSH = 全插件 Cordis agent harness：**没有特权核心可补丁**。外部插件 = 一个 Cordis 插件包
（package.json 声明 `dsh.bundle.patch` 指向 cordis.patch.yml），经 profile patch 层插入一个
loader entry（`id` + `name` + 可选 `config/disabled/inject`）；运行时 `apply(ctx, config)`
通过 `ctx` 上的服务（`logger`/`on`/`effect`/`inject`/`settings`/`llm`/`storageDomain`/…）
贡献行为，所有注册挂 `ctx.effect` 卸载即净。会话事实走 `session.append`（log-only 事件必须
`ignorable:true` 且类型并入 `IgnorableSessionEventMap`），改史只能走 `surfaceOp:'replace'`。

## 1. 装配层（插件怎么被加载）

### 1.1 插件包 manifest（外部插件最小集）

harness 内包规范见 `packages/AGENTS.md:5`（函数插件必须具名导出
`name`/`inject`/`Config`/`apply`，无 default export）；外部插件以 bundle 形态装配，当前插件
`package.json` 的合规面已由 P0/P1.2 固化（`scripts/assert-structure.mjs` M1–M5）。必需项：

| 项 | 值/形态 | 核验源 |
|---|---|---|
| `name` / `version` | 任意 npm 包名；版本 `x.y.z` | 当前插件 `package.json` |
| `type` | `"module"`（ESM everywhere） | `G:/deepseek-harness/AGENTS.md` Conventions |
| `main` / `types` | `./lib/index.js` / `./lib/types/index.d.ts` | `docs/cookbook/adding-a-package.md` |
| `exports["."]` | `{ types, default }` | 同上 |
| `exports["./cordis.patch.yml"]` | `./cordis.patch.yml`（发布包可装配，P1.2 收编） | 当前插件 `package.json` |
| `dsh.bundle.patch` | `"./cordis.patch.yml"`（bundle 格式声明） | `packages/bundle/base/package.json` |
| `dsh.client.*` | client 半边：`platform`/`inject`/`exports["./client"]` | `packages/client/AGENTS.md` |
| `peerDependencies` | `@deepseek-ai/cordis`（范围声明，必含）+ 实际使用到的 `@deepseek-ai/dsh-*` | 当前插件 P1/P1.2 已补齐 |
| `files` | 发布清单收编 `lib/` 与 `cordis.patch.yml` | P1.2 M3 断言 |

### 1.2 `cordis.patch.yml` 行格式与 patch 语义

- 行 = `EntryOptions`：`id`（组内稳定）、`name`（模块 specifier）、`config?`、`group?`、
  `disabled?`、`inject?`。定义处：`vendor/loader/src/config/entry.ts:16-26`。
- patch 文件是 entry-list 方言：顶层 `- insert:` 列表插入新行；非 insert patch 用
  `id` 定位目标行并**整体替换** `config`（不是合并）；`disabled`/`inject` 同样按行覆盖。
  `!!js` 表达式允许出现在 `config` 与 `disabled`（`config` 在目标行激活时对 plugin context
  插值；`disabled` 每次挂载决策时对 loader context 求值）。
  实现：`vendor/include/src/index.ts:52-100`（`applyEntryPatches`）。
- 行顺序无加载语义（激活由服务可用性驱动）；同 id 后写覆盖前写（last write winning per row）。
- 当前插件 bundle 层（模板态）只有一行插入：
  `- insert: [{ id: dsh-price-less, name: 'dsh-price-less' }]`。

### 1.3 profile 分层与调试

- 应用序：profile 列出的各 bundle（如 `dsh-base`）→ profile `cordis.patch.yml` → home 级
  → `--patch` overlay。`dsh --profile web --dump-config` 打印组合树。
  核验源：`docs/architecture.md` “Profiles and bundles”。
- 外部插件安装：`dsh plugin --profile <name> add <package>`；开发期可用注入器
  `dev_inject_plugin`（junction + `loader.create`，免重启）。
- 注意：`--patch` 重复注入同 id 会被 loader 拒绝（`duplicate loader entry id`）；已注入的
  插件不要叠 `--patch`（P1.1 真机方法学备注）。

## 2. Cordis 插件运行时模型

核验源：`vendor/cordis/src/registry.ts`、`fiber.ts`、`events.ts`、`service.ts`、
`docs/cordis-primer.md`。

| 概念 | 规则 |
|---|---|
| 插件形态 | 函数插件（`(ctx, config) => …`）、`{ apply(ctx, config) }`、`Service` 子类；外部插件用函数或 `apply` 对象。 |
| 入口导出 | 函数插件具名导出 `name`/`inject`/`Config`/`apply`，**不要 default export**（混用会丢 namespace）。 |
| `Config` | Standard Schema 校验器（schemastery 兼容）；校验失败 = `ValidationError`，插件不启动。当前插件 `src/config.ts` 用 schemastery。 |
| `inject` | 声明所需服务：数组 `['settings']` 或对象 `{ settings: null }`；服务可用前 fiber 处于 PENDING。 |
| `ctx.effect(fn)` | **一切注册的归宿**：fn 返回 disposer（或 disposer 迭代/异步迭代）；卸载时逆序执行。当前插件所有注册均走它。 |
| `ctx.on(name, listener)` | 事件监听（fiber 自动持有，卸载即摘）；返回 disposer。 |
| `ctx.plugin` / `ctx.inject` | 动态装载/依赖注入；`ctx.inject(['settings'], cb)` 是函数式等待服务可用的短路径（当前 `settings.ts` 用它）。 |
| 服务读取 | 声明依赖用 `ctx.<name>`；**可选服务用 `ctx.get(name)`**（`packages/AGENTS.md:7`）。 |
| waterfall | 监听器最后参数 `next`；**必须 `return next()` 才委托**，return 而不调 = 短路（`docs/cordis-primer.md`）。当前插件尚未注册 waterfall 监听（P6/P7 起）。 |

## 3. 当前插件已核验使用的 harness 接口

### 3.1 `ctx.logger(name)`（诊断通道）

- 定义：`vendor/cordis/src/logger.ts`。`ctx.logger` 是 LoggerService 的 callable：
  `ctx.logger('context-economy')` 返回 named `Logger`（info/warn/error/debug）。
- 纪律：诊断走 named logger，运营事实进会话事件（docs/11 §4 纪律③）。
- 当前插件：`src/platform/logger.ts:ceLogger`；`src/platform/diag-sink.ts` 经
  `ctx.logger.exporter()` 落盘 JSONL（公开导出面 `vendor/cordis/src/logger.ts:232-236`）。

### 3.2 `ctx.on('session/event')`（会话 firehose）

- 事件声明：`packages/core/session/src/index.ts:64-90`（`@mode emit`，post-commit、
  fire-and-forget；监听器异常被遏制，不影响 append 返回）。
- 监听签名：`(session: Session, event: SessionEvent) => void`；`SessionEvent` 是
  `type` 判别联合（`packages/core/session/src/types.ts:475-510`），switch type 自动窄化 data。
- 纪律：同步 post-commit 派发 ⇒ 监听器 O(1) + 异步旁路，**永不阻塞 append**（docs/11 §4 纪律②）。
- 当前插件：`src/platform/events.ts` 的 `createEventPump` 订阅，过滤后经微任务队列派发
  `input/user-message` 与 `metrics/session-event` 两个进程内领域事件。

### 3.3 `Session.append`（会话事实写入）

- 签名：`packages/core/session/src/index.ts:717-738`。
  - surface 事件（`user/message`/`assistant/message`/`tool/result`）：必须带
    `SurfaceIntent`（`surfaceOp`，replace 时还要完整 `sourceEventSeqs`）。
  - log-only 事件：类型须先声明合并进 `IgnorableSessionEventMap`，才可带
    `{ ignorable: true }`；未合并类型编译期不可标记（append 侧编译闸）。
  - 未知无标记 log-only 类型：append 现场去重 warn（loud-write backstop），但旧 harness
    读侧会拒读整条日志——所以**必须 ignorable**（`packages/core/session/src/index.ts:743-758`）。
- `IgnorableSessionEventMap` 定义：`packages/core/session/src/types.ts:445-466`；
  类型与载荷合并进 `SessionEventMap`（`packages/core/session/src/types.ts:260`）。
- 能力探测：补丁版导出运行时常量 `SESSION_LOG_INTENT = 1`
  （`packages/core/session/src/index.ts:31`；commit `ea04b581a5`）。vanilla 无此导出 ⇒ 通道缺失。
- 当前插件：`src/platform/ignorable-channel.ts` 探测 + 路由（emitted/mirrored/blocked）；
  `src/platform/logger.ts` 的 `emitCeFact` 是唯一事实发射端口（词汇表从 `SessionEventMap`
  自动派生，当前 = `never`）。

### 3.4 `ctx.inject(['settings'], cb)` + `settings.installSection`（设置段）

- `SettingsProvider.installSection(owner, ns, schema, entry, hooks)`：
  `packages/settings/settings/src/index.ts:472-521`。语义：注册 base（装配值）→
  provider 在时实时读取 scope → provider 脱离时回退 base；首次注册与 detach 各触发一次 onChange。
- 写路径：`scope.update(patch)` 或 `replace(section)`，带 `expectedRevision` revision-fence。
- 当前插件：`src/settings.ts` 注册 namespace `context-economy`（schema = `src/config.ts` 的
  schemastery `Config`）；client 半边经 `settingsScope.bind` 读同一 namespace。

### 3.5 `ctx.llm`（辅助 LLM 调用，P5 已施工）

- Context 键：`packages/llm/llm/src/index.ts:54-55`（`ctx.llm: LlmRuntime`）。
- `llm/stream` 是 waterfall：`packages/llm/llm/src/index.ts:60-68`。
- `GenerateOptions`：`packages/llm/llm/src/types.ts:407`；`purpose` 当前仅
  `'compaction' | 'session-title'`（`packages/llm/llm/src/types.ts:442-458` 一带）。
- `TokenUsage`：`packages/llm/llm/src/types.ts:149-157`（input/output/total/cacheRead/
  cacheWrite/reasoning）。
- 当前插件：`src/platform/llm.ts` 是 C2 purpose 单点适配（`CeAuxPurpose`/`CeGenerateOptions`/
  `toHarnessGenerateOptions`/`resolveLlmService`），P5 已补齐调用面：`streamCeLlm` 消费
  `CeGenerateOptions` 并透传 `StreamChunk`；`CeLlmUsageReceipt`/`toCeLlmUsage` 提供 usage 与
  缓存观测回执；服务缺失时 yield `CE_LLM_UNAVAILABLE` 终止块（fail-lazy）。
- 事实面（P5.1 锁定）：`streamCeLlm` 返回 `AsyncGenerator<StreamChunk, void, unknown>`；
  `onUsage` 回调抛错只 warn 不外溢（文案 `context-economy: llm usage receipt callback failed (contained)`，
  不中断辅助 LLM 流）。

### 3.6 `ctx.storageDomain.open(defineDomain({...}))`（持久 KV，P3 使用）

- Context 键：`packages/storage/storage-domain/src/index.ts:37`
  （`ctx.storageDomain: DomainFacility`）。
- `defineDomain(spec)`：`packages/storage/storage-domain/src/spec.ts:107-160`。
  字段：`name`（`UNIT_NAME_RE`）、`version`（非负整数）、`layout?`（`single|per-record`）、
  `compatibleVersions?`、`invalidRecords?`、`global?`、`tables`（zod record schemas）。
- `open(spec)`：`packages/storage/storage-domain/src/index.ts:100-140`——reserve 域名防重入、
  路由 backend、开 KV unit、按表 zod 校验记录、构造 `Domain`。**调用者持有 handle 并负责 close**
  （通常作为 `ctx.effect` disposer）。
- 当前插件：已使用（P3 `platform/storage.ts`：`context_economy` 域四实体表 + `fact_mirror` + `entity_snapshots`；`index.ts` 经 `logger.registerFactMirror` 接线）。

### 3.7 `ctx.skills`（技能目录，P4 使用）

- Context 键：`packages/skill/skill/src/index.ts:286-288`（`ctx.skills: SkillRegistry`）。
- `snapshot(options)`：`packages/skill/skill/src/index.ts:483-490`，返回
  `{ skills: SkillSummary[], complete: boolean }`。
- `get(name, options)`：`packages/skill/skill/src/index.ts:502-504`，返回
  `SkillDefinition | undefined`；`isSkillName` 不合法直接 `undefined`。
- `skills/change`：`packages/skill/skill/src/index.ts:290-299`，emit 通知（unfiltered
  invalidation）；消费者自己 `snapshot` 重取，监听异常被 harness 遏制。
- 当前插件：`src/platform/skills.ts` 已施工（P4）——经 `ctx.skills` 官方缝生成
  model-invocable 目录快照、`skillCatalogContains` 引用守卫查表、`watchSkillCatalog`
  订阅 `skills/change` 热更新；不手写 `SKILL.md` 扫描。

### 3.8 `@deepseek-ai/dsh-compaction`（改史/压缩事务类型与配对平衡守卫，P6 使用）

- `CompactionId`：`packages/compaction/compaction/src/brand.ts:11`（brand 工厂，无校验；
  同名类型导出）。
- 配对平衡守卫：`toolPairingBalancedBefore`/`toolPairingBalancedAfter`：
  `packages/compaction/compaction/src/tool-pairing.ts:111/123`——基于**当前表面序**的增量
  fold（`session.surface.nodes`/`replaceGeneration`，surface 重写后重建）；seq 不在当前表面
  或配对不完整会 throw，调用侧须先经 `balanceRange` 收缩（P6 端口封装）。
- `compaction/*` SessionEventMap 声明合并：`packages/compaction/compaction/src/types.ts:17-90`
  （全部 log-only，非 surface 事件）：`compaction/start`/`end` 为事务锁标记对（start 持锁、
  end 释放，ID/turn 必须匹配）；`compaction/summary`/`prune` 为影子计价协议（summary 内容在
  `data.summary`，其表面替换由紧随其后的 `user/message` replace 承载——紧邻契约；
  `prune` 是无模型价的替换前计价）。
- 当前插件：`src/platform/history.ts` 已施工（P6）——`createHistoryPort` 消费上述符号
  （H4 replace 唯一改史通道 + H5 事务对 + 可注入配对守卫），见 [10 §1 H4/H5](../10-wiring.md)。

### 3.9 `tools/*` 事件（P7 已施工；P15b/P21b 使用）

- `tools/execute` 与 `tools/post-execute` 都是 waterfall：
  `packages/core/tools/src/index.ts:155-167`（`tools/post-execute` 监听器签名
  `(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>)`）。
- T-entry 时机的实现缝已闭合（P1.2）：`tools/execute` 返回值会经
  `normalizeDispatchResult` 按 `value` 重新 render content，content-only 修改会丢；改挂
  `tools/post-execute` accept `content` 覆盖/追加。
- 当前插件：已施工（P7）——`src/platform/tools.ts` `createToolPort(ctx, hooks, logger)`
  （execute 仅信号/计量恒 `return next()`；post-execute 返回决策短路、hook 异常委托 next）
  + 决策构造器 `replaceContent`（T-entry 写时整形）/ `appendContent`（T-note 贴注）；
  T-entry/T-note 判据归 P15a/P15b，端口内不内置剪切规则。

### 3.10 客户端接口（client 半边）

> P14a 后按实际核验源码固化。以下路径均在 `G:/deepseek-harness/packages/client/...`。
> 客户端 SlotMap 声明通过 `import type {} from 'xxx/client'` 拉入 TypeScript 全局 merge，
> **不产生运行时依赖**；client 侧禁止 import `src/`（结构断言 S4）。

#### 3.10.1 包与导出（后续 client 工单直接查此表）

| 包 | checkout 路径 | `/client` 主要导出 | 用途 |
|---|---|---|---|
| `@deepseek-ai/dsh-client-ui-slots` | `packages/client/ui-slots` | `PropsRuntime`、`InjectFace`、`PropsRenderSlots`、`SlotComponent`、`register` 类型 | 槽位注册/组件 props 合成的唯一底层类型 |
| `@deepseek-ai/dsh-client-ui-renderer` | `packages/client/ui-renderer` | Context merge：`ctx.slots`、`ctx.uiRenderer` | **必须 type-only import**，否则槽注入不生效 |
| `@deepseek-ai/dsh-client-ui-session` | `packages/client/ui-session` | `useSession`、`sessionId`、`useProjection`、`useSessions` | Session scope 标准 props |
| `@deepseek-ai/dsh-client-ui-conversation` | `packages/client/ui-conversation` | `InputState`、`InputActions`、`SessionStandardProps`、`conversation.*` SlotMap | 会话 UI 槽与输入面 |
| `@deepseek-ai/dsh-client-ui-settings` | `packages/client/ui-settings` | `SettingsScope`、`SettingsScopeSnapshot` | 设置卡 scope 绑定 |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | `packages/client/ui-settings-plugins` | `settings.plugin.item` SlotMap 声明 | 设置卡槽注册 |
| `@deepseek-ai/dsh-api-remotes` | `packages/api/remotes` | `ClientRemote`、`ModelProviderGroup` | `ctx.remote.session` 模型目录 |
| `@deepseek-ai/dsh-session/types` | `packages/core/session` | `SessionId`（brand） | 槽 inject 参数类型 |

关键约定：
- `import type {} from '.../client'` 是 **declaration merge 副作用导入**，必须写；否则
  `PropsRuntime<'conversation.input.right'>` 在编译期会因 `SlotMap` 缺失而报错。
- 运行期 `inject` 数组（当前 `client/index.ts`）只需要 `slots`、`settingsScope`、
  `remote`、`remote.session`、`connection`；conversation/session 包只做类型面，不挂 runtime inject。

#### 3.10.2 SlotMap 关键槽位（P14a 已核验）

定义源：`packages/client/ui-conversation/src/client/contract/slots.ts`
（`interface SlotMap` 声明合并，约 119–161 行）；实际声明/渲染点：
`packages/client/ui-conversation/src/client/apply.ts`（约 262/280/302 行）。

| 槽 | kind | scope | 组件额外标准 props | 备注 |
|---|---|---|---|---|
| `settings.plugin.item` | keyed | root | 无 session 标准面；注册带 `key` | 当前插件设置卡（`key=context-economy`） |
| `conversation.session` | single | session | useSession/sessionId/useConversation/useInput/inputActions | 会话正文 |
| `conversation.session.header.actions` | list | session | 同上 | 会话头右操作，**不是星标主选** |
| `conversation.view` | list | session | 同上 + `ConvViewOwnerProps`（viewTarget/openView/completeViewRequest） | **是“会话视图页签”列表**，不是放按钮的槽 |
| `conversation.input.right` | list | session | 同上 | 输入栏右侧工具区，**P14a 星标主选** |
| `conversation.input.left` | list | session | 同上 | 输入栏左侧 |
| `conversation.input.plan` | single | session | 同上 + `InputControlOwnerProps`（locked） | Plan 控制 |
| `conversation.input.model` | single | session | 同上 + `InputControlOwnerProps`（locked） | 模型选择 |
| `conversation.input.dock` | list | session | 同上 + `InputZone`（session/input snapshot） | 编辑器上方 |
| `conversation.hero.workspace` | single | root | `useSessions` 等 global 面 | 无会话 Hero |
| `conversation.composer` | chain | session | 同上 + `ComposerChainProps` | 组合器接管链 |

#### 3.10.3 Session scope 标准 props（由 ui-session + ui-conversation 合并）

组件在 session-scope 槽上自动获得：

```ts
// ui-session/src/client/index.ts 的 SessionStandardProps
useSession: SnapshotSelectorHook<SessionSnapshot>
sessionId: SessionId
useProjection: UseProjection
// ui-conversation/src/client/contract/slots.ts 的 SessionStandardProps
useConversation: SnapshotSelectorHook<ConversationSnapshot>
useInput: SnapshotSelectorHook<InputState>
inputActions: InputActions
```

`session-maybe` 槽则将 `sessionId`/`useSession`/`useInput`/`inputActions` 变为可缺省：
`sessionId: SessionId | undefined`、`useInput: MaybeSnapshotSelectorHook<InputState>`、
`inputActions: InputActions | undefined`。

#### 3.10.4 `InputActions` 与 `InputState`

定义源：`packages/client/ui-conversation/src/client/contract/input.ts`。

```ts
export interface InputActions {
  setDraft(text: string): void       // 替换整个草稿（P14a 应用终稿入口）
  addAttachments(ids: readonly DraftAttachmentId[]): boolean
  removeAttachment(id: DraftAttachmentId): boolean
  pruneAttachments(ids: readonly DraftAttachmentId[]): void
  submit(): void
}

export interface InputState {
  draft: string                      // 剪贴板投影文本（星标按钮读取）
  attachmentIds: readonly DraftAttachmentId[]
  draftRev: number
  phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  claim?: { token: string; hint?: string; attachments?: boolean }
  occurrences: readonly Occurrence[]
  queue: readonly QueuedMessage[]
}
```

注意：`inputActions` 没有 `notify`；会话级通知在 `SessionInput.notify` 上，不通过槽组件
标准 props 暴露（P14a 用本地 toast）。

#### 3.10.5 注册骨架（P14a 当前形态）

```ts
// client/index.ts 的 apply(ctx) 内
const starBridge = createMockStarBridge()
ctx.slots.inject('conversation.input.right', function* () {
  yield ctx.slots.register({
    name: 'conversation.input.right',
    id: 'context-economy-star',
    order: 10,
    inject: (sessionId: SessionId) => ({ star: starBridge }),
  }, StarButton)
})
```

要点：
- `ctx.slots.inject(key, callback)` 会把 callback 放入 `ctx.effect`（声明生命周期）；
  callback 返回 generator 时逐个 yield disposer，卸载时逆序清理。
- 列表槽必须带 `id`；`order` 只影响同槽内展示顺序（不参与影子优先级）。
- `inject` 工厂参数由 slot 的 `scope` 决定：session 槽收 `sessionId`；root 槽不收参数。
- 组件 props 使用 `PropsRuntime<K> & InjectFace<I>` 合成；`I` 来自 `inject` 返回类型。

#### 3.10.6 build.sh 链接清单（client typecheck 必需）

`scripts/build.sh` 的 client 预备区必须包含：

```bash
link_pkg @deepseek-ai/dsh-client-ui-conversation packages/client/ui-conversation
link_pkg @deepseek-ai/dsh-client-ui-session packages/client/ui-session
```

这两个包自身的 checkout `node_modules` 已带齐 `dsh-api-session-controller`、
`dsh-api-workspace-controller` 等传递依赖，因此只 link 顶层两个包即可通过
`npm run typecheck:client`。

#### 3.10.7 当前插件 client 现状（P14a）

- client 注入：`['slots','settingsScope','remote','remote.session','connection']`
- 已注册槽：`settings.plugin.item`（设置卡）、`conversation.input.right`（星标按钮）
- 星标使用 `StarHostBridge` 接口（见 `docs/implement/P14a-star-button-ui.md` §2.3）；
  P14b1 已交付 host 半边（§3.11）；P14b2 只需替换 `createMockStarBridge()` 为真实 bridge，UI/类型不变。
- `docs/11 §5` 与 `docs/10 §1 H11` 已同步为 `conversation.input.right`。

### 3.11 Connection 通用 RPC 通道（P14b1 使用；星标 host 桥）

> P14b1 否决 P14a §8.2 的 Typert Remote 设想，改用官方 Connection 通道（依据见
> `docs/implement/P14b1-star-host-service.md` §0.1）。核验源均在 `packages/client/connection/`。

| 符号 | 定义处 | 用途 |
|---|---|---|
| `Context.connection: HostConnectionHandle`（Context merge） | `src/rpc-host.ts:52-57` | host 侧服务键（channel 注册 owner-scoped） |
| `HostConnectionService.rpc` getter | `src/rpc-host.ts:79-86` | 取 `HostConnectionRpc` |
| `HostConnectionRpc.handle(channel, handler)` | `src/rpc.ts:138-148` | 注册认证后的绝对 channel（trust + browser auth + prefix WebRoute） |
| `ConnectionRpcHandler = (endpoint, payload, signal) => Promise<ConnectionRpcResult<unknown>>` | `src/rpc.ts:100-104` | handler 签名 |
| `ConnectionRpcResult<T> = {ok:true,value} \| {ok:false,error:{code,message,details}}` | `src/rpc.ts:24-27` | 返回信封 |
| channel/endpoint 文法 `^\/[A-Za-z0-9._~-]+$` / `^[A-Za-z0-9_$.-]+$` | `src/rpc.ts:32-33` | 命名约束 |
| 专用 channel 先例测试 | `tests/node-half.host.spec.ts:272-319` | 注册/卸载语义 |

**wire 契约（P14b1 冻结；P14b2 client 侧常量必须逐字相等）**：channel `'/context-economy'`；
端点 `'star.preview'`（payload `{sessionId,prompt}`）与 `'star.apply'`（payload
`{sessionId,previewId,editedProduct}`）；信封 = `ConnectionRpcResult`。错误码：
`CE_STAR_BAD_REQUEST` / `CE_STAR_UNKNOWN_ENDPOINT` / `CE_STAR_NO_SESSION` /
`CE_STAR_LLM_FAILED` / `CE_STAR_PARSE_FAILED` / `CE_STAR_UNKNOWN_PREVIEW` /
`CE_STAR_STORAGE_FAILED` / `CE_STAR_INTERNAL` / `CE_STAR_UNAVAILABLE`（client 侧无连接服务）。

**类型面策略**：`@deepseek-ai/dsh-client-connection` 根 d.ts 会级联
`dsh-host-webserver`/`dsh-credentials`/`dsh-attachment`（插件未链接）。端口只从**源文件子路径**
`@deepseek-ai/dsh-client-connection/src/rpc.ts` 做 type-only 导入（该文件仅依赖已链接的
`dsh-brand`，零级联）；`ctx.get('connection')` 的最小结构面本地重声明，并在
`src/platform/star-bridge.ts` 用类型级互赋断言锁定（`AssertAssignable`）。**不得**为此链接
webserver/credentials/attachment。

**否决路线留档**：Typert Remote 需 host SRC fallback（`packages/api/gateway/src/index.ts:266-290,644-670`，
依赖装饰器 + 编译后形参名）+ client 强制 strict codec（`packages/api/gateway/src/client/index.ts:709-720`），
且需新服务键与 zod 打进 client bundle；本插件不采用。

## 4. 会话日志兼容契约（本插件最关键的 4 条）

1. **写**：`context-economy/*` 自定义事件必须 log-only + `{ ignorable: true }`；类型先并入
   `SessionEventMap` 与 `IgnorableSessionEventMap`（append 侧编译闸）。读侧只认落盘信封上的
   `ignorable` 标记，不查合并表（无组合依赖）。
2. **读**：未知类型且无 `ignorable` → `validateStoredEvents` 拒读整条日志
   （`packages/session/session-persistence/src/storage-contract.ts:69-80`）。
3. **改史**：任何历史变更只能 `session.append(type, data, { surfaceOp: { op:'replace', start, end }, sourceEventSeqs })`；
   禁止原地改/删。
4. **模型可见 ⟺ 已落盘**：一切进入模型请求的内容必须能从会话日志重建；新模型可见输入必须
   新增 `SessionEventMap` 事件类型。

## 5. 当前插件 ↔ 接口落位表（2026-09-08 现状）

| 当前文件 | 使用接口 | 状态 |
|---|---|---|
| `src/index.ts` | `apply(ctx, config)`、`ctx.effect`、`attachDiagSink`、`createEventPump`、`registerContextEconomySettings` | 已施工 |
| `src/settings.ts` | `ctx.inject(['settings'], cb)`、`installSection` | 已施工 |
| `src/config.ts` | schemastery `Config` | 已施工 |
| `src/platform/events.ts` | `ctx.on('session/event')`、`SessionEvent` 类型面 | 已施工（P1） |
| `src/platform/logger.ts` | `ctx.logger`、`SessionEventMap` 声明合并派生 `CeFactType` | 已施工（P1） |
| `src/platform/ignorable-channel.ts` | `SESSION_LOG_INTENT` 探测、`Session.append(type,data,{ignorable:true})` | 已施工（P1 翻转） |
| `src/platform/diag-sink.ts` | `ctx.logger.exporter()` | 已施工（P1.1） |
| `src/platform/llm.ts` | `GenerateOptions.purpose` 单点适配、`streamCeLlm`、`toCeLlmUsage` | 已施工（P5） |
| `src/platform/storage.ts` | `ctx.storageDomain.open` / `defineDomain` / `domainTable` | 已施工（P3） |
| `src/platform/skills.ts` | `ctx.skills` 快照 / `get` / `skills/change`（H13） | 已施工（P4） |
| `src/platform/history.ts` | `Session.append(surfaceOp replace)`、`compaction/*`、配对平衡守卫 | 已施工（P6） |
| `src/platform/tools.ts` | `ctx.on('tools/execute')`、`ctx.on('tools/post-execute')`、`createToolPort`、`replaceContent`/`appendContent` | 已施工（P7） |
| `src/platform/star-bridge.ts` | `ctx.get('connection')` 最小结构面、`connection.rpc.handle('/context-economy')`、`ConnectionRpcResult` 信封（§3.11） | 已施工（P14b1） |
| `src/domains/star.ts` | 星标 host 断面服务（`streamCeLlm` + `parseOptimizeOutput` + 卷宗回填 + 优化产物） | 已施工（P14b1） |
| `src/domains/optimize-facts.ts` | `context-economy/optimize-run` 两相事实声明合并 + fold | 已施工（P14b1） |
| `client/index.ts` | `ctx.slots.register`、`settingsScope.bind`、`remote.session`、`ctx.slots.inject('conversation.input.right')` | 已施工（P14a 增星标槽） |
| `client/star/*` | `PropsRuntime<'conversation.input.right'>`、`InputActions.setDraft`、`useInput`、`StarHostBridge` | 已施工（P14a） |

## 6. 复用方法（后续工单的核验流程）

1. 查本文表：接口是否已登记。
2. 未登记 → grep 到定义处：`grep -n "符号" G:/deepseek-harness/packages/**/src/**`（或
   `vendor/`），把 `文件:行` 写进工单 §2.3 才准 import。
3. 已登记但发现签名不符 → 以 checkout 源码为准，停工上报或更新本文。
4. 上游合并/升级后：重跑 `grep` 复核本文行号，升级自检 = `npm test`（回环用例即通道测试）。
