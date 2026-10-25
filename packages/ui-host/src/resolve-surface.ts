/**
 * 组合根界面选择（多根界面试验田，CR-065 切片六）：
 * 组合根持有受信界面清单，按用户持久化选择挑出本次要挂载的根界面。
 * - queryValue（如 URL ?surface=workbench-compact-ui）优先且写入存储；
 * - 未指定界面或 id 未知时回退到组合根提供的默认界面，再回退清单第一项。
 */
export function resolveSurfaceChoice<T extends { readonly id: string }>(
  surfaces: readonly T[],
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  options: { storageKey: string; queryValue?: string | null; defaultSurfaceId?: string },
): T {
  if (surfaces.length === 0) throw new Error('[ui-host] resolveSurfaceChoice requires at least one surface');
  const fallback = surfaces.find((s) => s.id === options.defaultSurfaceId) ?? surfaces[0]!;
  let picked: string | null = options.queryValue ?? null;
  if (picked && storage) {
    try { storage.setItem(options.storageKey, picked); } catch { /* 存储不可用时仅本次生效 */ }
  }
  if (!picked && storage) {
    try { picked = storage.getItem(options.storageKey); } catch { picked = null; }
  }
  return surfaces.find((s) => s.id === picked) ?? fallback;
}

/** Host-owned selection/persistence; consumers only see trusted descriptors and commands. */
export function createSurfaceNavigation(
  surfaces: readonly { readonly id: string; readonly displayName?: string }[],
  options: {
    currentSurfaceId: string;
    defaultSurfaceId: string;
    storageKey: string;
    storage?: Pick<Storage, 'setItem'>;
    location: { readonly href: string; replace(url: string): void };
  },
) {
  if (!surfaces.some(surface => surface.id === options.defaultSurfaceId)) throw new Error('[ui-host] Default surface is not registered');
  const select = (id: string) => {
    if (!surfaces.some(surface => surface.id === id)) throw new Error('[ui-host] Surface is not registered');
    try { options.storage?.setItem(options.storageKey, id); } catch { /* URL still carries this selection. */ }
    const url = new URL(options.location.href);
    url.searchParams.set('surface', id);
    options.location.replace(url.toString());
  };
  return Object.freeze({
    currentId: options.currentSurfaceId,
    options: Object.freeze(surfaces.map(surface => Object.freeze({value: surface.id, label: surface.displayName ?? surface.id}))),
    select,
    openDefault: () => select(options.defaultSurfaceId),
  });
}
