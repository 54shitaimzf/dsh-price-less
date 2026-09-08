# N1 · 工具身份通道与可剪集合

> **状态**：**已施工**（2026-09-09，N 系列首单）；探针报告与验收见 §9。
> **依赖**：无（R1–R4 已封存）。**总纲**：[`00-master.md`](00-master.md) §2/§3/§6。
> **正典**：[`docs/03 §2`](../03-shear.md)（四档时机 + 生命周期谓词）· [`docs/06 §2`](../06-cache.md)（断裂成本）·
> [`docs/11 §7`](../11-structure.md)（资产登记）· `docs/13 §3.9`（H6 挂点）。

## §1 目标

把"这条工具结果属于哪一类"从**猜命令字符串**升级为**读 DSH 工具签名**，产出带**证据等级**的机械分类器。
**本单只读、只分类、不剪**（影子记账归 N3，剪除执行归 N4）。

## §2 三条通道（均已核实存在）

| 通道 | 来源 | 现状 |
|---|---|---|
| 调用参数 | `ToolExecution.arguments`（解析后 JSON） | **我们丢掉了**（`toToolResultView` 未取；`callOf` 置空） |
| 工具签名 | `ctx.tools.get(name, exec.agent)` → `presentCall(args).kind` / `presentResult(args,result).card` | **未使用** |
| 结构化载荷 | `ToolExecutionResult.meta`（`output.presentationMeta` 投影，已落账） | **未使用** |

**已核实声明覆盖**（harness 原生工具，2026-09-09 核对 checkout）：

- `read` kind=read / card=read + meta；`read_image` kind=read + meta
- `write` / `edit` card=diff；`str_replace_editor` 按子命令 view=read / create·str_replace=diff
- `grep` kind=search / card=search + meta；`glob` kind=search / card=search + meta
- `web_search` kind=search / card=web；`web_fetch` kind=fetch / card=web
- `bash` / `pwsh` card=terminal（`presentResult` 拆出 `output` + `exitCode`）
- `run_code` kind=execute，**故意无 presentResult/meta**
- `job_output` kind=**read**（card=generic）· `job_list` kind=read · `job_kill` kind=execute
- `todo_write` kind=other；`ask_user_question` **无声明**
- `subagent` **无任何 presentCall/presentResult**（全 src 零声明）

## §3 交付物

1. **平台描述符**（`src/platform/tools.ts`）：`ToolResultView` 增 `args` / `meta` / `kind` / `card`；
   `ctx.tools.get(name, exec.agent)` + `presentCall` 取值；**任何异常 → 降级为只有 name**（fail-lazy，不得打断工具执行）。
   优先用 `result.meta`（已算好）；`presentResult` 仅在必要时调（大结果有投影成本）。
2. **纯核分类器**（`src/core/shear/classify.ts`）：输入纯描述符（含 `resultText`），输出：

   ```ts
   classify(desc: ToolDescriptor) → {
     verdict: 'cuttable' | 'never',   // 身份 → 形态两阶段收敛后的最终判定
     stage:   'identity' | 'shape',   // 由哪一步定音（可审计）
     basis:   'signature' | 'name' | 'command' | 'none',
     reason:  string,                 // 命中哪条判据，进账本
   }
   ```

   `ToolDescriptor` = `{ name, kind?, card?, args?, meta?, resultText, resultBytes }`——**平台只供字段，判定全在纯核**。
3. **只读探针**（`scripts/probe-n1.mjs`）：真实会话回放上统计签名覆盖率 / 判定分布 + 定音阶段 / basis 分布 /
   `needs-result` 子类分布（**无写、无网络**）。

## §4 分类规则（定稿）

### §4.1 决策序列（按序，先命中先定）

| # | 判据 | 结论 | basis | 理由 |
|---|---|---|---|---|
| 0 | 结果 < **2KB** | 不入候选 | — | 剪了没收益 |
| 1 | `card='diff'` 或 `kind ∈ {edit, delete, move}` | **never** | signature | 改史 |
| 2 | `card='read'` 或 `kind='read'`（**`job_output` 除外**） | **never** | signature | 项目代码事实 |
| 3 | `card='web'` 或 `kind='fetch'` | **never** | signature | 外部事实 |
| 4 | `card='search'` 或 `kind='search'` | **never** | signature | 代码 / 检索事实 |
| 5 | `card='terminal'` | **needs-result** | command | 命令串拆段 |
| 6 | 名 ∈ {`run_code`, `job_output`, `subagent`} | **needs-result** | name | 程序化输出 |
| 7 | 其余（无声明 / 认不出 / 异常降级） | **never** | none | 失败默认保留 |

