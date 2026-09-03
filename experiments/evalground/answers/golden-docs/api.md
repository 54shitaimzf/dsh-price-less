# relaudit API

> 服务：`npm run start` 后监听 127.0.0.1:8787。所有接口返回 JSON；
> 报告面板页由同一服务提供（`GET /`）。

## GET /api/versions

返回已发布版本列表。

响应：

```json
{ "releases": ["1.2.0"] }
```

字段：

- `releases`：string[]，按发布先后排列的版本号数组。

## GET /api/audit

对样例插件包 `sample-pkg/` 执行一次完整审计（R1–R8），写入运行记录并返回该次运行。

响应：

```json
{
  "id": "run-1710000000000",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "report": {
    "pkg": "dsh-sample-plugin",
    "version": "1.3.0",
    "auditedAt": "2026-01-01T00:00:00.000Z",
    "findings": [
      { "rule": "R4", "severity": "warn", "message": "…", "file": "scripts/build.sh" }
    ],
    "summary": { "errors": 0, "warns": 3, "infos": 0, "total": 3 }
  }
}
```

字段：

- `findings[]`：`rule`（R1–R8）、`severity`（error/warn/info）、`message`、`file`；
- `summary`：按严重度计数的 `errors/warns/infos/total`。

## GET /api/audit/:id

按运行 id 取回已存储的审计运行。未知 id 返回 404。

## GET /api/rules

返回规则目录（id/名称/严重度），共 R1–R8 八条。

## GET /api/runs

返回全部已存储的审计运行记录数组。

## GET /

返回报告面板页（HTML，前端加载后调用 /api/audit 并渲染）。
