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
  | 'settings:tabs';

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
  onSend: (text?: string, options?: { quizMode?: boolean; resend?: boolean }) => Promise<void>;
  onVoiceTrigger?: () => void;
  onAttachmentPicker?: () => void;
  'onUpdate:input'?: (value: string) => void;
  onUpdateInput?: (value: string) => void;
}

export interface MessageTransformContext {
  quizMode?: boolean;
  [key: string]: unknown;
}

export type MessageTransformer = (message: string, context?: MessageTransformContext) => string;
