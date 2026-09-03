# 真实压缩器产出（真实网关 hy3 · 2026-09-02T20:36:23.306Z）

- 数据面：真实短流程 `tests/fixtures/template-battery`（auth.js 修复 + 测试运行 + 一次 60KB 大读取）
- 压缩器读到的原始工作 ≈ 1811 字符；区域（runner 口径，工具结果截 12000）≈ **3336 token**（子流聚类 4 个）；门：minRegion=3000 → 压缩比门 ACTIVE（真实评估）

---
## S2 × 方案0（keep-original：refs 只留坐标指针）

### ① 模型写的程序（PTC：一次调用，模型只写代码不调工具）

```js
// A1-S2 闭合即全压 — no retain
const s = await tools.probe_substructure({ taskRef: "task" })
const subtasks = []
for (const sub of s.subtasks) {
  let refs = []
  let p = null
  if (sub.typeHint === "edit") {
    p = await tools.locate_change({ segmentRef: sub.spanKey, fileHint: "" })
    if (p) { const v = await tools.validate_pointer({ ...p }); if (v.ok) refs = [{ refKey: sub.spanKey, ...p }] }
  }
  const type = sub.typeHint === "edit" ? "impl" : sub.typeHint === "verify" ? "verify" : sub.typeHint === "wrap" ? "wrap" : "plan"
  const fields = type === "impl" ? { path: p?.path ?? "", change: "add null guard before accessing user.secret in checkAuth" }
    : type === "verify" ? { command: "node --test tests/auth.test.js", result: "pass 2 tests" }
    : type === "wrap" ? { conclusion: "fixed the auth null-guard bug; both tests pass" }
    : { goal: "Fix the authentication bug in src/auth.js so the tests pass." }
  subtasks.push({ type, ...fields, refs })
}
return { total: s.subtasks.length, sections: [{ summary: "Fix auth bug: added null guard to checkAuth, tests pass", subtasks }] }
```
（usage={"inputTokens":1803,"outputTokens":3456,"cacheReadTokens":1728,"totalTokens":5259}）

### ② 产物（总-分：1 summary + 4 个类型化子任务）

```json
{
  "total": 4,
  "sections": [
    {
      "summary": "Fix auth bug: added null guard to checkAuth, tests pass",
      "subtasks": [
        {
          "type": "plan",
          "goal": "Fix the authentication bug in src/auth.js so the tests pass.",
          "refs": []
        },
        {
          "type": "impl",
          "path": "src/auth.js",
          "change": "add null guard before accessing user.secret in checkAuth",
          "refs": [
            {
              "refKey": "sub:1",
              "path": "src/auth.js",
              "lineRange": "1-6",
              "symbol": "checkAuth"
            }
          ]
        },
        {
          "type": "verify",
          "command": "node --test tests/auth.test.js",
          "result": "pass 2 tests",
          "refs": []
        },
        {
          "type": "wrap",
          "conclusion": "fixed the auth null-guard bug; both tests pass",
          "refs": []
        }
      ]
    }
  ]
}
```
（schema=OK · PTR-TRUTH=OK（refs 均来自真实改动记录） · OUT=OK（无原文回显） · RATIO=effective (0.0435)）

### ③ harness 组装进上下文的 `[compressed task]` 块

```
[compressed task]
Fix auth bug: added null guard to checkAuth, tests pass
- [plan] 目标: Fix the authentication bug in src/auth.js so the tests pass.
- [impl] src/auth.js: add null guard before accessing user.secret in checkAuth｜引用: src/auth.js:1-6(checkAuth)
- [verify] node --test tests/auth.test.js: pass 2 tests
- [wrap] fixed the auth null-guard bug; both tests pass
```

---
## S1 × 方案1（expand：refs 由 harness 展开为真实内容 + 热桥接保留）

### ① 模型写的程序（PTC：一次调用，模型只写代码不调工具）

