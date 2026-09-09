# W2c 输出形态解析器（编译器 / 测试 / 构建日志关键词适配）——设计、实测与风险收益评估

> 状态：**已关闭（用户裁定 2026-09-09；账本 §74）｜只读历史**。W2 方向②「形态解析器」经评估后取消，未施工、无代码改动。
> 本文件保留为评估记录（含 73 个工具的确认输出形态目录）。
> 触发（用户 2026-09-09）：「对于 npm，各种编译器格式的匹配，你都没做吗？」并要求
> **完善设计 / 对更多编译器做关键词适配 / 一定要严格 / 查清各编译器输出形态后确认 / 重算节约 / 按风险收益评估**。
>
> **结论先行**
> 1. 现状确实**没有任何输出形态解析**——W2 只有「命令名白名单 + 保头 12 尾 12」（`core/shear/tool.ts`）。
> 2. 设计补全为**严格 drop-list**：门 0 排除文件转储 → 门 1 尾部汇总锚定 → 门 2 只删可证无信息行 → 信号优先。
> 3. 真机重算（27.3M 模型可见工具结果 token）：**可实现节约 0.14%–0.29%**；**20+ 家族的宽目录在语料上零增量**
>    （语料中唯一可删噪声 = 测试运行器逐条 PASS 行 `✓`）。理论上限 **0.44%**。
> 4. **旧口径 18.9% / 20.9% 作废**：宽松签名在 cur5 命中 954,616 token，其中 **866,490（90.8%）是文件转储误报**；
>    在 arch-big 命中 833,487 token，其中 **830,469（99.6%）是误报**。按旧口径落刀会切掉源码上下文。
> 5. **裁定建议：不按宽目录施工**（见 §5.3/§6）。唯一低风险增量 = C 类单规则（测试运行器逐条 PASS 行），收益 ≈0.3%、风险 ≈0。
>
> 平面：L0（确定性字符串规则；零模型/IO/状态）｜回退链：形态不识别 / 抽取未变小 / 解析异常 → 原文保留（失败方向 = 保留）
> 口径正典：`docs/03 §2`（T-entry 时机经济学）、`docs/03 §2.1`（W1 列表不剪）、`docs/05 §1`（五条节约理念）、账本 §71/§73。
> 复现探针：`scripts/probe-w2c.mjs`（已随本方向关闭删除，账本 §74）。

---

## 0. 现状：W2 只做「白名单 + 保头尾」

`core/shear/tool.ts` 的 T-entry 准入是五道门：① cmd 类；② ≥120 行且 ≥16 KiB；③ 非失败；④ 非列表（W1）；
⑤ 命令在 `LOG_COMMAND_RE` 过程日志白名单内。整形动作 = 保头 12 / 保尾 12。
**没有任何一种输出格式解析**（tsc / vitest / npm / cargo / gcc / maven / dotnet …）。
`classify.ts` 里的失败词正则只用于 N1 的「never cut」判断，不参与整形。账本 §71 把「形态解析器」列为候选 ③，一直未落地。

## 1. 语义边界（既有裁定的硬约束）

| 既有裁定 | 来源 | 对本单的约束 |
|---|---|---|
| 写时确定性：剪点必须在结果入账前定死 | 账本 §71（用户） | 只能挂 T-entry（`tools/post-execute` accept content），不得等后续轮次 |
| 失败方向 = 保留 | `AGENTS.md` / `docs/05 §1` | 不识别 / 抽取后未变小 / 解析异常 → 原文保留；**错误行、失败行、源码上下文行永不删** |
| 列表类与数据查询不剪 | `docs/03 §2` / 账本 §70（F11） | 不得触碰 `git` / `Get-Content` / `Select-String` / 目录列表 |
| 带外原则 | `docs/01 §4` | 省略标记必须是中性文本，不带插件内部标签 |
| 只做工具输出结果的处理 | `docs/03 §2` | 不改工具 schema、不依赖工具自声明、不依赖模型回应 |
| 字节稳定 | `docs/06` | 规则纯函数、无时钟随机；同输入 → 同输出 |

