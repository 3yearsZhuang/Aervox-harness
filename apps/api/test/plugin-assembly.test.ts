import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createPluginApiRegistry } from '@aervox/host-runtime-test/plugin-api-registry';
import type { PluginHostServices, ServerPluginRegistration } from '@aervox/host-plugin-api';
import { assembleFirstPartyPlugins, createHttpEndpointSink, mountPluginHttpEndpoints } from '@aervox/host-runtime-test/plugin-assembly';
import { ServerPluginRegistry } from '@aervox/host-runtime-test/modules/ecosystem/plugins/turn-plugins/registry';

const apiRegistry = createPluginApiRegistry();
const { isKnownStreamEventType, registerPluginApiContribution, resetPluginApiContributions } = apiRegistry;
const services = () => ({}) as PluginHostServices;
const loader = (registration: ServerPluginRegistration) => ({ pluginId: registration.pluginId, load: async () => ({ default: registration }) });

afterEach(() => { resetPluginApiContributions(); vi.restoreAllMocks(); });

describe('first-party plugin assembly lifecycle', () => {
  it('rolls back registered hooks and API contracts when the endpoint sink fails', async () => {
    const registry = new ServerPluginRegistry();
    const warn = vi.fn();
    const assembly = await assembleFirstPartyPlugins({
      turnRegistry: registry, apiRegistry, warn,
      onHttpEndpoints() { throw new Error('mount failure'); },
    }, [loader({
      pluginId: 'probe', turnPlugins: [{ id: 'probe' }],
      registerApiContract: () => registerPluginApiContribution({ streamEventTypes: ['probe_event'] }),
      httpEndpoints: [{ method: 'GET', path: '/v1/probe', handler: () => ({ payload: {} }) }],
    })]);
    expect(assembly.loaded).toEqual([]);
    expect(assembly.failed).toEqual(['probe']);
    expect(assembly.registrations).toEqual([]);
    expect(registry.getAll()).toEqual([]);
    expect(isKnownStreamEventType('probe_event')).toBe(false);
    expect(warn).toHaveBeenCalled();
    assembly.dispose();
  });

  it('preflights endpoint collisions before mounting, preserves the host and loads other plugins', async () => {
    const app = Fastify();
    app.get('/v1/host', async () => ({ owner: 'host' }));
    const registry = new ServerPluginRegistry();
    const handler = vi.fn(() => ({ payload: { owner: 'bad' } }));
    try {
      const assembly = await assembleFirstPartyPlugins({
        turnRegistry: registry, apiRegistry,
        onHttpEndpoints: createHttpEndpointSink(app, services, async () => true, vi.fn()),
        warn: vi.fn(),
      }, [loader({
        pluginId: 'bad', turnPlugins: [{ id: 'bad' }],
        httpEndpoints: [
          { method: 'GET', path: '/v1/shared', handler },
          { method: 'GET', path: '/v1/host', handler },
        ],
      }), loader({
        pluginId: 'good', turnPlugins: [{ id: 'good' }],
        httpEndpoints: [{ method: 'GET', path: '/v1/shared', handler: () => ({ payload: { owner: 'good' } }) }],
      })]);
      expect(assembly.failed).toEqual(['bad']);
      expect(assembly.loaded).toEqual(['good']);
      expect(registry.getAll().map((plugin) => plugin.id)).toEqual(['good']);
      expect((await app.inject('/v1/shared')).json()).toEqual({ owner: 'good' });
      expect((await app.inject('/v1/host')).json()).toEqual({ owner: 'host' });
      expect(handler).not.toHaveBeenCalled();
      assembly.dispose(); assembly.dispose();
      expect((await app.inject('/v1/shared')).statusCode).toBe(404);
      expect((await app.inject('/v1/host')).statusCode).toBe(200);
      expect(registry.getAll()).toEqual([]);
    } finally { await app.close(); }
  });

  it('closes every route admission when an unexpected framework error occurs halfway through mounting', async () => {
    const app = Fastify();
    const originalRoute = app.route.bind(app);
    vi.spyOn(app, 'route').mockImplementation((options) => {
      if (options.url === '/v1/fault') throw new Error('framework failure');
      return originalRoute(options);
    });
    const handler = vi.fn(() => ({ payload: {} }));
    try {
      expect(() => mountPluginHttpEndpoints(app, 'probe', [
        { method: 'GET', path: '/v1/partial', handler },
        { method: 'GET', path: '/v1/fault', handler },
      ], services, async () => true, vi.fn())).toThrow('framework failure');
      expect((await app.inject('/v1/partial')).statusCode).toBe(404);
      expect(handler).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('disposes exactly once in reverse order and continues after cleanup errors', async () => {
    const order: string[] = [];
    const warn = vi.fn();
    const registry = new ServerPluginRegistry();
    const register = registry.register.bind(registry);
    vi.spyOn(registry, 'register').mockImplementation((plugin) => {
      const dispose = register(plugin);
      return () => { order.push('hook'); dispose(); };
    });
    const assembly = await assembleFirstPartyPlugins({
      turnRegistry: registry, apiRegistry, warn,
      onHttpEndpoints: () => () => { order.push('http'); throw new Error('cleanup failure'); },
    }, [loader({
      pluginId: 'probe', turnPlugins: [{ id: 'probe' }],
      registerApiContract: () => () => { order.push('contract'); },
      httpEndpoints: [{ method: 'GET', path: '/v1/probe', handler: () => ({ payload: {} }) }],
    })]);
    assembly.dispose(); assembly.dispose();
    expect(order).toEqual(['http', 'hook', 'contract']);
    expect(registry.getAll()).toEqual([]);
    expect(assembly.registrations).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('rejects conflicting identities without replacing the already loaded plugin', async () => {
    const registry = new ServerPluginRegistry();
    const original = { id: 'probe' };
    const unwanted = vi.fn(() => () => undefined);
    const assembly = await assembleFirstPartyPlugins({ turnRegistry: registry, apiRegistry, warn: vi.fn() }, [
      loader({ pluginId: 'probe', turnPlugins: [original] }),
      loader({ pluginId: 'probe', registerApiContract: unwanted, turnPlugins: [{ id: 'probe' }] }),
      { pluginId: 'expected', load: async () => ({ default: { pluginId: 'imposter', registerApiContract: unwanted } }) },
    ]);
    expect(assembly.loaded).toEqual(['probe']);
    expect(assembly.failed).toEqual(['probe', 'imposter']);
    expect(registry.get('probe')).toBe(original);
    expect(unwanted).not.toHaveBeenCalled();
    assembly.dispose();
  });

  it('supports reassembling cached modules and closing one host without unregistering another host contract', async () => {
    const registerApiContract = () => registerPluginApiContribution({ streamEventTypes: ['shared_host_event'] });
    const loaders = [loader({ pluginId: 'probe', turnPlugins: [{ id: 'probe' }], registerApiContract })];
    const a = await assembleFirstPartyPlugins({ apiRegistry, turnRegistry: new ServerPluginRegistry() }, loaders);
    const b = await assembleFirstPartyPlugins({ apiRegistry, turnRegistry: new ServerPluginRegistry() }, loaders);
    a.dispose();
    expect(isKnownStreamEventType('shared_host_event')).toBe(true);
    b.dispose();
    expect(isKnownStreamEventType('shared_host_event')).toBe(false);
  });

  it('rejects duplicate parameter routes before mounting without conflating different suffixes', async () => {
    const app = Fastify();
    const handler = () => ({ payload: {} });
    try {
      expect(() => mountPluginHttpEndpoints(app, 'duplicate', [
        { method: 'GET', path: '/v1/probe/:first', handler },
        { method: 'GET', path: '/v1/probe/:second', handler },
      ], services, async () => true, vi.fn())).toThrow('重复');
      expect(app.hasRoute({ method: 'GET', url: '/v1/probe/:first' })).toBe(false);
      const dispose = mountPluginHttpEndpoints(app, 'suffixes', [
        { method: 'GET', path: '/v1/probe/:name.json', handler },
        { method: 'GET', path: '/v1/probe/:name.txt', handler },
      ], services, async () => true, vi.fn());
      expect((await app.inject('/v1/probe/test.json')).statusCode).toBe(200);
      expect((await app.inject('/v1/probe/test.txt')).statusCode).toBe(200);
      dispose();
    } finally { await app.close(); }
  });

  it('does not admit a handler if disposal occurs during its asynchronous enablement check', async () => {
    const app = Fastify();
    let finish!: (enabled: boolean) => void;
    let checking!: () => void;
    const started = new Promise<void>((resolve) => { checking = resolve; });
    const enabled = new Promise<boolean>((resolve) => { finish = resolve; });
    const handler = vi.fn(() => ({ payload: {} }));
    const dispose = mountPluginHttpEndpoints(app, 'probe', [{ method: 'GET', path: '/v1/probe', handler }],
      services, () => { checking(); return enabled; }, vi.fn());
    try {
      const request = app.inject('/v1/probe');
      await started; dispose(); finish(true);
      expect((await request).statusCode).toBe(404);
      expect(handler).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
