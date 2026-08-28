/**
 * Aervox｜思隅 @aervox/api — 进程内事件总线
 *
 * 定位声明（缺陷2修正）：本总线当前**未被任何领域模块使用**——跨域副作用一律走
 * 持久化的 Outbox 表（@aervox/database + apps/worker 消费），保证进程崩溃后可重放。
 * 本总线仅保留为进程内测试与"未来拆服务"的实验通道；若未来将其替换为消息队列
 * （NATS/Redis Streams），需补充持久化、顺序与重放语义（缺陷6：payload 已被类型
 * 约束为 JSON 可序列化值，可直接进入队列）。
 */
/** JSON 可序列化值约束（未来接入消息队列的硬前提） */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type DomainEvent = {
  type: string;
  payload: JsonValue;
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

  /** 发布事件（同步派发给所有订阅者；异常由订阅者自行捕获）。payload 必须为 JSON 可序列化值 */
  publish(eventType: string, payload: JsonValue): void {
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