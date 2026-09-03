# relaudit

插件发布流水线审计器：在发布前审计插件包（版本门 / tarball 结构 / lib 完整性 /
沙箱规则 / 依赖清单 / CHANGELOG 格式 / README 一致性），并渲染报告面板。

## 快速开始

```bash
npm test        # 运行全部领域与契约测试
npm run start   # 启动本地服务（http://127.0.0.1:8787）
npm run check   # 自检：数据与样例包完整性
```

## 审计对象

`sample-pkg/` 是一个示例插件包（含 link 依赖、发布脚本、CHANGELOG 与产物 tarball），
审计器对它执行 R1–R8 规则并产出结构化报告。

## 接口

详见 `docs/api.md` 与 `docs/rules.md`。