> 注：`grep` 的 `kind` 也是 `search`，故规则 3 只认 `card='web'` / `kind='fetch'`；`search` 归规则 4
> （两者结论同为 never，但**归因**必须正确，否则账本读不出真相）。

### §4.2 `needs-result` 的结果形态判定（先形态、后拆段）

| 判据（按序） | 结论 |
|---|---|
| 结果含**副作用迹象**：写盘 / 改库 / 发网 / 提交 / 部署 / 安装（`git commit·push·reset`、`rm·mv·cp·>·>>·Set-Content·Out-File`、`npm install·publish`、`pip install`、`curl·wget` 写请求、`docker·kubectl`、`chmod·chown`、`Invoke-*`；`run_code` 则扫**程序源码**同款特征） | **never** |
| 结果**已被截断**（`head`/`tail`/`wc`、spill 指针、`… truncated`） | **never**（看不到全貌） |
| 结果含**错误 / 异常 / 失败诊断**（错误行、stack、非零退出） | **never**（诊断即代码事实） |
| 结果含**文件全文 / 大段代码块 / 原始语料**（`cat`、`ls -R`、`git log`、子代理贴出全文） | **never** |
| 其余（成功结论 / 判定 / 计数 / 通过率） | **cuttable** |

`card='terminal'` 另按 `; && || |` 与换行**拆段**逐段判定，**整条取最保守段**；
任一段命中上表前四行 → 整条 `never`。

### §4.3 `basis` = 证据等级

| basis | 证据来源 | 谁给的 | 可信度 |
|---|---|---|---|
| `signature` | 工具自己声明的 `kind`/`card` | DSH 工具定义 | **硬** |
| `name` | 工具名白名单（仅 3 个） | 本插件 | **中** |
| `command` | 拆命令字符串 | 模型写的自由文本 | **弱** |
| `none` | 无 | — | 兜底 `never` |

### §4.4 两档阈值（一套分类器，两条线）

| 消费者 | 采用集合 | 误判代价 |
|---|---|---|
| **N3 影子模式**（只挂注记不剪） | `verdict==='cuttable'`（**任意 basis**）+ 1% never 对照组 | ≈0（多几十 token） |
| **N4 剪除执行**（不可逆） | 白名单 = `basis==='signature'` ∪ 影子晋升集；**实测 signature 组可剪 = 0（§9）**，故实际起步 = **空集**，完全由晋升驱动 | 信息永久消失 |

**晋升规则**：某 basis 组样本 ≥30 且 CUT-HOLD 率 <5% 且 保真率 ≥95% → 写入 N4 白名单。
白名单不拍脑袋，**拿影子数据一条条升上去**。

### §4.5 对照组（检验"永不剪"）

影子模式随机抽 **1% 的 `never` 项**也挂注记（**只问不剪**），采样必须**确定性**
（`hash(seq) % 100 === 0`，可回放，禁运行期随机）。

- 对照组 CUT-OK 率高 → `never` 过保守，回头放宽分类器；
- 对照组 CUT-HOLD 率高 → 反向证明 `never` 判得对。

## §5 验收

- `npm run gate` 绿 + `npm run typecheck:tests` 绿。
- `node scripts/probe-n1.mjs` 产出：按工具的签名覆盖率（有 kind / 有 card / 有 meta 占比）、
  判定分布 + 定音阶段、**basis 分布**（含 cuttable 的 basis / 工具分布）、判据命中、对照组采样率；**零写零网络**。
- 新增结构断言：`core/shear/classify.ts` 零 harness import（S1 既有规则覆盖）；
  `platform/tools.ts` 仍是唯一取 harness 工具类型的文件（D 规则）。
- 单测：每档 / 每 basis ≥1 用例；异常降级（`ctx.tools.get` 抛错、`presentCall` 返回 undefined）；
  拆段取最保守段；副作用 / 截断 / 错误诊断三类否决各 ≥1 例；确定性对照组采样。

## §6 尺寸预算

