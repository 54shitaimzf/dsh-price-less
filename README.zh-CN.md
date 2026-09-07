<div align="center">

<img src="docs/icons/whale-ring.png" alt="dsh-price-less —— 官方鲸鱼与上下文 token 消耗环" width="120" />

# dsh-price-less

**DeepSeek Harness 上下文管理插件**

> **留下无价的想法，省去有价的过程。**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-development-yellow.svg)]()
[![DSH](https://img.shields.io/badge/DSH-plugin--bundle-blue.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)]()

[English](./README.md) · [中文](./README.zh-CN.md)

</div>

---

## 目录

- [项目介绍](#项目介绍)
- [当前状态](#当前状态)
- [核心特性](#核心特性)
- [架构](#架构)
- [快速开始](#快速开始)
  - [环境要求](#环境要求)
  - [源码安装](#源码安装)
- [使用](#使用)
- [配置](#配置)
- [命令](#命令)
- [会话事实](#会话事实)
- [文档](#文档)
- [路线图](#路线图)
- [已知限制](#已知限制)
- [贡献](#贡献)
- [许可证](#许可证)
- [致谢](#致谢)

## 项目介绍

AI 编程会话越长越贵，也越容易跑偏。`dsh-price-less` 是非官方的 DeepSeek Harness **上下文管家**：它替你记住“现在在干嘛”，自动整理送进模型的上下文——该留的留下，该删的删掉，拿不准的不动，让每个 token 都花在刀刃上。

- **显式大任务（task）**：`/task` 一句话告诉插件现在在干嘛；开新任务、收尾旧任务，始终由你拍板
- **项目档案（project frame）**：`/init` 一问一答生成项目背景卡，模型始终带着“这是个什么项目”干活
- **自动识别**：判断每条消息是延续当前大任务，还是开了新的大任务——先关键词规则，拿不准才请轻量模型
- **提示词优化器**：`/optimize-prompt` 手动整理当前提示词，未来与星标按钮共用同一入口
- **只记账、可回放**：插件每个动作都留下可回放的事实日志；任何失败都“不动刀”，绝不弄丢你的内容

## 当前状态

| 区域 | 状态 |
|---|---|
| R1 平台底座（事件、存储、日志、模型调用） | 已完成 |
| R2 识别与优化核心（P8–P13） | 已完成 |
| P14a/P14b 提示词优化器与星标按钮 | 尚未接线 |
| R3 剪切（工具结果瘦身）/ R4 压缩（历史压缩） | 计划中 |
| npm / tarball 发布 | 尚未发布 |

> **重要**：自动识别默认**关闭**，需要显式设置 `discriminator.auto = true` 才会启用。`/optimize-prompt` 命令已注册，但完整提示词优化流程要等 P14b 后才可用。

## 核心特性

- **大任务边界**：`/task`、`/task close`、`/task` 查看状态——把连续的工作切成一段段边界清晰的大任务
- **项目档案**：`/init` 提案 → 你确认 → 写入项目档案 v1（`project_frame`）
- **自动识别**：先看你的显式指令，再跑零成本关键词规则，然后比对过往判定，最后才请轻量模型——任何一步拿不准就保持原样（fail-lazy）
- **提示词优化器**：`/optimize-prompt` 入口，后续与星标按钮共用
- **事实可回放**：`context-economy/*` 事件全部只记账（log-only）、不打扰会话（ignorable）
- **优雅降级**：harness 缺少 ignorable 通道时自动降级为 KV 事实镜像——事实照样留底，只是换了存放处

## 架构

![架构](docs/architecture.zh-CN.png)

上图是当前实现架构的彩色分层图，已实现的模块用实线/彩色标注，计划中的模块用虚线标注。一句话读图：顶层是你和 harness；domains 决定“做什么”，core 负责“怎么算”，platform 负责“怎么连”，最底层是留下来的三类数据。

```text
src/
├─ platform/    # 适配层：插件与 harness 打交道的唯一出口
├─ core/        # 纯逻辑：只做计算，不依赖 harness
├─ domains/     # 编排层：命令、自动识别、流程串接
├─ config.ts    # 配置项与默认值
├─ settings.ts  # 设置界面接线
└─ index.ts     # 插件入口
client/         # 设置卡片与星标按钮界面
docs/           # 设计文档与施工工单
```

## 快速开始

### 环境要求

- 支持 ESM 的 Node.js（建议 Node 20+）
- 本地 DeepSeek Harness 源码仓库（用于构建）
- `dsh` CLI 或 `dev_inject_plugin`（用于加载插件）

### 源码安装

当前只有**源码构建 / 开发者安装**方式，还没有发布 npm 包或 tarball。

```bash
# 1. 安装依赖
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund --no-package-lock

# 2. 从源码构建（需要本地 DSH checkout）
DSH_CHECKOUT=/path/to/deepseek-harness npm run build

# 3. 注入到 DSH 实例
dev_inject_plugin /path/to/dsh-price-less
```

计划中的发布形态（当前不可用）：

- npm：`dsh plugin add dsh-price-less`
- tarball：`dsh plugin add ./dsh-price-less-0.0.1.tgz`

## 使用

```text
/init 我要做一个上下文管理插件
/init confirm

/task 设计命令面
/task
/task close
```

## 配置

当前配置集中在 `discriminator` 命名空间。

| 配置 | 类型 | schema 默认值 | 说明 |
|---|---|---|---|
| `discriminator.auto` | boolean | `false` | 自动识别总开关 |
| `discriminator.provider` | string | 未设置 | 辅助模型 provider；与 `model` 同时设置时覆盖内置预设 |
| `discriminator.model` | string | 未设置 | 辅助模型；与 `provider` 同时设置时覆盖内置预设 |

> schema 未给 `provider` / `model` 声明默认值。留空时，辅助调用（自动识别、`/init`）回落到内置预设 `deepseek-official` / `deepseek-v4-flash-vision-exp`；两项**都**填写时以配置为准。开启 `discriminator.auto` 或使用 `/init` 可能会调用辅助模型，产生 API 费用，并可能把相关提示词内容发送给所配置的服务商。

## 命令

| 命令 | 作用 |
|---|---|
| `/task <描述>` | 显式开启一个新大任务 |
| `/task close` | 收尾当前大任务 |
| `/task` | 查看当前大任务状态 |
| `/init <项目目标>` | 发起项目档案初始化提案 |
| `/init confirm` | 确认并写入项目档案 v1（`project_frame`） |
| `/init cancel` | 取消当前提案 |
| `/init` | 查看当前项目档案 |
| `/optimize-prompt` | 提示词优化器入口；完整流程待 P14b |

## 会话事实

当前已发射的自定义事件均为只记账（log-only），并携带 `ignorable: true`。

| 事件 | 含义 |
|---|---|
| `context-economy/task-boundary` | 大任务边界事实（开了 / 关了哪个任务） |
| `context-economy/judge-recorded` | 一次自动识别的完整记录 |
| `context-economy/judge-error` | 一次识别失败的记录 |
| `context-economy/judge-verdict` | 识别结论：是不是新大任务 |

## 文档

设计正典维护在 [`docs/`](docs/) 下：

- [00 · 系统导览](docs/00-overview.md)
- [01 · 架构](docs/01-architecture.md)
- [02 · 判别器](docs/02-discriminator.md)
- [03 · 剪切层](docs/03-shear.md)
- [04 · 压缩器](docs/04-compactor.md)
- [05 · 宪法](docs/05-constitution.md)
- [06 · 缓存](docs/06-cache.md)
- [07 · 度量](docs/07-metrics.md)
- [09 · 状态](docs/09-state.md)
- [10 · 挂点](docs/10-wiring.md)
- [11 · 工程结构](docs/11-structure.md)
- [12 · 平台能力](docs/12-platform-capabilities.md)
- [13 · DSH 插件规范](docs/13-harness-plugin-spec.md)
- [施工总纲](docs/implement/00-master.md)

## 路线图

| 阶段 | 范围 | 状态 |
|---|---|---|
| R1 | 平台底座：事件、存储、技能目录、模型调用、历史改写、工具 | 已完成 |
| R2 | 识别域：大任务边界、项目档案、自动识别与提示词优化 | P8–P13 已完成；P14 待接入 |
| R3 | 剪切：工具结果瘦身 | 计划中 |
| R4 | 压缩：历史压缩 | 计划中 |

详细工单见 [docs/implement/00-master.md](docs/implement/00-master.md)。

## 已知限制

- **尚未发布**：`package.json` 仍标记为 `private`，暂无官方 npm/tarball 发布。
- **自动识别默认关闭**：`discriminator.auto` 默认为 `false`，避免产生非预期的辅助模型费用。
- **提示词优化器不完整**：`/optimize-prompt` 目前只是入口，完整星标流程依赖 P14b。
- **R3/R4 尚未实现**：剪切（工具结果瘦身）与压缩（历史压缩）仍在设计/计划阶段。
- **需要本地 checkout**：当前构建需要本地 DeepSeek Harness 源码仓库和 `dev_inject_plugin`。
- **依赖 ignorable 通道**：如果宿主 harness 未包含本地 ignorable 通道，插件事实会降级到 KV 镜像，而不是写入会话事件；在上游通道合并前，回放和可观测性可能受限。
- **模型调用**：开启自动识别或使用 `/init` 可能将内容发送给所配置的辅助模型，并产生费用。
- **非隶属关系**：本项目与 DeepSeek 无隶属关系。

## 贡献

欢迎提交 Issue 与 PR。提交前请确保：

```bash
npm run gate
```

全绿。

修改文档时，请同步更新 `README.md` 和 `README.zh-CN.md`。

## 许可证

[MIT](LICENSE)

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Cordis](https://github.com/cordijs/cordis)
- 灵感来自 `docs/` 中的上下文经济设计

> 本项目与 DeepSeek 无隶属关系。
