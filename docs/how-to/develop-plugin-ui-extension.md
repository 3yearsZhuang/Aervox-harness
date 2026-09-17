---
id: AVX-GUIDE-004
type: how-to
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.0.0
updated_at: 2026-09-18
reviewed_at: 2026-09-18
review_interval_days: 90
review_triggers:
  - plugins/**
  - apps/api/src/modules/ecosystem/plugins/**
  - packages/ui/src/registry/**
  - packages/ui/src/plugins/**
  - packages/ui/src/components/extension/**
  - packages/ui/src/composables/workbench-context.ts
  - scripts/export-plugins.mjs
sources:
  - docs/reference/plugin-config-and-pages.md
  - docs/reference/capability-composition.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
  - docs/reference/adr/ADR-015-vue-full-stack.md
---

# 操作指南：开发 Aervox 扩展插件（How-to）

- 提出人：linge · 2026-09-09
- 修改人：3yearszhuang · 2026-09-18

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

### 2.1 写 Manifest 与配置

```bash
cat > "$PLUGIN_EXAMPLE_DIR/bundle/plugin.manifest.json" <<'JSON'
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginManifest",
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

预期：插件 ID 与目录/页面命名不冲突；配置使用 Aervox DSL。数值约束用 `min/max`，不要用 JSON Schema 的 `minimum/maximum`。

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

这里显式加载 SDK、等待 `ready()`，再读取和保存本插件配置；用户文字通过 `textContent/value` 展示。不要直接用 `fetch` 调本地 API，也不要访问父 DOM、宿主存储或网络 CDN。独立双击 HTML 时没有宿主 init，不会进入可编辑状态，这是预期行为。

若只需提供模型技能，在 Bundle 根增加 `SKILL.md`（front matter 含 `name: acme-focus-card` 与 `description`）；正文写适用条件、使用步骤和退出条件。Skill 不执行脚本，不为模型授予工具或 OS 权限；多技能布局见[分发包规范](../reference/plugin-config-and-pages.md#81-单文件分发包规范aervox-plugin)。

### 2.3 校验并打包

以下脚本使用本仓已有 `fflate` 与构建出的契约/解析器，不依赖全局打包工具：

```bash
mise exec -- node --input-type=module - "$PLUGIN_EXAMPLE_DIR" <<'JS'
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { pluginManifestSchema } from './packages/contracts/dist/index.js';
import { parseConfigSchema, applyDefaults, validateValues } from './apps/api/dist/modules/ecosystem/plugins/config-schema.js';
const root = process.argv[2];
const bundle = path.join(root, 'bundle');
const manifest = pluginManifestSchema.parse(JSON.parse(await fs.readFile(path.join(bundle, 'plugin.manifest.json'), 'utf8')));
const fields = parseConfigSchema(JSON.parse(await fs.readFile(path.join(bundle, 'config.schema.json'), 'utf8')));
const result = validateValues(fields, applyDefaults(fields));
if (result.issues.length) throw new Error(JSON.stringify(result.issues));
const files = {};
async function collect(dir, prefix = '') {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('symbolic links are not allowed');
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await collect(path.join(dir, entry.name), relative + '/');
    else files[relative] = new Uint8Array(await fs.readFile(path.join(dir, entry.name)));
  }
}
await collect(bundle);
const bytes = zipSync(files, { level: 6 });
const filename = `${manifest.metadata.id}-${manifest.metadata.version}.aervox-plugin`;
await fs.writeFile(path.join(root, filename), bytes);
console.log(path.join(root, filename));
console.log('sha256:' + createHash('sha256').update(bytes).digest('hex'));
JS
```

预期：输出完整包路径及 64 位 SHA-256；ZIP 根直接包含 Manifest。该校验覆盖本例所用字段，不是完整安全审核。准备出厂声明包时，可将已评审资源加入 `plugins/<id>/` 后运行 `mise exec -- pnpm package:plugins`，得到 `dist-plugins/` 产物；该批量命令本身只打包。

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

同时验证刷新、深浅主题可读性、键盘操作、缺能力时的错误、先后保存的旧版本冲突。当前 revision 是前置检查，并发窗口仍可能丢失更新；并发验证必须记录该缺口，不得将其报告为已实现的原子 CAS。禁用插件后配置访问应被拒绝；当前入口 HTML/已有 iframe 撤权存在已登记缺口，见[Page 边界](../reference/plugin-config-and-pages.md#32-已有防护与未完成边界)，不能把缺口当作预期安全承诺。浏览器控制台出现 CSP 错误时核对是否依赖了远程资源。

## 3. 接入第一方 Vue 插槽

### 3.1 定义组件与可回收注册

以下示例位于 `packages/ui/src/plugins/<id>/`，由主仓第一方代码评审；它不属于 §2 ZIP 的动态入口。创建 `FocusDraftButton.vue`：

```vue
<script setup lang="ts">
import { useWorkbenchContext } from '../../composables/workbench-context';
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
import type { BuiltinUIPlugin } from '../plugin-runtime';
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

经评审后，将定义显式加入 [plugin-runtime.ts](../../packages/ui/src/plugins/plugin-runtime.ts) 的受信插件清单，或在已有宿主组合点传入 `customPlugins`。使用当前工作台的 registry，避免依赖全局单例造成多窗口串扰。新增插件不会因 ZIP 里多了这个文件就被自动发现。

预期：工具栏出现“起草下一步”，空输入时填入草稿；已有输入不被覆盖；停用时按钮注销，再启用仅出现一次。参照 [study-mode-plugin.test.ts](../../packages/ui/test/study-mode-plugin.test.ts)验证重复同步与清理。真实功能应复用宿主按钮样式与无障碍规则。

卡片、其他槽位和组件替换的完整接口见[规范 §5–§7](../reference/plugin-config-and-pages.md#5-前端-ui-插槽扩展规范ui-extension-slots)。特别注意：`overrideComponent` 没有 disposer，不能用 `registry.clear()` 停用单个插件；替换 `ComposerDock` 时必须由宿主安排恢复，并验证输入法、附件、语音与单次发送。

## 4. 接入第一方 Server Turn Hook

### 4.1 定义 Hook 并显式注册

在 `apps/api/src/modules/ecosystem/plugins/turn-plugins/<id>.ts` 定义，导入路径按当前位置调整：

```ts
import type { ServerTurnPlugin } from './types.js';

export const focusCardTurnPlugin: ServerTurnPlugin = {
  id: 'acme-focus-card',
  beforeTurn(ctx, config) {
    if (ctx.metadata?.mode !== 'acme-focus-card') return;
    const message = typeof config?.message === 'string'
      ? config.message
      : '一次专注一件事';
    return { extraSections: [`专注辅助要求：${message}`] };
  },
  async afterTurn(ctx, _config, beforeResult) {
    if (ctx.status !== 'Completed' || !beforeResult) return;
    // 在此接入经过评审的轻量后处理；不要在数据库事务中调用 LLM。
  },
};
```

在 API 受信组合位置 import 该定义并调用 `registry.register(focusCardTurnPlugin)`；与[现有 focus-mode 注册](../../apps/api/src/modules/ecosystem/plugins/turn-plugins/focus-mode.ts)保持同一种装配方式。也可在测试中通过 `buildApp({pluginRegistry})` 注入独立 `ServerPluginRegistry`。同时安装/登记相同 ID 的主记录，否则生产 Runner 的 enabled 门控不会激活它。

### 4.2 验证触发与边界

先用独立 registry 的测试验证：未安装、禁用、metadata 不匹配均不注入；已启用且 metadata 匹配时才返回片段；无保存配置时使用默认值；Hook 抛错不改变其他 Hook 的结果。通过 `[beforeResult]` 传递前后状态，并考虑后置重复运行时的幂等性。

`metadata` 在底层 Turn API 可用；当前 `useWorkbenchContext().sendMessage` 只接受 `quizMode/resend`。如需 UI 发起上例模式，应先设计并验证宿主发送适配，不能向该方法硬传 `metadata`，也不能拼接 `[模式:...]` 标签。配置提示词内容视为用户输入资料，不承载授权策略；`extraSections` 不是安全控制器。

本例只是 Hook 接口示例，不宣称新模式已在 UI 或生产启用。没有 Hook 硬超时与进程沙箱，后置异步函数也不自动成为可靠后台任务；新耗时业务应复用既有任务架构并单独设计取消/失败恢复。

## 5. 运行验证并交付

按改动范围选取定向检查；含 API/仓储测试不要并发启动多个整套测试命令。命令从根执行：

```bash
# 分发、配置、主动规则与内置插件
mise exec -- pnpm --filter @aervox/api exec vitest run test/plugin-config.test.ts test/plugin-distribution.test.ts test/builtin-plugins-market.test.ts test/proactive-plugin-lifecycle.test.ts
# 修改第一方 Hook 时增加领域回归
mise exec -- pnpm --filter @aervox/api exec vitest run test/study-term-plugins.test.ts
# 修改 UI 插槽/生命周期时
mise exec -- pnpm --filter @aervox/ui exec vitest run test/ui-registry.test.ts test/study-mode-plugin.test.ts
mise exec -- pnpm --filter @aervox/ui typecheck
mise exec -- pnpm --filter @aervox/api typecheck
# 依赖边界与文档检查
mise exec -- pnpm check:boundary
mise tasks run ci-docs
# 提交前按仓库要求执行双门禁；推送 PR 前终验
./aervox ci all
```

2026-09-18 本轮核验：上面首条 API 定向命令通过 4 文件 / 23 用例，UI 定向命令通过 2 文件 / 15 用例；这是已有回归的结果，不证明规范中列出的实现缺口已修复，也不替代新功能测试或本次 PR 全量门禁。

本轮也已按 §1 完成 API 及依赖的拓扑构建，并实际连续执行 §2 的文件生成、契约/默认值校验、ZIP 打包和临时数据库验证脚本，得到 `PASS: inspect/install/config/revision-check/page/disable/enable/uninstall`。该结果验证串行旧版本拒绝与 API 闭环；未执行 §2.5 的浏览器人工验证、Token 模式 Page 访问、并发配置写入或真实模型调用。

交付包含：源码与原始 `.aervox-plugin`、目标宿主版本/commit、完整 SHA-256、许可证与第三方依赖来源、权限和数据流说明、实际验证结果、升级/卸载影响及恢复步骤。先核对[规范发布清单](../reference/plugin-config-and-pages.md#9-验证与发布清单)，再在[落地追踪 §4.2](../reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)登记 CAP、位置、日期和验证证据。

覆盖安装先卸载旧版本，会清理配置、Secret 和授权；不可把 `overwrite: true` 当作无损升级。原始包及必要数据副本必须保留，动态插件的当前导出不等于完整备份。源码与规范修改走功能分支/PR；扩大第三方执行权限或改变核心架构先走 CR，不以一份安装包绕过评审。
