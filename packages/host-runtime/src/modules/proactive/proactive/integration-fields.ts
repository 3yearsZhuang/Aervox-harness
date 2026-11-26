/**
 * 主动智能集成（Home Assistant / 小米健康）的入参取值助手。
 *
 * REST 路由与工具执行两条链路此前各写一份：`requiredText` 的实现逐行相同，但
 * 路由版抛 `ValidationError`（映射为 HTTP 400），工具版抛裸 `Error`（落 500）。
 * 同一类「调用方少传字段」因此在小工具侧被报成服务端故障。取值与错误类型
 * 归一处后，两条链路给出同一个可判定的校验错误。
 */
import { ValidationError } from "../../../shared/errors.js";

/** 取出必填非空字符串；缺失或全空白抛校验错误（HTTP 400 / 工具参数错误）。 */
export function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ValidationError(`${name} is required`);
  return value.trim();
}

/** 取出可选非空字符串；缺失或全空白返回 undefined，不报错。 */
export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 取出可选对象；非对象（含数组、null）返回空对象。 */
export function inputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
