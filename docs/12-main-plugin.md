# 12 · 主插件：底座与数据面

> 主插件是**唯一横切设施与持久数据面的主人**：生命周期与恢复、原生组件接入、内建守卫、
> 公共前缀 P 服务、意图映射表更新（task 周期）、L3 差分写、能力域装配。
> 业务机制（体积/发现/意图强调/编排/文件治理）由五个能力域分别承担，主插件负责横切与数据面。

## 0. 它解决什么问题（人话版）

主插件是整套东西的**底座兼数据面**，也是**唯一常开的设施**。它负责把所有"横着切"的活统一收口，而不是让六个能力域各干各的。痛点是：如果每个能力域都直接去调 DSH 的底层能力（发事件、存状态、记日志、调模型、注册工具），升级 DSH 时要改一堆地方；而且"宕机了怎么办、谁越权了谁负责"没人统一管。思路是把这些横切的事全收进主插件一个壳——**统一接入、统一守卫、统一恢复、统一提供公共前缀 P**。收益是升级只改一处、状态能按顺序救回来、越权能被拦下；代价是它要维护一批公共件和一张守卫表。业务活（压缩、发现、意图强调、编排、文件治理）分别由五个能力域承担，主插件只当"壳 + 管家"——横切与数据面的事全部收口。

## 1. 系统内位置

```
主插件
 ├─ 底座: 恢复编排(§2) · 原生接入(§3) · 守卫(§4) · 装配(§5)
 └─ 数据面: P 服务(§6) · 意图映射表更新(§7) · L3 差分写(§8)
能力域 (02/03/04/13/15) 依赖主插件统一接口，不直接 import 原生包。
```

一句话：主插件分两半——**底座**（恢复、接入、守卫、装配）和**数据面**（P 服务、意图映射表更新、L3 差分写）。能力域只认主插件这层接口，不许绕过它直接引 DSH 原生包。

## 2. 恢复契约

原则：**写进日志/磁盘的才算状态；哪一项坏了就只降那一项，其他照常**。

所谓**恢复编排**，就是宕机/重启后按顺序把状态逐项救回来。下面的表就是"每样东西存在哪、怎么救、救不回来怎么样"。

| 状态 | 存哪 | 恢复 | 失效语义 |
|---|---|---|---|
| L3 知识（偏好/映射/工作摘要 vN） | storages 磁盘（docs/09） | 读盘+版本校验 | 回退上一版本 |
| task 表 | 日志事件 fold（`task-boundary`） | 回放重建 | 当作新 task |
| 意图映射表 | storages 磁盘 | 读盘+校验 | 只读退化（锚定降级为机械匹配） |
| 文件快照/页缓存 | 磁盘缓存+hash | 读盘+hash 校验 | 重建（页式有界） |
| 管道中间态 | 日志（`pipeline/*`） | 回放或丢弃 | 丢弃，留账 |

恢复序：L3 → task 表 → 意图映射表 → 文件快照 → 管道中间态；每步 `restore/step`，失败 `restore/degraded`，完成 `restore/done`（含降级清单）。

这里的顺序值得一提：先救最贵、最重要的 L3 知识，再到 task 表，再到意图映射表、文件快照，最后是管道中间态（**直接丢弃，留着记账就好**）。其中 task 表是**按事件顺序重放日志（事件 fold）**重建出来的——事件都是 log-only（只记日志、可回放、不触发副作用），所以重放就能推回状态。

## 3. 原生接入统一入口

**统一入口（原生接入）**的含义：所有对 DSH 原生能力（事件/存储/日志/LLM/工具）的调用，都走主插件一个壳，升级 DSH 只改主插件一处。下面这张表就是"原生能力 ↔ 主插件接口"的对照。

