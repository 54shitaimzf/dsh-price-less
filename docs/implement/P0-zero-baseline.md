# P0 工程零位核对（映射 R0；依赖 —；尺寸 S）

> 设计正典：[11 §1](../11-structure.md)（manifest 合规表）/ [11 §2](../11-structure.md)（模块树与依赖铁律）/
> [11 §4](../11-structure.md)（日志三纪律）/ [11 §8](../11-structure.md)（R0 行出门门槛）/ [11 §9](../11-structure.md)（结构验收）/
> [10 §1](../10-wiring.md)（H4 改史通道）/ [01 §4](../01-architecture.md)（可见性）。
> harness 符号清单：`surfaceOp` / `sourceEventSeqs`（@deepseek-ai/dsh-session 类型面）——本单**只核验拼写、不 import**（见 §2.4）。
> **范围注记**：本单范围 = 总纲 §3 P0 行字面范围（manifest 差距核对 + 断言骨架 + `npm run assert`）
> **加** ① apply 冒烟测试（R0 门「注入/卸载净」的离线替身——`dev_self_test` 真机链路属外部注入器，
> flash 不可自主执行，见 §6-⑤）② 入口导出差距清零 2 处（§2.3 已核对，属 11 §1 入口铁律的核对清零，
> 非新增设计）。扩展经用户批准（2026-09-06「完整零位」）。

## 1. 目标

把 docs/11 §1 manifest 合规表、§2 依赖铁律、§9 结构验收固化为**离线可重复执行的机械断言**
（`scripts/assert-structure.mjs` + `npm run assert`），后续 21 份工单共用同一引擎只追加规则；
以 fake ctx 冒烟测试给 R0 门「注入/卸载净」一个无头机械形态；清零两处入口导出差距。
全部验收零网络、零 API 调用、零真实模型。

## 2. 输入

### 2.1 正典摘录（工单自足，免翻全文；与正典冲突时以正典为准并停工上报）

**11 §1 manifest 合规表**（本单 M 族规则的唯一依据）：

| 项 | 规范要求 |
|---|---|
| name/version | `@dsh-external/dsh-context-economy` / 0.0.1 |
| peerDeps | 范围声明不硬编码版本 |
| dsh.bundle.patch | `./cordis.patch.yml` |
| dsh.client.* | inject + platform + `exports["./client"]` |
| 入口铁律 | `export name/inject/Config/apply`；一切资源注册挂 `ctx.effect`；waterfall 必须 `return next()` |
| client 铁律 | `inject=['slots'…]` + register 必带 name；操作用完整包名 |

**11 §2 依赖铁律**：`domains → core + platform`；`core ↛ platform`（反向禁止，CI 断言）；
platform 是唯一 `ctx` 触点（index.ts 装配根除外）；client 只经 settings/remote 面，不直接摸会话。
**11 §2 模块树**：host 半边事件驱动、**无 timer**（不用 daemon-loop 的轮询循环）。

**11 §4 日志三纪律**（本单 S3 的依据）：自定义会话事件必须 `ignorable:true`（`SessionEventMap`
声明合并）——否则旧版 harness 拒读新日志（fail-closed）；`context-economy/*` 全家 log-only。

**11 §9 结构验收**（本单 S 族逐步固化的清单）：core/ 零 harness import（含类型）；改史调用只出现在
platform/history；自定义会话事件全部 `ignorable:true`；UI 壳不变量（field-model.spec 只增不减）。

**10 §1 H4（改史唯一通道，S2 规则依据）**：`session.append` + `surfaceOp:{op:'replace',start,end}` +
完整 `sourceEventSeqs`（被遮蔽节点全列）。改史没有任何旁路。

