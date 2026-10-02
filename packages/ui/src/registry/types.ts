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
   * 出站结构化元数据（CR-060）：模式等插件私有语义由此承载，宿主不解释其取值。
   * 携带元数据时插件不应再改写消息文本，避免语义双写。
   */
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type MessageTransformer = (message: string, context?: MessageTransformContext) => string;

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

