/**
 * 组合根界面选择（多根界面试验田，CR-065 切片六）：
 * 组合根持有受信界面清单，按用户持久化选择挑出本次要挂载的根界面。
 * - queryValue（如 URL ?surface=workbench-compact-ui）优先且写入存储；
 * - 存储中的未知 id 静默回退到清单第一项，保证任何状态下都有可用界面。
 */
export function resolveSurfaceChoice<T extends { readonly id: string }>(
  surfaces: readonly T[],
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  options: { storageKey: string; queryValue?: string | null },
): T {
  if (surfaces.length === 0) throw new Error('[ui-host] resolveSurfaceChoice requires at least one surface');
  const fallback = surfaces[0]!;
  let picked: string | null = options.queryValue ?? null;
  if (picked && storage) {
    try { storage.setItem(options.storageKey, picked); } catch { /* 存储不可用时仅本次生效 */ }
  }
  if (!picked && storage) {
    try { picked = storage.getItem(options.storageKey); } catch { picked = null; }
  }
  return surfaces.find((s) => s.id === picked) ?? fallback;
}
