import { DrizzleQueryError } from "drizzle-orm";

/** Drizzle 0.45 wraps driver failures; classify the driver cause, never SQL/parameter text. */
export function sqliteErrorDetails(error: unknown): { code: string; message: string } {
  const seen = new Set<unknown>();
  while (error instanceof DrizzleQueryError && error.cause && !seen.has(error)) {
    seen.add(error);
    error = error.cause;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return { code: typeof code === "string" ? code : "", message: error instanceof Error ? error.message : String(error) };
}
