---
id: AVX-GUIDE-004
type: how-to
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.1.0
updated_at: 2026-09-09
reviewed_at: 2026-09-09
review_interval_days: 90
review_triggers:
  - packages/ui/src/registry/**
  - packages/ui/src/components/extension/**
  - packages/ui/src/components/workbench/ComposerDock.vue
sources:
  - docs/reference/plugin-config-and-pages.md
  - docs/reference/capability-composition.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
  - docs/reference/adr/ADR-015-vue-full-stack.md
---

# 操作指南：开发工作台 UI 扩展插件（How-to）

- 提出人：linge · 2026-09-09
- 修改人：linge · 2026-09-09

> 文档编号：AVX-GUIDE-004
> 类型：How-to
> 版本：v0.1.0
> 更新日期：2026-09-09
> 状态：Review Candidate
> 关联：[插件 Config、Page 与 UI 扩展规范](../reference/plugin-config-and-pages.md) · [能力组合与可选化目录规范](../reference/capability-composition.md) · [ADR-009](../reference/adr/ADR-009-electron-plugin-sandbox.md) · [ADR-015](../reference/adr/ADR-015-vue-full-stack.md)

本指南指导插件开发者如何基于 Aervox 前端 UI 扩展体系开发扩展插件。内容包括：如何在 10 个预设插槽中注入自定义 Vue 组件、如何读取与联动宿主工作台状态，以及如何安全替换工作台核心表现层（如输入底座 ComposerDock）。

## 1. 概念与双轨安全边界

在开始前，请根据插件类型确认接入方式：

1. **第一方 / 受信插件**：可以直接编写 Vue 组件并通过 `uiRegistry` 注入插槽或替换核心组件；
2. **第三方外部插件**：出于安全边界要求（ADR-009），第三方代码必须通过受限 iframe 沙箱（`PluginPageDialog`）与 Bridge SDK 运行，禁止直接注入未受审计的代码至主应用 DOM。

规范定义见 [插件 Config、Page 与 UI 扩展规范](../reference/plugin-config-and-pages.md)。

## 2. 任务一：向指定插槽注入自定义操作

### 2.1 适用场景

为工作台添加快捷按钮、扩展小工具或自定义指示卡片，例如在输入框工具栏添加「一键翻译」按钮。

### 2.2 步骤

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

## 3. 任务二：消费与联动宿主工作台状态

插件组件可通过 `useWorkbenchContext()` 依赖注入安全获取宿主状态：

```ts
import { useWorkbenchContext } from '@aervox/ui';

const {
  layout,       // layout.studyModeEnabled 开关专注模式，layout.openTool 打开工具箱
  timer,        // timer.timerRunning, timer.formattedTime 番茄钟状态
  composer,     // composer.input, composer.pendingAttachments 输入内容与附件列表
  conversation, // conversation.story 历史会话，conversation.streaming 流式中标记
  sendMessage,  // sendMessage('消息内容') 主动触发一次消息发送
} = useWorkbenchContext();
```

注意事项：

- 优先消费只读状态，通过暴露的受控方法（如 `sendMessage`、`layout.openTool`）变更状态；
- 禁止直接修改非自身持有的深层只读属性。

## 4. 任务三：替换核心表现层组件（Component Overrides）

### 4.1 适用场景

当需要完全定制聊天输入坞的交互形式（例如多模态画板输入、代码专用输入器）时，可以替换内置的 `ComposerDock`。

### 4.2 步骤

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
  (e: 'send', text?: string, options?: { quizMode?: boolean; resend?: boolean }): void;
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

## 5. 错误隔离与容错机制

工作台插槽内置了 Vue `onErrorCaptured` 容错隔离沙盒（`ExtensionSlotItem`）：

- 若插件组件在生命周期、计算属性或渲染中抛出未捕获异常，异常将被局部拦截，不会向上冒泡导致整个工作台或对话白屏；
- 出错组件会被卸载并自动显示降级占位徽标；
- 插件开发者在控制台可观察到详细错误调用栈以便调试。

## 6. 验证与门禁检查

完成开发后，执行以下命令进行本地验证：

```bash
# UI 单元测试
pnpm --filter @aervox/ui test

# 类型检查
pnpm --filter @aervox/ui typecheck

# 生产环境构建验证
pnpm --filter @aervox/web build
```
