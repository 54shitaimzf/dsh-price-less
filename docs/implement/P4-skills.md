# P4 技能目录端口（映射 R1；依赖 P0；尺寸 S）

> 状态：**计划态（本文件为 P4 施工工单）**。
> 设计正典：[10 §1 H13](../10-wiring.md)（技能目录挂点）/
> [11 §2](../11-structure.md)（模块树 `platform/skills.ts` 行 + 依赖铁律）/
> [02 §2](../02-discriminator.md)（稳定前缀 = 技能目录 + 项目帧；技能目录 = name/description/whenToUse 机械枚举）/
> [05 §4](../05-constitution.md)（引用守卫：优化产物引用技能名必须查表存在）/
> [06 §4](../06-cache.md)（稳定前缀版本事件：`skill` 装卸触发 bump）。
> harness 符号清单：`ctx.skills`（`SkillRegistry`）/ `SkillRegistry.snapshot` / `SkillRegistry.get` /
> `SkillSummary` / `SkillDefinition` / `SkillViewOptions` / `isSkillName` / `isModelInvocable` /
> `skills/change` 事件（`@deepseek-ai/dsh-skill`）。逐条 grep 核验源见 §2.3。

## 1. 目标

让稳定前缀的**技能目录原料**从 harness 官方技能注册表 `ctx.skills` 取得（不手写文件扫描）：
`platform/skills.ts` 提供技能目录快照枚举（name/description/whenToUse，过滤 model-invocable）、
`skills/change` 热更新订阅、单技能定义读取、引用守卫查表。本单**只建端口、不发机制行为**：
不装配 prefix 重建（P8）、不注册设置、不建会话事件、不接 storage。

## 2. 输入

### 2.1 正典摘录（工单自足；与正典冲突以正典为准并停工上报）

- **10 §1 H13**：技能目录 = DSH skill 系统文件根扫描（`SKILL.md` → name/description/whenToUse；
  目录 watch 热更新）；稳定前缀原料 + 引用守卫查表；枚举纯机械零 LLM。
  **本单实现修正**：harness 已把“扫描 + watch”收编为官方服务 `ctx.skills`（`dsh-skill` 注册表 +
  `dsh-skill-filesystem` 提供者）；本单**只经 `ctx.skills` 官方缝**，不手写 `SKILL.md` 扫描。
- **02 §2**：稳定前缀 = 技能目录（机械枚举，零 LLM）+ 项目最终目标（项目帧 vN）；技能目录取
  name / description / whenToUse；清单是查表产物，永远不靠模型回忆。
- **05 §4 引用守卫**：优化产物中引用的技能/命令名必须在枚举目录中存在（查表）；违反动作 =
  拒绝该引用（行级丢弃）。本单只提供查表谓词与快照，拒绝/记账动作归 P11/P14 域。
- **06 §4**：稳定前缀版本事件只有三种：技能装卸（目录变更，机械触发）、项目帧修订、压缩域
  档案变更；bump 理由枚举 `skill` 入账。本单只提供 `skills/change` 订阅端口，bump 执行归 P8。
- **11 §2**：`platform/skills.ts` = H13 技能目录枚举 + watch（稳定前缀原料 + 引用守卫查表）；
  `core ↛ platform`；platform 是唯一 `ctx` 触点（index.ts 装配根除外）。
- **13（P4 起新增 §3.7）**：`ctx.skills` 是 `SkillRegistry` 服务；`snapshot(options)` 返回
  `{ skills: SkillSummary[], complete: boolean }`；`get(name, options)` 返回 `SkillDefinition |
  undefined`；`skills/change` 是 emit 事件（unfiltered invalidation notification）。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `src/platform/skills.ts` | 不存在 | **新**（§3.1） |