| 原生组件 | 统一接口 | 说明 |
|---|---|---|
| 事件 session/event | `platform.emit(name, data)` | `context-economy/*` 命名空间集中登记 |
| 持久化 storages | `platform.persist(entity, vN)` | 原子写 + 版本化 |
| 日志 cordis logger | `platform.log(level, msg, ctx)` | 统一字段（pluginId/taskId/pipelineId） |
| LLM llm.stream | `platform.llm(purpose, envelope)` | 路由 + 用量回执 + purpose 标记 |
| 工具注册 | `platform.registerTool(def)` | 命名前缀与描述规范 |
| 生命周期 | `platform.onResume(fn)` | 恢复钩子注册 |

DSH 升级只改主插件一处；全部事件/日志/工具带统一身份字段。

这些 `platform.emit / persist / log / llm / registerTool / onResume` 就是**主插件暴露给各域的统一接口**：分别是发事件、存状态、记日志、调模型、注册工具、挂恢复钩子。各域通过这套接口使用 DSH 能力，底层细节由主插件统一隔离。

## 4. 内建守卫

宪法条文在 [docs/05](05-rule-domain.md)；执行在本文。**守卫**就是运行时警察，四条各管一摊：超预算就裁剪、字节不符就拒绝、补丁不规范就拦截、想绕过回退链就不许入。执行表唯一定居在本节（docs/05 只保留条文与指针）。

| 检查器 | 检查 | 结果 |
|---|---|---|
| 预算守卫 | 锚定段 ≤ `anchorBudgetTokens` | 超限即裁剪 |
| 字节守卫 | 同版本模板/锚定/文件流/摘要哈希一致 | 漂移即拒绝 |
| 补丁守卫 | 修改流 schema 可执行 | 自然语言驱动机械操作即拒绝 |
| 回退链守卫 | 模块自证步数最小 | 违宪禁入 |

装配期预检 + 运行期拦截；违反 → `guard/violation`（log-only）+ `violationRate`。

这几条用大白话说：

- **装配期预检 + 运行期拦截** = **装上时先查一遍，运行时再抓一次**，两道防线；
- **自证步数最小**（回退链守卫）= 模块要**证明自己没用更贵的手段就能解决**，怎么证明——在模块注释里写明我用了哪一档（平面分层/回退链步数/审查清单/度量，见 docs/05 §6）；
- **违宪禁入** = 违反宪法就不许装；
- 违反一律记成 `guard/violation`（log-only，只留日志可回放），并计入 `violationRate`。

## 5. 能力域装配

**装配**就是把各能力域按开关装进主插件。下表分两层：**已落地**（真实配置字段，见 `src/config.ts`）
与**设计蓝图**（域未实现，配置未落地——见各域文档状态标注）。

**已落地开关（v0.8.0 真相）**：

| 配置字段 | 状态 | 域 | 用途 |
|---|---|---|---|
| `sub2IntentMapping` | ✅ 默认 true | 输入域 | 指挥半边总开关：关 = 投影单元仍挂，但 orchestrator（压缩触发/溢出接管）不挂；判别器**独立**由 `discriminator.mode` 控制，不受此开关门控（`src/index.ts`） |
| `taskCompression` | ✅ 默认 true | 压缩域 | task 结束触发压缩（orchestrator 挂载条件之一） |
| `overflowRecovery` | ✅ 默认 true | 压缩域 | 上下文溢出接管（`agent/request-error` 兜底恢复） |
| `compressionDriver` | ✅ 'native' | 压缩域 | 压缩驱动选择：`'native'` = 现有行为；`'task-partitioned'` = 近因保留尾 + 冷区闭合任务整压（A3，orchestrator 选择层已接） |
| `retainTokens` | ✅ 默认 0 | 压缩域 | 近因保留尾阈值（token；task-partitioned 用；0=待验证集标定，docs/08） |
| `taskDigestBudgetRatio` | ✅ 默认 0.2 | 压缩域 | 摘要区/单 task digest 预算比例（docs/02 §3.2） |
| `taskDigestCacheLimit` | ✅ 默认 256 | 压缩域 | 摘要缓存 LRU 容量（0=关缓存） |
| `taskDigestMergeOnReopen` | ✅ 默认 true | 压缩域 | 同 task 二次归档策略（true=合并，false=拒绝） |
| `taskDigestProvider` / `taskDigestModel` | ✅ 默认 '' | 压缩域 | 摘要器 provider/model（空=跟随会话路由） |
| `taskDigestJournalPath` | ✅ 默认 '' | 压缩域 | 摘要落盘目录（空=默认 `~/.dsh/context-economy/knowledge.json`） |
| `discriminator.*` | ✅ 默认 off | 输入域 | 判别器运行时配置（mode/preset/promptVersion/窗口/容错参数——docs/03 §7-8；mounted 差异化见上） |

