# P1 事件面接线（映射 R1；依赖 P0；尺寸 S）

> 设计正典：[10 §1](../10-wiring.md)（H1/H7）/ [11 §2](../11-structure.md)（模块树两行）/
> [11 §4](../11-structure.md)（日志纪律②③）/ [02 §2](../02-discriminator.md)（输入面过滤）/
> [07 §5](../07-metrics.md)（回放管道）/ [09 §1](../09-state.md)（会话事实双源）。
> harness 符号清单：见 §2.3（逐条核验到定义处；找不到即停工上报——总纲 §2 铁律 3）。
> **范围注记**：本单范围 = 总纲 §3 P1 行字面范围（`platform/logger.ts` + `platform/events.ts`，
> H1 firehose → 异步旁路队列；10 §1 H1/H7）**加** ① 装配根接线 1 处（§3.3，模块树 index.ts 行
> 「装配根」职责的最小落点）② `scripts/assert-structure.mjs` 追加 D1/D2 + S2 修订（P0 §8-1/§8-4
> 协议明文授权本单追加）③ harness ignorable 写入通道缺口处置（§6-⑤——发现于规划期核验，
> 处置方案见 §2.4 决策点⑤，非新增设计）。

## 1. 目标

把 H1（判别器输入面）与 H7（度量回放面）从会话 firehose 上接下来：`platform/events.ts` 订阅
`session/event`、按输入面五条件产出 `input/user-message` 领域事件、按 H7 字面透传度量原料
`metrics/session-event`，全部经**异步旁路队列**派发（永不阻塞 append，监听器异常不外溢）；
`platform/logger.ts` 落 `ctx.logger('context-economy')` 诊断通道与 `context-economy/*` 自定义
事实事件发射端口（类型面从 `SessionEventMap` 声明合并自动派生）。账本字段暂不产出（P2）。

## 2. 输入

### 2.1 正典摘录（工单自足，免翻全文；与正典冲突时以正典为准并停工上报）

**10 §1 H1（判别器输入）**：挂点 `session/event` → `user/message`；输入面过滤同 02 §2
（append + `source.kind==='user'` + 主会话 + u≥1）；**同步 post-commit 派发，监听器异常不外溢**。

**10 §1 H7（度量回放）**：`step/start|end`、`assistant/message`（usage）、`request/header`、
`tool/call|result`（原始 arguments + meta）→ 07 账本全部字段可从会话 JSONL 回放重算。

**11 §2 模块树（本单两行）**：
- `platform/events.ts`——H1 firehose 订阅 → 进程内领域事件（异步队列旁路，§4 纪律②）；
- `platform/logger.ts`——`ctx.logger('context-economy')` + ignorable 自定义事件发射。

**11 §4 纪律②（接线形态铁律）**：firehose 消费走异步旁路——`session/event` 同步 post-commit
派发、监听器异常只 warn 不外溢；平台层把重活投递进自有队列，**永不阻塞 append**。
**纪律③**：诊断走 `ctx.logger('context-economy')`；运营事实一律进会话事件而非 stdout。

**02 §2 输入面过滤（自动断面输入，只有这些消息进判别）**：`user/message` append +
`source.kind==='user'` + 主会话（子代理会话不判）+ 非伪 user（approval 等系统消息不判）+
文本非空 + u≥1（首条由段状态机隐式开段，不判）。

**07 §5 回放管道**：会话 JSONL → fold（事件序重放）→ 段状态机 / 卷宗版本链 / 剪除账 →
usage 聚合 → 07 字段全表。同输入同账（纯函数断言）。

