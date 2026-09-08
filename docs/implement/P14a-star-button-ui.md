# P14a 星标按钮 UI（槽 + 预览）（映射 R2；依赖 P13；尺寸 M）

> 状态：**已施工（P14a 自动验收全绿；本单为下一未执行工单的计划稿已转为执行稿）**。前序：P13 命令面已施工；P11 星标断面纯核已施工。
> 本单交付 **client 半边星标入口与预览弹层**：在真实 conversation 槽位注册星标按钮，点击后调用
> 可替换的 `StarHostBridge` 获取断面预览，展示 diff 弹层，支持确认/编辑=终稿。**不实现任何 host 侧断面、
> 不写 KV、不发事实、不调 LLM**——这些归 P14b。
> 设计正典：[02 §4](../02-discriminator.md)（手动断面/预览确认/用户编辑即终稿）/
> [10 §1 H11](../10-wiring.md)（UI 槽与 host 方法）/
> [10 §4](../10-wiring.md)（时序 B：点星标→断面→预览→确认→回填）/
> [11 §2](../11-structure.md)（client 壳/星标按钮）/
> [11 §5](../11-structure.md)（星标按钮接线）/
> [13 §3.10](../13-harness-plugin-spec.md)（client 接口现状）/
> [P11 工单](P11-optimize.md) §8.1（预览 diff 消费 `OptimizeParseResult.product`）/ [P13 工单](P13-commands.md) §8.1（与 `/optimize-prompt` 共用委托点）。
> harness 核验源（均为本仓 checkout 实际源码，不是推测）：
> - `packages/client/ui-conversation/src/client/contract/slots.ts`：`conversation.input.right` / `conversation.session.header.actions` 槽声明；
> - `packages/client/ui-chat/src/client/apply.ts`：`conversation.view` 是整视图列表（chat/trajectory），不是按钮槽；
> - `packages/client/ui-plan/src/client/index.ts`：`conversation.input.plan` 单座注册示例；
> - `packages/client/ui-agent-preset/src/client/index.ts`：`conversation.session.header.actions` 注册示例；
> - `packages/client/ui-conversation/src/client/contract/input.ts`：`inputActions.setDraft(text)` 可用于确认后替换编辑器草稿。

## 0. 与文档的偏差修正（本次计划必须吸收）

1. **`docs/10 §1 H11` 写的 `conversation.view 星标按钮` 应修正为具体动作槽**：
   实际 harness 中 `conversation.view` 是“会话视图页签”列表（chat / trajectory），不是“放一个按钮”的槽；
   最贴近“星标按钮”的合成槽是 **`conversation.input.right`**（输入栏右侧工具区）或
   **`conversation.session.header.actions`**（会话头操作区）。本单选择 `conversation.input.right` 为主，
   因为它能直接读取当前草稿（`useInput().draft`），语义正是“优化当前 prompt”。
2. **P14a 的“mock host 方法契约”**：本单不猜测 P14b 的最终 remote 形态；本单定义稳定的
   `StarHostBridge` 接口并注入一个确定性 mock。P14b 实现真实 bridge 时只需替换该注入，不改 UI 组件。

## 1. 目标

在 client 半边注册星标按钮（`conversation.input.right`），点击后：
1. 读取当前会话和当前草稿；
2. 调用 `StarHostBridge.preview(sessionId, draft)` 获取结构化预览；
3. 在预览弹层中显示优化后 prompt 与原文 diff、权威段缺失警告、行式裁决摘要；
4. 用户可编辑产品文本；确认后调用 `StarHostBridge.apply(...)`；
5. apply 成功且返回 `ok` 后，用 `inputActions.setDraft(editedProduct)` 把编辑器草稿替换为终稿，关闭弹层；
6. 任何失败返回错误条并保持原草稿不变（fail-lazy）。

## 2. 输入

### 2.1 正典摘录（工单自足）

- **02 §4 五个出口**：A 优化后 prompt = 自由文本，预览 diff → 用户确认 → 原地替换；产品是可见可改的提示词，用户编辑即终稿。
- **02 §4 双通道输出契约**：产品通道任何文本都合法；最终把关 = 预览 diff + 用户确认。
- **10 §4 时序 B**：client 渲染 diff → 用户确认/编辑（= 终稿）→ 执行回填与落盘（P14b）。
- **11 §5**：星标按钮注册到 conversation 槽 → host 断面方法 → 预览 diff 弹层（复用壳的 popover/fixed 弹层基建）。
- **11 §1 client 铁律**：`inject=['slots'…]` + register 必带 name；操作用完整包名；UI 壳不变量保持。