**设计蓝图（未实现，勿混淆）**：`sub3PromptOptimizer`（04）/ `sub4Orchestrator`（13）/
`intentMapping`、`fileGovernance`（15）——对应能力域尚未落地，这些开关**不存在于代码**。

装配序：守卫先起 → 压缩 → 输入 → 提示词 → 文件与寻址 → 编排（默认关）。关闭任一域其余完整。

> **装配健壮性**：插件入口 `apply` 可能被 include/loader 以**部分 config 对象**加载（含空 `{}`），此时
> schemastery 的 `.default()` **不会触发**，直接读 `config.embeddingModelDir` 等会得 `undefined`，
> 曾致启动崩溃（`Cannot read properties of undefined (reading 'length')`）。修复：`apply` 入口统一走
> `resolveConfig()`，缺省字段用 `CONFIG_DEFAULTS`（与 config.ts `.default()` 同源）补全；
> `makeVotes`/`registerTaskProjection` 亦对 config 逐字段 `?? default` 兜底——任何装配路径下均可安全挂载。

> **模块切分与 harness 契约（2026-08 重构）**：为职责解耦，投票状态容器、artifact 存储、压缩驱动、压缩域
> fold 各自独立成模块：
> - `src/votes/table.ts`（`InMemoryVoteTable`）+ `src/votes/artifact.ts`（`VoteArtifactStore`/`hashText`/`isSystemInjectedUserText`）；
> - `src/task/driver.ts`（`CompressionDriver`+`NativeCompressionDriver`）、`src/task/compaction.ts`（`applyReplace`/`applyCompactionSummary`）→ `embedding.ts` 仅留端口与 provider；
> - `src/index.ts` 只保留装配 + `CONFIG_DEFAULTS`/`resolveConfig`。
> 公共 API（`apply`/`registerTaskProjection`/`resolveConfig`/`CONFIG_DEFAULTS`/`TASK_PROJECTION_KEY`）不变。