```js
// A1-S1 保尾 — retain the last subtask as refs + outline (no raw text)
const s = await tools.probe_substructure({ taskRef: "task" })
const subtasks = []
for (const sub of s.subtasks) {
  let refs = []
  let p = null
  if (sub.typeHint === "edit") {
    p = await tools.locate_change({ segmentRef: sub.spanKey, fileHint: "" })
    if (p) { const v = await tools.validate_pointer({ ...p }); if (v.ok) refs = [{ refKey: sub.spanKey, ...p }] }
  }
  const type = sub.typeHint === "edit" ? "impl" : sub.typeHint === "verify" ? "verify" : sub.typeHint === "wrap" ? "wrap" : "plan"
  const fields = type === "impl" ? { path: p?.path ?? "", change: "Add null/undefined guard before accessing user.secret" }
    : type === "verify" ? { command: "node --test tests/auth.test.js", result: "pass 2 tests" }
    : type === "wrap" ? { conclusion: "" }
    : { goal: "Inspect current auth.js and test expectations" }
  subtasks.push({ type, ...fields, refs })
}
let retain
if (s.subtasks.length > 0) {
  const last = s.subtasks[s.subtasks.length - 1]
  let rp = last.typeHint === "edit" || last.typeHint === "verify"
    ? await tools.locate_change({ segmentRef: last.spanKey, fileHint: "" }) : null
  const rrefs = rp ? [{ path: rp.path, lineRange: rp.lineRange, symbol: rp.symbol }] : []
  retain = { refs: rrefs, outline: "Run node --test, both tests pass" }
}
return { total: s.subtasks.length, sections: [{ summary: "Fix authentication bug in src/auth.js by adding null guard; tests pass", subtasks }], retain }
```
（usage={"inputTokens":1943,"outputTokens":2895,"cacheReadTokens":1856,"totalTokens":4838}）

### ② 产物（总-分：1 summary + 4 个类型化子任务）

```json
{
  "total": 4,
  "sections": [
    {
      "summary": "Fix authentication bug in src/auth.js by adding null guard; tests pass",
      "subtasks": [
        {
          "type": "plan",
          "goal": "Inspect current auth.js and test expectations",
          "refs": []
        },
        {
          "type": "impl",
          "path": "src/auth.js",
          "change": "Add null/undefined guard before accessing user.secret",
          "refs": [
            {
              "refKey": "sub:1",
              "path": "src/auth.js",
              "lineRange": "1-6",
              "symbol": "checkAuth",
              "content": "function checkAuth(user, token) {\n  if (!user || !token) {\n    throw new Error('missing credentials')\n  }\n  return token === user.secret\n}"
            }
          ]
        },
        {
          "type": "verify",
          "command": "node --test tests/auth.test.js",
          "result": "pass 2 tests",
          "refs": []
        },
        {
          "type": "wrap",
          "conclusion": "",
          "refs": []
        }
      ]
    }
  ],
  "retain": {
    "refs": [],
    "outline": "Run node --test, both tests pass"
  }
}
```
（schema=sections[0]: sections[...].subtasks[3] missing required field wrap.conclusion · PTR-TRUTH=OK（refs 均来自真实改动记录） · OUT=OK（无原文回显） · RATIO=effective (0.0516) · RET=OK）

> **⚠️ 真实模型方差示例（门在工作的证据）**：这个产物 `wrap.conclusion` 为空字符串 → schema 违例 → 在真实 runner 中该产物**不会被注入上下文**（fail-lazy：继续用完整原文，运行照常）；这正是 schema/PTR/OUT/RATIO 门存在的意义。**示例 ①（S2×方案0）是门全过的干净产物**——要看的"真实可用产出"以它为准。

### ③ harness 组装进上下文的 `[compressed task]` 块

```
[compressed task]
Fix authentication bug in src/auth.js by adding null guard; tests pass
- [plan] 目标: Inspect current auth.js and test expectations
- [impl] src/auth.js: Add null/undefined guard before accessing user.secret｜引用: src/auth.js:1-6→内容(function checkAuth(user, token) {
  if (!user || !token) {
    throw new Error('missing credentials')
  }
  return token === user.secret
})
- [verify] node --test tests/auth.test.js: pass 2 tests
- [wrap]
```
### ④ S1 热桥接保留节点（瞬态：下次压缩即删）

```
[热桥接 retain] Run node --test, both tests pass

```