## 2. 设计：drop-list（噪声删除），不是 keep-list（信号保留）

### 2.1 keep-list 已否决

旧原型「识别形态后只保错误行 + 汇总 + 首尾」一旦误报（把文件转储当成测试日志）就整段丢源码——
§4.4 实测的 90–99% 误报正是这条路径。**keep-list 作废。**

### 2.2 三道门

- **门 0｜转储排除**：若文本 ≥30% 的非空行匹配 read 信封行 `^\s*\d+[:|]\s`（文件内容转储），直接放弃整形。
- **门 1｜尾部汇总锚定**：家族汇总行必须出现在**结果最后 25 行内**，才认为这是该家族的日志。
  真机样本里测试汇总行 100% 在末尾（cur5 200/214）；文件正文即使引用了测试输出，末尾也不是汇总行 → 挡住误报。
- **门 2｜家族噪声删除**：只在门 0/1 通过后逐行匹配该家族噪声正则；命中且**不命中信号正则**才删。

### 2.3 信号优先（noise ∧ signal → keep）

信号正则 = 错误 / 失败 / 断言 / 堆栈 / 汇总 / 警告 / 失败字形（`× ✗ ✘ ● ❯`）→ **永不删**，即使同时命中噪声。
实测 `signalPrecedenceBlocks = 0`（语料里不存在噪声行同时是信号行），但规则保留为安全闸。

### 2.4 失败与边界

- 家族未识别 → 原文保留（记 `entry-shape-unrecognized` 计数，不入模型视野）；
- 识别了但零行可删 → 原文保留（不做无收益的字节改写）；
- 删完不更短 → 原文保留；含非 text 块 → 不整形；一次结果只认**第一个**命中的家族。
- 删行折叠为一行中性标记 `… (省略 N 行)`；保留行逐字不变（匹配时剥 ANSI，输出保留原字节）。

## 3. 形态目录（严格版，逐条来源）

分类学（决定收益上限）：

| 类 | 特征 | 可删噪声 | 实测收益 |
|---|---|---|---|
| **A 信号唯一型** | 编译器错误流：每行都是错误/上下文/汇总 | **无** | **0** |
| **B 进度型** | 构建/安装：下载、编译、任务进度行 | 进度行 | 取决于日志是否已被 `tail` |
| **C 逐条型** | 测试运行器：逐条 PASS 行 | `✓ ok --- PASS` 等通过行 | **本语料全部收益来源** |

### 3.1 C 类（逐条通过行）

| 家族 | 锚（尾部 25 行内） | 删（噪声） | 确认来源 |
|---|---|---|---|
| vitest | `^ *(Test Files\|Tests)\s+\d` | `^\s*[✓√]\s` | 真机 vitest 4.1.8（本机运行）+ 本语料 214 条真实样本 |
| jest | `^(Test Suites\|Tests\|Snapshots):\s+.*\d+ total$` | `^\s*[√✓]\s`、`^PASS\s+\S+` | 真机 jest 30.2.0 |
| mocha | `^\s*\d+ (passing\|failing\|pending)` | `^\s*[✓√]\s` | 真机 mocha 11.7.5 |
| ava | `^\s*\d+ tests? (passed\|failed)` | `^\s*[√✓]\s` | 真机 ava 6.4.1 |
| playwright | `^\s*\d+ (passed\|failed\|flaky)( \(\S+\))?$` | `^\s*ok\s+\d+\s`（**仅 ok 行；`x` 行保留**） | 真机 @playwright/test 1.56.1 |
| pytest | `^(?:=+ )?(?:\d+ (?:failed\|passed\|skipped\|error\|xfailed\|xpassed\|deselected\|warning)s?(?:, )?)+ in \d+\.\d+s(?: =+)?$` | `^\S+::\S+ (PASSED\|XFAIL\|XPASS\|SKIPPED)`、`^[.sFEx]+\s*$`、`^(platform\|rootdir\|configfile\|plugins\|collected)\b`、`\[\s*\d+%\]\s*$`（**节标题 `=+ … =+` 保留**） | pytest 9.1.1 真机 + `_pytest/terminal.py`；语料 1 条真实样本 |
| cargo test | `^test result: (ok\|FAILED)\.` | `^test .* \.\.\. ok$` | Rust Book / cargo 文档；语料 0 命中 |
| go test | `^(?:ok\|FAIL)\s+\S+\s+(?:\d+\.\d+s\|\[build failed\])$`、`^--- FAIL: ` | `^=== RUN\s`、`^--- PASS: `（**保留 `ok pkg` 汇总行**） | go1.27.1 真机；语料 0 命中 |
| ctest | `^\s*\d+% tests passed.* out of \d+$` | `^\s*\d+/\d+ Test\s+#\d+: .*\s+Passed\s+[\d.]+ sec$` | CMake 源码 cmCTestTestHandler.cxx |
| dotnet test | `^(Passed\|Failed\|Skipped)!\s+- Failed:` | 逐条 `^Passed\s+<name>$`、进度条 | vstest Resources.resx / ConsoleLogger.cs |
| ansible-playbook | `^PLAY RECAP \*+$` | `^ok: \[`、`^changed: \[` | ansible callback/default.py |
| rspec | `^\d+ examples?, \d+ failures?` | `^[.F*]+$` 进度行 | rspec-core progress_formatter.rb |
| R CMD check | `^Status: .*ERROR` | `^\*{1,2} checking .+ \.\.\. OK$`、`^\* using `、`\[\d+[ms]/\d+[ms]\]` | R tools logging.R / rcmdcheck |

