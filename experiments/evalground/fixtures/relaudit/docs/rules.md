# 审计规则说明（R1–R8）

> 每条规则：检测什么 / 判据 / 严重度。规则实现见 `src/audit/`。

## R1 semver 门

package.json 版本必须等于 CHANGELOG 头版本，且大于最近发布版本。

- 严重度：error

## R2 tarball 结构

产物 tarball 可解析、条目完整。

- 严重度：error

## R3 lib 完整性

main 字段指向的文件存在、非空，且位于包目录内。

- 严重度：warn

## R4 沙箱规则

build.sh 只允许白名单命令与环境变量（禁止网络抓取）。

- 严重度：warn

## R5 依赖审计

运行时依赖（含 link 依赖）必须在 node_modules 清单中；dev 依赖不算缺失。

- 严重度：warn

## R6 CHANGELOG 格式

版本条目格式 `## [x.y.z] - YYYY-MM-DD`，日历日期合法，必备节 Added/Fixed/Changed。

- 严重度：warn

## R7 README 一致性

README 顶部标注版本等于 package.json 版本。

- 严重度：warn

## R8 产物 files 一致性

（待实现）tarball 内条目必须由 package.json 的 `files` 字段声明。

- 严重度：error
