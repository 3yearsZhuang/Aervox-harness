---
id: AVX-GUIDE-004
type: how-to
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.2.0
updated_at: 2026-09-10
reviewed_at: 2026-09-10
review_interval_days: 90
review_triggers:
  - plugins/**
  - apps/api/src/modules/plugins/**
  - packages/ui/src/registry/**
  - packages/ui/src/plugins/**
  - packages/ui/src/components/extension/**
  - packages/ui/src/components/workbench/ComposerDock.vue
sources:
  - docs/reference/plugin-config-and-pages.md
  - docs/reference/capability-composition.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
  - docs/reference/adr/ADR-015-vue-full-stack.md
---

# 操作指南：开发 Aervox 扩展插件（How-to）

- 提出人：linge · 2026-09-09
- 修改人：3yearszhuang · 2026-09-11

关联：[插件 Config、Page 与 UI 扩展规范](../reference/plugin-config-and-pages.md) · [能力组合与可选化目录规范](../reference/capability-composition.md) · [ADR-009](../reference/adr/ADR-009-electron-plugin-sandbox.md) · [ADR-015](../reference/adr/ADR-015-vue-full-stack.md)

本指南指导插件开发者如何基于 Aervox 插件体系开发扩展插件。涵盖全栈插件生命周期：

1. **插件 Bundle 结构与配置 Schema**；
2. **服务端 Turn 插件与提示词动态插槽（`extraSections`）注入**；
3. **结构化元数据通信（消除纯文本前缀污染）**；
4. **前端 UI 插槽注入与工作台状态联动**；
5. **核心交互层替换与安全门禁验证**。

## 1. 概念与双轨安全边界

在开始前，请根据插件类型确认接入方式：

1. **第一方 / 受信插件**：可以直接编写 Vue 组件并通过 `uiRegistry` 注入插槽或替换核心组件；
2. **第三方外部插件**：出于安全边界要求（ADR-009），第三方代码必须通过受限 iframe 沙箱（`PluginPageDialog`）与 Bridge SDK 运行，禁止直接注入未受审计的代码至主应用 DOM。

规范定义见 [插件 Config、Page 与 UI 扩展规范](../reference/plugin-config-and-pages.md)。

## 2. 任务一：声明插件 Bundle 与配置模型

### 2.1 适用场景

为系统增加一个可独立分发、可启停并在系统设置中提供可视化配置表单的插件。

### 2.2 目录约定

在 `plugins/<plugin-id>/` 下建立标准 Bundle 目录：

```text
plugins/my-helper/
├── plugin.manifest.json   # 插件基础元数据与能力声明
├── config.schema.json     # 可视化配置 Schema（v1 规范）
└── SKILL.md               # 渐进披露给 Agent 的技能指导（可选）
```

### 2.3 编写 `config.schema.json`

基于 PluginConfigSchema v1 声明类型安全的可视化配置，系统设置面板将自动渲染对应的控制表单：

```json
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginConfigSchema",
  "schemaVersion": 1,
  "fields": [
    {
      "key": "strictGuidance",
      "type": "boolean",
      "label": "严格引导模式",
      "description": "开启后禁止直接给出最终答案，引导用户自主思考",
      "default": true
    },
    {
      "key": "scaffoldingSteps",
      "type": "integer",
      "label": "拆解步骤深度",
      "description": "复杂知识点拆解的小步骤数（建议 2~5）",
      "default": 3,
      "validation": { "minimum": 1, "maximum": 10 }
    }
  ]
}
```

## 3. 任务二：开发服务端 Turn 插件与提示词切面注入

### 3.1 适用场景

当插件需要影响 Agent 的推理行为、注入专属领域知识/教学原则，或者在回合结束后执行异步分析与沉淀时接入。

### 3.2 架构硬约束（纯净底座红线）

- **禁止修改 `base-prompt.ts`**：`packages/agent-loop/src/base-prompt.ts` 必须保持纯净通用，严禁将特定业务或插件逻辑以 `if (isMyPlugin)` 等形式硬编码侵入；
- **统一经由 `extraSections` 注入**：所有专属模式提示词一律在 `beforeTurn` 阶段动态构造并通过 `extraSections: string[]` 返回。

### 3.3 编写服务端 Turn 插件

在 `apps/api/src/modules/plugins/turn-plugins/<plugin-id>.ts` 编写服务端插件：

```ts
import type {
  AfterTurnContext,
  BeforeTurnResult,
  ServerTurnPlugin,
  TurnPluginContext,
} from './types.js';

export const myHelperTurnPlugin: ServerTurnPlugin = {
  id: 'my-helper',

  /** 前置切面：根据请求元数据与租户配置动态决定是否注入专属提示词 */
  async beforeTurn(ctx: TurnPluginContext, configValues?: Record<string, unknown>): Promise<BeforeTurnResult | void> {
    // 1. 检查请求元数据是否触发本插件（推荐）
    const isTriggered = ctx.metadata?.mode === 'my-helper';
    if (!isTriggered) return;

    // 2. 读取系统自动注入的租户配置（未配置时自动回退默认值）
    const isStrict = typeof configValues?.strictGuidance === 'boolean' ? configValues.strictGuidance : true;
    const steps = typeof configValues?.scaffoldingSteps === 'number' ? configValues.scaffoldingSteps : 3;

    // 3. 构建专属提示词片段
    const promptSection = `
# 我的助手核心原则
1. 采用分步拆解引导，当前拆解深度为 ${steps} 步。
2. ${isStrict ? '【严格模式】：绝对不要直接输出最终答案。' : '提供思路提示并引导用户探索。'}
`.trim();

    return {
      extraSections: [promptSection],
    };
  },

  /** 后置切面：回合终态后异步执行增强逻辑（不阻塞主响应流） */
  async afterTurn(ctx: AfterTurnContext, configValues?: Record<string, unknown>): Promise<void> {
    if (ctx.status !== 'Completed') return;

    // 可通过 ctx.llm 独立执行轻量单步语义抽取、记忆沉淀或打点
    // 异常会被外层安全拦截，不影响主会话状态
  },
};
```

编排器会自动对接 `IExtensionRepository` 检查当前租户是否启用该插件（`enabled === 1`），并自动加载 `IPluginConfigRepository` 的配置传入 `configValues`。

## 4. 任务三：前端结构化元数据协同（消除纯文本污染）

### 4.1 适用场景

当客户端与插件协同发起带有特定模式或意图的对话时，传递领域控制信息。

### 4.2 最佳实践

**严禁**通过字符串拼接的方式在用户消息文本中硬塞 `[模式：xxx]` 等技术标签。统一使用结构化 `metadata`：

```ts
import { useWorkbenchContext } from '@aervox/ui';