### 2.2 现有文件

| 路径 | 相关导出/内容 | 本单动作 |
|---|---|---|
| `client/index.ts` | `apply(ctx)`、`inject=['slots',...]`、settings 卡注册 | **改**：注册 `conversation.input.right` 星标槽；挂 mock bridge |
| `client/controller.ts` | 设置卡 controller（纯逻辑/快照） | 复用其“纯逻辑 + 注入”分层思路；不修改 |
| `client/components/*` | CeButton/CeConfirm/CeTip/popover 等基建 | 复用，不修改 |
| `client/field-model.ts` | 配置字段模型 | 本单不新增配置项；不修改 |
| `client/mascot.ts` / `theme.ts` / `icons.tsx` | 主题与图标 | 可能复用主题 token 和现有图标；不新增必须资产 |
| `scripts/build.sh` | 干净 checkout 的依赖链接清单（当前未含 conversation/session client 包） | **改**：补 `@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-session` 链接，否则 type-only imports 在干净环境无法解析 |
| `tests/client-apply-smoke.spec.ts` | client apply 冒烟 | **扩展**：断言星标槽注册/卸载 |
| `tsconfig.client.json` | 包含 client 全部 TS | 新增文件自动纳入 |

### 2.3 决策点记录（执行者不得再自行裁量）

1. **槽位定稿**：`conversation.input.right`，`id='context-economy-star'`，`order=10`。
   如果真机验证发现该槽在目标页面不可见/不可用，则降级为 `conversation.session.header.actions`
   并在验收报告中记录；不得使用 `conversation.view`（整视图页签）。
2. **`StarHostBridge` 接口（P14a 冻结，P14b 实现）**：
   ```ts
   export interface StarPreviewData {
     previewId: string
     originalPrompt: string
     product: string | null
     verdicts: readonly StarVerdictView[]
     missingAuthority: ReadonlyArray<{ index: number; text: string }>
     droppedLines: number
     ctxTokens: number
     short: boolean
   }
   export interface StarVerdictView {
     kind: string
     summary: string
   }
   export type StarPreviewResult =
     | { ok: true; data: StarPreviewData }
     | { ok: false; code: string; message: string }
   export interface StarApplyRequest {
     previewId: string
     editedProduct: string
   }
   export type StarApplyResult =
     | { ok: true; text?: string }
     | { ok: false; code: string; message: string }
   export interface StarHostBridge {
     preview(sessionId: string, prompt: string): Promise<StarPreviewResult>
     apply(sessionId: string, request: StarApplyRequest): Promise<StarApplyResult>
   }
   ```
3. **mock bridge**：P14a 内置 `createMockStarBridge()`，返回确定性样例：
   - `product` = `"mock 优化后 prompt\n（P14a 预览占位，P14b 接入真实断面）"`；
   - `missingAuthority` = 从 `extractAuthorityCandidates` 的纯逻辑模拟；
   - `apply` 直接返回 `{ok:true}`；不允许 mock 访问 host/storage/LLM。
4. **diff 算法**：实现轻量行级 diff（纯函数），不做完整 LCS 依赖；输出结构化行数组：
   `{type:'same'|'add'|'del', text}`。删除 = 原文独有，新增 = 产品独有。
5. **确认即终稿**：用户点击“应用”时传 `editedProduct`；若用户未编辑，传 `product ?? originalPrompt`。
   关闭/取消不调用 apply，不修改草稿。
6. **不新增配置**：星标通道常在，不受 `discriminator.auto` 门控；本单不新增 Config/field-model 项。
7. **不写事实**：本单 zero `context-economy/*` 字面量；`optimize-run` 由 P14b 发射。
8. **client 壳不变量**：不修改 `client/Card.tsx`、`client/controller.ts`、`client/field-model.ts` 的既有导出契约；
   新增星标组件独立文件。

## 3. 产出

### 3.1 `client/star/star-types.ts`（新，≤120 行）

上述 `StarHostBridge` / `StarPreviewData` / `StarApplyRequest` 等类型与行级 diff 类型。

### 3.2 `client/star/star-model.ts`（新，≤200 行；纯函数，零 React）