预估 **M**（2–4 文件 / ≤400 净行）：`platform/tools.ts` +40 / `core/shear/classify.ts` ~160 /
探针 ~180（脚本不计 src 净行）。超预算须在 §8 申报拆单。

## §7 风险与回退

| 风险 | 处置 |
|---|---|
| 工具不声明签名（第三方） | 降级 `never` / `needs-result`；不假设存在 |
| `get(name, scope)` scope 取错（多 preset） | 必须传 `exec.agent`；取不到 → 降级 `none` |
| `presentResult` 成本 | 优先 `meta`；`presentResult` 只在无 meta 时调 |
| harness 版本漂移 | 防御性解析；未知 shape → `never` |
| **`name` 白名单漂移**（改名 / 撞名） | 只有 3 个名字、范围小可审计；`basis='name'` **在晋升前一律不进 N4** |
| bash 无 meta | 走命令拆段；**建议向上游提**：bash 投影 `exitCode`/`spillPath` 进 meta |

## §8 决策记录（2026-09-09 用户裁定）

| # | 决策 |
|---|---|
| 1 | **`subagent` 开名字白名单通道**：身份通道认不出（零声明），但其返回体天然是子代理结论，值得进候选 |
| 2 | **`job_output` 从规则 2 摘出**：签名是 read，但载荷是后台作业 stdout（多为构建/测试日志），走结果形态判定 |
| 3 | **`run_code` 由 cuttable 改 needs-result**：kind=execute 且无 presentResult，身份分不出"算数/改盘"→ 扫程序源码副作用特征 |
| 4 | **`basis` 证据等级 + 两档阈值**：影子宽（任意 basis 挂注记）、剪除严（起步仅 signature），按 basis 逐组晋升 |
| 5 | **1% never 对照组**：只问不剪，用来检验"永不剪"是否过保守；采样确定性可回放 |

## §9 施工记录与探针报告（2026-09-09）

**交付**：`src/core/shear/classify.ts`（纯核分类器）· `src/platform/tools.ts`（描述符增 args/meta/kind/card/resultBytes + `ToolSignatureSource`）· `tests/shear-classify.spec.ts`（16 用例）· `scripts/probe-n1.mjs`（只读探针）。

**验收**：`npm run gate` 绿（**568 用例 / 54 文件**）· `npm run typecheck:tests` 绿 · D1–D17 + M/S 全 PASS（`ok=true vacuous=[]`）· 探针零写零网络。

**探针读数**（44 会话 / 5,032 条 `tool/result` / ≥2KB **2,160 条（42.9%）**；数据源 = 已解压会话 JSONL，`node scripts/probe-n1.mjs [--dir <目录>]`）：

| 项 | 数值 |
|---|---|
| 判定 | **cuttable 625（28.9%）** / never 1,535（71.1%） |
| 定音阶段 | shape 2,094（96.9%） / identity 66（3.1%） |
| basis（全部 ≥2KB） | command 1,342（62.1%） / name 752（34.8%） / signature 55（2.5%） / none 11（0.5%） |
| **cuttable 的 basis** | **name 402（64.3%） / command 223（35.7%） / signature 0** |
| cuttable 的工具 | run_code 402 · bash 209 · pwsh 14 |
| 签名覆盖（≥2KB 加权） | kind 37.3% / card 64.7% / meta 2.5% / 静态表未收录 0.5% |
| never 判据 | corpus 553 · truncated 374 · error-output 339 · side-effect 203 · file-fact 38 · search-fact 15 · unknown 11 · write-history 2 |
| 对照组 | 8 / 1,535（1% 确定性采样） |

**关键结论**：

1. **可剪面比设计期估计更大**（28.9% vs 20.6%）：结果形态把"成功结论"与"错误 / 语料 / 截断"分开，后者一律 never。
2. **候选高度集中在两类载荷**：`run_code`（402）与 `bash`/`pwsh`（223）——**N2 结论契约必须同时覆盖**（终端判定输出 vs 程序化结论）。
3. **`signature` basis 的可剪数 = 0**（55 条 signature 全是 never 的文件 / 检索 / 改史事实）→ **N4 不能从 signature 起步**；白名单实际起步为空集，完全靠影子数据把 `command` / `name` 两组升上来。§4.4 已按此修正。
4. 未收录工具仅 0.5%（探针静态表口径）；运行期由 `ctx.tools.get` 补齐，真实覆盖更高。
