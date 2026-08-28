/**
 * Aervox｜思隅 @aervox/agent-loop — 租约心跳（B2：长调用周期续租）
 *
 * 规则依据：AVX-HAR-001 §11.2「长模型/工具调用期间由 Host 续租」「续租失败立即停止
 * 产生新副作用」。Claim 后按固定间隔周期续租，覆盖模型长流与长工具调用（如
 * ask_user_question 最长 120s），避免租约超过 TTL 被恢复器误判为僵尸原地收敛。
 *
 * 续租采用数据库层 CAS（leaseId + fencing + Running 匹配）：
 * - renew 返回 ok=false（被抢占/恢复器已递增 fencing 或已终态）→ 判定租约丢失
 *   （lost=true），通知订阅方（executor 用它 abort 在途工具），并在检查点抛
 *   LeaseLostError；
 * - renew 抛传输/瞬时故障 → 不判定丢失，下一拍重试（丢失必须以 CAS 语义为准）。
 */
import { LeaseLostError } from "./errors.js";

export interface LeaseHeartbeatDeps {
  /** 周期续租调用（宿主 CAS；返回 ok=false 即租约已失） */
  renew(): Promise<{ ok: boolean }>;
  /** 心跳间隔（ms）；<=0 表示关闭 */
  intervalMs: number;
}

export class LeaseHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private beating = false;
  private lostFlag = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: LeaseHeartbeatDeps) {}

  /** 租约是否已被判定丢失（幂等向上收敛） */
  get lost(): boolean {
    return this.lostFlag;
  }

  start(): void {
    if (this.timer !== null || this.deps.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.beat();
    }, this.deps.intervalMs);
  }

  /** 恢复器抢先后不再写入 events/tools（executor 检查点；已丢失直接中止当前操作） */
  throwIfLost(): void {
    if (this.lostFlag) throw new LeaseLostError("heartbeat: lease lost during long call");
  }

  /** 订阅租约丢失（executor 用于 abort 在途工具调用；stop 时清理） */
  onLost(listener: () => void): void {
    this.listeners.add(listener);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  private async beat(): Promise<void> {
    if (this.beating || this.lostFlag) return; // 上一拍未落定或已丢失，跳过
    this.beating = true;
    try {
      const alive = await this.deps.renew();
      if (!alive.ok) this.markLost();
    } catch {
      // 瞬时/传输故障不判定丢失（CAS 失败才是丢失依据）；下一心跳重试
    } finally {
      this.beating = false;
    }
  }

  private markLost(): void {
    if (this.lostFlag) return;
    this.lostFlag = true;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 订阅方异常不扩散（abort 兜底失败由工具自身超时收敛）
      }
    }
  }
}