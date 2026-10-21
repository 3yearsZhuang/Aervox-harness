export { default as UISurfaceHost } from './UISurfaceHost.vue';
export { resolveSurfaceChoice } from './resolve-surface';
export { resolveWebPlatform } from './resolve-web-platform';
export { defineUISurface, useUISurfaceContext, UI_HOST_API_VERSION } from './surface-context';
export type {
  UISurfaceContext,
  UISurfacePlugin,
  UISurfaceManifest,
  UISurfaceFailureReason,
  UISurfaceKind,
  UIPlatform,
} from './surface-context';
