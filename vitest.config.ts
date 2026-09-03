import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 评测沙箱（experiments/evalground）有自己的离线断言体系（npm run ground:assert），
    // 其 fixtures/relaudit 是假项目工作区内容——被默认 glob 扫到会产生加载错误，
    // 不属于插件测试面。插件测试 = tests/*.spec.ts。
    exclude: ['**/node_modules/**', '**/dist/**', 'experiments/**', 'lib/**'],
  },
})