const { sendMessage } = useWorkbenchContext();

// 发送带有插件模式的纯净消息
await sendMessage('我想复习第二章的内容', {
  metadata: {
    mode: 'my-helper',
    focusTopic: 'chapter-2',
  },
});
```

服务端在 `TurnPluginContext.metadata` 中直接获取此对象，用户的历史消息记录与展示流保持绝对纯净。

## 5. 任务四：向指定插槽注入自定义操作

### 5.1 适用场景

为工作台添加快捷按钮、扩展小工具或自定义指示卡片，例如在输入框工具栏添加「一键翻译」按钮。

### 5.2 步骤

1. **编写自定义 Vue 组件**：

```vue
<!-- MyTranslateButton.vue -->
<script setup lang="ts">
import { Languages } from 'lucide-vue-next';
import { useWorkbenchContext } from '@aervox/ui';

const { composer } = useWorkbenchContext();

function handleTranslate() {
  if (!composer.input.value.trim()) return;
  composer.input.value = `[请翻译为中文] ${composer.input.value}`;
}
</script>

<template>
  <button
    class="composer-op-btn"
    type="button"
    title="快速翻译当前输入"
    @click="handleTranslate"
  >
    <Languages :size="15" />
    <span>翻译</span>
  </button>
</template>
```

1. **在插件入口注册插槽项**：

```ts
import { uiRegistry } from '@aervox/ui';
import MyTranslateButton from './MyTranslateButton.vue';

// 注册至输入框工具栏（可使用 registerSlotItem 或 registerSlotComponent）
const unregister = uiRegistry.registerSlotItem('composer:toolbar-actions', {
  id: 'my-translate-plugin:toolbar-btn',
  component: MyTranslateButton,
  priority: 10, // 数值越大越靠左/靠前
});
// 亦可使用三参数形式：uiRegistry.registerSlotComponent('composer:toolbar-actions', MyTranslateButton, { id: '...', priority: 10 });