| `src/index.ts` | 装配根 | **零改动**（P4 无运行期消费者；P8 起在装配根接线） |
| `scripts/build.sh` | `link_pkg` 集 | 加 `@deepseek-ai/dsh-skill` 链接（§3.4） |
| `package.json` | peerDependencies | 加 `@deepseek-ai/dsh-skill`（范围声明，不硬编码） |
| `scripts/assert-structure.mjs` | RULES 表 | 追加 D5（skill 概念收口，§3.5） |
| `tests/assert-structure.spec.ts` | 零位快照 | 补 D5 负/正样本 + 快照 `D5:'pass'` |
| `tsconfig.tests.json` | include 类型级 spec | 增 `tests/skills.spec.ts` |
| `docs/13-harness-plugin-spec.md` | §3 接口表 | 新增 §3.7 `ctx.skills` 核验节；落位表 `src/platform/skills.ts` 改已施工（P4）；后续小节顺延编号 |
| `docs/implement/00-master.md` | P4 行 | 执行后回写 `已施工` 与 commit（本文件在计划期仅加链接） |

### 2.3 harness 符号核验源（只 grep 定义处，确认后准 import；找不到即停工上报）

| 符号 | 定义处（G:/deepseek-harness） | 本单用途 |
|---|---|---|
| `ctx.skills: SkillRegistry`（Context 合并） | `packages/skill/skill/src/index.ts:286-288` | 服务解析 |
| `'skills/change'` 事件（emit） | `packages/skill/skill/src/index.ts:290-299` | 热更新订阅 |
| `SkillRegistry.snapshot(options): Promise<SkillCatalogSnapshot>` | `packages/skill/skill/src/index.ts:483-490` | 目录快照（含 complete） |
| `SkillRegistry.list(options): Promise<SkillSummary[]>` | `packages/skill/skill/src/index.ts:472-474` | （备选）只需名字时可用 |
| `SkillRegistry.get(name, options): Promise<SkillDefinition \| undefined>` | `packages/skill/skill/src/index.ts:502-504` | 单技能定义读取 |
| `SkillSummary`（name/description/whenToUse?/invocation/source/provider/resourceBase?） | `packages/skill/skill/src/index.ts:57-75` | 快照原料 |
| `SkillDefinition`（extends SkillSummary + content/path?/metadata?） | `packages/skill/skill/src/index.ts:87-94` | 单技能读取 |
| `SkillViewOptions`（cwd?/signal?/scope?） | `packages/skill/skill/src/index.ts:118-125` | 查询选项 |
| `isSkillName` / `isModelInvocable` | `packages/skill/skill/src/index.ts:35-37` / `128-130` | 名称合法性 / model 可见过滤 |
| `@deepseek-ai/dsh-skill` 包名与导出 | `packages/skill/skill/package.json` | peerDep + build 链接 |

## 3. 产出

### 3.1 `src/platform/skills.ts`（新，≤220 行）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill' // 拉入 Context.skills 与 skills/change 事件合并
import {
  isModelInvocable, isSkillName,
  type SkillDefinition, type SkillSummary, type SkillViewOptions,
} from '@deepseek-ai/dsh-skill'

export interface SkillCatalogEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
}
export interface SkillCatalogSnapshot {
  readonly skills: readonly SkillCatalogEntry[]
  readonly complete: boolean        // harness 快照完整性（provider 部分失败 = false；P8 决定 last-good 策略）
}

