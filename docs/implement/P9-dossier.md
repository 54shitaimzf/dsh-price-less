# P9 卷宗（映射 R2；依赖 P3,P8；尺寸 M）

> 状态：**已施工（commit `78f33ad`；`node scripts/verify-p9.mjs` 输出 `P9 VERIFY PASS`）**。
> 当前完成情况：R1 平台面已完成（P0–P7）；P8 已施工（commit `fa8fdab` + 真机接线修正
> `037b413`）；P9 卷宗纯核已施工（commit `78f33ad`），运行期接线仍留 P12/P14b。
> 设计正典：[02 §2](../02-discriminator.md)（卷宗纪律/输入栈）/
> [02 §4](../02-discriminator.md)（判别回填终审语义）/
> [09 §2/§4](../09-state.md)（卷宗 vN 实体、读写者矩阵、恢复）/
> [01 §3.5](../01-architecture.md)（task 段与 taskId）/
> [07 §0.5](../07-metrics.md)（`judgeCtxTokens` 卷宗体积）/
> [11 §2/§9](../11-structure.md)（模块树 `core/dossier.ts` 行 + 依赖铁律）。
> harness 符号清单：本单**零新增直接 harness import**；只复用 P3 已核验的 `ctx.storageDomain`
> 契约（`openContextEconomyStorage`/`putEntity`，定义处见 P3 工单 §2.3）。

## 1. 目标

落地 R2 判别域的**卷宗纯核** `core/dossier.ts`：task 内用户消息原文的 append-only 累积、
三分类标注（`action` / `pureQ` / `verifyQ`）、星标回填（终审 + 冲突审计）与边界清空。本单
只交付纯核与 P3 持久面契约测试，**不做运行期接线**——`dossier` 表的实际 append/回填由 P12
自动断面域与 P14b 星标 host 方法调用本核函数 + `putEntity` 完成。

## 2. 输入

### 2.1 正典摘录（工单自足；与正典冲突以正典为准并停工上报）

- **02 §2 卷宗纪律（三轴）**：**原文逐条累积**（不摘要、不转写——用户消息是稀疏高信号
  信道，整卷通常 ~10K token 量级）；**不积累历史判定**（不给提示词"可推翻前判"的纪律负担，
  锚定偏置从结构上消除）；**task 边界清空**（新 task 新卷宗，作用域天然有界、新鲜、无偏）。
  输入栈 = 稳定前缀 + 卷宗 + prompt；卷宗 = task 内全量用户消息（append-only）。
- **02 §4 B 判别回填**：回填 = 对卷宗全部消息的三分类**终审** + task 意图画像；manual 模式
  唯一裁决源，auto 模式权威升级；与既有自动裁决冲突以回填为准、`verdictBackfill.conflicts`
  记审计。落卷宗（KV），零历史字节变化、零缓存代价。
- **02 §4 门控**：卷宗太短（无贴文、无约束、消息寥寥）→ 星标产品层跳过，只回填裁决。
  P9 只提供门控所需统计量（消息数/文本长度/卷宗体积）与纯谓词，阈值由 P11 星标断面冻结。
- **09 §2 卷宗 vN**：内容 = task 内用户消息原文 + 标注（三分类/回填裁决）；版本事件 =
  每条消息追加 / 星标回填 = vN+1（终审）；写者 = 自动断面（追加）/ 星标（回填）。
- **09 §4 恢复**：卷宗存 durable KV；损毁 → 日志重放；回放失败按空卷宗重新积累。P9 交付的
  `appendDossierMessage`/`createDossier` 即回放重建原语，P21a 恢复编排负责从日志抽取并调用。
- **07 §0.5 判别族**：`judgeCtxTokens`（卷宗体积）从卷宗文本体积 fold 得出；P9 先落最小
  可回放记账 `foldDossierLedger`，P10/P12 入账时复用，不得另造口径。