### 3.2 B 类（进度 / 信息行）

| 家族 | 锚 | 删（噪声） | 确认来源 |
|---|---|---|---|
| npm 10/11 | `^npm error code [A-Z0-9]+$` | `^npm notice\b`、`^npm warn\b`、`^\s*> ` | 真机 npm 10.9.4 / 11.10.1 |
| npm 8/9 | `^npm ERR! code [A-Z0-9]+$` | 同上 | 真机 npm 8.19.4 / 9.9.4 |
| pnpm | `^\[ERR_PNPM_[A-Z0-9_]+\]` | 进度 / 装饰行 | 真机 pnpm 11.7.0 |
| yarn classic | `^error Command failed with exit code \d+\.$` | `^yarn run v`、`^info\b`、`^warning\b`、`^\$ ` | 真机 yarn 1.22.22 |
| yarn berry | `^➤ YN\d{4}: `（≠YN0000） | `^➤ YN0000:` | 真机 yarn 4.17.1 |
| bun | `^error: ` | `^\$ ` | 真机 bun 1.3.3 |
| webpack | `^webpack \d\S* compiled with \d+` | `^assets by status`、`^\s*asset `、`\[built\]\[code generated\]` | 真机 webpack 5.102.1 |
| vite build | `^error during build:$` | `^vite v\S+ building`、`^transforming\.\.\.$`、`^rendering chunks`、`^computing gzip size`、`^✓ \d+ modules transformed`、`^dist/` | 真机 vite 7.1.12 |
| rollup | `^\[!\] (RollupError\|Error\|\(plugin )` | 进度箭头行 | 真机 rollup 4.52.5 |
| esbuild / tsup / tsdown | `^[X✘] \[ERROR\] `、`ERROR\s+Error: Build failed` | 框线 / `^CLI ` / `^ℹ `（**源码帧保留**） | 真机 esbuild 0.25.11 / tsup 8.5.0 / tsdown 0.22.2 |
| cargo build | `^\s{4}Finished\s` | `^\s{3,}(Compiling\|Checking\|Downloading\|Updating)\s` | cargo 官方输出 |
| maven | `^\[INFO\] BUILD (SUCCESS\|FAILURE)` | `^\[INFO\] (Downloading\|Downloaded\|Scanning\|Building\|Compiling\|Copying\|Installing)\b`、`^Progress \(`（**保留 `Tests run:` 汇总行**） | Maven ExecutionEventLogger.java |
| gradle | `^BUILD (SUCCESSFUL\|FAILED)` | `^> Task :\S+ (UP-TO-DATE\|NO-SOURCE\|FROM-CACHE)$`、`^Daemon `、`^Welcome to Gradle` | Gradle 功能测试源码 |
| ninja | `^ninja: build stopped` | `^\[\d+/\d+\] `、`^ninja: Entering directory ` | ninja status_printer.cc |
| cmake | `^CMake Error` | `^-- ` 状态行 | CMake cmMessenger.cxx |
| meson | `\d+:\d+: ERROR: ` | configure 进度行 | meson mlog.py / mtest.py |
| bazel | `^ERROR: `、`FAILED in` | `^INFO: `、`^\[\d+/\d+\] `、`^(Loading\|Analyzing\|Fetching):` | bazel UiStateTracker.java |
| docker build | `^ERROR: failed to solve`、`returned a non-zero code` | `^#\d+ (DONE\|CACHED\|sha256:)`、` ---> ` | moby dispatchers.go / buildkit printer.go |
| make | `^make(?:\[\d+\])?: \*\*\* ` | `^make.*(Entering\|Leaving) directory ` | GNU make src/remake.c |
| terraform | `^│? ?Error: ` | `^[╷╵]$`、`^│\s*$` | terraform diagnostic.go |
| dotnet build / msbuild | `error [A-Z]{2,}\d{3,4}: ` | `^\s*(Determining projects to restore\|Restored \|MSBuild version)` | MSBuild Strings.resx |
| pip | `^ERROR: (?:Could not find a version\|No matching distribution found)` | `^(?:Collecting\|Downloading\|Using cached) `、`^Defaulting to user installation`、下载进度条 | pip 26.0.1 真机 |
| poetry | `^Because .+ version solving failed\.$` | `^Resolving dependencies\.\.\.$`、`^Updating dependencies$`、`^  - (?:Installing\|Updating\|Removing) ` | poetry 2.4.3 真机 |
| uv | `^error: `、`^\s*× ` | `^Using (?:Python\|CPython) `、`^Creating virtual environment at:`、`^\s*\+ .+==.+$` | uv 真机 |
| tox | `^\S+: FAIL code \d+ ` | `^\S+: commands\[\d+\]> `、`^\S+: (?:install_deps\|freeze\|develop-inst)> ` | tox 4.61.3 真机 |
| dart / flutter analyze | `^\s*(?:error\|warning\|info\|hint)\s+[•-]\s` | `^Analyzing .+\.\.\.$` | dartdev analyze.dart / flutter_tools analyze_once.dart |
| pdflatex | `^!\s{1,2}.+$` | `This is pdfTeX, Version`、`entering extended mode`、`^\[\d+\]$`、`PDF statistics:`（**保留 `Output written on …`**） | TeX tex.web / latexmk.pl |
| composer | `^Your requirements could not be resolved`、`^  Problem \d+$` | `^  - (Downloading\|Installing\|Upgrading\|Removing) `、`^Loading composer repositories`、`^Updating dependencies$`、`^Writing lock file$` | composer Installer.php / SolverProblemsException.php |
| swift / swiftc | `^Build (?:of .+ )?complete!`（成功） | `^\[\d+/\d+\] (Compiling\|Linking\|Merging module\|Emitting module) `、`^Building for .+\.\.\.$` | swift PrintingDiagnosticConsumer.cpp / LLBuildProgressTracker.swift |
| ghc / cabal / stack | `^\[\s*\d+ of \d+\] (Compiling\|Linking\|Instantiating\|Loading) `、`^Completed \d+ action\(s\)\.$` | `^\[\s*\d+ of \d+\] (Compiling\|Linking\|Instantiating\|Loading) `、`^Resolving dependencies\.\.\.$`、`^Build profile: `、`^In order, the following (will\|would) be built`、`^\S+> (configure\|build\|copy/register\|test) `（**诊断块保留**） | GHC Messager.hs / cabal ProjectOrchestration.hs / stack Execute.hs |

