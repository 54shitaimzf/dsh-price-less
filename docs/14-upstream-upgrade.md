# 14 · 上游升级 runbook（harness 版本切换）

> 本文件回答一个问题：**上游发新版本时，要动哪些地方、怎么验、怎么退。**
> 配套：基线裁定见 [`implement/REPAIR-2026-09-10.md §8.1`](implement/REPAIR-2026-09-10.md)；
> 不可锚的 cast 与上游弃用面台账见 [`legacy.md §14`](legacy.md)。

## 1. 现行基线（2026-09-10 用户裁定）

**基线 = B+**：上游 `origin/master` @ `c291e7961a`（**0.1.5-rc.2**）**+ 重放本仓的 ignorable 补丁**。

| | A（历史） | B（原计划） | **B+（现状）** |
|---|---|---|---|
| harness | `feat/ignorable-logintent-alpha2` @ `2fa55bc741`（base tag `dsh-v0.1.3-alpha.2`） | `origin/master` vanilla | `origin/master` **+ 补丁重放** |
| 事实轨真源 | 会话 JSONL | ❌ KV 镜像（降级） | ✅ **会话 JSONL**（保住） |
| 会话格式 | v2 | v3 | v3 |
| 跟主线 | ❌ 每次升级重放补丁 | ✅ | ✅ |

**分支**：`bplus-0.1.5` @ `f0dc41471c` = `c291e7961a`（0.1.5-rc.2）
+ `8ff0bceeae`（ignorable 补丁重放） + `f0dc41471c`（catalog 重生成）。

> **为什么加补丁是划算的**：补丁很小（原提交 6 文件 `+141/-8`），但少了它事实轨只剩 KV 镜像，
> 且**跨域实时消费断线**（[`docs/12 §3`](12-platform-capabilities.md)）。重放实测只冲突 2 处，
> 且其中 1 处是生成物（重跑即好）。

---

## 2. 升级步骤（可复现）

### 2.1 在 harness 侧造出新基线

```powershell
cd G:\deepseek-harness
git fetch origin
git worktree add -b bplus-<版本> G:\dsh-bplus-wt origin/master
cd G:\dsh-bplus-wt
git cherry-pick <ignorable 补丁 commit>      # 本次 = 2fa55bc741
# —— 冲突处理（实测只有这两处）——
#  ① packages/core/session/src/index.ts  = 导入行：取 HEAD 的导入 **并入** 补丁新增的
#     `IgnorableSessionEventMap, LogIntent` 类型 与 `isSurfaceEligibleType` 值导入。
#  ② docs/persistence-catalog.md         = 生成物：先随便取一侧，随后重跑生成脚本。
git commit --no-verify -C <补丁 commit>       # lefthook 在无 node_modules 时会拦，故 --no-verify
pnpm install --prefer-offline
pnpm run gen-persistence-catalog              # ②的正解：重生成（行号因新增类型而位移）
pnpm run verify-persistence-catalog
pnpm run build:lib                            # host + client
pnpm exec vitest run packages/core/session     # 本次读数：15 文件 / 504 用例全绿
```

### 2.2 把插件对准新基线

```powershell
cd D:\deepseek-plugin
$env:DSH_CHECKOUT='G:/dsh-bplus-wt'           # 或升级完成后的 G:/deepseek-harness
& 'C:\Program Files\Git\bin\bash.exe' scripts/build.sh   # 重链 node_modules junction + 编译 lib
npm run gate ; npm run typecheck:tests
```

> Windows 上 `bash` 解析到 `C:\Windows\system32\bash.exe`（WSL），`npm run build` 会挂在
> `set: pipefail`。要么用上面的 Git Bash 显式调用，要么
> `npm config set script-shell "C:\Program Files\Git\bin\bash.exe"`。

### 2.3 切换与重启

见 §5 的 `scripts/promote-bplus.ps1`。**必须**：先 promote（切 checkout + 重链 + 重编译），
再清数据，最后重启宿主——顺序错了会拿到「插件 = 新基线、宿主 = 旧基线」的错配。

---

## 3. 已知接触面清单（每次升级逐条核）

改版本时按此表走一遍；**新发现的接触面必须补进本表**，否则下次升级还会踩。

