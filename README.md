# @dsh-external/dsh-context-economy

> **实现状态（2026-09）：R0 ✓ · R1 3/8（events/logger/diag-sink）· R2–R4 设计态；P1.2 地基修补 ✓。**
> 当前是**模板态骨架**：装配/构建/测试/设置 UI 壳全部可用，双核心与四层防御的机制代码
> 尚未施工（工单进度见 [docs/implement/00-master.md](docs/implement/00-master.md)）。
> 打包清单、干净构建、client 卸载冒烟与 purpose/T-entry 契约锚已补齐（P1.2）；
> 观察模式设置项已清理；R3/R4 不再组织对照实验（实验结论已固化进设计）。

DSH 的**全自动上下文管理工具**：判别、剪切、压缩自转，无人值守；用户唯一的主动作是可选的
星标（把散落的意图/约束/验收/路径整理成一份确定化的执行包）。

**五条节约理念**：缓存复用 · 软件架构经验提取 · 无关内容剪枝 · 执行路线确定化 ·
多做（相信用户决策）· 只在必要时刻探索 —— 正典见 [docs/00 §1](docs/00-overview.md)。

## 一图

```
 ├─ 核心一 优化判别器（02）：一个理解核、两个断面（星标手动 / 自动对表）
 ├─ 核心二 压缩器（04）：边界装配+热尾 · 压力路径 40% · 防溢出保险丝
 ├─ 叠加层 剪切层（03）：工具剪切四档 + 对话 run 剪切
 └─ 支撑面：宪法守卫（05）· 缓存纪律（06）· 度量（07）· 实验史（08，封存）
          · 状态版本（09）· 挂点（10）· 工程结构（11）
```

## 读文档（推荐序）

1. **[docs/00](docs/00-overview.md)** 总览：定位、五理念、公共契约、术语、路线图；
2. **[docs/01](docs/01-architecture.md)** 架构总纲：平面分层、分划单位正典、四层防御；
3. **[docs/02](docs/02-discriminator.md)** / **[docs/03](docs/03-shear.md)** /
   **[docs/04](docs/04-compactor.md)** 双核心与剪切层（机制设计正典）；
4. **[docs/11](docs/11-structure.md)** 工程结构与搭建（模块树 / 数据面 / UI 壳 / R0–R4）；
5. 按需：宪法 [05](docs/05-constitution.md) · 缓存 [06](docs/06-cache.md) · 度量 [07](docs/07-metrics.md)
   · 实验 [08](docs/08-experiment.md) · 状态 [09](docs/09-state.md) · 挂点 [10](docs/10-wiring.md)。

**实验框架**：`experiments/evalground/` **已封存**（结论固化进 docs/02–04 设计与常数；
不再作为门禁，run 证据原样保留）。`docs/08-experiment.md` 保留为历史方法学。
**存档**：退役设计 = [docs/legacy.md](docs/legacy.md)；账本历史 = [docs/ledger-history.md](docs/ledger-history.md)（只增不改）。

## 构建 / 测试 / 挂载

```bash
# 构建（需先建立 checkout 依赖 junction）
DSH_CHECKOUT=G:/deepseek-harness npm run build       # host tsc + client tsdown
npm run typecheck && npm run typecheck:client
npm run test                                          # vitest（壳不变量）

# 注入到 DSH 实例（注入器环境内）
dev_inject_plugin <本目录>      # 卸载：dev_uninject_plugin dsh-context-economy
```

> 装配后自动链默认 **off**（不挂载，零成本）；星标通道常在。设置卡壳 + 星标按钮 +
> 消息列表度量可视化按 [docs/11 §5](docs/11-structure.md) 接线，设置项载荷唯一入口
> `client/field-model.ts`。
