/**
 * Aervox｜思隅 @aervox/core — 稳定序列化（去重键用，单一真源）
 *
 * 缺陷 D-KEY：去重键原为 `${name}:${JSON.stringify(args)}`，对对象键序敏感 ——
 * `{query:"x",limit:10}` 与 `{limit:10,query:"x"}` 语义完全相同却得到不同键，
 * 于是同一逻辑调用被当作两次不同调用执行，幂等账本被绕过、副作用可能重复发生。
 * 真实 LLM 输出中键序不保证稳定，故去重必须建立在规范序列化之上。
 *
 * 规则：
 * - 对象键按字典序排序后递归（键序无关）；
 * - 数组**保序**（`[1,2]` 与 `[2,1]` 语义不同，不可归一化）；
 * - 循环引用以 `"[Circular]"` 标记降级，不抛异常（不得因去重键构造使 Turn 崩溃）；
 * - 其余类型（null / 数字 / 字符串 / 布尔 / undefined）按值序列化。
 *
 * 与 `safe-serialize.ts` 的 `safeStringify` 刻意分工，切勿合并：
 * - 本函数**排序键**，产出键序无关的规范形 —— 去重要求同一语义参数得同一键；
 * - `safeStringify` **不排序键**、只对循环处打标记 —— 事件与账本要求保真载荷。
 * 排序会改写审计载荷，不排序则无法用于去重，故二者必须分开。
 */
export function stableSerialize(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") return Number.isFinite(value as number) ? String(value) : "null";
  if (type === "boolean") return String(value);
  if (type === "string") return JSON.stringify(value);
  if (type === "undefined") return "undefined";
  if (type === "bigint") return `"${String(value)}"`;
  if (type === "function" || type === "symbol") return "[Unsupported]";
  const obj = value as object;
  if (seen.has(obj)) return '"[Circular]"';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => stableSerialize(item, seen)).join(",")}]`;
    }
    const entries = Object.keys(obj as Record<string, unknown>).sort();
    return `{${entries
      .map((key) => `${JSON.stringify(key)}:${stableSerialize((obj as Record<string, unknown>)[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** 工具调用去重键：name + 参数稳定序列化（键序无关，数组保序） */
export const dedupeKey = (name: string, args: unknown): string => `${name}:${stableSerialize(args)}`;