export function toSkillCatalogSnapshot(
  summaries: readonly SkillSummary[],
  complete: boolean,
): SkillCatalogSnapshot
// 过滤 isModelInvocable；映射 { name, description, whenToUse }；按 name 码点升序；新对象，不引用输入。
export function skillCatalogContains(catalog: SkillCatalogSnapshot | undefined, name: string): boolean
export function skillCatalogNames(catalog: SkillCatalogSnapshot | undefined): string[]
export async function listSkillCatalog(
  ctx: Pick<Context, 'skills' | 'logger'>,
  options?: SkillViewOptions,
): Promise<SkillCatalogSnapshot | undefined>
export async function getSkillDefinition(
  ctx: Pick<Context, 'skills' | 'logger'>,
  name: string,
  options?: SkillViewOptions,
): Promise<SkillDefinition | undefined>
export function watchSkillCatalog(
  ctx: Pick<Context, 'skills' | 'logger' | 'on'>,
  onChange: (catalog: SkillCatalogSnapshot | undefined) => void,
  options?: SkillViewOptions,
): () => void
```

**语义（实现必须逐字照抄；冲突以正典为准停工）：**

1. **服务解析**：`const skills = ctx.skills`；`skills == null` 视为能力缺失——`listSkillCatalog` /
   `getSkillDefinition` 返回 `undefined`，`watchSkillCatalog` 仍订阅 `skills/change`（事件总线
   与服务无关）但首刷回调收到 `undefined`。失败不抛出（fail-lazy）。
2. **listSkillCatalog**：优先调用 `skills.snapshot(options)` 取 `{ skills, complete }`
   （若 fake/旧版无 `snapshot` 只有 `list`，回退 `list(options)` 并置 `complete=true`）；
   `try/catch` 包裹——provider 侧抛错已由 harness 计 `complete=false`，本层再兜底：
   捕获后 `ctx.logger('context-economy').warn('context-economy: skill catalog unavailable (contained, fail-lazy)', e)`，
   返回 `undefined`。
3. **toSkillCatalogSnapshot**：过滤 `isModelInvocable(s) === true` 的 summary；每条仅取
   `{ name, description, whenToUse }`（whenToUse 为 undefined 时省略键）；按 `name` 码点升序
   （`a.name < b.name ? -1 : a.name > b.name ? 1 : 0`）；输出全新对象与数组（不引用 harness
   输入对象——**前序 P3 风险带入：快照只读，调用方不得原地修改，违者由 P8 字节守卫兜底**）。
4. **skillCatalogContains / skillCatalogNames**：纯函数；`catalog === undefined` 视为空目录
   （返回 false / []）；查表按 `name ===` 精确匹配（技能名是 kebab-case 全等，不做大小写折叠）。
5. **getSkillDefinition**：`isSkillName(name)` 不合法直接 `undefined`（与 harness 同语义）；
   `skills.get(name, options)`；失败 catch + warn + `undefined`。
6. **watchSkillCatalog**：
   - 返回 disposer；disposer 幂等（重复调用 no-op）。
   - 订阅 `ctx.on('skills/change', refresh)`；**立即首刷一次**（P8 接入时无需等第一次变更）。
   - `refresh`：置 `running` 防重入；`listSkillCatalog` 完成后若未 dispose 才回调；回调用
     try/catch 包住，onChange 抛错只 warn 不外溢。
   - 不引用 `setInterval`/`setTimeout`（S5）；热更新完全由 `skills/change` 驱动。

### 3.2 `tests/skills.spec.ts`（新，≤200 行；全部 fake，零 cordis 运行时 import）

手写 fake ctx：`skills = { snapshot, get }` 可选；`on(name, fn)` 返回 disposer 并记录监听器；
`logger('context-economy')` 返回 warn spy。用例（七组）：

1. **toSkillCatalogSnapshot**：过滤 modelInvocable=false；映射仅 `name/description/whenToUse`；
   排序按 name 码点；输出与输入不共享引用（改输入不影响输出）。
2. **skillCatalogContains / skillCatalogNames**：命中 true；未命中 false；`undefined` 目录 false/[]。
3. **listSkillCatalog**：fake `snapshot` 返回 `{skills, complete:false}` → 快照 complete=false；
   `skills` 缺失 → `undefined` 且不抛；`snapshot` reject → warn + `undefined`（fail-lazy）。
4. **getSkillDefinition**：合法名委托 `skills.get` 并返回；非法名不调用直接 undefined；
   `skills` 缺失/`get` reject → undefined + warn。
5. **watchSkillCatalog 首刷 + 变更**：首刷回调收到快照；`emit('skills/change')` 后再刷并回调；
   两次调用之间 `running` 防重入（同步二次 emit 只触发一次 list，用 microtask 排空断言）。
6. **watchSkillCatalog 卸载**：disposer 后 emit 不再回调；重复 dispose no-op。
7. **onChange 抛错遏制**：onChange throw 被 catch + warn，不影响 disposer 正常执行。

### 3.3 `scripts/verify-p4.mjs`（新，≤110 行；agent 自动化验收入口）

流程同 P3 先 build 再 gate（`@deepseek-ai/dsh-skill` 需 build.sh 链接）：

1. `DSH_CHECKOUT=G:/deepseek-harness npm run build`（目录不存在 → SKIP 不判 FAIL）→ 非 0 即 FAIL。
2. `npm run gate` → 非 0 即 FAIL。
3. `node scripts/assert-structure.mjs --json` 连跑两次，diff 非空即 FAIL。
4. grep/扫描组（期望 0 命中）：
   - `src/platform/skills.ts`：`fetch(`, `http.get`, `axios`, `setInterval(`, `\.append(`,
     `readFile`, `watchFile`, `readdir`, `chokidar`, `from '@deepseek-ai/dsh-storage`,
     `from '../core`, `from './storage.ts`。
   - `src/core`：`@deepseek-ai/dsh-skill|ctx\.skills|skills/change|SkillSummary|SkillDefinition`
     （core 零 skill 概念）。
5. 行数预算：`src/platform/skills.ts ≤220`、`tests/skills.spec.ts ≤200`、`scripts/verify-p4.mjs ≤110`。
6. `grep -n "id: 'D5'" scripts/assert-structure.mjs` 与 `grep -n "D5: 'pass'" tests/assert-structure.spec.ts`
   各至少 1 命中。
7. 打印 `P4 VERIFY PASS` 或失败清单，exit 0/1。

### 3.4 `scripts/build.sh` + `package.json` 改动（≤10 行净增）

```bash
# P4：技能目录端口（ctx.skills 官方注册表；只 import dsh-skill，不手写文件扫描）
link_pkg @deepseek-ai/dsh-skill packages/skill/skill
```

`package.json` peerDependencies 增加 `"@deepseek-ai/dsh-skill": ">=0.1.3-alpha.1 <2"`。

### 3.5 `scripts/assert-structure.mjs` 追加 D5（引擎零改动）

```js
{ id: 'D5', canon: 'docs/10 §1 H13 + docs/11 §2 + docs/13 §3.7',
  appliesTo: (p) => p.startsWith('src/') && p.endsWith('.ts'),
  check: (f) => /(ctx\.skills|skills\/change|SkillSummary|SkillDefinition|@deepseek-ai\/dsh-skill)/.test(f.text)
    && f.path !== 'src/platform/skills.ts' && f.path !== 'src/index.ts'
    ? [{ message: 'skill registry concepts must only appear in platform/skills.ts (index.ts wiring allowed, docs/10 §1 H13)' }]
    : [] }
```

`tests/assert-structure.spec.ts`：负样本 `src/core/a.ts` 出现 `ctx.skills` / `SkillSummary` →
issue；正样本 `src/platform/skills.ts` 与 `src/index.ts`（未来 `ctx.inject(['skills'])` 接线位）→
0 issue；真实树零位快照增 `D5:'pass'`。

### 3.6 文档回写（实现后执行）

- `docs/implement/00-master.md`：P4 行标 `已施工 commit <hash>`。
- `docs/13-harness-plugin-spec.md`：新增 §3.7 `ctx.skills`（核验源表见 §2.3）；原 §3.7 tools 起
  顺延为 §3.8；落位表 `src/platform/skills.ts` → 已施工（P4）。
- `docs/11-structure.md` 状态行补 `P4`。

## 4. 实现要点（每步独立可验证；顺序执行）

1. **核验 harness**（§2.3）：逐条 grep 到定义处，确认 `ctx.skills`/`snapshot`/`get`/
   `skills/change` 与 P4 设计一致；不一致停工上报。
2. **改 build.sh + package.json**（§3.4）→ `DSH_CHECKOUT=G:/deepseek-harness npm run build` 绿。
3. **写 `src/platform/skills.ts`**（§3.1）→ `npm run typecheck` 绿。
4. **写 `tests/skills.spec.ts`**（§3.2）→ `npm test` 绿（新增 7 组用例）。
5. **追加 D5**（§3.5）→ `npm run assert` 绿；更新 `tests/assert-structure.spec.ts` 快照与负/正
   样本 → `npm test` 绿。
6. **写 `scripts/verify-p4.mjs`**（§3.3）→ `node scripts/verify-p4.mjs` 全 PASS。
7. **全链自验**：`DSH_CHECKOUT=G:/deepseek-harness npm run build`；`npm run gate`；
   `node scripts/assert-structure.mjs --json` 双跑 diff 空。
8. 对照 §5 清单逐条打勾；全部满足后执行 §3.6 文档回写，再进 §7。

## 5. 验收（全机械 + agent 自动化检查）

- [ ] `node scripts/verify-p4.mjs` 输出 `P4 VERIFY PASS`（§3.3 七组全过）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0（build.sh 链接 `@deepseek-ai/dsh-skill`）
- [ ] `npm run gate` exit 0（typecheck + typecheck:client + vitest + assert 四段全绿）
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次输出逐字节一致（diff 为空）；
      零位快照含 `D5:pass`
- [ ] `tests/skills.spec.ts`：§3.2 七组用例齐全且绿（vitest 输出可见）
- [ ] `grep -R "readFile\|watchFile\|readdir\|chokidar\|SKILL.md" src/platform/skills.ts` 无命中
      （不手写文件扫描，只走 `ctx.skills` 官方缝）
- [ ] `grep -R "@deepseek-ai/dsh-skill\|ctx\.skills\|skills/change\|SkillSummary\|SkillDefinition" src/core`
      无命中（core 零 skill 概念；S1/D5 反向）
- [ ] `grep -R "fetch(\|http.get\|axios\|setInterval(\|\.append(" src/platform/skills.ts`
      无命中（零网络/零 timer/不写会话日志）
- [ ] `git diff tests/field-model.spec.ts tests/apply-smoke.spec.ts tests/events-pump.spec.ts`
      为空（既有测试零改动；assert-structure.spec 只按 P4 追加 D5 样本/快照）
- [ ] 行数预算：`src/platform/skills.ts ≤220`、`tests/skills.spec.ts ≤200`、
      `scripts/verify-p4.mjs ≤110`（`wc -l`）

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **只走官方缝**：不 `readFile`/`watchFile`/`chokidar` 扫描 `SKILL.md`；harness 已有
   `dsh-skill` + `dsh-skill-filesystem` 承担扫描与 watch，本单若手写扫描 = 重复实现 + 双源漂移。
2. **零 timer**：热更新只能由 `skills/change` 事件驱动；禁 `setInterval`/`setTimeout` 轮询（S5）。
3. **零 core import**：`platform/skills.ts` 不 import `core/**`；快照类型是平台侧结构，
   未来 `core/prefix.ts` 如需同构类型，由 P8 在 core 本地重声明（P2 模式）。
4. **快照只读**：`toSkillCatalogSnapshot` 输出全新对象；调用方不得原地修改快照/条目
   （P3 审查风险同构：按引用共享会绕过版本语义，P8 字节守卫兜底）。
5. **fail-lazy 方向**：`skills` 服务缺失或 `snapshot/get` 失败 → `undefined` + warn（不抛出）；
   引用守卫在目录缺失时 `skillCatalogContains` 返回 false——P11/P14 必须显式决定“目录不可用”
   时的产品策略（建议 fail-lazy 放行并记 `guard/violation` 之外的 `skillCatalogUnavailable` 诊断，
   由 P11/P14 工单落账，P4 不建事件名）。
6. **不建会话事件**：P4 不声明任何 `context-economy/*` 事件类型；目录变更的度量
   `prefixRebuildCause{skill}` 由 P8 在 prefix 层入账。
7. **停工上报触发器**：① §2.3 核验签名与设计不符；② build.sh 链接 `@deepseek-ai/dsh-skill`
   后 typecheck 仍无法 resolve；③ `skills/change` 事件在 harness 中的派发语义与“emit 通知”
   不符（例如被实现为 waterfall）；④ 行数预算超限且无法精简；⑤ 任何未覆盖决策点。
   上报带证据（命令 + 输出 + file:line）。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p4): 技能目录端口——ctx.skills 快照枚举 + skills/change 热更新 + 引用守卫查表`
- 账本快照：**本单不需要**（端口无机制改动；R1 段末随 P7 出首份 07 报表快照，见总纲 §4）。
- 汇报（**本单最后一步，执行者必须完成**）：按 §9 向用户报告修改内容、功能实现与文档对应表。

## 8. 对接面（P4 如何被后续计划消费）与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式（P4 提供） |
|---|---|
| P8 分划单位 + 稳定前缀 | `watchSkillCatalog` 订阅目录变更 → `prefixRebuildCause:'skill'` bump；`listSkillCatalog` 产出快照作为项目帧技能目录快照原料（P8 在 core 本地重声明同构类型，不 import platform） |
| P11 星标断面 | `listSkillCatalog` 为引用守卫提供当前目录；`skillCatalogContains` 逐技能名查表 |
| P13 命令面 + init 项目帧 | init 采集时经 P8/P11 使用同一目录快照，保持稳定前缀同源 |
| P14 星标按钮 UI | 预览确认前跑引用守卫：`skillCatalogContains` 不命中 → 行级丢弃（P14 域记账，P4 只提供查表） |
| P21 恢复编排 + 全链验收 | 恢复序中项目帧重建后，用 `listSkillCatalog` 重放目录快照（只读校验） |

### 8.2 对后续计划的修正（随本计划先行回写 `docs/implement/00-master.md`）

| 行 | 原依赖 | 修正为 | 理由 |
|---|---|---|---|
| P4 | P0 | 不变 | `platform/skills.ts` 不 import P1 `events.ts`（logger 走 `ctx.logger` 基线），也不碰 storage；P0 基线即可 |
| P8 | P3,P4,P2 | 不变 | 已含 P4；P8 需在 core 本地重声明 `SkillCatalogEntry` 同构类型（禁止 core import platform，P2 模式） |
| P11/P14 | — | 不变 | 引用守卫消费 P4 查表，但依赖列已通过 P8/P9/P13 传递；无需改行 |

总纲 §3 依赖主干图无需改边（P4 仍为 P0 后继、P8 前驱）。

## 9. 汇报模板（本单最后一步）

执行者在全绿后向用户报告，必须包含：

1. **修改内容**：列出新增/改动文件与行数；`tests/assert-structure.spec.ts` 仅 D5 样本与快照变化。
2. **功能实现**：`ctx.skills` 官方缝枚举（非手写扫描）；`toSkillCatalogSnapshot` 过滤/排序/最小
   字段；`skills/change` 热更新订阅；引用守卫查表；fail-lazy 与 warn 行为；verify-p4 结果。
3. **与文档对应表**：

| 功能 | 代码 | 文档 |
|---|---|---|
| H13 技能目录端口 | `src/platform/skills.ts` | docs/10 §1 H13；docs/11 §2 skills.ts 行 |
| 稳定前缀技能目录（name/description/whenToUse） | `toSkillCatalogSnapshot` | docs/02 §2 |
| 引用守卫查表 | `skillCatalogContains` / `skillCatalogNames` | docs/05 §4 |
| 目录热更新（skills/change） | `watchSkillCatalog` | docs/10 §1 H13；docs/13 §3.7 |
| fail-lazy 与服务缺失降级 | `listSkillCatalog`/`getSkillDefinition` | docs/05 回退链 + 总纲铁律 6 |
| D5 skill 概念收口 | `scripts/assert-structure.mjs` D5 | docs/11 §2；docs/13 §3.7 |
| 自动化验收 | `scripts/verify-p4.mjs` | 总纲 §2 铁律 2 + §5 全机械验收 |

4. **后续计划修正已回写**：§8.2 的 P4 依赖不变与 P8/P11/P14 消费方式是否已核对
   `docs/implement/00-master.md`。
