/**
 * Aervox｜思隅 @aervox/api — Turn 实时流式事件总线（CR-031）
 *
 * 进程内轻量级 Pub/Sub 事件总线：
 * 1. 执行器与协调器写入 SQLite 的同时向本总线广播，实现 <10ms 极低延迟实时直推；
 * 2. SSE 端点在全量重放 SQLite 存量历史后挂载本总线监听，彻底消除 400ms 高频数据库空轮询；
 * 3. 严格的生命周期管理：Attempt 终态排空或客户端断开后即时注销监听，防止内存泄漏。
 */
import { EventEmitter } from "node:events";

export interface StreamEventFrame {
  id: string;
  turnId: string;
  sequence: number;
  eventType: string;
  payloadVersion: number;
  occurredAt: string;
  data: unknown;
}

export interface StreamHubSubscriber {
  onEvent: (event: StreamEventFrame) => void;
  onSettled: (status: string) => void;
}

export class TurnStreamHub {
  private readonly emitter = new EventEmitter();

  constructor() {
    // 允许较多客户端/测试并发监听，消除 MaxListenersExceeded 警告
    this.emitter.setMaxListeners(100);
  }

  /**
   * 广播单个流式事件
   */
  publishEvent(turnId: string, event: StreamEventFrame): void {
    this.emitter.emit(`turn:${turnId}:event`, event);
  }

  /**
   * 广播回合终态（Completed / Failed / Interrupted / Cancelled）
   */
  publishSettled(turnId: string, status: string): void {
    this.emitter.emit(`turn:${turnId}:settled`, status);
  }

  /**
   * 订阅指定回合的实时事件与终态通知
   * @returns 取消订阅的清理函数
   */
  subscribe(turnId: string, subscriber: StreamHubSubscriber): () => void {
    const eventChannel = `turn:${turnId}:event`;
    const settledChannel = `turn:${turnId}:settled`;

    const handleEvent = (event: StreamEventFrame) => {
      subscriber.onEvent(event);
    };

    const handleSettled = (status: string) => {
      subscriber.onSettled(status);
    };

    this.emitter.on(eventChannel, handleEvent);
    this.emitter.on(settledChannel, handleSettled);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.emitter.off(eventChannel, handleEvent);
      this.emitter.off(settledChannel, handleSettled);
    };
  }
}

/** 模块内单例 */
export const turnStreamHub = new TurnStreamHub();