**09 §1 会话事实**：自定义 ignorable 事件进会话 JSONL（`context-economy/*` 全家 log-only，
只记账、可回放、零副作用）；KV 只是加速缓存，损毁 = 重放日志重建。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/index.ts` | `export const name`、`export { Config }`、`apply(ctx, config)`（P0 后含 Config 再导出） | +ctx.effect 挂泵（§3.3） |
| `src/settings.ts` | `registerContextEconomySettings`（host 半边 settings 注册） | 不动（§5 注释修正 2 处） |
| `scripts/assert-structure.mjs` | 引擎 + RULES（M1–M5/S1–S5，P0 产出） | S2 修订 + 追加 D1/D2（§3.4） |
| `package.json` | peerDeps 3 件；scripts build/typecheck×2/test/assert/gate | peerDeps +2；devDep `@deepseek-ai/dsh-session` 不需要（peer + junction 足够） |
| `scripts/build.sh` | link_pkg junction 集（cordis/cosmokit/schemastery/dsh-settings/@types/node） | junction +5（§3.5） |
| `tests/field-model.spec.ts` | 11 用例，既有断言只增不减 | 不动 |

### 2.3 harness 核验源（总纲 §2 铁律 3：只信源码，逐条 grep 到定义处才准 import）

| 符号 | 定义处（G:/deepseek-harness） | 本单用途 |
|---|---|---|
| `'session/event'`（cordis emit，post-commit） | `packages/core/session/src/index.ts:64-85` | H1/H7 唯一订阅点 |
| `Session.append`（信封构造：type/seq/time/data/surfaceOp?/sourceEventSeqs?） | `packages/core/session/src/index.ts:699-727` | logger 发射端口的目标 API；**无 ignorable 参数 = §6-⑤ 缺口** |
| `SessionEvent` / `SessionEventMap` / `SurfaceOp` / `SurfaceIntent` | `packages/core/session/src/types.ts:260-476` | 事件面类型；`ignorable?: true` 信封字段 @:465 |
| `SessionEventMap` 声明合并范例（目标模块 `'@deepseek-ai/dsh-session/types'`） | `packages/compaction/compaction/src/types.ts:17-91` | logger 词汇表扩展形态 |
| `session.header.origin`（唯一合法值 `'subagent'`） | `packages/core/session/src/index.ts:469`；`packages/session/session-format-v1-to-v2/src/validation.ts:58` | 「主会话」判定 |
| `MessageSourceMap.user = { kind: 'user' }`（merge-extensible） | `packages/llm/llm/src/message.ts:100-107` | 「非伪 user」判定（approval 等系统消息走独立事件类型，不落 `user/message`） |
| `ctx.logger(name)`（named logger） | `vendor/cordis/src/context.ts:27` | 纪律③诊断通道 |
| `validateStoredEvents`（未知类型且非 ignorable → 整条拒读） | `packages/session/session-persistence/src/storage-contract.ts:69-80` | ignorable 缺口的后果证据；回环断言依据 |
| `KNOWN_SESSION_EVENT_TYPES`（本仓词汇，插件事件不在其中 by construction） | `packages/core/session/src/known-event-types.ts:22` | 同上 |

### 2.4 决策点记录（规划期定案，执行者不再自行裁量）

1. **u≥1 不在本单**：首条消息隐式开段是段状态机事实（P8 `core/units.ts`）；本单只实现
   **无状态**五条件（append / kind==='user' / 主会话 / 非伪 user / 文本非空）。
2. **S2 规则修订**：`.append(` 归口从 `platform/history.ts` 扩到 `platform/{history,logger}.ts`
   （S2 正典本意 = 改史归口；log-only 事实事件 append 不是改史）。**修正记录（施工期发现）**：
   不对 `surfaceOp|sourceEventSeqs` 设关键词路径禁令——docs/10 §1 H1 输入面过滤要求读
   `event.surfaceOp`、docs/11 §2 允许 core 本地重声明；写侧归口由 `.append(` 规则 +
   P6 类型级测试承接（详见 §3.4）。
3. **初始生产词汇表为空**：本单只落发射端口与类型派生机制，不发明正典外事件名；
   `context-economy/*` 各类型由后续机制工单（P9 judge-*、P13 optimize-run、P19/P20 压缩域…）
   经声明合并自行扩展。
4. **peerDeps 增 `@deepseek-ai/dsh-session`**（docs/11 §1 R1 行所列 dsh-llm/dsh-tools 之外）：
   platform 层事件类型面必需（SessionEvent / SessionEventMap / cordis Events 合并）。范围声明
   `>=0.1.3-alpha.1 <2`（M2 为「必含」非「恰含」，加键合规）；docs/11 §1 现状列随本单回写。
   `@deepseek-ai/dsh-llm` 同批补（docs/11 §1 R1 行明文；本单类型链经 dsh-session 传递依赖它）。
5. **ignorable 写入通道缺口**：harness 0.1.3-alpha.1 的 `Session.append` 信封构造无 ignorable
   参数（§2.3 证据链），而 11 §4 纪律①要求 `context-economy/*` 必带 `ignorable:true`——
   现状直接发射 = 写出未知类型无标记行 = 会话重载被 `validateStoredEvents` 整条拒读（砖掉恢复）。
   **处置**：本单 `emitCeFact` 运行期 fail-closed（不写、warn、计数）；独立补丁阶段给 harness
   `Session.append` 加非 surface 事件 `{ignorable?: true}` 通道（LogIntent），落地后本单端口
   翻转为真实发射并升级回环测试。fail-closed 期间 P2–P8 全不受阻（第一个真实消费者在 P9）。

## 3. 产出

### 3.1 `src/platform/events.ts`（新，净增 ≤150 行）

```ts
export interface CeDomainEvents {
  'input/user-message': { session: Session; seq: SessionSeq; time: number; text: string }
  'metrics/session-event': { session: Session; event: SessionEvent }   // frozen 原事件引用
}
export const METRICS_FACE_TYPES  // H7 字面六类：step/start|end、assistant/message、request/header、tool/call、tool/result
export function passesInputFace(origin: string | undefined, event: SessionEvent): boolean   // 纯函数
export interface EventPump { on(kind, fn): () => void; dispose(): void; stats(): EventPumpStats }
export interface EventPumpStats { enqueued: number; dispatched: number; listenerErrors: number; dropped: number; depth: number }
export function createEventPump(ctx: Context, logger?: Logger): EventPump
```

- **领域事件 map 用本地声明**（不引 cordis Events 合并——进程内口，P2 core/ledger 以本地
  重声明类型消费，保 core 零 harness import）。
- `passesInputFace`：`type==='user/message'` && `surfaceOp==='append'` &&
  `data.source?.kind==='user'` && `origin!=='subagent'` && 文本非空（content blocks 的 text
  拼接后 trim 非空）。纯函数、无状态（决策点①）。
- `createEventPump`：`ctx.on('session/event')` 监听器 O(1)——try/catch 包裹、过滤 + enqueue +
  微任务排空调度（**无 timer**，S5 合规）；同步段异常只 warn 不外溢（纪律②）；
  排空按 FIFO 保序逐条派发，handler 异常 catch + warn + `listenerErrors` 计数、不影响后续；
  `dispose()` 清队列 + 停调度；`dropped` = dispose 后到达的事件数。

### 3.2 `src/platform/logger.ts`（新，净增 ≤100 行）

```ts
export type CeFactType = Extract<keyof SessionEventMap & string, `context-economy/${string}`>
export function ceLogger(ctx: Context): Logger          // ctx.logger('context-economy')
export function emitCeFact(session: Session, type: CeFactType, data: JsonValue): void
export function ceFactStats(): { blockedNoIgnorableChannel: number }
```

- 词汇表从 `SessionEventMap` 声明合并**自动派生**（测试 spec 内合并 `'context-economy/test-probe'`
  即扩类型面——类型级验证，决策点③）。
- 运行期 **fail-closed**（决策点⑤）：warn 一条（含 blockedNoIgnorableChannel 计数语义），
  不调 `session.append`。guard 行含 `ignorable` 字样（S3 启发式锚点自然满足）。
- harness LogIntent 补丁落地后翻转：`session.append(type, data, { ignorable: true })`。

### 3.3 `src/index.ts` 装配（+约 6 行）

`apply()` 增：`ctx.effect(() => { const pump = createEventPump(ctx); return () => pump.dispose() })`。
无新配置字段；client 壳零改动。
**apply-smoke 适配（施工期记录）**：`tests/apply-smoke.spec.ts` 组 1 的「disposers 为空」断言随
泵接线更新为「恰 1 个泵 disposer + 恰 1 个 firehose 监听器」；FakeCtx 增 callable logger
（`ctx.logger(name)`）与 `on` 记录面——P0 §3.3 冒烟契约的追加式修订，随本工单显式落账。

### 3.4 `scripts/assert-structure.mjs` 规则演进（P0 §8-1 协议：追加 + 显式过本工单，引擎零改动）

| 演进 | 语义 |
|---|---|
| S2 修订 | `.append(` 归口 `src/platform/{history,logger}.ts`（history = H4 改史；logger = log-only 事实事件，非改史）。**修正记录（施工期发现）**：初版还拟对 `surfaceOp|sourceEventSeqs` 关键词设路径禁令，与正典冲突——docs/10 §1 H1 输入面过滤本身要求读 `event.surfaceOp`、docs/11 §2 明文允许 core 本地重声明事件类型（含 sourceEventSeqs 字段名）——按总纲 §1「冲突以正典为准」删除关键词路径禁令；写侧归口由 `.append(` 规则 + P6 类型级测试（P0 §8-3 演进协议）承接 |
| D1 新增（11 §4 纪律②） | src/**.ts 中 `on('session/event'` 锚后 10 行监听体内出现 `await` → issue（异步旁路启发式 v1） |
| D2 新增（10 §1 H2/H6） | 文本含 `on('agent/pre-step'` 或 `on('tools/execute'` 的文件须含 `return next(`（waterfall）。**修正记录（施工期）**：零位为 **pass** 而非规划时写的 vacuous——vacuous 仅当 appliesTo 命中 0 文件，而 D2 的 appliesTo = src 全部 .ts（恒命中），注册面为空时规则跑过无 issue = pass |

零位快照更新：`{M1–M5:pass, S1:vacuous, S2:pass, S3–S5:pass, D1:pass, D2:pass}`。

### 3.5 `package.json` + `scripts/build.sh`

- peerDeps += `"@deepseek-ai/dsh-session": ">=0.1.3-alpha.1 <2"`、`"@deepseek-ai/dsh-llm": ">=0.1.3-alpha.1 <2"`；
  scripts += `typecheck:tests`（tests/ce-logger.spec.ts 的类型级词汇派生验证，断言面追加）。
- build.sh junction 集 += 6：`@deepseek-ai/dsh-session → packages/core/session`、
  `@deepseek-ai/dsh-llm → packages/llm/llm`、`@deepseek-ai/dsh-brand → packages/util/brand`、
  `@deepseek-ai/dsh-util-values → packages/util/values`、`@deepseek-ai/dsh-scope → packages/core/scope`、
  `@deepseek-ai/dsh-session-persistence → packages/session/session-persistence`（后四件 =
  dsh-session d.ts 解析链 + 集成测试缺口回归用；解析失败 = 停工上报，禁 npm install 补装）。

## 4. 实现要点（每步独立可验证；顺序执行）

1. **依赖接线**（§3.5）→ `npm run typecheck` 绿（junction 解析实证）。
2. **写 `src/platform/events.ts`**（§3.1）→ typecheck 绿。
3. **写 `src/platform/logger.ts`**（§3.2，fail-closed 形态）→ typecheck 绿。
4. **`src/index.ts` 挂泵**（§3.3）→ typecheck ×2 绿。
5. **断言演进**（§3.4）→ `node scripts/assert-structure.mjs`：D1/D2 就位、真实树全过。
6. **写三份 spec**（§5）→ `npm test` 绿。
7. **注释残留修正**：`src/settings.ts` 头注失效符号（`sanitizeEffort`/`DISC_CAPABILITIES`）
   与失效节号（`docs/07 §18.1` → 现行 `docs/07 §0.5 指标一览`）；client/field-model.ts:19
   同类失效引用**不动**（UI 壳零改动铁律，留 P14）。
8. 全链自验：`npm run gate` exit 0；`DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0。
9. 对照 §5 清单逐条打勾，全部满足才进 §7。

## 5. 验收（全机械）

- [ ] `npm run gate` exit 0（= typecheck + typecheck:client + vitest + assert 四段全绿）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次输出逐字节一致（diff 为空），
       零位快照含 D1:pass、D2:pass、S2:pass（修订后）
- [ ] `npm run typecheck:tests` exit 0（ce-logger.spec.ts 声明合并 `context-economy/test-probe`
       后载荷类型可用 + 族外类型被 CeFactType 拒绝——类型级词汇派生双侧断言）
- [ ] `tests/events-pump.spec.ts`：五条件过滤各 ≥1 例（append 排除 replace / kind 非 user 排除 /
       origin==='subagent' 排除 / 空文本排除 / 正例通过）+ metrics 六类透传 + 非 face 事件静默 +
       handler 异常遏制不中断后续 + FIFO 保序 + dispose 后到达计 dropped + stats 计数 + 确定性
- [ ] `tests/ce-logger.spec.ts`：named logger 接线；`emitCeFact` fail-closed（warn + 0 次 append +
       计数递增）；spec 内声明合并 `'context-economy/test-probe'` 通过类型检查（类型级词汇派生）
- [ ] `tests/harness-session.spec.ts`：junction 缺失时整文件 skip（skipIf + 注明环境原因）；
       存在时——真 `Context`+`SessionStore` → `session.append` 合成事件 → firehose → 泵派发断言；
       **缺口回归测试**：`validateStoredEvents` 断言未知类型无 `ignorable` 被拒读（决策点⑤后果可复核）
- [ ] `git diff tests/field-model.spec.ts` 为空（既有断言零改动）
- [ ] 行数预算：`src/platform/events.ts` 净增 ≤150、`src/platform/logger.ts` 净增 ≤100（wc -l）
- [ ] `grep -rn "fetch(\|http.get\|axios" src/ tests/` 无命中（零网络）

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **永不阻塞 append**：`session/event` 监听器内禁 await/重活（D1 断言固化）；队列上重活在
   后续工单（P2 起的 handler）中消化。
2. **不发明事件名**：生产代码零 `context-economy/*` 字面量（词汇表空，决策点③）；
   测试 spec 的 `'context-economy/test-probe'` 仅存于测试。
3. **fail-closed 不是静默丢弃**：每次 blocked 必须 warn + 计数可观测（纪律③——诊断走 logger）。
4. **主会话判定**：`origin !== 'subagent'`（`header.origin` 无第三态，validation.ts:58）；
   非伪 user 由 `source.kind==='user'` 单条件承担（approval 等走独立事件类型，§2.3 核验）。
5. **ignorable 缺口**：补丁落地前严禁对生产 session 发射 `context-economy/*`（砖恢复风险，
   §2.4 决策点⑤证据链）；`.append(` 调用点只许 platform/{history,logger}.ts（S2）。
6. **停工上报触发器**：① junction/exports 解析失败；② 真实树断言出现非本单预定修复的 fail；
   ③ `session.append` 运行期拒绝未知 type 字符串（集成测试暴露即上报——影响 P9+ 通道形态）；
   ④ 行数预算超限且无法精简；⑤ 任何未覆盖决策点。上报时给出证据（命令 + 输出 + file:line）。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p1): 事件面接线——platform/events.ts H1/H7 异步旁路 + logger ignorable 端口（fail-closed）+ D1/D2 断言`
- 账本快照：**本单不需要**（无 docs/07 字段产出；H7 face 即回放原料，R 门快照随 R1 全段出）。
- 上报事项：ignorable 写入通道缺口与处置（§2.4 决策点⑤）；`dev_self_test` 真机余项仍待用户择机执行（P0 §7 沿袭）。

## 8. 对接面（P2–P21 如何消费本单）

1. **P2（度量底座）**：`core/ledger/` 以**本地重声明**消费 `metrics/session-event` 的
   `{ session, event }` 形状与 `METRICS_FACE_TYPES`（core 零 harness import）；
   泵 `on('metrics/session-event', fold)` 即回放入账入口。
2. **P6（改史端口）**：`platform/history.ts` 是 `.append(` 的改史归口（S2）；logger 词汇表
   由 P9+ 机制工单声明合并扩展（本单端口自动放行）。
3. **P8/P12（判别域）**：`on('input/user-message')` 即 H1 消费入口；u≥1 与段状态机在
   `core/units.ts` 补齐，输入面五条件已由 `passesInputFace` 承担。
4. **harness LogIntent 补丁**（独立阶段）：落地后 `emitCeFact` 翻转真实发射，回环测试升级
   （append → snapshotEvents → ignorable===true → validateStoredEvents 放行），本单缺口条目关闭。
