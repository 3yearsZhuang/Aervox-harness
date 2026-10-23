---
id: AVX-GUIDE-004
---

# 操作指南：开发 Aervox 扩展插件（How-to）

<a id="AVX-TUT-003"></a>

关联：[Aervox 插件开发规范](../reference/plugin-config-and-pages.md)、[能力组合规范](../reference/capability-composition.md)、[ADR-009](../reference/adr/ADR-009-electron-plugin-sandbox.md)、[ADR-015](../reference/adr/ADR-015-vue-full-stack.md)。

本指南先制作一个可打包、预检、安装和保存配置的 Page 插件，再给出第一方 UI 与 Server Turn 的接入步骤。详细字段和安全边界以插件开发规范为准。Page 示例不需要模型密钥或新增依赖；第一方源码扩展需要随宿主构建，安装 ZIP 不会加载其中的任意 Vue/TypeScript 代码。

## 1. 准备开发环境并选择接入方式

在仓库根操作；先按[从哪开始](../getting-started.md)准备 mise 与依赖。新克隆按顺序执行，已完成安装且锁文件未变时跳过安装：

```bash
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm exec turbo run build --filter=@aervox/api
```

预期：API 及其依赖构建通过，存在 `apps/api/dist/app.js` 与 `packages/contracts/dist/index.js`。出现依赖包 `TS2307` 时先确认拓扑构建完成，不用系统 Node 或向子包重复安装依赖。

选择路径：配置表单/独立页面/声明式 Skill 使用 §2；在工作台插槽添加受信 Vue 组件使用 §3；改变回合前后行为使用 §4。后两者是主仓第一方集成；新增独立可执行可选模块须按能力组合规范裁定交付载体。声明式资源 Bundle 不要求为其虚构一个运行时模块。

本例把包和 API 验证数据放在临时目录，不覆盖当前插件。先创建工作目录，以下命令在同一终端连续执行：

```bash
PLUGIN_EXAMPLE_DIR="$(mktemp -d)"
mkdir -p "$PLUGIN_EXAMPLE_DIR/bundle/pages/dashboard"
```

## 2. 制作最小 Config + Page 分发包

### 2.0 用作者 CLI 快速开始

在独立临时目录生成可运行的 Config + Page 示例；`init` 要求目标目录尚不存在，`pack` 不覆盖已有产物：

```bash
PLUGIN_STARTER_DIR="$(mktemp -d)"
mise exec -- pnpm plugin init "$PLUGIN_STARTER_DIR/example" example
mise exec -- pnpm plugin check "$PLUGIN_STARTER_DIR/example"
mise exec -- pnpm plugin pack "$PLUGIN_STARTER_DIR/example" "$PLUGIN_STARTER_DIR/example-1.0.0.aervox-plugin"
```

命令构建并复用共享契约，验证 Manifest、宿主兼容要求、Config 作者规则、Page/Skill 入口、声明权限和允许的资源路径。`pack` 输出包路径及完整 SHA-256，同源码生成的字节稳定。它不会执行插件服务端代码，也不代替签名、真实安装和页面验收。以下 §2.1～2.5 使用前面 `PLUGIN_EXAMPLE_DIR` 下的手写示例，便于逐项理解接口。

### 2.1 写 Manifest 与配置

```bash
cat > "$PLUGIN_EXAMPLE_DIR/bundle/plugin.manifest.json" <<'JSON'
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginManifest",
  "requires": { "hostApiVersion": { "min": "1.0.0", "maxExclusive": "2.0.0" } },
  "metadata": {
    "id": "acme-focus-card",
    "displayName": "专注提示卡",
    "publisher": "acme",
    "version": "0.1.0",
    "description": "读取并保存一条专注提示",
    "license": "AGPL-3.0-or-later"
  },
  "spec": {
    "config": { "schemaVersion": 1, "entry": "config.schema.json" },
    "pages": [{
      "id": "dashboard",
      "title": "专注提示卡",
      "entry": "pages/dashboard/index.html",
      "capabilities": ["config.read", "config.write"]
    }]
  }
}
JSON
cat > "$PLUGIN_EXAMPLE_DIR/bundle/config.schema.json" <<'JSON'
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginConfigSchema",
  "schemaVersion": 1,
  "fields": [{
    "key": "message",
    "type": "string",
    "label": "专注提示",
    "default": "一次专注一件事",
    "required": true,
    "validation": { "minLength": 1, "maxLength": 120 }
  }]
}
JSON
```

