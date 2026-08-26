# Hello Aervox Demo 插件

演示 Aervox 插件 Config 与 Page 能力的最小示例（规范见 [插件 Config 与 Page 规范](../../docs/reference/plugin-config-and-pages.md)）。

## 内容

- `plugin.manifest.json`：插件 Manifest v1（声明配置与一个 Page）；
- `config.schema.json`：Config Schema v1（string / boolean / secret 三种字段）；
- `pages/dashboard/index.html`：使用 Page Bridge 读取/保存配置、发送宿主通知并关闭的页面；
- `install.mjs`：一键安装脚本。

## 安装

1. 启动 API：`pnpm --filter @aervox/api dev`；
2. 安装：`node demos/plugin-hello/install.mjs`；
3. 打开 Web/Desktop 设置 → 插件 → `hello-aervox`：
   - 「配置」打开配置弹窗，编辑问候语、启用开关与密钥；
   - 「页面」打开 iframe 页面，可读取/保存配置、发送通知。

可选环境变量：`AERVOX_API_URL`、`AERVOX_WORKSPACE_ID`、`AERVOX_USER_ID`。
