import { getCurrentInstance, hasInjectionContext, inject, provide, type App, type InjectionKey } from 'vue';
import { getDefaultAervoxClient, type AervoxClient } from './transport.js';

export const AERVOX_CLIENT: InjectionKey<AervoxClient> = Symbol('aervox-client');
let providedClient: AervoxClient | undefined;
export function provideAervoxClient(client: AervoxClient, app?: App): void {
  providedClient = client;
  if (app) app.provide(AERVOX_CLIENT, client);
  else provide(AERVOX_CLIENT, client);
}
export function useAervoxClient(): AervoxClient {
  const resolved = (hasInjectionContext() || getCurrentInstance()) ? inject(AERVOX_CLIENT, undefined) : undefined;
  if (resolved) return resolved;
  // A provided client plus no injection context means this runs from an event
  // handler or async callback: inject() silently drops out there and the
  // fallback default client lacks host extensions (this hid the mobile backup
  // failure). Surface the misuse instead of failing later in the feature.
  if (providedClient && typeof console !== 'undefined') {
    console.warn('[aervox] useAervoxClient()/getClientTransport() resolved the default client outside setup; capture the transport during setup instead.');
  }
  return getDefaultAervoxClient();
}
/** Resolve in the composable factory, then retain the returned transport in its callbacks. */
export const getClientTransport = () => useAervoxClient().transport;
export const getClientPlatformServices = () => useAervoxClient().platform;
