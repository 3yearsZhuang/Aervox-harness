/**
 * Aervox｜思隅 @aervox/worker — 全局防打扰裁决器（CR-032 §2.1 / S4）
 *
 * 内核坚守的防打扰底线，对所有主动派发（内置规则 + 插件规则）统一生效：
 * 1. 感知源授权（插件规则未获 plugin_grants 授权即切断事件输入，fail-closed）；
 * 2. 规则冷却（lastTriggeredAt + cooldownSeconds）；
 * 3. 静音时段（respect_global 读全局窗口 / bypass 用规则自带窗口）；
 * 4. 全局频次水位（滑动 1 小时窗口内全系统派发次数 ≤ 上限）。
 *
 * 纯函数实现：不触库、不依赖时钟（now 注入），便于节流与并发抑制测试。
 */

export interface QuietHoursWindow {
  start: string;
  end: string;
}

export type QuietHoursPolicy = "respect_global" | "bypass";

export type ArbitrationDecision =
  | "dispatch"
  | "suppressed_unauthorized"
  | "suppressed_cooldown"
  | "suppressed_quiet_hours"
  | "suppressed_rate_limit";

export interface ArbitrationInput {
  now: Date;
  /** 规则冷却起点（上次派发时间；null 表示从未派发） */
  lastTriggeredAt?: string | null;
  cooldownSeconds: number;
  quietHoursPolicy: QuietHoursPolicy;
  /** 规则自带静音窗口（bypass 策略时生效；缺省视为无窗口） */
  quietHours?: QuietHoursWindow | null;
  /** respect_global 策略下的全局静音窗口（本地时区 HH:mm） */
  globalQuietHours?: QuietHoursWindow | null;
  /** 感知源授权检查结果（内置规则恒为 true） */
  authorized: boolean;
  /** 滑动窗口内已派发次数 */
  dispatchedInWindow: number;
  /** 全局频次水位上限（窗口内最多派发次数） */
  maxDispatchesPerHour: number;
}

export interface ArbitrationVerdict {
  decision: ArbitrationDecision;
  /** 人读原因（写入 trigger event 的 reason 字段） */
  reason: string;
}

/** 全局防打扰缺省参数（CR-032 §2.1：默认水位 + 全局静音窗口） */
export const DEFAULT_MAX_DISPATCHES_PER_HOUR = 3;
export const DEFAULT_GLOBAL_QUIET_HOURS: QuietHoursWindow = {start: "22:00", end: "07:00"};

/** "HH:mm" → 当日分钟数；非法输入返回 null（调用方按无窗口处理） */
function parseHm(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * 判定时刻是否落在静音窗口内（本地时区）。
 * start <= end 为日内窗口；start > end 为跨午夜窗口；start === end 视为零长度（永不静音）。
 */
export function isWithinQuietHours(now: Date, window: QuietHoursWindow | null | undefined): boolean {
  if (!window) return false;
  const start = parseHm(window.start);
  const end = parseHm(window.end);
  if (start === null || end === null || start === end) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end;
}

/** 冷却判定：lastTriggeredAt + cooldownSeconds > now 即仍在冷却 */
export function isCoolingDown(now: Date, lastTriggeredAt: string | null | undefined, cooldownSeconds: number): boolean {
  if (!lastTriggeredAt || cooldownSeconds <= 0) return false;
  const last = Date.parse(lastTriggeredAt);
  if (Number.isNaN(last)) return false;
  return now.getTime() < last + cooldownSeconds * 1000;
}

/**
 * 全局防打扰裁决：按 授权 → 冷却 → 静音时段 → 频次水位 的顺序放行或抑制。
 * 任一环节不通过即 fail-closed，返回可观测的抑制原因。
 */
export function arbitrate(input: ArbitrationInput): ArbitrationVerdict {
  if (!input.authorized) {
    return {decision: "suppressed_unauthorized", reason: "plugin sensor grant missing (fail-closed)"};
  }
  if (isCoolingDown(input.now, input.lastTriggeredAt, input.cooldownSeconds)) {
    return {
      decision: "suppressed_cooldown",
      reason: `cooldown active until ${new Date(Date.parse(input.lastTriggeredAt!) + input.cooldownSeconds * 1000).toISOString()}`,
    };
  }
  const window = input.quietHoursPolicy === "bypass" ? input.quietHours : (input.globalQuietHours ?? null);
  if (isWithinQuietHours(input.now, window)) {
    return {
      decision: "suppressed_quiet_hours",
      reason: `quiet hours ${window!.start}-${window!.end} (policy=${input.quietHoursPolicy})`,
    };
  }
  if (input.dispatchedInWindow >= input.maxDispatchesPerHour) {
    return {
      decision: "suppressed_rate_limit",
      reason: `global dispatch watermark reached (${input.dispatchedInWindow}/${input.maxDispatchesPerHour} per hour)`,
    };
  }
  return {decision: "dispatch", reason: "arbitrator approved"};
}
