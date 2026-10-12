import { inject, type Component, type InjectionKey } from 'vue';

export type UIPlatform = 'web' | 'desktop' | 'mobile';
export type UISurfaceKind = 'main' | 'companion';

/** 宿主装配 API 版本：插件经 requires.hostApiVersion 声明所需的最低版本。 */
export const UI_HOST_API_VERSION = 1;

/**
 * 界面插件清单（UISurfaceManifest）——受信构建输入的显式描述符。
 * 区别于可安装的 PluginManifest：只描述"我是谁、我挂在哪、我需要什么"，
 * 不携带代码 URL，不进入插件市场启停记录或声明式分发包。
 */
export interface UISurfaceManifest {
  /** 唯一标识，组合根与诊断日志据此辨认界面 */
  readonly id: string;
  /** 界面契约版本，当前固定为 1 */
  readonly apiVersion: 1;
  /** 挂载的宿主插槽：主界面或桌宠 */
  readonly surface: UISurfaceKind;
  /** 支持的平台清单，宿主按当前平台匹配 */
  readonly platforms: readonly UIPlatform[];
  /** 面向用户的展示名，用于加载失败提示与组合根切换器 */
  readonly displayName?: string;
  /** 一句话说明，供组合根切换器展示 */
  readonly description?: string;
  /** 对宿主的可选前置要求 */
  readonly requires?: {
    /** 需要的最低宿主装配 API 版本 */
    readonly hostApiVersion?: number;
    /** 宿主必须提供的能力标识（如 'window-controls'） */
    readonly capabilities?: readonly string[];
  };
}

/** Trusted build-time definition. This is not an installable PluginManifest. */
export interface UISurfacePlugin extends UISurfaceManifest {
  load(signal: AbortSignal): Promise<Component>;
}

/** 宿主校验失败原因（结构化，供 UI 文案与测试断言使用） */
export type UISurfaceFailureReason =
  | 'missing'
  | 'malformed'
  | 'api-version'
  | 'host-api-version'
  | 'surface-mismatch'
  | 'platform-unsupported'
  | 'capability-unsupported'
  | 'load-failed'
  | 'load-timeout'
  | 'render-error';

/** 构建期定义界面插件：形状校验失败立即抛错（fail-fast），返回冻结后的清单。 */
export function defineUISurface(plugin: UISurfacePlugin): UISurfacePlugin {
  if (!plugin || typeof plugin.id !== 'string' || !plugin.id.trim()) {
    throw new Error('[ui-host] UISurfacePlugin requires a non-empty id');
  }
  if (plugin.apiVersion !== 1) {
    throw new Error(`[ui-host] UISurfacePlugin "${plugin.id}" must declare apiVersion 1`);
  }
  if (plugin.surface !== 'main' && plugin.surface !== 'companion') {
    throw new Error(`[ui-host] UISurfacePlugin "${plugin.id}" has unknown surface "${String(plugin.surface)}"`);
  }
  if (!Array.isArray(plugin.platforms) || plugin.platforms.length === 0) {
    throw new Error(`[ui-host] UISurfacePlugin "${plugin.id}" must declare supported platforms`);
  }
  if (typeof plugin.load !== 'function') {
    throw new Error(`[ui-host] UISurfacePlugin "${plugin.id}" must provide a load() function`);
  }
  return Object.freeze(plugin);
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
