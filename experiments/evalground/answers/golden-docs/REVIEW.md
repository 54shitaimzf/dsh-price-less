# 上市前审查报告：relaudit 审计器

> 审查范围：src/audit/（规则实现与组装）、public/（filter/format）、src/render-panel.js。
> 共报告 11 项：9 项缺陷 + 1 项严重度映射问题 + 1 项观察点。

| 编号 | 位置 | 损害 | 修复建议 | 严重度 |
|---|---|---|---|---|
| B1 | src/audit/semver.js · compareVersions() | 语义化版本按字符串字典序比较：1.10.0 被判定小于 1.9.0，版本门会放行回归版本或拦截正常升级 | 按 major/minor/patch 数值段比较（复用 parseVersion） | error |
| B2 | src/audit/severity.js · RULE_SEVERITY | 版本门不匹配（R1）只标 warn，未知规则落 info：真实 error 级问题被埋进报告底部 | R1 映射为 error，未知规则保持 info 兜底 | error |
| B3 | src/audit/tarball.js · listTarballEntries() | ustar prefix（深目录/长路径）读出后未拼接，产物条目只剩裸文件名；深目录未声明文件漏报 | prefix 非空时拼接 `${prefix}/${name}` | error |
| B4 | src/audit/files.js · checkLib() | main 指向包目录之外（如 ../../evil.js）时无守卫，审计静默通过 | 校验 resolved 位于 pkgDir 内，否则报错 | warn |
| B5 | src/audit/sandbox.js · ALLOWED_COMMANDS | npx 与 curl 被白名单放行：构建脚本可联网抓取、执行任意包，沙箱规则失效 | 从白名单移除 npx 与 curl | warn |
| B6 | src/audit/deps.js · checkDeps() | devDependencies 混入运行时依赖集合：构建产物中没有的 dev 依赖被报为运行时缺失（样例包 typescript 即产生误报） | 只检查 pkg.dependencies | warn |
| B7 | src/audit/changelog.js · checkChangelog() | 日期只验形状不验范围：2026-13-05 等非法日期通过（样例包 CHANGELOG 中即存在） | 调用 isValidDate(year, month, day) 做日历校验 | warn |
| B8 | src/audit/consistency.js · checkConsistency() | README 版本取最后一个版本 token 比对：顶部徽章过期、后续章节提到当前版本时误判通过 | 只取首个版本 token（顶部徽章）比对 | warn |
| B9 | public/filter.js · applyFilter() | 过滤级别采用严格大于：`>` 而非 `>=`，minSeverity='warn' 时丢 warn 行、'error' 时返回空集，面板过滤在边界上整体失效 | 改为 `>=`，非法 minSeverity 回退 'info' | error |
| B10 | public/format.js · countTotal() | 计数先字符串拼接再相加：2 error + 1 warn + 4 info 统计成 25 而非 7，面板"共 N 条"错误 | 改为逐项 Number 相加 | warn |
| O1 | src/audit/index.js · runAudit()（观察点） | 审计结果无版本失效指纹（只记 auditedAt），同一包不同版本可能命中旧审计结论 | 报告携带 pkgVersion + 规则集版本指纹作为缓存键 | info |

**审查结论**：B1–B3 与 B9 为发布阻断级（error），建议修复后放行；B4–B8 与 B10 为质量级（warn）；O1 为观察点。未发现虚构问题；样例包审计会因 B6/B5/B7/B8 的误报/漏报产生失真结果，与代码依据一致。
