# P14b2 星标真实桥 + 时序 B 端到端（映射 R2；依赖 P14b1；尺寸 M）

> 状态：**计划稿（P14b1 的下一条）**。前序：P14a client 星标 UI（`createMockStarBridge()`）、P14b1 host 断面服务
> + Connection RPC 桥端口（channel `/context-economy`，端点 `star.preview`/`star.apply`）。
> 本单交付 **client 真实桥**（`ctx.connection.rpc.call` → P14b1 端口）+ **时序 B 端到端**
> （预览 → 用户确认/编辑 → 回填落盘）+ 真机冒烟 + R2 出门验收。
> **前置契约冻结**：本单不重新设计传输/信封/DTO——一切以 [P14b1 §3.1](P14b1-star-host-service.md) 为准；
> 若 P14b1 实施时按停工上报改了契约，本单以 P14b1 的**验收记录 + 端口常量**为唯一真源，只改契约测试，不改设计。
> 设计正典：[10 §4](../10-wiring.md)（时序 B 端到端）/ [02 §4](../02-discriminator.md)（用户确认即终稿）/
> [11 §5](../11-structure.md)（星标按钮接线）/ [13 §3.10](../13-harness-plugin-spec.md)（client 接口现状）/
> [13 §3.11](../13-harness-plugin-spec.md)（P14b1 新建的 Connection RPC 桥）。
> harness 核验源（逐条已 grep 到定义处；找不到 = 停工上报）：
> - `packages/client/connection/src/client/rpc.ts:31-71`：`createWebConnectionRpc.call(channel, endpoint, payload, signal)`——POST `${channel}/${endpoint}`，RPC 信封自带 rpcId 校验，返回 `ConnectionRpcResult`；
> - `packages/client/connection/src/client/rpc.ts:12-13`：channel `^\/[A-Za-z0-9._~-]+$` / endpoint `^[A-Za-z0-9_$.-]+$`；
> - `packages/client/connection/src/client/index.ts:112-125`：`ConnectionHandle.rpc: ClientConnectionRpc`（**注意：client Context 无 `connection` 属性合并**，须 `ctx.get('connection')` 取用）；
> - `packages/api/remotes/src/client/index.ts:58-63`：`ConnectionHandle` 的 type-only 再导出（本插件已链接该包，**无需新增构建链接**）；
> - `packages/client/ui-conversation/src/client/contract/input.ts`：`InputActions.setDraft(text)`（确认后替换草稿；P14a 已用）。

## 0. 与文档的偏差修正（本单必须吸收）

1. **client 取 connection 服务的方式**：client 侧 `Context` 没有 `connection` 属性合并（只有 `connection/reset` 事件合并）。
   实现必须用 `ctx.get('connection') as ConnectionHandle | undefined`（官方 gateway client 同款写法：
   `packages/api/gateway/src/client/index.ts:155,225`），并在 `undefined` 时返回 `CE_STAR_UNAVAILABLE`。
2. **常量重复声明 + 契约测试**：client 不得 import `src/`（S4）。channel/端点常量在
   `client/star/star-protocol.ts` 独立声明，由 `tests/star-transport.spec.ts` 断言与
   `src/platform/star-bridge.ts` **逐字相等**（这是两侧协议不漂移的机械证明）。
3. **mock 保留**：`createMockStarBridge()` 保留为测试资产（`tests/star-model.spec.ts` 继续用）；
   运行期 `client/index.ts` 改用 `createHostStarBridge(ctx)`。
4. **主环境挂载**：插件当前**未挂载**（2026-09-08 审查结论）。真机冒烟分两级：
   ① 隔离 home 自动冒烟（必做，零用户环境影响）；② 主 profile 挂载 + 浏览器点击（用户在场时做，属 R2 出门的人工确认项）。

## 1. 目标

把 P14a 冻结的 `StarHostBridge` 接到 P14b1 的真实端口上，使浏览器里的星标按钮走完整时序 B：
读草稿 → `star.preview` → 弹层 diff → 用户编辑/确认 → `star.apply` → 卷宗回填 + 产物落盘 + 两相事实
→ `inputActions.setDraft(editedProduct)`（终稿）。任何失败只显示错误条、**绝不动草稿**。

## 2. 输入

### 2.1 现有文件

