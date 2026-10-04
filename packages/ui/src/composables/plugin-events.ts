/**
 * Aervox｜思隅 @aervox/ui — 通用插件事件总线（CR-060）
 *
 * 宿主工作台只负责把传输层的**通用插件事件出口**接到本总线，不解释任何事件语义；
 * 插件在自身模块内订阅并持有自己的状态。宿主因此无需为任何插件事件预留回调、
 * 状态字段或组件 props。
 */
export type PluginEventType = string;

/** 事件处理函数：载荷结构由声明该事件类型的插件负责校验 */
export type PluginEventHandler = (eventType: PluginEventType, data: unknown) => void;

export interface PluginEventBus {
  /** 发布事件（宿主转发用；插件不得自行伪造他人的事件类型） */
  emit(eventType: PluginEventType, data: unknown): void;
  /** 订阅全部事件，返回取消订阅函数 */
  on(handler: PluginEventHandler): () => void;
}

/** 创建插件事件总线 */
export function createPluginEventBus(): PluginEventBus {
  const handlers = new Set<PluginEventHandler>();
  return {
    emit(eventType, data) {
      for (const handler of [...handlers]) {
        try {
          handler(eventType, data);
        } catch {
          // 单个订阅者异常隔离，不影响其他订阅者与回合流
        }
      }
    },
    on(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