> **v0.4.0-runtime2：settings 动态配置 + GUI 卡片（2026-08）**：
> - 配置权威源从"装配时物化 cfg"升级为 **settings scope 动态读取**：`src/settings.ts`
>   `registerContextEconomySettings` 经 `installSettingsSection` 把插件配置注册为
>   `context-economy` namespace（用户层 > 装配 base > schema 默认）；`configSource()`
>   每次调用取当前已解析值（settings 服务未装配/脱离时回退装配 base——消费方永不持有失效源）。
> - `src/index.ts` 装配改造：判别器/编排经 `mountDiscriminator`/`mountOrchestrator` 挂载，
>   settings 变更（onChange）→ 拆旧挂新（幂等）；mode=off 卸载、observe/active 重挂应用新配置。
>   判别器 U 空间游标由 `userIndexBefore(session.events, seq)` 锚定会话日志——重挂不丢计数。
> - **GUI 配置卡片（client 半边首次交付）**：`client/` 目录（controller + Card + entry），
>   tsdown 产出 `lib/client.js`（`window.__ModuleLoader__.load` CJS 契约、external=共享模块表行），
>   在「设置 → 插件 → 可配置」标签注册 `settings.plugin.item` 卡片（key='context-economy'）：
>   字段 = 顶层 4 开关 + 判别器 17 字段（枚举经 parse 校验文本+合法值提示；保存统一走
>   `scope.mutate` 多段 path 原子提交）；每字段 hint = 说明与模型参数条件。
> - **依赖与构建**：host 增 `@deepseek-ai/dsh-settings` peerDependency；build.sh 增
>   `build:client` 阶段（存在 `client/` 时 tsdown）；`npm run typecheck:client` 仅类型检查。
> - **验证边界（诚实记录）**：host 半边（namespace 注册/配置写入/mode 重挂）已在本实例
>   实测通过；client 端到端（GUI 卡片渲染/保存）需 **dsh 重启**后验证——client-modules
>   无全量重扫路径（"Scanning is incremental per package"），新 bundle 的
>   `dsh.client` 声明须经 loader 条目重装配进入 boot graph。
>
> **v0.4.0-runtime3：配置卡片 UI 重构（2026-08，零行为 Δ）**：
> - **分层与形态**：卡片从"21 字段平铺"重构为 4 组编号标题 + 配色区组（装配/判别/容错/高级，
>   末组默认折叠）；枚举字段改原生 `<select>` 下拉，数字改步进输入 + 单位，布尔改复选框，
>   文本改 placeholder 输入——`client/{controller,Card}.tsx`。
> - **提示词版本收窄**：`discriminator.promptVersion` 从用户卡片移除（保留为 schema 内部字段，
>   运行时自动回退最新，docs/04）；用户自定义方向改为"预设说明 + 高级覆盖"，不再暴露版本号。
> - **品牌化**：DeepSeek 官方蓝 `#4D6BFE`/`#4166D5`、区组配色防视觉疲劳；头部内嵌鲸鱼娘女仆
>   吉祥物（**MIT 许可**，DeepSeek-Whale-Girl `assets/whale/whale-maid.png` 缩放 192px →
>   base64 data-URL，`client/mascot.ts`；内嵌原因：client 由 `__ModuleLoader__` 加载，
>   asset 文件路径解析不可靠，data-URL 离线/无外链/无 CSP 资源问题）。归属见
>   `client/mascot.ts` 头注释。
> - **一键恢复默认**：`CLIENT_DEFAULTS`（镜像 `CONFIG_DEFAULTS`，src/config.ts；可选覆盖清空）。
> - **配置 schema 与判别逻辑零改动**——纯 client 外表层变更，无新增判定语义（账本无新记录类型）；
>   client.js 18.98kB → 104.25kB（含吉祥物 base64）；client 端到端按 §9 验收视确认。
>
> **v0.6.0：配置组件库重构 + 判别器默认 off（2026-08）**：
> - **组件库（自研、token 驱动）**：`client/components/` 下 CeSelect/CeToggle/CeNumber/CeText/
>   CePath/CeButton/CeGroup/CeTip/CeConfirm/FieldRow；全部内联引用真实 `--dsw-*` 令牌
>   （亮/暗双主题自适应）——历史 bug 根因是 `--theme-*` 在 DSH 不存在，恒落到硬编码深色回退值。
> - **行为变更（唯一 host Δ）**：`discriminator.mode` 默认 `observe` → `off`（schema
>   `.default()` + `CONFIG_DEFAULTS` + `CLIENT_DEFAULTS` 三源同改）。原因：observe 零行为收益
>   却付出每消息一次的 LLM 判定 token；`judge-verdict` 仅 engine 发、无消费端。默认 off =
>   判别器不挂载 = 零成本，observe/active 由用户在配置卡片显式开启。`src/index.ts:96` 挂载门
>   保持 `mode !== 'off'`；engine 内部 `off→observe` 仅为防御性映射。
> - **设置项分级精简**：字段按 `visibility` 分级（core 常显 / tune 调节组 / debug 排障组 /
>   hidden 不单独渲染）；默认只露 6 个核心项（①②展开，③④默认折叠）。`compressionDriver`
>   （现仅 native 单值）与 `provider/model`（改由复合"模型路由"接管）设为 hidden。
> - **模型路由下拉**：`provider/model` 由自由文本改复合下拉（预设三源恒显示 + 配置目录
>   `session.modelCatalog()` 合并 + "手动填写（高级）"折叠区），与对话模型选择一致；选中
>   即同时写 provider+model，消除两者不匹配误配源。`journalPath` 改 CePath（默认目录|自定义）。
> - **帮助浮窗 + 危险确认**：长说明收进 CeTip（"?" 浮窗），下拉/浮窗/确认弹层全用
>   **position:fixed 定位到视口** + 高 z-index（3000/3500）——根因：AppFrame 与设置列都是
>   `overflow:hidden`，绝对定位子弹层被裁切（表现为"被侧边栏遮挡/不在最上层"）；fixed 不被
>   祖先 overflow 裁切（本卡无 transform 祖先），并在根层叠上下文压过内容列。不引入 react-dom portal
>   （本插件不带 react-dom 依赖）。「恢复默认」加 CeConfirm 二次确认（危险红，fixed 全屏遮罩）。
> - **高安全**：`save()` 改 `scope.mutate(ops, basedRevision)` revision-fence 原子提交；外部
>   配置变更触发 `conflicted`（提示刷新，不静默合并）。字段 parse 返回精确错误文案（如"需 ≥ 1000"），
>   非法值阻断保存。
> - **外观细节（UI 打磨）**：顶部品牌条改为 border-box 背景渐变首层（clip 到圆角，无"夹角"、
>   无需 overflow:hidden）；分组标题去掉序号（①②③④）与装饰圆点，改用 `client/icons.tsx`
>   分组图标（power/靶心/滑杆/数据库，currentColor 随 accent 上色）；选项标签分隔符
>   `·` 改「：」；「复原/放弃修改」用 `--dsw-alias-interactive-bg-hover-danger` 填充底 + 错误色
>   （不再只有框+文字）。
> - **纯逻辑下沉可单测**：`client/field-model.ts`（parse/format/默认解析/分流/路由合并），
>   新增 `tests/field-model.spec.ts`；`config-defaults.spec.ts` 追加 mode=off 回归断言。
>   client.js 104.25kB → 138.36kB。
> - **账本**：docs/07 §18 已追加本重构快照（唯一行为 Δ = mode 默认 off，judgeCount 默认归 0）。
>
> **v0.6.1：配置卡片 UI 打磨（2026-08，零行为 Δ，纯外表层）**：
> - **大折叠 + 模式常驻**：四组包进最外层「设置项」大折叠，默认收起（不干扰翻阅其它插件设置）；
>   展开时组内前两项（功能开关/识别与判断）默认开、后两项收。`discriminator.mode` 由组内上提为
>   卡片头部常驻项（关键开关零次点击），组内不再重复渲染（GroupBlock `skipField`）。
> - **纯 hover 帮助浮窗**：CeTip 去 click 兜底，改为 `?` 上鼠标悬浮即展、移入保持、移开后约
>   120ms 关（跨 6px 间隙用悬停缓冲桥接）；仍 position:fixed 最上层、不占布局。
> - **选项系统提示弱化**：CeSelect 把 `（跟随预设）/（默认）/（原生）` 等从主文本剥离，渲染成
>   值右侧**浅色副文案**（labelTertiary），值用 labelPrimary 锚定注意力；去掉中文全角括号错位，
>   改统一「值 + 浅色提示」对齐结构；纯提示项（如跟随预设）整行浅色斜体。
> - **加减步进钮**：CeNumber 的 `−/＋` 加 `--dsw-alias-fill-l2` 填充底 + hover 高亮，并
>   flex 居中修正字形基线偏移（不再靠行高）。
> - **标题对比度**：组标题由 accent 品牌色改 `--dsw-alias-label-primary`（白底对比达标），
>   品牌色只保留在图标/描边/顶部渐变条/主按钮；卡片描述改「自动识别对话节点，在合适的时机
>   帮你压缩上下文、节约 token。」，其余字段 hint/docs 按同一"严谨、专业但易懂"句式重写。
> - **零行为 Δ**：无 schema/判别/压缩逻辑改动，纯 client 外表层；client.js 138.36kB → 149.08kB。
>
> **v0.6.2：真·悬浮弹层 + 主题感知配色 + 原生 V + 父级层级（2026-08，零行为 Δ，纯外表层）**：
> - **根因修复（弹层真悬浮）**：`popover.ts` 落位 `setFixed({ position: 'fixed', left, top })`——
>   此前落位丢 `position` 掉成 static，弹层变成文档流块级元素、撑高卡片（"不是浮窗、影响布局"）。
>   现浮窗/下拉/`?` 提示/确认弹层真正脱离布局、压最上层（z-index 3000/3500）。
> - **下拉浮层**：显式取触发钮实宽（fixed 下 `minWidth:100%` 不再塌成视口宽）；`.ce-scroll-panel`
>   隐藏滚动条 + 保留滚轮；可滚动时顶/底叠透明→面板底色渐变预告（pointer-events:none，成熟的 UI）。
> - **原生同款宽 V**：提取 `IconChevronDownOutline14` 原生 path 成自包含 `Chevron`（不 import
>   官方图标包、不加依赖）；组头/「设置项」分区头/下拉触发钮全用它，rotate 表达开合，替换实心三角。
> - **主题感知配色（去硬编码）**：删除 `DS_BLUE/DS_BLUE_DARK` 及全部 `#4D6BFE/#4166D5/#0ea5e9/#7c3aed`；
>   改用 `--dsw-alias-state-{business,success,warn,error}-{primary,tertiary}`（亮/暗自动换值，
>   design-platform.css `body[data-ds-dark-theme]`），`tint()`（color-mix）做透明。顶部品牌条改
>   3px 实线 `state-business-primary`。
> - **功能区语义色（望色生义）**：四组 accent/tint = 功能开关 business(蓝)、识别与判断 success(绿)、
>   模型与调优 warn(琥珀)、高级与调试 error(红，仅小面积)；正文仍 `label-primary`。
> - **下拉项配色**：选中 = 品牌浅底 + 左 3px 类别竖条 + 值加粗 + **绿勾**(success-primary)；
>   每选项带类别彩色指示条（`EconomySelectOption.tone` 纯展示元数据，不影响值/parse）；系统提示灰。
> - **父级层级 + 对齐**：「设置项」= 父容器（bg-layer-1+border+圆角+分区标题行）包住四个子组；
>   取消 CeGroup body 横向缩进（paddingLeft+borderLeft）→「模式」行与组字段同一根左对齐竖线；
>   层级由容器视觉表达，不用缩进。
> - **文案一致性**：mode 字段 hint 补「（测量）」与下拉 observe 选项逐字一致；新增 spec 断言。
> - **零行为 Δ**：无 schema/判别/压缩逻辑改动；client.js 149.08kB → 155.33kB；**账本** docs/07 §18.6。
> - **稳定性与间距补丁**：模型下拉框删"文字型复原"胶囊（复位走「（跟随预设）」）；「复原」改
>   **预留 56px 右槽**（出现/消失零位移，可扩展到同排右侧控件）；保存按钮 `minWidth:88`、hint 行
>   `minHeight:14` 防条件渲染位移；组标题去"胶囊"改扁平行；父容器「设置项」`padding:6px 12px`、
>   「模式」行 `padding:0 12px` 统一 12px 内容列；`CeNumber` input 固定 100px + unit 固定 48px 槽
>   （单位不挤数值、数字行对齐）；链接/激活/开关 accent 由 `brandPrimary`→`businessPrimary`
>   （含 CePath 激活边框、CeToggle 默认 accent）。
>   client.js 155.33kB → 155.09kB；**账本** docs/07 §18.7。
> **v0.6.3：数字控件整行化 + 复原零位移（2026-08，零行为 Δ，纯外表层）**：
> - **数字控件整行化**：`CeNumber` 从 `fit-content` 窄带改为**整行框**（与 CeSelect 触发区同高/同描边/
>   同底色/同圆角），可编辑数值 `flex:1` 撑满 → 与下拉框/文本/路径字段左缘右缘同位、不再"太窄+不齐"。
> - **步进钮升级 + 单位贴后**：`+/−` 文字钮改为**上下 chevron**（沿用 CHEVRON_PATH 原生 wide-V，up/down
>   旋转），一组两钮 embed 整行尾部，fillL2 底 + borderLeft 分隔"编辑区/步进区"，hover 加深变色；
>   单位右对齐浅色、统一贴到步进列左侧（"放置在后"），不再挤数值、跨行同位。
> - **复原零 reflow**：「复原」**始终渲染、仅 `visibility:hidden` 切换**（占位恒定），出现/消失连垂直方向
>   也不跳；叠加 `disabled`+`tabIndex=-1`+`aria-hidden`，隐藏态鼠标/键盘/读屏均无法命中（仅占空间、无死区交互）。
> - **聚焦/步进交互**：`focus-within` 时框边 `businessPrimary`（invalid 恒 `errorPrimary`）；步进钮 hover
>   交互底+文字加深。
> - **零行为 Δ**：无 schema/判别/压缩逻辑改动；client.js 155.09kB → 156.28kB；**账本** docs/07 §18.8。
> - **下拉框滚动渐变淡出（bug 修复，随 v0.6.3）**：`CeSelect` 列表的顶部/底部渐变之前**只设 `left/right`、
>   漏 `top/bottom`**（absolute 落位到列表下方静态位置），滚动时看不到"还有内容"的渐隐提示；
>   已补 `top:4`/`bottom:4`（对齐 fixed 面板 4px padding）使两块渐变真正叠在列表边缘，与滚动检测联动。
>   作用域仅本插件下拉；「设置项」仍随外层滚动、不引入内部滚动。client.js 156.34kB → 156.38kB；
>   **账本** docs/07 §18.9。淡出明显度：高度 18→30px + 边缘 22% 保色平台，边缘内容少时也更清晰。
> **v0.2.0-s6（embedding 降级）**：边界语义票全套已移除——`src/votes/`（table + artifact）、
> `embedding.ts` 的投票/provider/端口实现、`makeVotes`、以及 `embeddingTier`/`taskEmbeddingThreshold`/
> `embeddingModel*` 配置字段。`embedding.ts` 仅留 `EmbeddingPort` 接口 + `cosineSimilarity`（零成本空壳，
> 供映射检索留门）；`models/`、`vendor/` 运行时不再随包（`files` 已去除）。判定固定纯机械。
>
> **harmless-on-harness 契约修复**：
> - 投影 `init()` 改为 `init(_header: SessionHeader)`（对齐 `ProjectionDefinition` 契约；state 由日志 fold 重建，header 仅占位）。
> - `todo/write` 事件所有权已迁至 `@deepseek-ai/dsh-tool-todo`（对 `SessionEventMap` 做声明合并），
>   需 `import type {} from '@deepseek-ai/dsh-tool-todo'` 载入合并，否则 `SessionEvent<'todo/write'>` 与
>   `case 'todo/write'` 类型检查失败（新版 harness 破坏性变更之一）。
> - `compactRegion`/`compactIfNeeded` 的 agent 参数按 `CompactionAgentContext`（`{session, options}`）类型化，
>   不再用 `as never` 强转。

