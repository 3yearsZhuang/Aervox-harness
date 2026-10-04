import type { Component } from 'vue';

export type ExtensionSlotName =
  | 'header:actions'
  | 'header:before'
  | 'nav:menu-items'
  | 'sidecards:widgets'
  | 'conversation:top'
  | 'conversation:bottom'
  | 'message:bubble-actions'
  | 'composer:toolbar-actions'
  | 'composer:bottom-bar'
  | 'composer:indicator'
  | 'settings:tabs'
  | 'settings:conversation-rows'
  | 'workbench:drawers'
  | 'taskcenter:cards';

export interface ExtensionComponentRegistration {
  id: string;
  component: Component;
  priority: number;
  props?: Record<string, unknown>;
}

export type RegisteredSlotComponent = ExtensionComponentRegistration;
export type RegisteredSlotItem = RegisteredSlotComponent;

export interface RegisterSlotOptions {
  id?: string;
  priority?: number;
  props?: Record<string, unknown>;
}

export interface SlotItemConfig {
  id?: string;
  component: Component;
  priority?: number;
  props?: Record<string, unknown>;
}

export type SlotItem = RegisterSlotOptions | SlotItemConfig;

export interface ComposerContractProps {
  input: string;
  streaming: boolean;
  isComposing: boolean;
  enterToSend: boolean;
  placeholder?: string;
  onSend: (text?: string, options?: { metadata?: Record<string, unknown>; resend?: boolean }) => Promise<void>;
  onVoiceTrigger?: () => void;
  onAttachmentPicker?: () => void;
  'onUpdate:input'?: (value: string) => void;
  onUpdateInput?: (value: string) => void;
}

export interface MessageTransformContext {
  /**
   * 宿主已决定的**显式**出站元数据（例如插件自有卡片发起的出题意图）。
   * 插件若要为自己负责的普通发送附加模式语义，应由变换器**返回** `metadata`，
   * 而不是改写本字段（本字段只读，宿主不解释其取值）。
   */
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 变换器返回值。
 *
 * - 返回 `string`：仅改写消息文本（兼容旧写法）；
 * - 返回对象：可同时给出插件自述的出站 `metadata`，由宿主合并进 Turn 请求。
 *
 * 这是插件为自己负责的发送附加模式语义的**唯一**通用接缝：宿主不解释插件私有取值，
 * 也不为任何具体插件硬编码模式派生（CR-060）。
 */
export type MessageTransformResult =
  | string
  | {
      text: string;
      /** 插件自述的出站元数据；与宿主显式元数据冲突时以宿主显式值为准 */
      metadata?: Record<string, unknown>;
    };

export type MessageTransformer = (
  message: string,
  context?: MessageTransformContext,
) => MessageTransformResult;

/** 变换管道输出：归一后的最终文本 + 各插件自述元数据（按注册优先级合并） */
export interface MessageTransformOutput {
  text: string;
  metadata?: Record<string, unknown>;
}

export interface MessageTransformerRegistration {
  id: string;
  transformer: MessageTransformer;
  priority: number;
}

export interface WorkbenchCardContribution {
  id: string;
  label: string;
  description: string;
  icon: Component;
  summary: () => string;
  action: () => void;
  extraComponent?: Component;
  priority?: number;
}

