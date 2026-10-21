import type { ToolSafetyLevel, ToolSpec } from "./types.js";

/** An explicit level may tighten a declaration, but must not downgrade a write tool. */
export function resolveToolSafetyLevel(spec: ToolSpec | undefined): ToolSafetyLevel {
  const fallback = spec?.readOnly ? "read_only" : "write_with_approval";
  if (spec?.safetyLevel === undefined) return fallback;
  if (spec.safetyLevel === "read_only" && !spec.readOnly) return "write_with_approval";
  return spec.safetyLevel;
}