- `diffLines(original: string, product: string): DiffLine[]`
- `parseMockPreview(input: string): StarPreviewData`
- `clampPreviewText(text: string, maxChars?: number): string`
- `summaryOfVerdicts(verdicts: readonly StarVerdictView[]): string`
- 全部纯函数、确定性输出；可单测。

### 3.3 `client/star/star-bridge.ts`（新，≤100 行）

- `createMockStarBridge(now?: () => number): StarHostBridge`
- 仅返回内存 mock，不 import host 侧文件、不 import `src/`。

### 3.4 `client/star/StarButton.tsx`（新，≤260 行；React 组件）

- 使用 `PropsRuntime<'conversation.input.right'>` + `InjectFace<StarButtonInjected>`；
- 从 `useInput` 读取当前草稿和 `inputActions`；
- 按钮仅在当前会话存在且草稿非空时启用；
- 点击后进入 `loading`，展示禁用/转圈；调用 `star.preview`；
- 成功后打开预览弹层（复用 `client/components/popover.ts` 或固定浮层）；
- 弹层内含：diff 视图、缺失权威段警告、行式裁决摘要、可编辑 textarea；
- 确认按钮调用 `star.apply`，成功后 `inputActions.setDraft(editedProduct)`，关闭并提示；
- 失败显示错误条，不关闭原草稿，不调用 setDraft。

### 3.5 `client/index.ts`（改，净增 ≤60 行）

- 增加 type-only imports：
  - `import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'`
  - `import type {} from '@deepseek-ai/dsh-client-ui-session/client'`
  - `import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'`
  - `import type { SessionId } from '@deepseek-ai/dsh-session/types'`
  - 以及 star 组件/类型。
- 在 `apply(ctx)` 内创建 `const starBridge = createMockStarBridge()`；
- 增加星标槽注册：
  ```ts
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'context-economy-star',
    order: 10,
    inject: (sessionId: SessionId) => ({
      star: starBridge,
    }),
  }, StarButton))
  ```
- 保持现有 settings 卡注册不变；`ctx.effect` 生命周期保持。

### 3.6 `tests/star-model.spec.ts`（新，≤220 行）

- `diffLines`：纯新增/纯删除/相同/空输入；
- `createMockStarBridge`：preview 返回 ok、含有 deterministic previewId；apply 返回 ok；
- 状态汇总 `summaryOfVerdicts`；
- 不 import React/运行时。

### 3.7 `tests/client-apply-smoke.spec.ts`（改）

- 断言 `slotsCalls` 现在包括 `'settings.plugin.item'` 与 `'conversation.input.right'`；
- 断言星标槽 registration `id='context-economy-star'`、`order=10`、组件为函数；
- 断言卸载时无异常。

### 3.8 `scripts/verify-p14a.mjs`（新，≤160 行）

0. 构建依赖检查：`scripts/build.sh` 含 `dsh-client-ui-conversation` 与 `dsh-client-ui-session` 链接行；
1. 前序基线 grep：`client/index.ts` 有 `conversation.input.right`、`StarButton`；
2. `npm run typecheck:client`；
3. `npm run typecheck`；
4. `npm test`（一次完整）；
5. `npm run assert`；
6. 反向扫描：`client/star/*` 不得出现
   `from '../src/`、`from '../../src/`、`emitCeFact`、`context-economy/`、
   `streamCeLlm`、`putEntity`、`@deepseek-ai/dsh-storage`、`session.append`；
7. `DSH_CHECKOUT=G:/deepseek-harness npm run build`（缺失 checkout 则记录 SKIP）；
8. 打印 `P14a VERIFY PASS` 或失败清单，exit 0/1。

## 4. 实现要点（顺序执行）

0. 补 `scripts/build.sh`：增加 `@deepseek-ai/dsh-client-ui-conversation` 与 `@deepseek-ai/dsh-client-ui-session` 两个 client type-only 包的链接（仅构建/类型依赖，不新增运行时 peerDep）。
1. 建 `client/star/star-types.ts` + `star-model.ts` → `npm run typecheck:client` 绿。
2. 建 `client/star/star-bridge.ts`（mock）→ `npm run typecheck:client` 绿。
3. 建 `client/star/StarButton.tsx` → `npm run typecheck:client` 绿。
4. 改 `client/index.ts` 注册槽 + mock bridge → `npm run typecheck:client` 绿；
   `npm run test -- tests/client-apply-smoke.spec.ts` 绿。
