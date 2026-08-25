/**
 * Aervox｜思隅 @aervox/api — 进程内事件总线
 *
 * 模块间跨域通信的唯一通道（取代模块间直接函数调用）。
 * 未来某模块拆分为独立服务时，仅需将 publish/subscribe 替换为消息队列（NATS/Redis Streams）调用，
 * 业务逻辑代码零改动。
 */
type DomainEvent = {
  type: string;
  payload: unknown;
  occurredAt: string;
};

type EventHandler = (event: DomainEvent) => void;

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  /** 订阅事件；返回取消订阅函数 */
  subscribe(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  /** 发布事件（同步派发给所有订阅者；异常由订阅者自行捕获） */
  publish(eventType: string, payload: unknown): void {
    const handlers = this.handlers.get(eventType);
    if (!handlers) return;
    const event: DomainEvent = {
      type: eventType,
      payload,
      occurredAt: new Date().toISOString(),
    };
    for (const handler of handlers) {
      handler(event);
    }
  }
}

export const eventBus = new EventBus();