**入口导出铁律的字面分解**（M5 规则依据）：host 半边（`src/index.ts`）必须导出
`name` / `Config` / `apply`（host 无静态 inject 声明——事件订阅用 `ctx.on` 动态挂、settings 服务用
`ctx.inject(...)` 函数式消费，见 `src/settings.ts`）；client 半边（`client/index.ts`）必须导出
`name` / `inject` / `apply`。host 的 `inject` 属 client 铁律那行，host 不要求。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `package.json` | scripts: build / build:client / typecheck / typecheck:client / test；peerDeps 3 件；dsh.bundle.patch + dsh.client.* | 加 `assert`、`gate` 两 scripts |
| `src/index.ts` | `export const name`、`export function apply`（31 行，模板态） | +1 行再导出 Config |
| `src/config.ts` | `export interface Config` + `export const Config`（schemastery schema）、`CONFIG_DEFAULTS`、`resolveConfig()` | 不动 |
| `src/settings.ts` | `registerContextEconomySettings(ctx, config, hooks)`：`ctx.inject(['settings'], …installSection(ctx, 'context-economy', Config, resolved, {setSource, onChange})…)`；settings 服务脱离时静默跳过；disposer 回退装配 base | 不动（冒烟的被测对象） |
| `client/index.ts` | `export const CONTEXT_ECONOMY_NS`、`export const inject = ['slots','settingsScope','remote','remote.session','connection']`、`export function apply`（72 行） | +1 行 `export const name` |
| `cordis.patch.yml` | bundle 装配行 | 不动（M3 只断言存在与字段指向） |
| `tests/field-model.spec.ts` | 11 用例，既有断言只增不减 | 不动 |
| `vitest.config.ts` | exclude experiments/lib；glob = tests/*.spec.ts | 不动 |
| `scripts/build.sh` | DSH_CHECKOUT 探测 + junction + tsc host + tsdown client | 不动 |

### 2.3 已核对事实（规划期核对，2026-09-06；执行者免重查，抽验即可）

1. **入口导出差距 2 处**：`src/index.ts` 无 `Config` 再导出；`client/index.ts` 无 `name` 导出。
   这是 M5 在当前真树上仅有的 2 个 fail 点，**属本单预定修复项**，不是正典冲突。
2. **基线已绿**：`npm run typecheck`、`npm run typecheck:client`、`npm test`（11/11）、
   `DSH_CHECKOUT=G:/deepseek-harness npm run build` 在改动前全部通过——验收基线真实成立。
3. **junction 依赖在位**：`node_modules/{schemastery,cordis,@deepseek-ai/dsh-settings}` 均为
   build.sh / 手工建的链接（指向 G:/deepseek-harness vendor/packages）。
4. **S 族零位干净**：`src/`、`client/` 中 `setInterval` / `surfaceOp` / `sourceEventSeqs` /
   `.append(` 零命中——S2/S5 当前零误报风险。
5. **零位快照预期**：M1–M5 修复后 = pass；S1 = vacuous（`src/core/` 尚不存在）；
   S2/S3/S4/S5 = pass（覆盖文件非空）。

### 2.4 harness 核验源（总纲 §2 铁律 3：只信源码，逐条 grep 到定义处才准使用）

| 符号 | 定义处 | 用途 | 限制 |
|---|---|---|---|
| `surfaceOp` / `sourceEventSeqs` | `G:/deepseek-harness/packages/core/session/lib/types/types.d.ts`（SurfaceOp / SessionEvent 信封） | S2 规则的词表拼写依据 | **只读 grep 核验拼写**，不 import、不改动该文件 |
| `ignorable` | 同上 SessionEvent 信封字段 | S3 规则词表 | 同上 |

> 本单不调用任何 `dev_*` 命令（`dev_scaffold_plugin` / `dev_build_plugin` / `dev_self_test` /
> `dev_inject_plugin` 属 **dsh-super-injector 注入器**，不在 harness checkout 内；见 §6-⑤）。

## 3. 产出

### 3.1 `scripts/assert-structure.mjs`（新，全文件 ≤150 行）

ESM（package.json 已 `type:module`），只用 Node 内置模块（`node:fs` / `node:path` / `node:url`）。

**导出面**（供 vitest 直接 import，规则纯函数不摸 fs）：

```ts
export interface RuleFile { path: string; text: string }        // path 用 '/' 分隔
export interface RuleIssue { rule: string; path: string; line?: number; message: string }
export interface Rule {
  id: string                       // 'M1'…'S5'；命名空间：M=manifest，S=structure，D=P6 起域规则
  canon: string                    // 正典节号，如 'docs/11 §1 表'
  appliesTo: (path: string) => boolean
  check: (file: RuleFile, all: Map<string, string>) => RuleIssue[]   // 纯函数；all = 全文件集文本表
}
export const RULES: Rule[]
export function runRules(files: RuleFile[]): { ok: boolean; issues: RuleIssue[];
  rules: Record<string, { status: 'pass'|'fail'|'vacuous'; issueCount: number }>; vacuous: string[] }
export function collectFiles(root: string): RuleFile[]            // 引擎侧文件收集（含根清单文件）
export function main(): void                                      // CLI 入口
```

**引擎语义**：
- 文件集 = `src/**` + `client/**` + `tests/**` 递归（`.ts/.tsx/.mjs/.css/.json`）+ 根清单
  `package.json`、`cordis.patch.yml`、`tsdown.config.ts`、`vitest.config.ts`；排除
  `node_modules/ lib/ experiments/ scripts/ docs/ datasets/ reports/ .git/ .*`。
- 规则先按 `appliesTo` 过滤文件：命中 0 文件 → 该规则 `status:'vacuous'`（不算失败，但显式列进
  `vacuous[]`——「暂全过」必须诚实可见）；否则跑 `check`，有 issue → `fail`，无 → `pass`。
- 文本输出（默认，人类读）：按规则 id 排序，每条一行
  `<id> <PASS|FAIL|VACUOUS> <canon>` + fail 明细行；**禁时间戳、禁 ANSI 颜色、路径一律 `/` 分隔**。
- `--json` 输出：`JSON.stringify(result, null, 2)`（schema 如上，字段名冻结，供 R 门与账本工具消费）。
- exit code：0 = 全过（含 vacuous）；1 = 有 fail；2 = 引擎自身异常（如 package.json 解析失败）。

**规则表（10 条，全部启用）**：

| id | canon | appliesTo | check 语义 | 零位预期 |
|---|---|---|---|---|
| M1 | 11 §1 表 | package.json | `name === '@dsh-external/dsh-context-economy'` 且 `version` 匹配 `/^\d+\.\d+\.\d+/` | pass |
| M2 | 11 §1 表 | package.json | peerDependencies 必含 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings`、`schemastery` 三键，且每键值匹配 `/[<^~>=]/`（范围声明，禁硬编码精确版本） | pass |
| M3 | 11 §1 表 | package.json + 文件集 | `dsh.bundle.patch === './cordis.patch.yml'` 且文件集含 `cordis.patch.yml` | pass |
| M4 | 11 §1 表 + package.json | package.json | `dsh.client.platform === 'web'`；`dsh.client.inject` 为数组且含 `react` 与 `@deepseek-ai/dsh-client-ui-slots`；`exports['./client']` 存在 | pass |
| M5 | 11 §1 表（入口铁律） | src/index.ts、client/index.ts | host 文本匹配 `export const name`、`export function apply`、`/export\s*\{[^}]*\bConfig\b[^}]*\}/`；client 文本匹配 `export const name`、`export const inject`、`export function apply` | 本单 §4-① 修复后 pass |
| S1 | 11 §2 依赖铁律 + §9 | src/core/** | 文本不得匹配 `/from\s+['"]@deepseek-ai\//` 与 `/from\s+['"]cordis/`（type-only import 同样命中——「含类型」）与 `/from\s+['"][^'"]*platform/` | **vacuous**（目录不存在） |
| S2 | 11 §9 + 10 §1 H4 | src/**.ts | 文本命中 `/surfaceOp|sourceEventSeqs|\.append\(/` 的文件路径必须是 `src/platform/history.ts` | pass（零命中） |
| S3 | 11 §4 纪律① | src/**.ts | 逐行找锚：行含 `/['"]context-economy\//` 且去前导空白后不以 `//` 或 `*` 开头；窗口 [锚−1, 锚+3] 行内须含 `/ignorable/`，否则 issue（启发式 v1；P6/P16 升级类型级测试） | pass（零锚点） |
| S4 | 11 §2 依赖铁律 | client/** | 文本不得匹配 `/from\s+['"][^'"]*\.\.\/src\//`（client 不得摸 host src） | pass |
| S5 | 11 §2（无 timer） | src/**、client/** | 文本不得含 `setInterval(` | pass |

> 行数预算：引擎约 70 行 + 10 规则约 60 行 + 头注约 15 行。写不下 → **停工上报，禁止砍规则**；
> 允许把 check 写紧凑（单表达式 return），不许降断言强度。

### 3.2 `tests/assert-structure.spec.ts`（新）

vitest 常规用例（`import { RULES, runRules } from '../scripts/assert-structure.mjs'`——vitest 可直接
load .mjs）：

1. **负样本**（防「永真断言」，每条规则 ≥1 用例）：构造违规虚拟 `RuleFile`（如 M5 喂缺 Config 导出的
   host 文本、S1 喂 `import type { X } from '@deepseek-ai/dsh-session'` 的 core 文本、S3 喂无 ignorable 的
   事件 append 行、S5 喂含 `setInterval(` 的文件），断言对应规则返回 ≥1 issue。
2. **正样本**：每条规则喂干净虚拟文件，断言 0 issue。
3. **真实树集成**：`collectFiles(仓库根)` → `runRules` → `ok === true`（vacuous 允许）。
4. **零位快照**：真实树输出的 `rules` 逐条等于快照
   `{ M1:'pass',M2:'pass',M3:'pass',M4:'pass',M5:'pass',S1:'vacuous',S2:'pass',S3:'pass',S4:'pass',S5:'pass' }`。
   （后续工单新增规则或目录落地改变状态时，**随该工单更新此快照**——快照漂移 = 有人动了断言面，
   必须显式过工单。）
5. **确定性**：真实树 `runRules` 跑两遍，`JSON.stringify` 逐字节相等。

### 3.3 `tests/apply-smoke.spec.ts`（新）

R0 门「注入/卸载净」的**离线替身**：手写 FakeCtx（禁 import cordis 运行时；`schemastery` 允许——它是
`src/config.ts` 的真实运行时依赖且 junction 在位）。被测对象 = 真实 `apply`（`src/index.ts`）。

**FakeCtx 最小语义**（按 `src/settings.ts` 实际行为）：
- `logger.info/warn/error` 记入数组；
- `inject(deps, cb)`：`deps` 含 `'settings'` 且 fake 服务表提供时才执行 `cb` 并收集其返回的 disposer；
  未提供 = 不执行（cordis 依赖缺失语义 → settings.ts 的「静默跳过」路径）；
- `effect(fn)`：执行并收集 disposer；
- fake settings 服务：`installSection(owner, ns, schema, entry, hooks)` 记录全部入参，调用
  `hooks.setSource(() => entry)`（模拟注册动态闭包）与 `hooks.onChange()`（模拟 attach 首次触发），
  返回 disposer（模拟 detach）。

**用例（3 组）**：
1. **无 settings 服务**：`apply(fakeCtx, {})` 不抛；日志含 `'applying (template state)'`；
   installSection 调用 0 次；disposers 为空（无残留注册）。
2. **注册面正确**：带 fake settings 时 installSection 恰 1 次；`ns === 'context-economy'`；
   `schema === Config`（同一引用，自 src/config.ts import）；`entry.discriminator.mode === 'off'`
   （resolveConfig 默认）；`hooks.setSource` 与 `hooks.onChange` 均为函数。
3. **卸载净**：跑完 apply 后依次执行收集到的全部 disposer——无异常；重复执行一遍亦无异常
   （容错余量）；再无新日志 error。

### 3.4 入口导出补齐（各 1 行）

- `src/index.ts`：+ `export { Config } from './config.ts'`（host 侧 interface + schema 同名双面一并带出）。
- `client/index.ts`：+ `export const name = '@dsh-external/dsh-context-economy'`（与 tsdown banner 的
  ModuleLoader load id 一致）。

### 3.5 `package.json` scripts（+2）

```json
"assert": "node scripts/assert-structure.mjs",
"gate": "npm run typecheck && npm run typecheck:client && npm test && npm run assert"
```

## 4. 实现要点（每步独立可验证；顺序执行）

1. **先修入口导出**（§3.4 两处）→ `npm run typecheck && npm run typecheck:client` 绿。
   先修复再写断言，M5 首跑即绿。
2. **写 `scripts/assert-structure.mjs`**（引擎 + RULES + CLI 按 §3.1）→
   `node scripts/assert-structure.mjs` 手动跑：M1–M5 全 PASS、S1 VACUOUS、S2–S5 PASS；
   `node scripts/assert-structure.mjs --json` 输出合法 JSON。
3. **加 package.json scripts**（§3.5）→ `npm run assert` 可用。
4. **写 `tests/assert-structure.spec.ts`**（§3.2 五组）→ `npm test` 绿（原 11 用例 + 新用例）。
5. **写 `tests/apply-smoke.spec.ts`**（§3.3 三组）→ `npm test` 绿。
6. **全链自验**：`npm run gate` exit 0；`DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0。
7. 对照 §5 清单逐条打勾，全部满足才进 §7。

## 5. 验收（全机械）

- [ ] `npm run gate` exit 0（= typecheck + typecheck:client + vitest + assert 四段全绿）
- [ ] `DSH_CHECKOUT=G:/deepseek-harness npm run build` exit 0
- [ ] `node scripts/assert-structure.mjs --json` 连跑两次输出逐字节一致（`diff` 为空）
- [ ] `node scripts/assert-structure.mjs` exit 0，输出含 10 条规则行、S1 标 VACUOUS
- [ ] `tests/assert-structure.spec.ts`：负样本用例 ≥10（每规则 ≥1，用例名含规则 id）、真实树集成、
       零位快照、确定性用例齐全（vitest 输出可见）
- [ ] `tests/apply-smoke.spec.ts`：3 组用例齐全且绿
- [ ] `git diff tests/field-model.spec.ts` 为空（既有断言零改动）
- [ ] `src/` 净增 ≤2 行（两处导出）；`scripts/assert-structure.mjs` ≤150 行（`wc -l`）
- [ ] 本单全部新增/改动文件零网络调用：`grep -rn "fetch(\|http.get\|axios" src/ scripts/assert-structure.mjs tests/` 无命中

## 6. 禁区与注意（总纲 §2 全文继承，此处只列本单特有）

1. **禁止弱化规则换绿**：负样本不过 → 修规则实现或修产品码，**不是**删负样本、放宽正则。
   断言面改动只许走「追加/激活」，存量规则语义冻结。
2. **assert 文本输出确定性**：禁时间戳、禁 ANSI 颜色、路径 `/` 分隔——win32 与 linux 双跑 diff 必须为空。
3. **断言代码不依赖 docs/**：`collectFiles` 排除 `docs/`，规则 check 不得读任何文档文件。
4. **术语防混淆**：`docs/ledger-history.md` 内出现的「P0」是 evalground 实验批次历史名，
   与本工单无关，勿据其推测范围。
5. **`dev_*` 命令边界**：`dev_self_test` 真机全链路（注入/重载/卸载净）属 dsh-super-injector
   （外部工具，不在 `G:/deepseek-harness`），**flash 不可自主执行也不可伪造其输出**；本单的
   apply 冒烟是其离线替身（fake ctx 验注册面与卸载净），不是替代——真机核验由用户择机执行并记账。
6. **环境**：schemastery/cordis 经 build.sh junction 进 node_modules；若 vitest/tsc 无法 resolve
   → 停工上报（环境链接缺失，不是代码问题，禁止 npm install 补装发布物）。
7. **停工上报触发器**：① M 族真实树 fail 且非本单预定修复（M5 两处）可解；② build.sh 零位失败；
   ③ 发现 manifest 与 11 §1 表正典矛盾；④ assert-structure.mjs 超 150 行且无法精简；
   ⑤ 任何未覆盖决策点。上报时给出证据（命令 + 输出 + file:line），不自行设计。

## 7. 完成动作

- commit（单笔，验收全绿后）：
  `feat(p0): 零位核对——manifest/结构断言骨架 + apply 冒烟 + 入口导出补齐（npm run assert/gate）`
- 账本快照：**本单不需要**（无机制改动，不产 docs/07 字段；R 门快照随 R1 出）。
- 上报事项（提交信息附言或 PR 描述）：R0 门真机余项 `dev_self_test` 待用户择机执行。

## 8. 对接面（P1–P21b 如何消费本单）

1. **规则 id 命名空间**：M（manifest）/ S（structure）已占用；D 预留给域规则（P6 改史端口起）。
   后续工单 = 在 `RULES` 追加规则 + 更新 §3.2 零位快照 + 补对应负/正样本用例，**引擎与 CLI 零改动**。
2. **`--json` schema 冻结**：`{ ok, rules: {id: {status, issueCount}}, vacuous: string[], issues: [{rule, path, line?, message}] }`
   （issues 按 rule id 再按 path 排序）。R 门验收（总纲 §4-3「npm run assert 全绿」）与账本工具以此为准。
3. **vacuous 演进协议**：P3 建 `src/core/` 后 S1 转 pass（零位快照随 P3 更新）；S3 在 P6 升级为
   SessionEventMap 声明合并的类型级测试（11 §9 原文即「类型级测试」，本单启发式 v1 只是先行占位）。
4. **P1 衔接**：P1（事件面接线）工单编写时按本单模式追加 D 族规则（如 H1 firehose 消费须异步旁路、
   waterfall 必须 `return next()` 的静态启发式），并复用本单 `npm run gate` 作为其验收第一行。