| 路径 | 本单动作 |
|---|---|
| `client/star/star-types.ts` | 只读（`StarHostBridge`/`StarPreviewData`/`StarApplyRequest` 已冻结） |
| `client/star/star-bridge.ts` | **改**：新增 `createHostStarBridge(ctx)`；保留 `createMockStarBridge` |
| `client/star/star-model.ts` | 只读（`diffLines`/`summaryOfVerdicts`/`clampPreviewText`） |
| `client/star/StarButton.tsx` | 只读（UI 不因本单变化） |
| `client/index.ts` | **改**：mock → host bridge（≤6 行净增） |
| `src/platform/star-bridge.ts` | 只读（常量/信封真源） |
| `tests/client-apply-smoke.spec.ts` | **改**：断言注入的是 host bridge（不再是 mock），且无 connection 时预览返回 `CE_STAR_UNAVAILABLE` |
| `scripts/verify-p14a.mjs` | 只读（P14b2 不回改历史工单脚本） |

### 2.2 决策点（执行者不得再自行裁量）

1. **client 桥的失败映射**：transport `ok:false` → 原样透传 `code`/`message`；`call` 抛出（404/网络/auth）→
   `CE_STAR_UNAVAILABLE`；`ok:true` 但 value 形状非法 → `CE_STAR_BAD_REQUEST`（**绝不把非法值当预览渲染**）。
2. **不重试、不轮询、不缓存**：一次点击一次调用；预览态只活在弹层组件的 state 里。
3. **草稿只在 apply ok 后替换**（P14a 已实现，本单不改该分支）。
4. **预览弹层的 short 提示**：`short===true` 时产品区显示"卷宗过短，本次仅回填裁决"（文本常量在 `star-protocol.ts`）。

## 3. 产出

### 3.1 `client/star/star-protocol.ts`（新，≤70 行；纯常量 + 纯校验）

```ts
export const STAR_BRIDGE_CHANNEL = '/context-economy'
export const STAR_PREVIEW_ENDPOINT = 'star.preview'
export const STAR_APPLY_ENDPOINT = 'star.apply'
export const STAR_CLIENT_CODES = { unavailable: 'CE_STAR_UNAVAILABLE', badValue: 'CE_STAR_BAD_REQUEST' } as const
export const STAR_SHORT_NOTICE = '卷宗过短，本次仅回填裁决'
export function isStarPreviewData(value: unknown): value is StarPreviewData
export function isStarApplyValue(value: unknown): value is { text?: string }
```

形状校验逐字段（`previewId`/`originalPrompt` 字符串，`product` 字符串或 null，`verdicts`/`missingAuthority` 数组且元素字段类型正确，
`droppedLines`/`ctxTokens` 有限数，`short` 布尔）——**不接受多余字段推断，缺失必填字段即失败**。

### 3.2 `client/star/star-bridge.ts`（改，净增 ≤90 行）

```ts
export function createHostStarBridge(ctx: Pick<ClientContext, 'get'>): StarHostBridge
```

- `preview(sessionId, prompt)`：`connection()` → `rpc.call(STAR_BRIDGE_CHANNEL, STAR_PREVIEW_ENDPOINT, { sessionId, prompt })`；
- `apply(sessionId, request)`：`rpc.call(..., STAR_APPLY_ENDPOINT, { sessionId, previewId: request.previewId, editedProduct: request.editedProduct })`；
- `connection()` 每次调用时读取（`ctx.get('connection') as ConnectionHandle | undefined`），**不在构造期快照**——
  连接重置/服务迟到都不影响；`undefined` → `{ ok:false, code: STAR_CLIENT_CODES.unavailable, ... }`；
- 全部 `try/catch`，异常不外溢（`StarHostBridge` 的契约是返回结果，不是抛错）。

### 3.3 `client/index.ts`（改）

`const starBridge = createMockStarBridge()` → `const starBridge = createHostStarBridge(ctx)`；
槽注册其余部分零改动。

### 3.4 `tests/star-transport.spec.ts`（新，≤260 行；两侧同测）

1. **契约等价**：host 端口常量 === client 协议常量（channel/两个端点逐字相等）；
   host `StarPreviewDto` 的键集合 === client `StarPreviewData` 的键集合（运行时样例对象 + 键排序断言）；