### 3.3 A 类（信号唯一：可识别，但零行可删）

tsc（`file(l,c): error TS####:`）、eslint（`✖ N problems`）、biome、prettier、oxlint、gcc、clang、
ld/collect2、javac（`File.java:l: error:`）、kotlinc、swift、ghc/cabal/stack、dart、zig、mypy、ruff、black、
flake8、pylint、python traceback、node 栈、go build / go vet、php、typst、pdflatex、nim、crystal、sbt/scalac。

**结构性论证**：编译器错误流 = 错误行 + 代码上下文 + 汇总，**每一行都可能是修 bug 所需的**；
删任何一行都违反「失败方向 = 保留」。识别 A 类不产生任何可删行 → 对 A 类做宽目录是纯成本（维护面 + 误报面），零收益。

### 3.4 严格性过滤器（对研究结论的再收紧）

调研给出的「噪声」里有一批**必须否决**的条目——它们属于失败侧或源码上下文：

| 调研建议删 | 本设计裁定 | 理由 |
|---|---|---|
| vitest/jest/mocha 的 `× ✗` 失败行 | **保留** | 失败行 = 答案（哪个用例失败） |
| vitest 的 `❯ <file> (N tests \| M failed)` | **保留** | 失败文件定位 |
| gcc/clang 的源码回显 / caret（`^\s*\d+ \|`、`^\s*\^~*$`） | **保留** | 定位错误的上下文 |
| biome/oxlint/esbuild/tsdown 的源码帧 | **保留** | 同上 |
| maven 全部 `[INFO]` | **保留 `Tests run:` / BUILD` | 汇总行是信号 |
| node 栈里的 `at ... (node:internal/...)` | **保留** | 堆栈是失败信息 |
| cargo / rustc / clippy 的源码帧（`^\s*\d+ \|`、`^ --> `） | **保留** | 定位错误的上下文 |
| python traceback 的回显源码行 / `^~^` 锚行 | **保留** | 异常定位上下文 |
| pytest 的 `=+ … =+` 节标题 | **保留** | FAILURES / summary 分区导航 |

**本设计的删行集合 = 调研噪声规则的严格子集。** 这是「一定要严格」的落地口径。

## 4. 重算节约

### 4.1 语料与口径

- 语料：本地解压会话去重后 **45 个标准模式会话 + 7 个 run_code 快照**（去重键 = 结果数+token 数）。
  `cur`..`cur5`/`scan_17` 是同一会话的不同时刻，去重后 run_code 实际 ≈ 2 个会话（cur5 3.29M + scan_33 0.21M）。
- **模型可见工具结果** = `tool/result` 事件。`tool/code-dispatch` 是 run_code 内部子分发，
  harness 明确「never derives a model message」（`packages/core/tools/tests/ptc.spec.ts:1635`），**不进模型上下文，不计入**。
- token 估算：`core/meter/estimate.ts` 两桶密度（CJK 1.5 / 其余 2.9）。

### 4.2 宽目录实测（`scripts/probe-w2c.mjs`）

| 语料 | 池（模型可见工具结果 token） | 命中结果 | 节约 token | 占池 |
|---|---|---|---|---|
| 45 个标准模式会话 | 7,756,601 | 71 | **10,956** | **0.141%** |
| run_code 快照（含重复） | 19,525,865 | 504 | 56,285 | 0.288% |
| **cur5（当前会话）** | **3,288,113** | — | **9,479** | **0.288%** |

**20+ 家族的宽目录与「只有 vitest 一条规则」结果完全一致**——其余家族在语料中命中 0 行可删噪声。

### 4.3 天花板（各噪声类逐行统计）

| 噪声类 | 命中行 | token（std / ptc） | 占池 |
|---|---|---|---|
| `✓`/`√` 逐条通过行 | 971 / 4,750 | 16,838 / 86,576 | 0.217% / 0.443% |
| jest `PASS`、cargo `test ... ok`、go `=== RUN`/`--- PASS`、pytest `PASSED`、maven/gradle/npm 进度行 | **0** | **0** | — |

**结论：语料中唯一存在的可删噪声是测试运行器的逐条通过行。**

### 4.4 旧口径污染审计（关键更正）

旧签名 = `error TS\d+` / `Test Files\s+\d` / `Tests\s+\d+ (passed|failed)` / `\bPASS\b` /
`\bFAIL\b` / `npm (ERR!|error)` / `error\[E\d+\]` / `BUILD SUCCESSFUL` / `= \d+ passed|failed`
（**无位置约束**）。

| 语料 | 旧签名命中 | 真日志 | **误报** | 误报占比 |
|---|---|---|---|---|
| cur5 | 704 条 / 954,616 tok | 232 条 / 88,126 tok | **472 条 / 866,490 tok** | **90.8%** |
| arch-big | 488 条 / 833,487 tok | 6 条 / 3,018 tok | **482 条 / 830,469 tok** | **99.6%** |

误报构成：**文件转储**（cur5 440,581 tok / arch-big 641,032 tok）+ 数据查询结果（411,620 / 137,778 tok）。
旧原型的「只保错误行 + 首尾」落在这些结果上就会删源码行——**正是用户担心的「连 git 都敢截断」的放大版**。

### 4.5 精度实测（新设计）

- 门 0（转储排除）：在语料 575 条命中结果中**拒绝 0 条**（真日志都不是转储）；
- 删行抽样：语料共 3,573 条被删行，**全部是测试运行器逐条通过行**（`✓ … Nms`），无一内容行；
- 尾部锚定：命中结果 100% 含尾部汇总行（cur5 200/214；其余 14 条汇总不在末尾 → 保守放弃）。

### 4.6 与其它档对比

| 档 | 语料 | 节约 | 占工具结果池 |
|---|---|---|---|
| **T0 读后写超越**（`foldToolShear` 独立回放，484 ops） | arch-big 2,503,960 | **957,486** | **38.24%** |
| 边界压缩（真机单次） | 某会话区间 | 78,825 | 该区间 86.6% |
| **形态解析（本单）** | 全部 27.3M | ≤86,576（天花板） | **≤0.44%** |

同一回放的两个关键事实：
- arch-big（标准模式）：`ops = 484 全为 T0`，T-entry 整形 **0 次**、T0-R **0 次**、列表跳过 119 次——**当前 W2 在标准模式下从未动刀**；
- cur5（run_code 模式）：`ops = 0 / decisions = 0`——唯一工具 `run_code`（类别 other），**剪切层整体空转**。
  形态解析在 run_code 下是唯一可用的写时杠杆，但收益只有 0.29%（T0 在 run_code 下结构性不可达：
  外层结果是程序聚合打印，与 read/write 事件无对应关系）。

## 5. 风险收益

### 5.1 收益

- 现实收益 **0.14%–0.29%**（单会话约 9.5K token；45 个标准会话合计约 11K）；
- 上限 **0.44%**；结构上限：A 类 = 0、B 类取决于是否已被 `tail`（本语料 0）、C 类 = 逐条 PASS 行。

### 5.2 风险

| 风险 | 等级 | 说明 | 缓解 |
|---|---|---|---|
| 误报落刀切源码 | **高**（旧口径 90–99%） | 宽松关键词命中文件转储 | 门 0 + 门 1 + drop-list |
| 规则维护面 | 中 | 20+ 家族 × 版本漂移（npm `ERR!`→`error`、vitest reporter 变化） | 锚失效 = 不识别 = 原文保留（安全） |
| 缓存稳定性 | 低 | T-entry 写时整形，断裂成本 0 | 不变 |
| 版本/账本面 | 低 | 新增家族字段、`SHEAR_POLICY_VERSION` 4→5 | 按既有纪律 |
| 收益不足 | **高** | 0.3% 收益 vs 20 家族维护面 | **不建宽目录** |

### 5.3 裁定建议

**不建议按宽目录施工。**
1. 收益 ≤0.44%，宽目录在语料上零增量——20 个家族的规则面与误报面换不到 0.3%；
2. 真正的大头（文件转储 46–68% 的池、数据查询 ~30% 的池）**不是形态解析的合法目标**
   （前者归 T0/T0-R/边界压缩，后者被 W1 裁定禁止）；
3. 旧口径的 18.9% 来自 90–99% 误报，据此施工会重演「切掉答案」的事故。

**可选的唯一低风险增量**：C 类单规则（测试运行器尾部锚定 + 删逐条 PASS 行，vitest/jest/pytest/cargo/go/ctest/dotnet/ansible 共用）。
收益 ≈0.3%，风险 ≈0（删行只匹配行首通过字形/词，且门 0/信号优先双保险）。

## 6. 待用户拍板

| 选项 | 内容 | 收益 | 风险 |
|---|---|---|---|
| **A（推荐）** | 关闭 W2 方向②（形态解析器），本单留作评估记录；精力投 T0/T0-R 与边界压缩 | — | — |
| **B** | 只落 C 类单规则（逐条 PASS 行删除），A/B 类不落 | ≈0.3% | ≈0 |
| **C** | 按宽目录施工（A+B+C 三类） | ≤0.44% | 高（误报 + 维护面） |

## 附录 A 复现

- `node scripts/probe-w2c.mjs --dir <sessions-dir> [--focus <file>]`（只读、零改史、零网络、零模型）；
- 输出：§4.2 表 + §4.3 天花板 + §4.4 污染审计；
- 口径：会话 JSONL 的 `tool/result` 文本；token 用已构建 `lib/core/meter/estimate.js`。

## 附录 B 研究出处与确认方法

2026-09-09 四路并行调研（A：JS/TS 与包管理器；B：Python/Rust/Go；C1：原生构建与基础设施；C2：JVM/.NET 与其它语言），
要求逐条给出**失败正则 / 汇总正则 / 噪声规则 / 逐字样本 / 出处**，无法确认者标 `UNCONFIRMED`。

| 组 | 取证方式 | 覆盖 | 未确认 |
|---|---|---|---|
| A | **本机真实运行**（tsc 6.0.3、vitest 4.1.8、jest 30.2.0、mocha 11.7.5、ava 6.4.1、playwright 1.56.1、eslint 10.10.0、biome 2.3.4、prettier 3.6.2、webpack 5.102.1、vite 7.1.12、rollup 4.52.5、esbuild 0.25.11、tsup 8.5.0、tsdown 0.22.2、npm 8/9/10/11、pnpm 11.7.0、yarn 1.22.22 / 4.17.1、bun 1.3.3、node 25.7.0） | 23 个 | pnpm 汇总行 |
| B | **本机真实运行**（pytest 9.1.1、mypy 2.3.1、ruff 0.16.6、black 26.5.1、flake8 7.3.0、pylint 4.0.8、pip 26.0.1、poetry 2.4.3、uv、tox 4.61.3、cargo/rustc/clippy 1.98.1、python traceback、go test/build/vet 1.27.1） | 18 个 | golangci-lint / staticcheck（GitHub 限流） |
| C1 | 官方源码/测试/手册（gcc、clang、ld、make、cmake、ninja、meson、bazel、ctest、docker、terraform、ansible） | 12 个 | 无 |
| C2 | 官方源码/测试（javac、maven、gradle、kotlinc、dotnet build/test、msbuild、vstest、dart/flutter analyze、zig、pdflatex、typst、php、composer、rspec、R CMD check、swift/swiftc、ghc、cabal、stack） | 20 个 | nim/crystal/sbt/scalac |

A/B 组的噪声建议里含**失败侧与源码上下文**条目（如 vitest 的 `×`、gcc 的 caret 回显、cargo 的源码帧）；
本单按「失败方向 = 保留」**再收紧一层**（§3.4）后才进入目录——**本设计的删行集合 = 调研噪声规则的严格子集**。

## 附录 C 变更记录

- 2026-09-09 初稿：用户追问后补全设计 + 四路输出形态调研（73 个工具确认 / 7 项 UNCONFIRMED）+ 重算节约 +
  风险收益评估；旧口径作废见 §4.4；新增 `scripts/probe-w2c.mjs`；`docs/implement/TODO.md` §3 加评估指针。
- **未施工**：本单只交付设计与评估，不改任何机制代码、不升 `SHEAR_POLICY_VERSION`、不动账本（裁定后按 §6 走）。
