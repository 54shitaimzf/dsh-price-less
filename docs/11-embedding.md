# 11 · Embedding 选型与降本增效

> 目的：为套件里的 embedding 用途（映射检索、任务类型路由、Tier-2/patch 弱票）
> 建立"能力边界 → 现状选型 → 特化降本"的完整决策基线。
> 铁律：embedding 是**增强项不是前提**（[docs/05 §3](05-rule-domain.md)），
> 一切优化都以"L0 机械匹配优先、embedding 只在低置信窗口触发"为前提。

## 0. 它解决什么问题（人话版）

这章讲的是"给 agent 配个**语义大脑**"这件事，但定位很明确：**是增强项，不是必需品**。痛点是——agent 想记住"项目里某种意图对应哪段代码"，或者一眼分辨"这是个什么类型的任务"，光靠逐字匹配不够，得有点语义联想能力。思路是用 **embedding**（把一段文字变成一串数字向量，语义相近的向量在空间里距离就近）来做检索、路由、分类；但**绝不包打天下**——能确定算出来的先用 L0 机械规则，只有低置信的窗口才轮到 embedding 出马。收益是能命中模糊表述、按语义归类；代价是 embedding 是个"笨"模型，对精确的符号/数字/路径、对"上下文里的隐含约束"都抓不住，那些必须靠机械层兜底。所以默认档是 `embeddingTier:'off'`（向量档关着，用关键词+路径前缀+符号名表等机械等价物替代），要开就往 tiny / standard 走，而不是一上来拖个几 GB 的大模型。

## 1. 能力面板：embedding 能做什么（以及不能做什么）

先用一句话说清楚这条界线：**embedding 负责"语义相近"这一类活（检索、相似度门控、路由分类、聚类、多语/代码检索）；精确符号/数字/路径匹配、以及生成与推理，由机械层（L0 symbol/Jaccard）与模型层承担**。下面拆成能做和做不了的。

能：

- **语义检索**（映射表 ↔ 用户意图）；**相似度门控**（patch 弱票、去重）；
- **路由/分类**（任务类型识别——一类模型可做 instruction-conditioned 检索）；
- **聚类**（task 摘要分组、会话分段、异常检测）；
- **双语/多语与跨语言检索**（中英混合项目单模型覆盖）；
- **代码检索**（代码 embedding 或 LLM-embedder 在代码+文档混合语料上训练）。

不能（边界，必须靠机械层兜底）：

- 精确符号/数字/路径匹配（embedding 模糊，L0 的 symbol/Jaccard 才可靠）；
- 生成与推理（它不是生成模型）；
- 语义不等于意图：用户"上下文里的隐含约束"embedding 抓不住（这正是偏好/映射差分机制存在的理由）。

## 2. 现状图谱（2025–2026）

**四族选型：**