2. **端到端（进程内）**：fake connection 捕获 host handler → 用 client `createHostStarBridge` 对着
   fake `ctx.get('connection')` 的 `rpc.call` 调 → 断言 payload 键名与值、返回 DTO 经 `isStarPreviewData` 通过；
3. **失败映射**：`call` 抛错 → `CE_STAR_UNAVAILABLE`；`ok:false` 原样透传；`ok:true` + 非法 value → `CE_STAR_BAD_REQUEST`；
4. **无 connection**：`ctx.get` 返回 `undefined` → 两个方法都返回 `CE_STAR_UNAVAILABLE`，不抛；
5. **host 端口**：未知端点 → `CE_STAR_UNKNOWN_ENDPOINT`；payload 缺字段 → `CE_STAR_BAD_REQUEST`；handler 抛错 → `CE_STAR_INTERNAL`；disposer 调用后再次调用抛错/不再分派。

### 3.5 `tests/client-apply-smoke.spec.ts`（改）

- 断言 `conversation.input.right` 的 `inject()` 返回的 `star` 是 host bridge（`preview` 在无 connection 时返回 `CE_STAR_UNAVAILABLE`）；
- 保持既有卸载/槽位断言不变。

### 3.6 `scripts/verify-p14b2.mjs`（新，≤170 行）

0. 前序门：`lib/platform/star-bridge.js` 与 `lib/domains/star.js` 存在（P14b1 已构建）；
1. 契约 grep：client 协议常量三值 + host 端口常量三值（同一脚本内比对）；
2. 反向扫描：`client/star/*` 不得出现 `from '../src/`、`context-economy/` 字面事件名、`emitCeFact`、`putEntity`、`session.append`、`streamCeLlm`、`@deepseek-ai/dsh-client-connection`；
3. `npm run gate` + `npm run typecheck:tests`；
4. build（Git bash 优先，同 P14b1 §3.7-5）；
5. **隔离 home 自动冒烟**：`DSH_HOME=<临时目录>` + `dsh plugin --profile web add D:/deepseek-plugin` +
   `dsh --profile web --dump-config`（断言含 `dsh-price-less` 行）+ `dsh web --profile web --port 0 --no-open`
   （后台起、读启动日志确认插件 `applying`/`config updated`、curl `/context-economy/star.preview` 得到 401/403 或 JSON 错误信封、退出、删临时目录）；
6. 行数/净增预算；
7. 打印 `P14b2 VERIFY PASS`。

### 3.7 文档回写（§8.2）+ R2 出门验收

- `docs/ledger-history.md` 追记 **§32 账本快照：R2 判别域段末**（只增不改）：断面族字段（`optimizePromptTokens`/
  `verdictBackfill{count,conflicts}`/`shearAtStar`）+ 判别族字段（`judgeCount`/`tableHitRate`/`judgeErrorRate`）
  的回放口径与本次真机/隔离冒烟读数；数据源 = `optimize-run` 两相事实 + 既有 judge 事实。
- `docs/11 §8 R2 行`出门门槛逐条核对表（边界 F1 / 判别成本 / tableHitRate / `optimizePromptTokens` 入账 /
  `auto` 开关可用（默认关）/ 星标端到端）——逐条给"证据 = 命令/文件/日志行"。

## 4. 实现要点（顺序执行）

1. 建 `client/star/star-protocol.ts` → `npm run typecheck:client` 绿。
2. 改 `client/star/star-bridge.ts` → `npm run typecheck:client` 绿。
3. 改 `client/index.ts` → `npm run typecheck:client` + `npm test -- tests/client-apply-smoke.spec.ts` 绿。
4. 写 `tests/star-transport.spec.ts` → `npm test` + `npm run typecheck:tests` 绿。
5. 写 `scripts/verify-p14b2.mjs` → PASS。
6. 隔离 home 冒烟（§3.6-5）→ 记录日志行。
7. 真机冒烟（用户在场）：主 profile 挂载（`dsh plugin --profile web add D:/deepseek-plugin`，**改动用户环境前须经用户确认**）
   → 重启 DSH（lib 变更需重启，HMR 不含 host 半边）→ 浏览器点星标 → 预览 → 编辑 → 应用 → 草稿替换；
   → `grep 'optimize-run' <session>.jsonl` 见两相；→ `/optimize-prompt` 返回产品文本；
   → 回写 `docs/ledger-history.md` §32。
8. 跑完整 `node scripts/verify-p14b2.mjs` + `npm run gate` 收尾。