## 6. 公共前缀 P 服务

```
P = [文件流段(文件与寻址域 vN)] [压缩段(压缩域摘要)] [目标/步骤段(输入域 task 定义 / 编排域子目标)]
```

**P**（提前拼好的公共前缀包：文件流内容+压缩摘要+任务目标）是这套东西的心脏。要点：

- P 是对象不是文本：不进对话历史，同版本逐字节可复现；
- 目标级更新（task 边界/管道模式切换时一次性重建）；
- 分发：主会话与编排域子代理请求共用（子代理 = P + 拆分片段 i）；
- 知识出口统一在提示词锚定段（docs/04，用户可见可改）——P 不含给模型的隐藏知识段。

用大白话讲：P 是一个**对象，不是一段文本**——它不进对话历史，而是被各段请求（主会话、子代理）当作同一份缓存前缀复用。同版本内容逐字节一致（**字节稳定**），这是缓存命中的物理基础。它只在 task 边界、管道模式切换这种**目标级**时刻才整体重建一次。P 没有"偷偷塞给模型"的隐藏段——所有给模型看的知识，都统一从提示词**锚定段**出口（docs/04），P 与锚定段是同一份数据（L3 + 意图映射表）的两个出口，同一版本源，永不漂移。

## 7. 意图映射表更新（task 周期，主插件执行）

