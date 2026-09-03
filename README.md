# @dsh-external/dsh-context-economy

DSH 插件：**全面 token 节约 + 执行效率**（`src/config.ts` 装配，schema 见 `src/config.ts`）。

## 当前落地状态（v0.8.0）

| 能力 | 状态 | 代码 | 文档 |
|---|---|---|---|
| 判别器（task 边界语义判定） | ✅ | `src/discriminator/*` | [docs/03](docs/03-input-domain.md) |
| 判别器 → 段状态机（语义票合议，active 模式） | ✅ v0.8.0 | `src/task/projection.ts` + `engine.ts` | docs/03 §5 |
| 任务段状态机（投影 fold） | ✅ | `src/task/projection.ts` | docs/03 |
| 显式 `/task` 指令 | ✅ | `src/task/explicit.ts` | docs/03 |
| 压缩触发 + 溢出接管 | ✅ | `src/task/{orchestrator,driver,range,compaction}.ts` | [docs/02](docs/02-compaction.md) |
| task 分划压缩选择（近因门+冷区闭合任务） | ✅ | `src/task/range-task-partitioned.ts` | docs/02 §4.5 |
| 结构化摘要 schema / 缓存 / 按 task 落盘 | ✅（L0） | `src/task/{digest-schema,digest-cache,digest-store}.ts` | docs/02 §4.5 |
| digest 替换检查点事务（G2 自研驱动，端到端） | 📐 | `src/task/{summarizer,driver-task-partitioned}.ts` | docs/02 §4.5 Next |
| 配置 schema | ✅ | `src/config.ts` | [docs/00 §2](docs/00-overview.md) |
| 提示词产品域 / 编排域 / 文件与寻址域 | 📐 蓝图（未实现） | — | docs/04 / 13 / 15 |

## 快速上手（读文档）

1. **[docs/00](docs/00-overview.md)** 系统总览——**先看状态标注**（✅ 已落地 / 📐 蓝图），不把设计当现状；
2. **[docs/03](docs/03-input-domain.md)** 判别器真相：决策链（T0/L0/L1/LLM/fail-lazy）、窗口口径、自适应链、溯源记录、observe/active 模式；
3. **[docs/07 §0.5](docs/07-metrics.md)** 当前已落地指标一览（定义 + 观测方式 + 代码落点 + 改造协议）。

宪法与回退链：[docs/05](docs/05-rule-domain.md)（确定性优先 / 字节稳定 / 账本快照 / 配对 Δ）。

## 构建 / 测试 / 挂载

```bash
# 构建（需先建立 checkout 依赖 junction）
DSH_CHECKOUT=G:/deepseek-harness bash scripts/build.sh   # 或等价 tsc 编译（见 docs/00）
npm run test      # vitest 全量单测（76 用例）
npm run typecheck

# 热装配到当前 DSH 实例（免重启，替换 <root> 为本目录）
dev_install_package <root>      # 双路径一致：重启后由 profile bundles 装配
dev_uninject_plugin dsh-context-economy   # 卸载即净（回滚）
```

> 装配后判别器默认 **off**（不挂载，零成本）；判别记录 = 日志行
> `context-economy: judge record <json>`（grep 即回放）。observe/active 需在配置卡片显式开启。