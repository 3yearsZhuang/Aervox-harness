import { readonly, ref } from 'vue';

/** Latest refresh owns the projection; failures preserve previously loaded data. */
export function createResource<Args extends unknown[], Value>(query: (...args: Args) => Promise<Value>, commit: (value: Value) => void) {
  const loading = ref(false);
  const error = ref<string | null>(null);
  let generation = 0;
  const load = async (...args: Args): Promise<void> => {
    const current = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const value = await query(...args);
      if (current === generation) commit(value);
    } catch (cause) {
      if (current === generation) error.value = cause instanceof Error ? cause.message : '加载失败';
      throw cause;
    } finally { if (current === generation) loading.value = false; }
  };
  const replace = (value: Value): void => {
    generation++;
    loading.value = false;
    error.value = null;
    commit(value);
  };
  return {loading: readonly(loading), error: readonly(error), load, replace};
}
