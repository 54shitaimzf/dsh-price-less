/**
 * context-economy client bundle 构建（外部插件自包含形态，参照 dsh-super-injector）。
 *
 * 产物契约（与官方 clientConfig / 注入器 client.js 一致）：
 * - CJS 格式 + `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`
 *   包装——Loader 模块表按 id 装配；factory 接收注入的 require；
 * - react / @deepseek-ai/dsh-client-store 等共享模块表项保持 external（不打包，
 *   运行时由模块表提供）；其余（本插件代码）全部内联；
 * - 无 CSS 文件（样式用内联 style 对象，避开 lightningcss 依赖链）。
 *
 * type-only import（@deepseek-ai/dsh-client-ui-settings/client、
 * @deepseek-ai/dsh-api-remotes/client、.../ui-settings-plugins/client）在编译时擦除，
 * 不产生运行时依赖——mono 纯度规则的镜像自查：本 bundle 不得运行时 import
 * 共享模块表之外的 @deepseek-ai 包。
 */

import { defineConfig } from 'tsdown'

/** 共享模块表（packages/client/web/src/platform.ts PLATFORM_MODULES）中本 bundle 用到的行。 */
const SHARED = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
]

export default defineConfig({
  name: '@dsh-external/dsh-context-economy/client',
  entry: { client: 'client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => SHARED.includes(specifier),
    alwaysBundle: (specifier: string) => !SHARED.includes(specifier),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: 'window.__ModuleLoader__.load({ id: "@dsh-external/dsh-context-economy", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})