预期：插件 ID 与目录/页面命名不冲突；配置使用 Aervox DSL。数值约束用 `min/max`，不要用 JSON Schema 的 `minimum/maximum`。`requires.hostApiVersion` 声明 `>= min`、`< maxExclusive` 的宿主 API 半开区间；省略要求的旧包默认兼容宿主 API v1。它与插件发布版本、Config 版本和根界面版本是不同概念，见[版本合同](../reference/plugin-config-and-pages.md#81-单文件分发包规范aervox-plugin)。

### 2.2 写页面与 Bridge 调用

```bash
cat > "$PLUGIN_EXAMPLE_DIR/bundle/pages/dashboard/index.html" <<'HTML'
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>专注提示卡</title>
  <style>
    body { font: 16px system-ui; margin: 2rem; color: #20252b; background: #fff; }
    label, input, button { display: block; margin: 1rem 0; }
    input { width: min(90%, 30rem); padding: .5rem; }
  </style>
</head>
<body>
  <h1>专注提示卡</h1>
  <label for="message">专注提示</label>
  <input id="message" maxlength="120" disabled>
  <button id="save" disabled>保存</button>
  <p id="status" role="status">等待宿主连接…</p>
  <script src="/v1/plugin-pages/bridge.js"></script>
  <script>
    const input = document.getElementById('message');
    const save = document.getElementById('save');
    const status = document.getElementById('status');
    const bridge = window.AervoxPluginPageBridge;
    (async () => {
      try {
        await bridge.ready();
        const snapshot = await bridge.getConfig();
        input.value = String(snapshot.values.message || '');
        input.disabled = false;
        save.disabled = false;
        status.textContent = '可以编辑';
      } catch (error) {
        status.textContent = '读取失败：' + error.message;
      }
    })();
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await bridge.saveConfig({ values: { message: input.value } });
        status.textContent = '已保存';
      } catch (error) {
        status.textContent = '保存失败，请重新打开页面后核对：' + error.message;
      } finally {
        save.disabled = false;
      }
    });
  </script>
</body>
</html>
HTML
```

这里显式加载 SDK、等待 `ready()`，再读取和保存本插件配置；用户文字通过 `textContent/value` 展示。可用 `bridge.onContext(handler)` 接收主题变化并在页面释放时取消订阅；`notify/close` 也返回 Promise，调用前分别声明 `host.notify/host.close` 并处理拒绝。不要直接用 `fetch` 调本地 API，也不要访问父 DOM、宿主存储或网络 CDN。独立双击 HTML 时没有宿主 init，不会进入可编辑状态，这是预期行为。

若只需提供模型技能，在 Bundle 根增加 `SKILL.md`（front matter 含 `name: acme-focus-card` 与 `description`）；正文写适用条件、使用步骤和退出条件。也可用 `spec.skill` 指向自定义入口，优先于根文件回退，仍按 pluginId 登记；`spec.skills[]` 的显式 `entry` 优先于 inline `content`。被显式引用的文件不会再扫描登记一次，传统入口按确定顺序发现，预检和安装使用同一技能集合。Skill 不执行脚本，不为模型授予工具或 OS 权限；多技能布局见[分发包规范](../reference/plugin-config-and-pages.md#81-单文件分发包规范aervox-plugin)。

### 2.3 校验并打包

使用同一作者 CLI 校验手写示例并生成包：

```bash
mise exec -- pnpm plugin check "$PLUGIN_EXAMPLE_DIR/bundle"
mise exec -- pnpm plugin pack "$PLUGIN_EXAMPLE_DIR/bundle" "$PLUGIN_EXAMPLE_DIR/acme-focus-card-0.1.0.aervox-plugin"
```

预期：检查报告没有 issues，打包输出完整路径及 64 位 SHA-256，ZIP 根直接包含 Manifest。修改包后使用新输出文件名或明确移走旧产物；命令不会悄悄覆盖已有包。配置注册、API 分发预检和 CLI 使用同一作者校验器，仍需额外验证资源依赖、功能及权限实际执行。

准备出厂声明包时，可将已评审资源放入 `plugins/<id>/` 后运行 `mise tasks run package-plugins`；批量入口也执行共享校验、排除第一方实现源码并生成字节可重现的 `dist/plugins/` 产物。该目录是 gitignore 生成物，测试不依赖其中的既有文件。运行 `mise tasks run check-standards` 可检查内置声明包、作者工具及历史 OpenAPI 结构兼容；该检查不代表签名或产品发布验收。

### 2.4 在临时数据库验证安装闭环

下面使用 `buildApp` 与 Fastify `inject`，不监听端口、不连接模型，不写当前主库。为 Skill、Page、附件和迁移状态注入临时路径；此方式用于开发验证，不能复制为生产关闭认证或合并隐私库的配置。

```bash
mise exec -- node --input-type=module - "$PLUGIN_EXAMPLE_DIR" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInMemoryDatabase, initDatabaseSchema } from './packages/repositories/dist/index.js';
import { buildApp } from './apps/api/dist/app.js';
const root = process.argv[2];
const db = await createInMemoryDatabase();
await initDatabaseSchema(db.client);
const { app } = await buildApp({
  db: db.db, client: db.client,
  auth: { mode: 'open' },
  skillsRoot: path.join(root, 'skills'),
  pluginsRoot: path.join(root, 'installed-pages'),
  attachmentsRoot: path.join(root, 'attachments'),
  migrationStatePath: path.join(root, 'migration-state.json'),
});
try {
  await app.ready();
  const packageBase64 = (await fs.readFile(path.join(root, 'acme-focus-card-0.1.0.aervox-plugin'))).toString('base64');
  const inspect = await app.inject({ method: 'POST', url: '/v1/plugins/inspect-package', payload: { packageBase64 } });
  assert.equal(inspect.statusCode, 200);
  assert.equal(inspect.json().isValid, true);
  const install = await app.inject({ method: 'POST', url: '/v1/plugins/install-package', payload: { packageBase64, overwrite: false } });
  assert.equal(install.statusCode, 201);
  const base = '/v1/plugins/acme-focus-card';
  const config = await app.inject({ method: 'GET', url: base + '/config' });
  assert.equal(config.json().values.message, '一次专注一件事');
  const revision = config.json().revision;
  const saved = await app.inject({ method: 'PUT', url: base + '/config', payload: { revision, values: { message: '先完成一个小目标' } } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().values.message, '先完成一个小目标');
  const stale = await app.inject({ method: 'PUT', url: base + '/config', payload: { revision, values: { message: '旧版本写入' } } });
  assert.equal(stale.statusCode, 409);
  const page = await app.inject({ method: 'GET', url: base + '/pages/dashboard/assets/index.html' });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('AervoxPluginPageBridge'));
  assert.ok(page.headers['content-security-policy'].includes("connect-src 'none'"));
  assert.equal((await app.inject({ method: 'PATCH', url: base, payload: { enabled: false } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: base + '/config' })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PATCH', url: base, payload: { enabled: true } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: base })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: base + '/config' })).statusCode, 404);
  console.log('PASS: inspect/install/config/revision-check/page/disable/enable/uninstall');
} finally {
  await app.close();
  await db.cleanup();
}
JS
```

预期输出 `PASS: inspect/install/config/revision-check/page/disable/enable/uninstall`。这是 API 验证，不会运行浏览器 Bridge JavaScript；不能据此声称 Page 的完整浏览器安全测试通过。

### 2.5 在工作台人工验证

使用本机 loopback、open 认证的独立开发实例验证本例（Token 模式页面资源授权缺口见规范 §3.2），打开插件管理的本地包安装，选择上一步 ZIP，核对预检显示 ID、发布者、版本、摘要、配置及页面能力，再安装。打开插件 Page，应先出现“可以编辑”，保存后显示“已保存”，关闭重开后值仍在；通用配置表单应显示相同值。

同时验证刷新、通过 `onContext` 接收的明暗主题、键盘操作、缺 capability 时拒绝，以及两个窗口持有同一 revision 后保存的冲突。配置保存使用 SQL revision CAS，旧 revision 返回 409 且不修改 Secret；遇到冲突重新读取并由用户核对合并，不要无条件覆盖重试。

验证伪造来源/旧 nonce 消息无效，重新加载或切换 Page 后旧请求结果不进入新页。用另一 API 客户端停用再启用插件，保持旧 iframe，验证配置、通知、关闭均被拒绝，刷新宿主后新 Page 可调用；移除 Page capability 后旧窗口也不能继续使用该能力。四种调用均复验当前 Page 及打开代际，配置返回前再复验；保存由宿主注入当前 `expectedPageId` 与代际，写事务再检查 `config.write`。在预检通过后、PUT 提交前移除该能力，验证返回 409 且配置 revision、值与 Secret 不变；插件不能通过 Bridge 参数伪造别的 Page 身份。界面获知禁用或不可用状态后销毁 iframe，入口 HTML 与普通资源也拒绝访问。尚无跨窗口或外部 API 变化的全局撤权实时推送；同代际撤权再授权、完整 Bearer 页面资源通道和任意第三方代码强制终止仍未验收，见[Page 边界](../reference/plugin-config-and-pages.md#32-已有防护与未完成边界)。控制台出现 CSP 错误时核对是否依赖远程资源；使用嵌套 Page 入口时，验证宿主打开声明的实际路径且相对脚本、样式和图片可加载，`assets/index.html` 只保留为兼容别名。

## 3. 接入第一方 Vue 插槽

### 3.1 定义组件与可回收注册

以下示例位于 `plugins/acme-focus-card/src/ui/`，由主仓第一方代码评审并通过插件包的公开入口导出；它不属于 §2 ZIP 的动态入口。创建 `FocusDraftButton.vue`：

```vue
<script setup lang="ts">
import { useWorkbenchContext } from '@aervox/ui/plugin-api';
const { composer } = useWorkbenchContext();
function draft() {
  if (!composer.input.value.trim()) {
    composer.input.value = '请帮助我把下一步任务拆成一个小目标';
  }
}
</script>

<template>
  <button type="button" @click="draft">起草下一步</button>
</template>
```

在同目录 `index.ts` 定义注册；ID 必须与对应插件主记录一致：

```ts
import type { BuiltinUIPlugin } from '@aervox/ui/plugin-api';
import FocusDraftButton from './FocusDraftButton.vue';

export const focusDraftPlugin: BuiltinUIPlugin = {
  id: 'acme-focus-card',
  setup(registry) {
    const remove = registry.registerSlotItem('composer:toolbar-actions', {
      id: 'acme-focus-card:draft-button',
      component: FocusDraftButton,
      priority: 10,
    });
    return () => remove();
  },
};
```

### 3.2 接入宿主并验证生命周期

经评审后，在 Web/桌面组合根的插件定义清单中加入该定义，由工作台的 `plugins` 参数注入 [plugin-runtime.ts](../../packages/ui/src/plugins/plugin-runtime.ts)。使用 setup 参数中的作用域注册表，避免依赖全局单例造成多窗口串扰。新增插件不会因 ZIP 里多了这个文件就被自动发现。

预期：工具栏出现“起草下一步”，空输入时填入草稿；已有输入不被覆盖；停用时按钮注销，再启用仅出现一次。参照 [plugin-registration.test.ts](../../plugins/focus-mode/test/plugin-registration.test.ts)验证重复同步与清理。真实功能应复用宿主按钮样式与无障碍规则。

卡片、其他槽位和组件替换的完整接口见[规范 §5–§7](../reference/plugin-config-and-pages.md#5-前端-ui-插槽扩展规范ui-extension-slots)。运行时自动收集通过作用域注册表登记的贡献，setup 返回 `void` 也只激活一次；组件替换可通过返回的注销函数撤销，停用时自动恢复仍存活的前一个替换或默认组件。替换 `ComposerDock` 仍须验证输入法、附件、语音与单次发送。

有外部计时器或异步请求时，在 setup 的第三个参数中登记资源并观察取消信号：

```ts
setup(registry, context, lifecycle) {
  if (!lifecycle) return;
  const { signal } = lifecycle;
  lifecycle.effect(() => {
    const timer = setInterval(() => refreshStatus(signal), 1000);
    return () => clearInterval(timer);
  });
}
```

`refreshStatus` 由插件实现，传入的信号供其请求取消及结果提交前检查。验证 setup 中途抛错后贡献消失、重复同步没有重复计时器、停用后迟到结果不回写；状态可通过 `getPluginState(id)` 查看。运行时关闭只释放本实例，不清除用户保存的插件偏好。

### 3.3 复用工作台控件

第一方插件从 `@aervox/ui/primitives` 导入[共享控件](../../packages/ui/src/primitives/index.ts)，让插件设置、工具栏和宿主页面使用一致的外观与交互：

- 操作按钮使用 `AervoxButton`，按用途选择 `primary`、`secondary`、`ghost` 或 `danger`；图标按钮提供 `aria-label`，异步操作绑定 `loading` 或 `disabled`。
- 布尔启停使用 `AervoxSwitch`，通过 `v-model` 更新本地状态；授权操作采用受控 `checked`，请求成功后再更新权威状态。勾选多项和确认条款仍用原生复选框及 `aervox-checkbox`。
- 记录卡片使用 `AervoxCard`；图标、名称和操作并列时设置 `layout="record"`，正文、操作和附加内容分别使用 `record-main`、`record-actions`、`record-detail`。共享布局负责窄窗口折行。
- 表单沿用原生 `input`、`select`、`textarea` 与 `aervox-field`，滑块使用 `aervox-range`；页面标题使用 `AervoxSettingsHeading`，互斥选项和页面切换使用 `AervoxSegmentedControl`（页面切换设置 `variant="tabs"`）。

局部样式只补充内容布局，不覆盖共享控件的颜色、圆角、尺寸和焦点状态。提交前检查明暗主题、窄窗口，以及禁用、加载和失败后的状态；插件启停仍按既有生命周期验证。可参考[插件开关与导航用例](../../plugins/focus-mode/test/ui-components.test.ts)。

## 4. 接入第一方 Server Turn Hook

### 4.1 定义 Hook 并显式注册

在 `plugins/acme-focus-card/src/server/turn-plugin.ts` 定义，从公开宿主契约导入类型：

```ts
import type { ServerTurnPlugin } from '@aervox/host-plugin-api';

export const focusCardTurnPlugin: ServerTurnPlugin = {
  id: 'acme-focus-card',
  beforeTurn(ctx, config) {
    ctx.signal.throwIfAborted();
    if (ctx.metadata?.mode !== 'acme-focus-card') return;
    const message = typeof config?.message === 'string'
      ? config.message
      : '一次专注一件事';
    return { extraSections: [`专注辅助要求：${message}`] };
  },
  async afterTurn(ctx, _config, beforeResult) {
    ctx.signal.throwIfAborted();
    if (ctx.status !== 'Completed' || !beforeResult) return;
    // 在此接入经过评审的轻量后处理；不要在数据库事务中调用 LLM。
  },
};
```

在 API 受信组合位置 import 该定义并调用 `registry.register(focusCardTurnPlugin)`；与[现有 focus-mode 装配](../../packages/host-runtime/src/plugin-assembly.ts)保持同一种装配方式（实现位于 `plugins/focus-mode/src/server/`，由该装配点以容错方式加载并注入）。也可在测试中通过 `buildApp({pluginRegistry})` 注入独立 `ServerPluginRegistry`。同时安装/登记相同 ID 的主记录，否则生产 Runner 的 enabled 门控不会激活它。

### 4.2 验证触发与边界

先用独立 registry 验证：未安装、禁用、metadata 不匹配均不注入；已启用且匹配时才返回片段；无保存配置时使用默认值。后置只复用配置快照，执行前重新检查当前 enabled/available；通过 `beforeResult` 传递前后状态。补充父回合取消、默认 15 秒期限、迟到结果丢弃和捕获端口失效的用例，业务副作用另行设计幂等。

`metadata` 在底层 Turn API 可用；本例只展示服务端接入，UI 须按当前工作台公开发送接口和插件状态映射验证透传，不能拼接 `[模式:...]` 文本控制标签。配置提示词内容视为用户输入资料，不承载授权策略；`extraSections` 不是安全控制器。

本例只是 Hook 接口示例，不宣称新模式已在 UI 或生产启用。Hook 上下文提供 `signal/deadlineEpochMs`，作者向异步调用传播信号；查询、配置读取、Hook 等待及窄端口均受执行范围约束。宿主默认单 Hook 15 秒，可配置到不超过 60 秒，父期限只能收紧。超时停止等待并关闭端口，不能强制终止同进程同步死循环，也不会撤销已接受的数据库写入。后置函数不自动成为可靠后台任务；耗时业务另行设计取消和恢复。

## 5. 运行验证并交付

按改动范围选取定向检查；含 API/仓储测试不要并发启动多个整套测试命令。命令从根执行：

```bash
# 共享作者规则与 OpenAPI 历史结构兼容
mise tasks run check-standards
# 分发、配置、主动规则与内置插件
mise exec -- pnpm --filter @aervox/api exec vitest run test/plugin-config.test.ts test/plugin-config-schema.test.ts test/plugin-distribution.test.ts test/plugin-upgrade.test.ts test/builtin-plugins-market.test.ts test/proactive-plugin-lifecycle.test.ts
# 修改第一方 Hook 时增加领域回归
mise exec -- pnpm --filter @aervox/api exec vitest run test/study-term-plugins.test.ts test/turn-plugin-lifecycle.test.ts test/turn-plugin-cancel-integration.test.ts
# 修改 UI 插槽/生命周期时（宿主通用接缝）
mise exec -- pnpm --filter @aervox/ui exec vitest run test/ui-registry.test.ts
# 修改第一方插件 UI 注册/清理与配置竞态时（实现已内聚到插件包）
mise exec -- pnpm --filter @aervox/plugin-focus-mode exec vitest run test/plugin-registration.test.ts
mise exec -- pnpm --filter @aervox/ui typecheck
mise exec -- pnpm --filter @aervox/api typecheck
# 依赖边界与文档检查
mise exec -- pnpm check:boundary
mise tasks run ci-docs
# 提交前按仓库要求执行双门禁；推送 PR 前终验
./aervox ci all
```

交付包含：源码与原始 `.aervox-plugin`、目标宿主版本/commit、完整 SHA-256、许可证与第三方依赖来源、权限和数据流说明、实际验证结果、升级/卸载影响及恢复步骤。先核对[规范发布清单](../reference/plugin-config-and-pages.md#9-验证与发布清单)，再在[落地追踪 §4.2](../reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)登记 CAP、位置、日期和验证证据。

覆盖安装先准备独立 generation，再以短事务激活，保留启停选择、配置、Secret 和既有授权，撤权不会复活。并发配置 revision 变化返回 `409 PLUGIN_INSTALL_CONFLICT`，调用方重新预检；不兼容配置变化须先提供迁移方案。generation 包的 Schema/Page 注册和资源上传返回 `409 PLUGIN_PACKAGE_IMMUTABLE`，修改包内容应重新打包升级，不直接覆盖已激活资源。

安装后导出返回保存的原始归档，不含用户配置/Secret，也不是任意后续文件改动的备份。旧代际保留至显式卸载；清理只删除带宿主所有权标记的代际及已登记 legacy Page 资源，未知 legacy 目录保留。当前没有运行失败后的自动回退、复杂迁移或旧代际垃圾回收。保留原包与必要数据副本，宿主代码回退先按 [ADR-028](../reference/adr/ADR-028-plugin-atomic-activation.md)核对资源布局兼容。源码与规范走功能分支/PR；扩大第三方执行权限或改变核心架构先走 ADR。

<a id="avx-tut-003"></a>
<a id="agent-tools"></a>

## 6. 添加 Agent 工具

工具通过第一方插件的 `toolContributions` 暴露给宿主。可运行参考为 [focus-mode 注册单元](../../plugins/focus-mode/src/server/index.ts)与[工具贡献](../../plugins/focus-mode/src/server/focus-tools.ts)，契约为 [PluginToolContribution](../../packages/host-plugin-api/src/index.ts)。不要照搬已删除教程中向宿主私有注册表直接注入的示意代码。

1. 在插件中定义 `ToolSpec` 的名称、描述、参数 Schema 与安全等级，写清真实副作用；`readOnly` 影响逐次审批，不能用于规避写入授权。
2. 在工具 Provider 中验证参数，通过宿主窄接口完成实际操作，不直接导入仓储。检查调用者取消、截止及授权修订，耗时 I/O 保持有界，失败明确返回错误。
3. 通过 `ServerPluginRegistration.toolContributions(services)` 构造贡献，必要的 `guidance`、结果投影和专用协议归插件所有；注册单元由宿主组合根显式装配。
4. 工具列表可见性与执行时资格分别验证：停用、缺包、撤权或旧实例不能继续执行。声明和提示词不能替代运行时检查。
5. 回归覆盖合法输入、非法参数、拒绝审批、停用后调用、取消/超时及结果投影；有写入时断言实际数据副作用和失败后的状态。跨进程工具同时检查子进程回收。
6. 按 §5 运行定向与边界检查，在 PR 中记录覆盖范围。涉及新权限、隔离模型或数据责任时先修订对应 ADR。