订阅 `task-boundary`：意图映射表写入者（`mapping/updated`、`mapping/stale`）；
L3 差分与映射更新同步提交（同一 task 结束事务）；映射表结构规格在 docs/15。

**成对提交**的意思：L3 差分和映射表更新这两处变动，**同一次落盘**（同一 task 结束事务），要么都成、要么都放弃，不许只改一半。task 边界是主插件更新映射表的触发器。

## 8. L3 差分写

- task 结束证据（工具信号/用户纠正）→ 偏好/映射差分 +1 → 工作摘要按 task 归档（意图定义不挂 task，唯一在 docs/15）；
- 无证据 → 版本不变（零成本）；
- 用户编辑锚定段（提示词域高信号纠正，docs/04）优先级高于自动差分；同轮冲突用户编辑胜。

**差分写**就是只记录变化的部分，没变的字节不动。task 结束时，主插件看有没有证据（工具调用信号、用户纠正）；有就做偏好/映射差分、把**工作摘要**按 task 归档（注意是"工作摘要"，不是"意图摘要"——意图定义不挂在 task 上，唯一在 docs/15）；没证据就版本不变，零成本。用户**手动改锚定段**（提示词域的高信号纠正）优先级比自动差分高，同轮冲突时用户编辑赢。

## 9. 验收标准

- [ ] 恢复契约五步 ≥3 次恢复测试全部按序、可降级；
- [ ] 任一域对原生包 import 为零（CI 静态检查）；
- [ ] 四守卫各有装配期+运行期触发用例；
- [ ] 映射更新与 L3 差分同事务提交（测试断言幂等/一致）。
- [ ] settings：`context-economy` namespace 注册（describe 可读）、配置写入 revision 递增、
      判别器 mode 切换拆旧挂新（hook 数 +1/-1）；
- [ ] client：重启后 GUI 设置→插件→可配置 出现 context-economy 卡片；改字段保存生效
      （判账号本 call 字段反映新配置）；非法枚举保存被拒；host 半边全链路无需重启已验证。
- [x] client（v0.4.0-runtime3）：卡片按 4 组分层（编号标题+配色+折叠）；枚举下拉/数字步进/
      布尔复选框/文本 placeholder；头部鲸鱼娘吉祥物（MIT）；「恢复推荐默认」一键到 CONFIG_DEFAULTS；
      promptVersion 不再用户可见。待用户刷新后按 §18.3 视确认渲染与保存。
