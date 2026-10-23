import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/** RFC 9457, with the legacy machine-readable fields retained during /v1 migration. */
export const apiProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  instance: z.string().optional(),
  code: z.string(),
  message: z.string(),
  error: z.string().optional(),
  requestId: z.string().optional(),
  details: z.unknown().optional(),
}).passthrough().openapi("ApiProblem");

export type ApiProblem = z.infer<typeof apiProblemSchema>;

export const idempotencyKeySchema = z.string().min(1).max(512).refine(value => value.trim().length > 0);
export const idempotencyHeadersSchema = z.object({
  "Idempotency-Key": idempotencyKeySchema.optional(),
});

/** Transport-independent JSON endpoint definition. Paths use OpenAPI placeholders. */
export interface ApiEndpoint<ResponseSchema extends z.ZodType = z.ZodType> {
  readonly method: "get" | "post" | "put" | "patch" | "delete";
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly tags: string[];
  readonly body?: z.ZodType;
  /** Explicit HTTP body presence; omission preserves the published /v1 contract. */
  readonly bodyRequired?: boolean;
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly response: ResponseSchema;
  /** Generator-only representations for schemas such as bounded recursive DSLs. */
  readonly openapi?: { readonly body?: z.ZodType; readonly response?: z.ZodType; readonly headers?: z.ZodObject };
  readonly status?: number;
  readonly errors?: Readonly<Record<number, string>>;
  readonly validationErrorCode?: string;
  readonly validationErrorMessage?: string;
}

export type ApiEndpointResponse<Endpoint extends ApiEndpoint> = z.output<Endpoint["response"]>;

/** Encode values as path segments; never interpolate caller-controlled URL syntax. */
export function apiEndpointPath(endpoint: Pick<ApiEndpoint, "path">, params: Record<string, string> = {}): string {
  return endpoint.path.replace(/\{([^}]+)\}/g, (_placeholder, name: string) => {
    if (!Object.hasOwn(params, name) || !params[name]) throw new Error(`missing_endpoint_parameter:${name}`);
    return encodeURIComponent(params[name]);
  });
}