- **11 §2 模块树**：`core/dossier.ts` = 卷宗：append-only 累积、标注、回填、边界清空
  （02 §2）；`core ↛ platform`（反向禁止，CI 断言）。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/core/units.ts` | `foldSegmentState`、`TaskSegment`/`taskId` | 复用；不修改（taskId → dossier key 映射在 §3.1） |
| `src/core/ledger/fold.ts` | `estimateTokens` | 复用；不修改 |
| `src/platform/storage.ts` | `openContextEconomyStorage`、`putEntity`/`getEntity`/`auditEntity` | 复用；不修改 |
| `src/index.ts` | 装配根 | **零改动**（P9 无运行期接线；P12/P14b 才接 storage + events） |
| `scripts/assert-structure.mjs` | RULES 表 | 本单**不追加规则**；若真实树断言出现预期外 fail 先停工 |
| `tsconfig.tests.json` | include 列表 | 增 `tests/dossier.spec.ts` |
| `docs/implement/00-master.md` | P9 行 | 实现后回写 `已施工 commit <hash>` |

### 2.3 harness 符号核验源（只 grep 定义处；找不到即停工上报）

| 符号 | 定义处（G:/deepseek-harness） | 本单用途 |
|---|---|---|
| `ctx.storageDomain` / `storageDomain.open` | P3 工单 §2.3（`packages/storage/storage-domain/src/*`） | 仅测试经 `openContextEconomyStorage` 间接消费 |
| `putEntity` 的 source/CAS 语义 | P3 工单 §3.1（`src/platform/storage.ts`） | P9 测试断言 body 可版本化写读 |

核验动作：P9 新增 core 文件不得出现任何 `@deepseek-ai/*` / `cordis` / `platform/` import；
测试文件允许 import `src/platform/storage.ts`（与 `tests/storage.spec.ts` 同模式）。

### 2.4 决策点记录（执行者不再自行裁量）

1. **三分类词汇冻结**：`action`（动作）/ `pureQ`（纯理解提问）/ `verifyQ`（验证提问），
   与 docs/07 `judgeVerdictDist{action|pureQ|verifyQ}` 一致。P10 判据输出必须用这三个值，
   不得另造近义词。
2. **标注存储按 seq 索引**：`annotations: Record<string, DossierAnnotation[]>`，键 =
   `String(seq)`；同 seq 允许多条标注，**最后一条为最新裁决**（backfill 会 replace 为终审）。
3. **append-only 的纯函数语义**：`appendDossierMessage` 返回**新对象**，不修改入参；
   `msg.seq <= 最后消息 seq` 时 no-op 返回原 body（防乱序/重复，不抛错——core 纯核零异常）。
4. **回填冲突计数**：`backfillDossier` 对每条 backfill verdict，仅当该 seq 已存在 `by:'auto'`
   的标注且 class 不同时 `conflicts + 1`；backfill 后该 seq 的标注**替换**为
   `[{class, by:'backfill', at}]`（终审覆盖自动裁决，docs/02 §4 以回填为准）。无 auto 标注
   或 auto class 相同则冲突 0。
5. **taskId → storage key**：`dossierStorageKey(taskId) = dossier:${taskId}`。P8 生成的
   `task-<n>` 在**单会话 fold 内唯一**；P12/P13 若跨会话复用同一 storage domain，必须把
   taskId 做成会话级唯一（例如带 session 标识），本函数不替调用方做作用域猜测。
6. **度量先行口径**：`foldDossierLedger` 的 `ctxTokens = estimateTokens(所有消息文本以
   '\n' 连接)`（P2 `estimateTokens`，chars/1.5 向上取整）；`annotationCounts` 只统计每个
   seq 的**最后一条**标注 class。P10/P12 入账 `judgeCtxTokens` 时复用本函数，不得另算。
7. **门控阈值归 P11**：P9 只提供 `isDossierShort(body, gate)` 纯谓词与
   `dossierMessageCount`/`dossierTextLength`/`foldDossierLedger` 统计量；`gate` 的
   `minMessages`/`minTextLength` 默认值由 P11 工单冻结（docs/02 §4 门控）。
8. **不新增事实名**：P9 不声明任何 `context-economy/*` 事件；卷宗只落 `dossier` KV 表。
   违反 docs/09 §1 事实清单即停工。
9. **P8 收尾前置（真机失败复盘纳入）**：P9 开工前必须完成 §4 阶段 0——确认 P8 接线修正
   （`ctx.inject(['skills'])` 子 fiber）、lib 新鲜度、真实宿主无 `cannot get property
   "skills" without inject`。P8 修正未提交前，P9 不得开始写码。

## 3. 产出

### 3.1 `src/core/dossier.ts`（新，≤200 行）

```ts
import { estimateTokens } from './ledger/fold.ts'

export const DOSSIER_CLASSES = ['action', 'pureQ', 'verifyQ'] as const
export type DossierClass = (typeof DOSSIER_CLASSES)[number]
export type DossierAnnotationBy = 'auto' | 'backfill'

export interface DossierMessage {
  seq: number
  time: number
  text: string
}

export interface DossierAnnotation {
  class: DossierClass
  by: DossierAnnotationBy
  at: number
}

export interface DossierBody {
  taskId: string
  messages: DossierMessage[]
  annotations: Record<string, DossierAnnotation[]>
}

export interface DossierBackfill {
  verdicts: Partial<Record<number, DossierClass>>
  at: number
}

export interface DossierBackfillResult {
  body: DossierBody
  conflicts: number
}

export interface DossierGate {
  minMessages: number
  minTextLength: number
}

export interface DossierLedger {
  messageCount: number
  textLength: number
  ctxTokens: number
  annotationCounts: Record<DossierClass, number>
}

export function dossierStorageKey(taskId: string): string
export function createDossier(taskId: string): DossierBody
export function appendDossierMessage(body: DossierBody, message: DossierMessage): DossierBody
export function annotateDossier(body: DossierBody, seq: number, verdict: DossierClass, by: DossierAnnotationBy, at: number): DossierBody
export function backfillDossier(body: DossierBody, backfill: DossierBackfill): DossierBackfillResult
export function foldDossierLedger(body: DossierBody): DossierLedger
export function isDossierShort(body: DossierBody, gate: DossierGate): boolean
```

**语义（实现必须逐字照抄；冲突以正典为准停工）：**

1. **dossierStorageKey**：返回 `` `dossier:${taskId}` ``。
2. **createDossier**：`{ taskId, messages: [], annotations: {} }`。
3. **appendDossierMessage**：
   - `message.text` 为空串 → 返回原 body（防脏数据；输入面过滤已保证非空，此处双保险）。
   - `body.messages` 非空且 `message.seq <= 最后一条 seq` → 返回原 body（append-only、防乱序）。
   - 否则返回新对象：`messages: [...body.messages, message]`，`annotations` 浅拷贝
     （`{...body.annotations}`），不共享数组。
4. **annotateDossier**：
   - `seq` 不存在于 `messages` → 返回原 body。
   - 若该 seq 已存在完全相同的 `{class, by}` 标注 → 返回原 body（幂等）。
   - 否则返回新对象，给该 seq 的标注数组**追加** `{class, by, at}`（不 replace）。
5. **backfillDossier**（终审）：
   - 遍历 `backfill.verdicts`，只处理 `seq` 存在于 `messages` 的条目。
   - 对每个待处理 seq：读取该 seq 现有标注中 `by:'auto'` 的最后一条，若其 class 与回填
     class 不同 → `conflicts++`。
   - 处理方式 = **replace** 该 seq 标注为 `[{class, by:'backfill', at: backfill.at}]`；
     无 auto 标注或 auto 相同同样 replace（终审落地）。
   - 返回 `{ body: 新对象, conflicts }`；没有任何有效 verdict 时返回原 body 与 `conflicts:0`。
6. **foldDossierLedger**：
   - `messageCount = messages.length`。
   - `textLength = Σ message.text.length`。
   - `ctxTokens = estimateTokens(messages.map(m => m.text).join('\n'))`。
   - `annotationCounts`：按 seq 升序遍历 `messages`，只取该 seq 标注数组**最后一条**的
     class 计数（backfill replace 后即终审）。
7. **isDossierShort**：`body.messages.length < gate.minMessages ||
   textLength(body) < gate.minTextLength`。
8. **零外部状态**：所有函数纯函数；不 import platform/harness；不抛错（no-op 防御）。

### 3.2 `tests/dossier.spec.ts`（新，≤240 行；fake 域 + P3 持久契约）

用例（九组，命名含 `dossier`）：

1. **createDossier / dossierStorageKey**：空卷宗形态；`dossierStorageKey('task-1') ===
   'dossier:task-1'`。
2. **appendDossierMessage**：正序追加返回新对象；原 body 不被修改；乱序/重复 seq no-op；
   空文本 no-op。
3. **annotateDossier**：命中 seq 追加标注；未知 seq no-op；相同 `{class,by}` 幂等 no-op。
4. **backfillDossier**：无 auto → 替换为 backfill 且 conflicts 0；auto 相同 → conflicts 0
   且替换为 backfill；auto 不同 → conflicts 1 且替换为 backfill；未知 seq 忽略。
5. **foldDossierLedger**：messageCount/textLength/ctxTokens 与手算一致；annotationCounts
   只统计每 seq 最后一条（backfill 覆盖 auto 后只计 backfill class）。
6. **isDossierShort**：给定 gate `{minMessages:2, minTextLength:10}`，消息数或文本长度不足
   均 true；同时满足 false。
7. **P8 集成**：用 `foldSegmentState`（P2 fixture facts）得到 `task-1`/`task-2` 两段；
   `dossierStorageKey` 两键不同；`createDossier('task-1')` 后 `appendDossierMessage`，
   `createDossier('task-2')` 为空（边界清空语义）。
8. **确定性**：同一 body 连续 3 次 `JSON.stringify(foldDossierLedger(...))` 逐字节一致。
9. **P3 持久契约**：复用 `tests/storage.spec.ts` 的 FakeTable/FakeDomain 最小实现，
   `openContextEconomyStorage` 打开后：
   - `putEntity('dossier', dossierStorageKey('task-1'), createDossier('task-1'), source)` →
     v1；
   - `putEntity(..., appendDossierMessage(v1.body, msg), source, {baseVersion:1})` → v2；
   - `putEntity(..., backfillDossier(v2.body, backfill).body, source, {baseVersion:2})` → v3；
   - `auditEntity('dossier', key)` 返回 v1/v2/v3 三条；用 `baseVersion:1` 重放 v2 写入 →
     `CasMismatchError`。
   该组直接证明 P9 body 与 P3 持久面契约闭合，且版本链/CAS 语义满足 docs/09 §2 协议 4。

### 3.3 `scripts/verify-p9.mjs`（新，≤120 行；agent 自动化验收入口）

流程（确定性输出，exit 0/1）：

1. **P8 收尾门**：`node scripts/verify-p8.mjs` → 非 0 即 FAIL（P8 修正未验收，P9 不得开工）。
2. `DSH_CHECKOUT=G:/deepseek-harness npm run build`——checkout 目录不存在 → 打印
   `SKIP build (checkout missing)` 继续；存在但失败 → FAIL。
3. `npm run gate` → 非 0 即 FAIL；`npm run typecheck:tests` → 非 0 即 FAIL。
4. `node scripts/assert-structure.mjs --json` 连跑两次，diff 非空即 FAIL。
5. grep/扫描组（期望 0 命中）：
   - `src/core/dossier.ts`：`@deepseek-ai/`、`from 'cordis`、`platform/`、`ctx\.`、
     `session.append`、`setInterval(`、`emitCeFact`、`context-economy/`。
   - `src/index.ts`：`skills/change`、`export const inject = ['skills']`（P8 收尾复查）。
6. grep/扫描组（期望 ≥1 命中）：
   - `dossierStorageKey`、`appendDossierMessage`、`backfillDossier`、`foldDossierLedger`
     在 `src/core/dossier.ts`；
   - 测试名 `describe('dossier` 在 `tests/dossier.spec.ts`；
   - `ctx.inject(['skills']` 在 `src/index.ts` 与 `lib/index.js`（P8 收尾复查）。
7. **lib 新鲜度检查**：`lib/index.js` 必须存在；不含 `export const inject = ['skills']`；
   含 `ctx.inject(['skills']`（真机失败复盘防回归）。
8. 行数预算：`src/core/dossier.ts ≤200`、`tests/dossier.spec.ts ≤240`、
   `scripts/verify-p9.mjs ≤120`。
9. 打印 `P9 VERIFY PASS` 或失败清单，exit 0/1。

### 3.4 `tsconfig.tests.json`（改）

`include` 数组追加：

```json
"tests/dossier.spec.ts"
```

### 3.5 文档回写（实现后执行）

- `docs/implement/00-master.md`：P9 行标 `已施工 commit <hash>`；P8 收尾修正提交的 commit
  也同步记入 P8 行（`真机接线修正 commit <hash>`）。
- `docs/11-structure.md` 状态行：`R2 判别域进行中（P8/P9 已施工）`。
- `docs/implement/P8-units-prefix.md`：如 P8 收尾提交后，状态行改为
  `已施工 commit fa8fdab + fix commit <hash>`（若执行者有权改历史工单状态）。

## 4. 实现要点（每步独立可验证；顺序执行）

### 阶段 0：P8 收尾（真机接线修正落地；未完成不得进入 P9 本体）

1. 复核工作区 P8 修正：
   - `src/index.ts` 不含 `export const inject = ['skills']`，含 `ctx.inject(['skills']`；
   - `tests/prefix-wiring.spec.ts` 五组用例（含 `无 skills 服务时主插件仍可用`）；
   - `scripts/verify-p8.mjs` 含 lib 新鲜度检查。
2. `DSH_CHECKOUT=G:/deepseek-harness npm run build` 重建 lib。
3. `node scripts/verify-p8.mjs` 全 PASS。
4. `npm run gate` 与 `npm run typecheck:tests` 全绿（P8 修正的测试已跑过可复核）。
5. 真机/宿主复查（可用则做，不可用记录 SKIP）：
   - `dev_self_test`；
   - `dev_build_plugin /d/deepseek-plugin`；
   - `dev_inject_plugin /d/deepseek-plugin`；
   - `dsh web --no-open` 或已运行宿主日志中不再出现 `cannot get property "skills"
     without inject`，且 `logs/context-economy.log` 可见 `prefix unavailable until init
     frame`（无项目帧，P8 预期行为）。
6. P8 修正单独提交：
   `fix(p8): 技能 watch 改为 ctx.inject(['skills']) 子 fiber + lib 新鲜度检查`
7. 更新 `docs/implement/00-master.md` P8 行 commit 注记；然后才允许开始 P9 本体。

### 阶段 1：P9 本体

1. **核验 harness**（§2.3）：逐条 grep P3 符号；无新增直接 import。
2. **度量先行**：先写 `src/core/dossier.ts` 中的 `foldDossierLedger` 与 `isDossierShort`
   相关统计量（§3.1），再写 append/annotate/backfill 机制本体。
3. **写 `src/core/dossier.ts`**（§3.1）→ `npm run typecheck` 绿（core 零 harness/platform
   import，S1 不红）。
4. **写 `tests/dossier.spec.ts`**（§3.2）→ `npm test` 绿（九组用例；P3 持久契约组用 fake
   domain，零 cordis 运行时）。
5. **改 `tsconfig.tests.json`**（§3.4）→ `npm run typecheck:tests` 绿。
6. **写 `scripts/verify-p9.mjs`**（§3.3）→ `node scripts/verify-p9.mjs` 输出
   `P9 VERIFY PASS`。
7. **全链自验**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`；`npm run gate`；
   `node scripts/assert-structure.mjs --json` 双跑 diff 空。
8. 对照 §5 清单逐条打勾；全部满足后执行 §3.5 文档回写，再进 §7。

## 5. 验收（全机械 + agent 自动化检查）

- [ ] `node scripts/verify-p9.mjs` 输出 `P9 VERIFY PASS`（§3.3 九组全过）
- [ ] `node scripts/verify-p8.mjs` 输出 `P8 VERIFY PASS`（P8 收尾门）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0（P9 新文件进 lib/ 编译）
- [ ] `npm run gate` exit 0（typecheck + typecheck:client + vitest + assert 四段全绿）
- [ ] `npm run typecheck:tests` exit 0（`tests/dossier.spec.ts` 进 include）
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次输出逐字节一致（diff 为空）
- [ ] `tests/dossier.spec.ts` §3.2 九组用例齐全且绿（vitest 输出可见）
- [ ] `grep -R "@deepseek-ai/\|from 'cordis\|from \".*platform" src/core/dossier.ts`
      无命中（core 零 harness/platform import；S1 反向）
- [ ] `grep -R "ctx\.\|session.append\|setInterval(\|emitCeFact\|context-economy/" src/core/dossier.ts`
      无命中（纯核零触点、零 timer、零事实发射、不新增事实名）
- [ ] `grep -n "export const inject = \['skills'\]" src/index.ts` 无命中；`grep -n "ctx.inject(\['skills'\]" src/index.ts`
      至少 1 命中（P8 修正复查）
- [ ] `grep -n "export const inject = \['skills'\]" lib/index.js` 无命中；`grep -n "ctx.inject(\['skills'\]" lib/index.js`
      至少 1 命中（lib 新鲜度——防 `dsh web` 陈旧 lib 回归）
- [ ] `git diff tests/apply-smoke.spec.ts tests/events-pump.spec.ts tests/field-model.spec.ts tests/prefix-wiring.spec.ts`
      为空（P8 修正已在阶段 0 提交；P9 本体不碰既有测试）
- [ ] 行数预算：`src/core/dossier.ts ≤200`、`tests/dossier.spec.ts ≤240`、
      `scripts/verify-p9.mjs ≤120`（`wc -l`）

**agent 介入的真实宿主检查（P8 收尾已做则 P9 本体无新宿主面；如 P8 收尾 SKIP，则本单补做）**：

- [ ] `dev_self_test` 全 PASS（准备注入前必跑）
- [ ] `dev_build_plugin /d/deepseek-plugin` 产出 tgz
- [ ] `dev_inject_plugin /d/deepseek-plugin` 注入成功（宿主运行中才可执行）
- [ ] `dev_plugin_status` 显示 `@dsh-external/dsh-context-economy` 已装配且 fiber 状态正常
- [ ] 宿主日志中无 `cannot get property "skills" without inject`；`logs/context-economy.log`
      可见 `prefix unavailable until init frame`（P8 预期行为）

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **core 零 harness import**：`core/dossier.ts` 不得出现任何 `@deepseek-ai/*` 或 `cordis`
   import；不得 import `platform/storage`（测试文件可以）。
2. **不新增事实名**：P9 不声明任何 `context-economy/*` 事件类型；卷宗只落 `dossier` KV 表。
3. **不接线**：P9 不在 `src/index.ts` 订阅 `input/user-message`，不调用 `putEntity`；
   运行期消费归 P12/P14b。
4. **不改历史字节**：卷宗 append/回填都走新版本写入（`putEntity` baseVersion 递进），
   禁止原地改 `messages`/`annotations` 旧字节；core 函数只返回新对象。
5. **纯函数不抛错**：append/annotate 对乱序、重复、未知 seq 一律 no-op 返回原 body；
   backfill 对未知 seq 忽略。防御性静默只限 core 纯核；P12/P14b 调用方负责诊断与记账。
6. **lib 必须与 src 同步重建**：P9 虽不直接改 `src/index.ts`，但 `dsh web`/注入器加载
   `lib/index.js`；任何 src 变更后未 `npm run build` 即真机 = 陈旧 lib（P8 复盘教训）。
7. **可选服务只走 `ctx.inject`**：后续 P10/P12 若需 `ctx.llm`/`ctx.skills` 等可选服务，
   沿用 P8 修正模式，不得在根 ctx 直接读未声明服务。
8. **停工上报触发器**：① P8 收尾门不过；② §2.3 核验签名与设计不符；③ `backfillDossier`
   冲突语义与 docs/02 §4 冲突；④ 行数预算超限且无法精简；⑤ 任何未覆盖决策点。
   上报带证据（命令 + 输出 + file:line）。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p9): 卷宗纯核——dossier append-only + 三分类标注 + 回填终审 + P3 持久契约`
- 账本快照：**本单不需要**（P9 无运行期机制；R2 出门时随 P14b 出 07 快照，见总纲 §4）。
- 汇报（**本单最后一步，执行者必须完成**）：按 §9 向用户报告修改内容、功能实现与文档对应表。

## 8. 对接面（P9 如何被后续计划消费）与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式（P9 提供） |
|---|---|
| P10 判据与对表 | 读 `DossierBody` 渲染判据 prompt；`DossierClass` 三分类词汇即 P10 输出契约；`foldDossierLedger.ctxTokens` 入账 `judgeCtxTokens` |
| P11 星标断面 | `isDossierShort` 门控（阈值 P11 冻结）；`appendDossierMessage`/`backfillDossier` 供断面后回填；`foldDossierLedger` 供优化前体积记账 |
| P12 自动断面 | `on('input/user-message')` → `foldSegmentState` 取当前 taskId → `dossierStorageKey` → `appendDossierMessage` → P3 `putEntity` 逐条追加 |
| P13 命令面 + init 项目帧 | T0 close/open 切换 taskId 后，用 `createDossier(新 taskId)` 清空卷宗（边界清空语义） |
| P14b 星标 host 方法 | 用户确认终稿 → `backfillDossier` 写回卷宗 vN+1；`verdictBackfill.conflicts` 用 `DossierBackfillResult.conflicts` 入账 |
| P17/P19 边界装配/归档 | 归档时读 `DossierBody` 作为 task 卷宗事实源；归档后由 P19 调用 `createDossier(新 taskId)` 清空 |
| P21a 恢复编排 | 日志重放时逐条 `appendDossierMessage` 重建卷宗（`createDossier` 起步）；`foldDossierLedger` 校验重建结果 |

### 8.2 对后续计划的修正（本计划先行记录，实现后回写总纲）

| 行 | 原依赖 | 修正为 | 理由 |
|---|---|---|---|
| P9 | P3,P8 | 不变 | 本计划按总纲现状执行；P9 显式消费 `foldSegmentState.taskId`（P8 工单 §8.2 预告） |
| P10 | P9,P5,P2 | **P9,P5,P2,P8** | `judge-verdict` 契约源在 P8（P8 工单 §8.2 已记）；P10 输出三分类必须用 `DossierClass` 词汇 |
| P11 | P8,P9,P5,P2 | 不变 | P11 门控阈值冻结 `DossierGate`；回填复用 `backfillDossier` |
| P12 | P10,P3 | **P10,P3,P8,P9** | P12 需要 `foldSegmentState`（P8）+ `dossierStorageKey`/`appendDossierMessage`（P9）才能逐条追加卷宗 |
| P14b | P14a,P11,P13,P6,P3 | 不变 | P14b 回填写卷宗必须经 P9 `backfillDossier` + P3 `putEntity`，不得自写 body |

**P8 收尾修正对后续的影响（审查纳入）**：

- P10/P12/P13/P14b 凡需 `ctx.skills`/`ctx.llm` 等**可选服务**，一律沿用
  `ctx.inject([...])` 子 fiber 模式；不得在主插件根 ctx 直接读未声明服务。
- 任何 src 变更后，真机/`dsh web` 前必须 `DSH_CHECKOUT=G:/deepseek-harness npm run build`
  并过 lib 新鲜度检查（`verify-p9.mjs` 已含；后续 verify 脚本继承该检查）。
- `taskId` 跨会话唯一性：P12/P13 若跨会话使用同一 storage domain，必须在调用
  `dossierStorageKey` 前把 P8 段状态机的 `task-<n>` 扩展为会话级唯一 taskId；该决策在
  P12/P13 工单正文冻结，不留在 P9 猜测。

## 9. 汇报模板（本单最后一步）

执行者在全绿后向用户报告，必须包含：

1. **修改内容**：列出新增/改动文件与行数；P8 收尾 commit 与 P9 commit 分开列出；
   明确 `src/index.ts` 在 P9 中零改动（P8 修正除外）。
2. **功能实现**：
   - `core/dossier.ts`：append-only、三分类标注、backfill 终审与 conflicts、边界清空
     `createDossier`、`foldDossierLedger`/`isDossierShort` 统计口径；
   - P3 持久契约测试结果（v1→v2→v3 版本链、audit 三版、CAS 冲突命中）；
   - P8 收尾结果（`verify-p8` PASS、lib 新鲜度、真实宿主无 `skills without inject`）；
   - `scripts/verify-p9.mjs` 结果（`P9 VERIFY PASS`）。
3. **与文档对应表**：

| 功能 | 代码 | 文档 |
|---|---|---|
| 卷宗 append-only/原文累积 | `appendDossierMessage` | docs/02 §2 卷宗纪律 |
| 三分类标注 | `annotateDossier` / `DossierClass` | docs/02 §3/§4；docs/07 §0.5 |
| 回填终审 + 冲突审计 | `backfillDossier` / `DossierBackfillResult.conflicts` | docs/02 §4 B |
| 边界清空 | `createDossier` | docs/02 §2 卷宗纪律 |
| 卷宗体积记账 | `foldDossierLedger.ctxTokens` | docs/07 §0.5 判别族 |
| 门控统计 | `isDossierShort` / `DossierGate` | docs/02 §4 门控 |
| 卷宗 vN 持久契约 | P3 `putEntity` 集成测试 | docs/09 §2/§4 |
| taskId → key | `dossierStorageKey` | docs/01 §3.5；P8 `foldSegmentState` |
| P8 收尾/可选服务注入 | `ctx.inject(['skills'])` 复查 + lib 新鲜度检查 | P8 工单 §3.4/§8.2 |
| 自动化验收 | `scripts/verify-p9.mjs` | 总纲 §2 铁律 2 + §5 全机械验收 |

4. **后续计划修正已回写**：§8.2 的 P12 依赖补 P8/P9、P10 三分类词汇、P14b 回填走 P9、
   taskId 跨会话唯一性决策是否已核对 `docs/implement/00-master.md` 并落笔。