## 5. 验收（全机械 + 一条人工确认）

- [ ] `node scripts/verify-p14b2.mjs` 输出 `P14b2 VERIFY PASS`
- [ ] `npm run gate` exit 0；`npm run typecheck:tests` exit 0
- [ ] `npm test` exit 0（含 `tests/star-transport.spec.ts` 与 smoke 扩展）
- [ ] 契约等价断言绿：host/client 常量逐字相等、DTO 键集合相等
- [ ] `grep -n "createMockStarBridge" client/index.ts` 无命中；`grep -n "createHostStarBridge" client/index.ts` 命中
- [ ] `grep -n "context-economy/\|emitCeFact\|putEntity\|session.append\|streamCeLlm" client/star/*` 无命中
- [ ] 隔离 home 冒烟日志含 `dsh-price-less` 组合树行 + 插件 `applying` 行；临时 home 已删除
- [ ] 主环境真机点击一次走通（用户在场确认）；会话 JSONL 含同 `previewId` 的 preview/applied 两条 `optimize-run`
- [ ] `docs/ledger-history.md` §32 已追记；`docs/11 §8 R2` 逐条核对表已出
- [ ] 行数预算：`star-protocol.ts ≤70`、`star-bridge.ts` 净增 ≤90、`tests/star-transport.spec.ts ≤260`、`verify-p14b2.mjs ≤170`

## 6. 禁区与注意

1. **不改 host 半边**：`src/**` 本单零 diff（除 P14b1 已交付者）。
2. **不新增运行时依赖**：client 侧不得 import `@deepseek-ai/dsh-client-connection`（用 `dsh-api-remotes/client` 的 type-only 再导出）。
3. **不动 UI 壳**：`StarButton.tsx`/`star-model.ts`/`star-types.ts` 零改动。
4. **失败默认保留**：任何错误分支不得调用 `setDraft`。
5. **主环境变更需用户确认**：挂载插件到主 profile 属用户环境改动，须先问（审批提示已禁用，不得自行升级权限）。
6. **停报触发器**：`ctx.get('connection')` 取不到服务而隔离 home 冒烟又证明 host 端口已注册 → 停工上报（可能是装配层级/isolate 问题），不得绕过。

## 7. 完成动作

- commit：`feat(p14b2): 星标真实桥——Connection RPC 端到端 + 时序 B 回填 + R2 出门验收`
- 账本快照：**需要**（`docs/ledger-history.md` §32，R2 段末；回放管道产出）。
- 汇报：按 §9。

## 8. 对接面与后续计划修正

### 8.1 对接面

| 后续 | 消费方式 |
|---|---|
| R3 P15a/P15b | `optimize_artifact.shear` 是剪切清单真源；`optimize-run(applied).shearPairs/shearTokens` 是账本起点 |
| P21b 全链验收 | 星标端到端 = R2 已验；P21b 复用 `foldOptimizeRunFacts` 做四族回放 |
| 上游 ignorable 合并 | 与星标桥无关（桥走官方 connection），删除清单见 docs/12 §2 |

### 8.2 对后续计划的修正（**本单完成时回写**）

| 文档 | 修正 |
|---|---|
| docs/11 §9 状态行 | "P14b2 待接真实桥" → "R2 判别域完成（P14a/P14b1/P14b2）"；下一段 = R3 剪切域 |
| docs/11 §5 星标按钮行 | 补注：真实桥 = Connection RPC `/context-economy` |
| docs/13 §3.10.7 | 当前插件 client 现状：host bridge 已接（`createHostStarBridge`），mock 仅测试用 |
| docs/13 §5 落位表 | `client/star/star-protocol.ts` / `client/star/star-bridge.ts` 行状态更新 |
| 00-master §3 | P14b1/P14b2 行标"已施工"；R2 段末追记 |
| docs/ledger-history.md | 新增 §32（只增不改） |

## 9. 汇报模板（本单最后一步）

1. 修改文件与净增行数；
2. 功能：真实桥（取服务方式/失败映射/形状校验）、契约测试、隔离 home 冒烟读数、真机点击结果；
3. 文档对应表：桥↔docs/13 §3.11；端到端↔docs/10 §4；终稿语义↔docs/02 §4；
4. R2 出门逐条核对结论 + §32 快照编号 + 下一段（R3）入口条件。
