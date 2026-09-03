# 审计规则说明（R1–R8）

> 每条规则：检测什么 / 判据 / 严重度。规则实现见 `src/audit/`。

## R1 semver 门

检测 package.json 版本与 CHANGELOG 头版本、已发布版本之间的门禁关系。

- 判据：CHANGELOG 首个 `## [x.y.z] - date` 条目版本必须等于 package.json 版本；
  package.json 版本必须大于最近发布版本（`releases` 数组末位）。
- 严重度：error

## R2 tarball 结构

检测产物 tarball 可解析、条目完整，无损坏条目。

- 判据：tarball 可用（ustar 解析出条目）、无空尺寸异常条目；深目录/长文件名的
  ustar prefix 拼接后完整匹配。
- 严重度：error

## R3 lib 完整性

检测 main 字段指向的文件存在、非空，且位于包目录内。

- 判据：main 解析后位于包目录内、文件存在、字节数 > 0。
- 严重度：warn

## R4 沙箱规则

检测 build.sh 只使用白名单命令与环境变量（发布沙箱禁止联网抓取）。

- 判据：每条命令的首词在 ALLOWED_COMMANDS 内；引用的环境变量在 ALLOWED_ENV 内；
  白名单不含 npx/curl。
- 严重度：warn

## R5 依赖审计

检测运行时依赖（含 link 依赖）都已在 node_modules 清单中。

- 判据：`dependencies`（不含 devDependencies）的每个包名出现在 node-modules.json。
- 严重度：warn

## R6 CHANGELOG 格式

检测版本条目格式与日历日期合法性、必备节。

- 判据：条目 `## [x.y.z] - YYYY-MM-DD`；日期为真实日历日期；每节含
  Added / Fixed / Changed。
- 严重度：warn

## R7 README 一致性

检测 README 顶部标注版本等于 package.json 版本。

- 判据：README 首个 `vX.Y.Z` token（顶部徽章）等于 package.json 版本。
- 严重度：warn

## R8 产物 files 一致性

检测 tarball 内条目都由 package.json 的 `files` 字段声明，且声明内容在产物中存在。

- 判据：tarball 中每条非 `package.json`/目录条目要么精确匹配 files 中的文件，
  要么位于 files 中声明的目录前缀下（否则报「未在 files 字段声明」）；files 中
  声明的目录必须在产物中存在条目；files 中声明的文件必须在产物中存在
  （否则报「在产物中缺失」）。
- 严重度：error
