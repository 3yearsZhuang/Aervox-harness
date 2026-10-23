import { ValidationError } from "./errors.js";
import { idempotencyKeySchema } from "@aervox/contracts";

/** Forward operation identity without exposing the rest of the HTTP headers. */
export function readIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError("invalid_idempotency_key");
  }
  return parsed.data;
}
