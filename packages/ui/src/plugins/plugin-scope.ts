import { effectScope } from 'vue';
import type { UIRegistry } from '../registry/ui-registry';

/** 第一方插件实例的合作式取消与同步资源归属，不是权限沙箱。 */
export interface UIPluginLifecycle {
  readonly signal: AbortSignal;
  onDispose(cleanup: () => void): () => void;
  effect(setup: () => (() => void) | void): () => void;
}

export function createUIPluginScope(registry: UIRegistry) {
  const scopedRegistry = registry.createScope();
  const effects = effectScope(true);
  const controller = new AbortController();
  const cleanups = new Set<() => void>();
  let disposed = false;

  function onDispose(cleanup: () => void): () => void {
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      cleanups.delete(dispose);
      cleanup();
    };
    if (disposed) dispose();
    else cleanups.add(dispose);
    return dispose;
  }

  function run<T>(callback: () => T): T {
    if (disposed) throw new Error('UI plugin scope is disposed');
    return effects.run(callback) as T;
  }

  const lifecycle: UIPluginLifecycle = {
    signal: controller.signal,
    onDispose,
    effect(setup) {
      const cleanup = run(setup);
      return onDispose(cleanup ?? (() => undefined));
    },
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    controller.abort();
    const errors: unknown[] = [];
    const steps = [...cleanups].reverse();
    steps.push(() => effects.stop(), () => scopedRegistry.dispose());
    for (const cleanup of steps) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'UI plugin cleanup failed');
  }

  return { registry: scopedRegistry, lifecycle, run, dispose };
}
