import { defineConfig, mergeConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import sharedConfig from '../../vitest.shared';

// 插件包测试环境（CR-060：插件测试随实现内聚）。
// 需要 DOM 的组件用例在文件头用 `// @vitest-environment happy-dom` 单独声明，
// 其余用例保持 node 环境（SFC 编译在 node 下才具备文件系统访问能力）。
export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [vue()],
  }),
);