// 在插件停用或卸载时调用注销函数
export function onDeactivate() {
  unregister();
}
```

1. **可选插槽清单（ExtensionSlotName）**：
   - 顶部操作区前置/后置：`header:before` / `header:actions`
   - 主导航胶囊展开区：`nav:menu-items`
   - 侧边卡槽区：`sidecards:widgets`
   - 对话流顶部/底部：`conversation:top` / `conversation:bottom`
   - 单条消息气泡操作：`message:bubble-actions`
   - 输入框底座工具栏/底栏：`composer:toolbar-actions` / `composer:bottom-bar`
   - 系统设置分类页签：`settings:tabs`

## 6. 任务五：消费与联动宿主工作台状态

插件组件可通过 `useWorkbenchContext()` 依赖注入安全获取宿主状态：

```ts
import { useWorkbenchContext } from '@aervox/ui';

const {
  layout,       // layout.focusModeEnabled 开关专注模式（兼容 studyModeEnabled），layout.openTool 打开抽屉
  timer,        // timer.timerRunning, timer.formattedTime 番茄钟状态
  composer,     // composer.input, composer.pendingAttachments 输入内容与附件列表
  conversation, // conversation.story 历史会话，conversation.streaming 流式中标记
  sendMessage,  // sendMessage('消息内容', { metadata: { ... } }) 主动触发一次消息发送
} = useWorkbenchContext();
```

注意事项：

- 优先消费只读状态，通过暴露的受控方法（如 `sendMessage`、`layout.setFocusModeEnabled`）变更状态；
- 禁止直接修改非自身持有的深层只读属性。

## 7. 任务六：替换核心表现层组件（Component Overrides）

### 7.1 适用场景

当需要完全定制聊天输入坞的交互形式（例如多模态画板输入、代码专用输入器）时，可以替换内置的 `ComposerDock`。

### 7.2 步骤

1. **编写替换组件，遵循 `ComposerContractProps` 契约**：

```vue
<!-- CustomComposer.vue -->
<script setup lang="ts">
import type { ComposerContractProps } from '@aervox/ui';

const props = withDefaults(defineProps<ComposerContractProps>(), {
  input: '',
  streaming: false,
  isComposing: false,
  enterToSend: true,
  placeholder: '请输入消息…',
});

const emit = defineEmits<{
  (e: 'update:input', value: string): void;
  (e: 'send', text?: string, options?: { resend?: boolean }): void;
}>();

function handleSubmit() {
  if (props.streaming || props.isComposing || !props.input.trim()) return;

  // 单通道派发原则：若宿主传递了 onSend，只调用回调，不重复 emit
  if (props.onSend) {
    void props.onSend(props.input);
  } else {
    emit('send', props.input);
  }
}
</script>

<template>
  <div class="custom-composer">
    <textarea
      :value="input"
      :disabled="streaming"
      @input="emit('update:input', ($event.target as HTMLTextAreaElement).value)"
    />
    <button type="button" :disabled="streaming" @click="handleSubmit">
      {{ streaming ? '生成中…' : '发送' }}
    </button>
  </div>
</template>
```

1. **注册组件替换**：

```ts
import { uiRegistry } from '@aervox/ui';
import CustomComposer from './CustomComposer.vue';

uiRegistry.overrideComponent('ComposerDock', CustomComposer);
```

1. **防重入规范（高危陷阱）**：
   - 必须遵守**单通道派发原则**：若检测到 `props.onSend` 回调，则只执行该回调；未检测到时才回退至 `emit('send')`。切勿同时调用两者，否则会导致带附件消息的并发双重提交；
   - 宿主端已具备 `isSendingMessage` 互斥锁与 `attachmentUploading` 守卫，但插件端仍应在 UI 上将提交按钮置灰（`:disabled="streaming"`）。

## 8. 错误隔离与容错机制

工作台插槽内置了 Vue `onErrorCaptured` 容错隔离沙盒（`ExtensionSlotItem`）：

- 若插件组件在生命周期、计算属性或渲染中抛出未捕获异常，异常将被局部拦截，不会向上冒泡导致整个工作台或对话白屏；
- 出错组件会被卸载并自动显示降级占位徽标；
- 插件开发者在控制台可观察到详细错误调用栈以便调试。

## 9. 验证与门禁检查

完成开发后，执行以下命令进行本地验证：

```bash
# 1. UI 扩展单元测试
mise x -- pnpm --filter @aervox/ui test

# 2. 服务端插件与 API 集成测试
mise x -- pnpm --filter @aervox/api test

# 3. TypeScript 全仓类型检查
mise x -- pnpm --filter @aervox/ui typecheck
mise x -- pnpm --filter @aervox/api typecheck

# 4. 架构依赖边界守卫
node scripts/import-boundary.mjs

# 5. 文档与治理门禁
mise tasks run ci-docs
```
