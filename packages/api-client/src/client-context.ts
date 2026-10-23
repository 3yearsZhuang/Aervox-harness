import { getCurrentInstance, hasInjectionContext, inject, provide, type App, type InjectionKey } from 'vue';
import { getDefaultAervoxClient, type AervoxClient } from './transport.js';

export const AERVOX_CLIENT: InjectionKey<AervoxClient> = Symbol('aervox-client');
export function provideAervoxClient(client: AervoxClient, app?: App): void {
  if (app) app.provide(AERVOX_CLIENT, client);
  else provide(AERVOX_CLIENT, client);
}
export function useAervoxClient(): AervoxClient {
  return hasInjectionContext() || getCurrentInstance() ? inject(AERVOX_CLIENT, undefined) ?? getDefaultAervoxClient() : getDefaultAervoxClient();
}
/** Resolve in the composable factory, then retain the returned transport in its callbacks. */
export const getClientTransport = () => useAervoxClient().transport;
export const getClientPlatformServices = () => useAervoxClient().platform;
