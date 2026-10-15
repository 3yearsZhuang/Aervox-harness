import { apiEndpointPath, type ApiEndpoint, type ApiEndpointResponse } from '@aervox/contracts';
import type { AervoxTransport } from './transport.js';

/** Keep endpoint names and runtime payload validation tied to the shared contract. */
export async function requestEndpoint<Endpoint extends ApiEndpoint>(
  transport: AervoxTransport,
  endpoint: Endpoint,
  body?: unknown,
  params?: Record<string, string>,
): Promise<ApiEndpointResponse<Endpoint>> {
  // Validate without injecting defaults into the wire payload; the server owns defaults.
  endpoint.body?.parse(body);
  endpoint.params?.parse(params);
  const response = await transport.request(endpoint.method.toUpperCase(), apiEndpointPath(endpoint, params), body);
  return endpoint.response.parse(response) as ApiEndpointResponse<Endpoint>;
}
