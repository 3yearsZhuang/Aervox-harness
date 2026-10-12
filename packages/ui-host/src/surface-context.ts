import { inject, type Component, type InjectionKey } from 'vue';

export type UIPlatform = 'web' | 'desktop' | 'mobile';
export type UISurfaceKind = 'main' | 'companion';

/** Trusted build-time definition. This is not an installable PluginManifest. */
export interface UISurfacePlugin {
  readonly id: string;
  readonly apiVersion: 1;
  readonly surface: UISurfaceKind;
  readonly platforms: readonly UIPlatform[];
  load(signal: AbortSignal): Promise<Component>;
}

/** One context per mounted root; abort only detaches this client's work. */
export interface UISurfaceContext {
  readonly platform: UIPlatform;
  readonly surface: UISurfaceKind;
  readonly signal: AbortSignal;
  readonly requestClose?: () => void;
}

export const UI_SURFACE_CONTEXT: InjectionKey<UISurfaceContext> = Symbol('aervox-ui-surface');

export function useUISurfaceContext(): UISurfaceContext {
  const context = inject(UI_SURFACE_CONTEXT);
  if (!context) throw new Error('UI surface must be mounted by UISurfaceHost');
  return context;
}