| # | 接触面 | 单一事实源 | 漂移如何暴露 |
|---|---|---|---|
| 1 | replace `surfaceOp` 端点键名 | `src/core/ledger/types.ts` `REPLACE_OP_ENDPOINT_KEYS` | `platform/history.ts` 的 `ReplaceOpAnchor`/`...Back` **编译期红** + `tests/history-real-session.spec.ts`（真校验器）+ `tests/history.spec.ts` 的字面钉 |
| 2 | 会话格式版本 / `system/message` 占 surface 节点 0 | 上游 `SESSION_FORMAT_VERSION` | `tests/history-real-session.spec.ts` 的 HC5 用例（区间起点 > 系统节点 + 反证 harness 会拒） |
| 3 | 同步历史读（`snapshotEvents`/`eventAt`/`ownEvents`） | `platform/events.ts: readSessionEvents` | 上游 `@deprecated` 只红 lint 不红 typecheck——**台账见 `legacy.md §14`** |
| 4 | ignorable 写入通道（补丁） | `platform/ignorable-channel.ts` 的 `SESSION_LOG_INTENT` 探测 | 探测为 false → 事实轨降级（KV 镜像）；`tests/ignorable-channel.spec.ts` + 冒烟 `emitted` 断言 |
| 5 | 子分发事件族 | 上游 `tool/code-dispatch-start` **与** `tool/ptc-dispatch-start` | `core/assemble/ledger.ts` 的 `DISPATCH_START_TYPES`（两族都认）；见 `legacy.md §15` |
| 6 | `peerDependencies` 版本范围 | `package.json` | semver 预发布规则：范围必须显式覆盖宿主元组（现 `>=0.1.3-alpha.1 <2 \|\| >=0.1.5-alpha.0 <2`） |
| 7 | `platform/star-bridge.ts` 的源码深路径导入 | 上游 `@deepseek-ai/dsh-client-connection/src/rpc.ts` | 上游挪文件即断（本次未踩雷）；下次升级**优先核这条** |
| 8 | 测试替身对线格式的解读 | `tests/replace-op.ts`（`expectedReplaceOp` / `replaceEndpoints`） | 2026-09-10 实测：**6 处替身**各自硬编码 `start`/`end`，基线一换全部静默失效（表面不收敛），失败伪装成别的原因。已全部收口到该助手——**新写替身必须复用它** |

---

## 4. 验收清单

1. `npm run gate` 退出 0（typecheck + typecheck:client + vitest + assert `ok=true vacuous=[]`）；
2. `npm run typecheck:tests` 退出 0（词汇派生与编译闸的类型级守门）；
3. `& bash scripts/build.sh` 退出 0；
4. **lib 级冒烟**（跑在构建产物上，非 src）——五项，缺一不可：
   - `SESSION_LOG_INTENT === 1`（补丁生效）与 `SESSION_FORMAT_VERSION` 符合预期；
   - `REPLACE_OP_KEYS` 与 harness 权威形状一致、且读写两侧是**同一常量对象**；
   - 真 `SessionStore` 接受一次 replace，且 `system/message` 头节点存活；
   - `foldSurfaceNodes` 对**新端点名**正确遮蔽（旧实现会静默返回未遮蔽序列）；
   - 通道可用 → `emitted` 且 append 带 `{ignorable:true}`；通道缺失 + 镜像 + 回灌 → facts 面到达。
5. harness 侧：`pnpm exec vitest run packages/core/session` 全绿（补丁自带的 5 条用例在内）；
6. 真机：冒烟清单见 [`implement/REPAIR-2026-09-10.md §5.3`](implement/REPAIR-2026-09-10.md)。

---

## 5. 切换与回滚

`scripts/promote-bplus.ps1` 做三件事（幂等）：移除临时 worktree → 把 `bplus-0.1.5` 切到主 checkout
→ `pnpm install` + `build:lib` + 重链插件 + 重编译插件。**它不碰你的会话数据，也不重启宿主。**

```powershell
# 切换
pwsh -File D:\deepseek-plugin\scripts\promote-bplus.ps1
# 之后：清空/挪走 ~/.dsh/sessions 与 ~/.dsh/storages（v2 → v3，用户自决）；然后重启 dsh web

# 回滚
cd G:\deepseek-harness
git checkout feat/ignorable-logintent-alpha2
pnpm install ; pnpm run build:lib
cd D:\deepseek-plugin
$env:DSH_CHECKOUT='G:/deepseek-harness'
& 'C:\Program Files\Git\bin\bash.exe' scripts/build.sh
cd G:\deepseek-harness ; git checkout bplus-0.1.5   # 想再切回来
```

> ⚠️ **回滚不完整**：插件源码的端点常量已按 B+ 写死（`startSeq`/`endSeq`）。回滚到 A 需要把
> `core/ledger/types.ts` 的常量改回 `{ start: 'start', end: 'end' }`——`ReplaceOpAnchor` 会红着
> 告诉你这件事，这就是该锚的设计意图。**A 不再是受支持基线。**
