import { apiEndpointPath, type ApiEndpoint, type ApiEndpointResponse } from '@aervox/contracts';
import type { AervoxTransport } from './transport.js';

/** Keep endpoint names and runtime payload validation tied to the shared contract. */
export async function requestEndpoint<Endpoint extends ApiEndpoint>(
  transport: AervoxTransport,
  endpoint: Endpoint,
  body?: unknown,
  params?: Record<string, string>,
  query?: Record<string, string | undefined>,
  options?: Parameters<AervoxTransport['request']>[3],
): Promise<ApiEndpointResponse<Endpoint>> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  // Validate without injecting defaults into the wire payload; the server owns defaults.
  endpoint.body?.parse(body);
  endpoint.params?.parse(params);
  endpoint.query?.parse(query ?? {});
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) search.set(key, value);
  }
  const path = apiEndpointPath(endpoint, params) + (search.size ? `?${search}` : '');
  const response = options === undefined
    ? await transport.request(endpoint.method.toUpperCase(), path, body)
    : await transport.request(endpoint.method.toUpperCase(), path, body, options);
  // A transport can complete after its caller stopped observing. Do not parse
  // or return that stale response even if the transport ignored cancellation.
  signal?.throwIfAborted();
  return endpoint.response.parse(response) as ApiEndpointResponse<Endpoint>;
}