5. 写 `tests/star-model.spec.ts` → `npm test` 绿。
6. 写 `scripts/verify-p14a.mjs` → `node scripts/verify-p14a.mjs` PASS。
7. 真机（如可用）：`dev_build_plugin` / `dev_inject_plugin` 后在浏览器确认按钮出现、mock 弹层可开可关；
   不可用则 SKIP 并在汇报中说明。

## 5. 验收（全机械 + agent 自动化）

- [ ] `node scripts/verify-p14a.mjs` 输出 `P14a VERIFY PASS`
- [ ] `npm run typecheck:client` exit 0
- [ ] `npm run typecheck` exit 0
- [ ] `npm test` exit 0（含 `tests/star-model.spec.ts` 与 client-apply-smoke 扩展）
- [ ] `npm run assert` exit 0
- [ ] `scripts/build.sh` 已包含两个新增 client type-only 包链接（grep 断言）
- [ ] `grep -n "context-economy/" client/star/*` 无命中
- [ ] `grep -n "emitCeFact\|streamCeLlm\|putEntity" client/star/*` 无命中
- [ ] `grep -n "conversation.view" client/index.ts` 无新增星标注册（仅允许设置卡引用；若存在说明实现走错槽）
- [ ] `git diff --numstat -- client/index.ts` 净增 ≤60
- [ ] 行数预算：`client/star/star-types.ts ≤120`、`star-model.ts ≤200`、
      `star-bridge.ts ≤100`、`StarButton.tsx ≤260`、`scripts/verify-p14a.mjs ≤160`

## 6. 禁区与注意

1. **不实现 host 逻辑**：client 不得直接 import `src/`、不得写 storage、不得调 LLM。
2. **不修改设置卡壳**：`Card.tsx`/`controller.ts`/`field-model.ts` 的公共契约不因本单变化。
3. **不新增配置项**：星标常在。
4. **不发射事实**：禁止在 client 侧出现 `context-economy/*` 字面量。
5. **fail-lazy**：预览或应用失败只显示错误，绝不改写用户草稿。
6. **停报触发器**：若 `conversation.input.right` 的 `PropsRuntime`/`inject` 签名与工单不符，
   以 harness 源码为准停工上报；不得自行改 harness 槽声明。

## 7. 完成动作

- commit（验收全绿后）：
  `feat(p14a): 星标按钮 UI——conversation.input.right 槽 + 预览 diff 弹层 + StarHostBridge mock 契约`
- 账本快照：**本单不需要**（P14b 端到端后随 R2 出 07 快照）。
- 汇报（**本单最后一步，执行者必须完成**）：按 §9 报告。

## 8. 对接面与后续计划修正

### 8.1 对接面

| 后续工单 | 消费方式 |
|---|---|
| P14b | 实现 `StarHostBridge` 的真实版，替换 `createMockStarBridge()`；UI 组件/类型不变 |
| P13 `/optimize-prompt` | 与星标共用同一 host flow；P14b 实现 `manualOptimize` 后命令入口自动可用 |
| P11 断面纯核 | 预览数据形状与 P11 的 `product`/`missingAuthority` 对齐 |
| P21b 全链验收 | 客户端星标端到端作为 R2 出门验收的一部分 |

### 8.2 对后续计划的修正

| 计划 | 原表述 | 修正 |
|---|---|---|
| docs/10 §1 H11 | `conversation.view 星标按钮` | **改为 `conversation.input.right 星标按钮`**（若采用 header 则写 header actions）；P14a 完成时回写 docs/10 |
| P14b | “星标 host 方法” | 本单冻结 `StarHostBridge`；P14b 应提供该 bridge 的真实实现。**修正（P14b1 §0.1）：暴露面 = Connection 通用 RPC 通道 `/context-economy`（端点 `star.preview`/`star.apply`），否决 custom Typert Remote contribution**（依据：host SRC fallback 依赖编译后形参名 + client 强制 strict codec） |
| P13 | `/optimize-prompt` 入口 | 已注册；P14b 只需传入 `manualOptimize`，不重复注册 |

## 9. 汇报模板（本单最后一步）

执行者全绿后向用户报告：
1. 修改文件与净增行数（`client/index.ts` 明确）；
2. 功能：槽位、按钮、预览弹层、mock bridge、diff 模型、client 冒烟；
3. 文档对应表：按钮↔docs/10 §4；预览↔docs/02 §4；mock 契约↔本单 §2.3；
4. 后续修正：docs/10 H11 槽位纠正、P14b bridge 替换点是否落笔。