| 族 | 代表 | 优劣 |
|---|---|---|
| 通用小模型（百 MB 内） | all-MiniLM、bge-small/base-zh、nomic | 体积小、快、可量化；复杂语义/长文本弱 |
| 多语通用（数百 MB） | **bge-m3**（8k 语境、1024 维、多语检索+多语相似度合一） | 中文+代码混合项目的实用标杆 |
| LLM-embedder（数 GB） | **Qwen3-Embedding**、gte-Qwen2-7B、[Llama-Embed-Nemotron-8B](https://ar5iv.labs.arxiv.org/html/2511.07025) | 质量碾压小模型（[Qwen3-Embedding 论文](https://huggingface.co/papers/2506.05176) 亦做 rerank）；体积=反模式的另一端 |
| 代码专项 | voyage-code、jina-code、代码混合蒸馏 | 代码语义检索高，但引入即多一个模型 |

这里 bge-m3 和 Qwen3-Embedding 是重点。简单记：**bge-m3 是一个中文多语 568M 的通用模型**（一模型多任务、中文强、成熟、量化齐全），是我们默认的实用标杆；**Qwen3-Embedding-0.6B 是一个 0.6B 指令式前沿模型**（2026 前沿、中英多语最强小份量、还带 rerank），但体积也要按 GB 算，是标准档里偏重的一端。下面的表格就是围绕这两者展开的。

**三个 2025–2026 的关键趋势（直接服务降本）：**

1. **Matryoshka 维度截断**：[向量可按需截断维度](https://learn.microsoft.com/zh-cn/azure/search/vector-search-how-to-truncate-dimensions)——1024 截到 128–256 维，存储/相似度计算省 4–8 倍，质量损失集中在保留前若干维上。说白了就是**向量按需截取前 128 维**，质量损失集中在前几维，成本却省下好几倍；
2. **量化**：int8/binary 让内存再降 4 倍，相似度门控场景损失常在误差内；
3. **hybrid（BM25 + dense + RRF）成为中文/代码检索的标准做法**（[中文 RAG 管线实践](https://github.com/yiongq/mcp-chinese-rag-toolkit)）：稀疏检索廉价可靠、dense 兜语义——**这正是我们"机械优先 + embedding 兜底"的学术对应物**。这里的 BM25 是**关键词稀疏检索**（便宜、精确、可解释），dense 是**向量稠密检索**（兜语义），hybrid 就是**两者加权混用**。

### 2.1 候选模型评估（2026 前沿 × 契合度）

评估基准 = 我们的四点需求：①中英+代码混合 ②短句分类/路由与检索 ③本地/量化/CPU ④体积分段与降本。

| 模型 | 规格 | 契合度 | 优点 | 缺点 | 档位 |
|---|---|---|---|---|---|
| **Qwen3-Embedding-0.6B** | 0.6B、指令式、MTEB 前沿、含 rerank | 高 | 2026 前沿；中英+多语最强小份量 | ~0.6–1.3GB(int8)；需指令前缀 | standard+ / high |
| Qwen3-Embedding-4B/8B | 数 GB | 低-中 | 质量天花板 | 体积=反模式；除非实测路由不达标 | high（仅实测） |
| **bge-m3** | 568M、1024 维、8k、dense+sparse+multi | 高（综合默认） | 一模型多任务；中文强；成熟/量化全 | 非最前沿；multi-vector 全用贵（我们只跑 dense） | standard（默认） |
| bge-small/base-zh | 24M/109M、512/768 维 | 中 | 体积最小、CPU 快 | 中英混合/代码弱 | tiny |
| Conan-Embedding-v2（腾讯） | 中文特化 | 中 | 中文新秀 | 代码/多语待实测 | standard 备选 |
| nomic-embed-text-v1.5 | 137M、768 维、Matryoshka | 低-中 | 英文好、可截断 | 中文/代码一般 | 英文 tiny |
| API 系（OpenAI v3-large / Cohere v4） | — | 低（宪法冲突） | 质量好 | 非本地、按次付费 | 仅对照 |

**选型三条判断**（比榜单分更重要）：

1. 榜单高分 ≠ 我们场景收益——用途是短句分类+top-K+门控，bge-m3 与 Qwen3-0.6B 差距在此大概率是噪音级，由 docs/08 实测定胜负；
2. 0.6B 的"小"是相对的（GB 级仍重）→ 归 standard+/high，tiny 依旧留给老小模型；
3. 前沿模型换来的是说明书成本（指令前缀/量化曲线/onnx 导出/多语回退）——按"选型→冒烟→docs/08 实测"三步推进。
4. **选型规则：standard 默认 bge-m3，Qwen3-0.6B 实测挑战；换档先于微调（§3）**。

## 3. 针对我们的特化降本清单（按收益排序）

| # | 手段 | 收益 | 落点 |
|---|---|---|---|
| 1 | **L0 先行，dense 只在低置信窗口触发**（BM25/symbol/Jaccard 先跑） | dense 触发率压到最低 → 推理成本≈0 | docs/05 回退链（已定） |
| 2 | **向量缓存**：用户消息/摘要按内容哈希缓存向量，近重复输入零重编码 | 重复场景 0 成本 | L3 附带向量缓存 |
| 3 | **Matryoshka 截断**：选支持截断的模型，跑 128 维 | 存储/计算省 4–8 倍 | 配置 `dimension: 128` |
| 4 | int8 量化 + 懒加载/空闲卸载 | 内存峰值再降 4 倍 | docs/05 §3（已定） |
| 5 | **空闲预计算**：task 摘要/文档映射的向量在空闲时批量算好落盘，查询只编码短消息 | 查询侧零索引编码 | 度量账本（docs/07） |
| 6 | 域内蒸馏/小模型（中文/TS 固定域 → bge-small-zh 类） | 体积与延迟最小 | 按用户工作负载选档 |
| 7 | **rerank 保持关闭**：embedding 召回即可；仅当 docs/08 试验证明召回质量不足才评估轻量 rerank | 省一次全量 rerank 每请求成本 | docs/08 判定 |

这张清单的排序其实就是"成本从低到高、收益从高到低"：**先把 L0 机械匹配跑足，把 dense 触发率压到最低（推理成本≈0），再谈截断、量化、缓存**。rerank 默认关闭——embedding 召回在门控场景足够；除非实测召回真的不够，才由 docs/08 判定开启。

## 4. 明确的"不高"清单

- 默认拖数 GB 的 LLM-embedder（质量收益被 L0 先行吸收大半，体积代价是反面的）——**除非**实测任务类型路由准确率不达标；
- 为每个用途各装一个模型（一个指令型小模型/或 bge-m3 单模型覆盖检索+路由即可）。

## 5. 验收基线（进 docs/08）

- 映射检索：`embeddingTier:'off'`（机械）vs `'tiny'`/'standard' 的召回差可测；
- 触发率：dense 实际调用次数/请求 < 20%（L0 先行有效性的硬指标）；
- 质量闸：仅当"机械召回不达标"才许开更高档，禁止用 embedding 补机械层的系统性缺口。

## 6. 输入设计准则：格式即特征（embedding 的分工边界）

embedding 是"笨"模型，它的分类/检索质量高度依赖输入形态。提示词产品域的**统一输出格式**（docs/04 §2.1）就是为它做的特征工程：

- **主目标恒为第一节**（固定标题、固定措辞）→ embedding 只编码 Goal 节即可精确做任务类型路由与映射检索；
- **不编码全文**：分类只看前段，省编码 token、索引更小；
- **先规范化、后 embedding**：格式是 L0 确定性产物，embedding 只是"读固定槽位的一行字"——通过输入设计让笨模型够用；分工边界到此为止：embedding 读固定槽位，反馈闭环与端到端联合优化不在职责内，由人工配置参数（docs/08 预注册判定）。

## 9. 实测结论（v0.1.0-s3：语义票线上对照）

> 接口已落地：`SemanticVoteProvider`（`src/task/embedding.ts`）+ `SemanticVoteTable` 运行时通道
> + `embeddingTier:'local'` 档（Ollama /api/embed，模型 `qwen3-embedding:0.6b`，639MB，40ms/次）。
> 以下是用真实模型在归档会话上的**判定质量**实测（非推测）：

**实验**：Qwen3-Embedding-0.6B 余弦（当前用户消息 vs 当前 task 宣言锚）作语义票，
`score < threshold` ⇒ 边界候选；对照纯机械 v2。GT=用户意图标定（dsp-14b/dsp-c388/card-b5f9）。
严格评分（turn/end 索引精确匹配）：**总 F1 基线 24.0% → 语义票 on@0.5 16.7%（Δ −7.3pp）**；
召回 +35.7pp 但 FP 从 8 涨到 74（precision 27.3%→9.8%）。

**为什么（可分离性诊断）**：边界 turn 与任务内 turn 的相似度分布完全重叠（均值差 <0.05，
标准差同量级；dsp-14b 上甚至方向相反：新任务 0.534 vs 任务内 0.505）。步进锚（vs 上一消息）
方向正确但依然重叠（0.487 vs 0.574）。

**根因**：Qwen3-Embedding 的语义空间按"话题/句式/领域词"组织；本项目换向大多发生在
**同领域、同句式**的指令之间（"审查一下 X"→"Y 有问题，谈谈"），任务标识不在句子语义里，
在**任务级目标/约束的漂移**里——短句余弦抓不到。

**结论与下一步（探针候选，按成本排序）**：
1. **任务摘要锚**：锚 = task 压缩摘要（跨 task 语义断层在摘要层更显著），而非单条宣言；
2. **检索式探针**：用 Qwen3-Embedding 的 query 指令模板把"当前任务目标"编码为 query、
   "下一条用户指令"编码为 doc，做不对称检索打分（而非对称余弦）；
3. **任务级分类器**：轻量分类模型（意图域路由），预算内 128 维（`embeddingDimension`）；
4. 或接受"换向 = 机械强信号 + 显式命令"的保守组合（当前默认），把 embedding 留给
   映射检索（文档语义检索是它的强项，与本节诊断不矛盾）。

## 10. 2026.8 选型重验与插件内打包形态（v0.2.0）

> 上一轮（§9）默认模型为 Qwen3-Embedding-0.6B（Ollama 外部服务，639MB）。
> 用户质询"100M 以内最先进"后重验（HF 实测文件尺寸），结论：**选型改为
> `ibm-granite/granite-embedding-97m-multilingual-r2`（2026-05，Apache-2.0，97M 参数 =
> "Sub-100M 检索 SOTA"，多语，32K 上下文），量化 ONNX 93.3MB**。

### 失格清单（实测，非推测）

| 候选 | 实测体积 | 结论 |
|---|---|---|
| Qwen3-Embedding-0.6B | GGUF 639MB / ONNX q8 585MB | 顶配档（experimental），超出 100M |
| KaLM-embedding-multilingual-mini-instruct-v2.5 | ONNX q8 **536MB**（名字 mini≠体积小） | 出局 |
| granite-embedding-107m-multilingual | fp16 204MB / ONNX fp32 408MB | 出局（无现成 ≤100M 量化 ONNX） |
| geevec-embeddings-1.0-lite | 698MB | 出局 |
| **granite-embedding-97m-multilingual-r2** | **ONNX q8 93.3MB**（onnx-community 导出） | **✅ 入选**（官方 1_Pooling=CLS+Normalize，384 维） |

### 打包形态（单插件确保的最终回答）

```
插件包（@dsh-external/dsh-context-economy, v0.2.0）
├─ lib/                            # 编译产物
├─ models/granite-embedding-97m-multilingual-r2/   # 118MB（模型 93.3 + tokenizer 24）
├─ vendor/embedding-runtime/       # 81MB（transformers.js CJS + onnxruntime-node win32-x64 CPU 精简）
│    └─ README.md  + scripts/setup_vendor.ps1      # 复现：npm install → sharp 存根 → 平台裁剪
└─ src/  ...（SemanticVoteProvider / LiteEmbeddingPort / 档位工厂）
```

- **零外部服务**：推理 = transformers.js CJS + onnxruntime-node（CPU），首次加载 ~840ms，
  热推理 **3-4ms/条**（384 维 CLS+normalize；对比 Ollama 0.6B 40ms + 外部进程）；
- **零 C 盘**：全部文件随插件目录（本会话为 D:\deepseek-plugin，junction 装配不复制）；
- **离线可用**：模型随包分发（local_files_only），不联网；
- **插拔档位**：`embeddingTier: 'off' | 'lite'(默认打包档) | 'local'(外部 Ollama，experimental)`；
  `embeddingModel/embeddingModelDir/embeddingVendorDir/taskEmbeddingThreshold` 均可配置；
  provider 接口（SemanticVoteProvider/EmbeddingPort）不变，测试全绿 66/66。
- 注意事项：sharp 以存根满足（仅文本推理，图像功能禁用）；裁剪仅保留 win32-x64 CPU 后端并
  删除 GPU EP（DirectML/dxcompiler）与 wasm——如需 GPU 加速可经 setup 脚本参数放开。
- 代价诚实声明：模型 q8 量化 + BERT 各向异性 → 原始余弦区间压缩（0.70-0.79）——
  与 §9 结论一致，**不得用"宣言锚距离"作为判据**；判别须用原型三类对比 / 相对差（见 §9 下一步）。
