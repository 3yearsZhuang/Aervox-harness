/**
 * Aervox｜思隅 @aervox/core — 容错序列化（单一真源）
 *
 * 缺陷 D-CIRC：模型可能返回自引用的 `arguments`（`{self:{...self}}`）。任何裸
 * `JSON.stringify` 遇之都会抛 `Converting circular structure to JSON`：
 * - 预算计量里抛 → 逃出流式循环，整 Turn 收敛为 `execution error`；
 * - 写 tool_request 事件时抛 → 事件与工具账本双双落不下去，崩溃点前移到
 *   `inspectToolInput` 的入参安全判定之前（该判定本可优雅拒绝循环引用）。
 *
 * 本函数保持原形（键序、字段名不变），仅对环回引用与不可序列化值降级为标记：
 * - 事件载荷与工具账本必须留痕（可审计要求不允许静默丢弃），且必须能承载畸形参数；
 * - 审计者应能看见参数里有环，而不是看到一条「工具被静默丢弃」的空洞记录。
 *
 * 与 `executor.ts` 内 `stableSerialize`（去重键用）的区别：
 * - `stableSerialize`：**排序键**，产出键序无关的规范形（去重要求同一语义参数同键）；
 * - 本函数：**不排序键、不改变结构**，只在循环处打标记（保真要求）。
 *
 * 两者刻意分工，切勿合并：排序会改写审计载荷，不排序则无法用于去重。
 */

export function safeStringify(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") return Number.isFinite(value as number) ? String(value) : "null";
  if (type === "boolean") return String(value);
  if (type === "string") return JSON.stringify(value);
  if (type === "undefined") return "null";
  if (type === "bigint") return `"${String(value)}"`;
  if (type === "function" || type === "symbol") return "[Unserializable]";
  const obj = value as object;
  if (seen.has(obj)) return '"[Circular]"';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => safeStringify(item, seen)).join(",")}]`;
    }
    const entries = Object.entries(obj as Record<string, unknown>).map(
      ([key, val]) => `${JSON.stringify(key)}:${safeStringify(val, seen)}`,
    );
    return `{${entries.join(",")}}`;
  } catch {
    // 兜底：getter 抛异常等极端情况也不得连带整个 Turn 失败
    return '"[Unserializable]"';
  } finally {
    seen.delete(obj);
  }
}

/**
 * 稳定序列化：用于工具调用去重键。
 *
 * 缺陷 D-KEY：原实现为 `JSON.stringify(args)`，对对象键序敏感 ——
 * `{query:"x",limit:10}` 与 `{limit:10,query:"x"}` 语义完全相同却得到不同键，
 * 于是同一逻辑调用被当作两次不同调用执行，幂等账本被绕过、副作用可能重复发生。
 * 真实 LLM 输出中键序不保证稳定，故去重必须建立在规范序列化之上。
 *
 * 规则：
 * - 对象键按字典序排序后递归（键序无关）；
 * - 数组**保序**（`[1,2]` 与 `[2,1]` 语义不同，不可归一化）；
 * - 循环引用以 `"[Circular]"` 标记降级，不抛异常（不得因去重键构造使 Turn 崩溃）；
 * - 其余类型（null / 数字 / 字符串 / 布尔 / undefined）按值序列化。
 */
function stableSerialize(value: unknown, seen: Set<object> = new Set()): string {
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
const dedupeKey = (name: string, args: unknown): string => `${name}:${stableSerialize(args)}`;

/** 共享 UTF-8 编码器（无状态；模块级复用，避免流式路径每 chunk 分配） */
const utf8 = new TextEncoder();

