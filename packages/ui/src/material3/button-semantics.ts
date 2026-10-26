type MaterialButtonHost = HTMLElement & { readonly updateComplete?: Promise<boolean> };

const states = ['aria-pressed', 'aria-busy', 'aria-current'] as const;
const references = [
  ['aria-controls', 'ariaControlsElements'],
  ['aria-describedby', 'ariaDescribedByElements'],
  ['aria-labelledby', 'ariaLabelledByElements'],
] as const;
const names = [...states, ...references.map(([name]) => name)];
type ReferenceControl = HTMLElement & Partial<Record<typeof references[number][1], Element[] | null>>;

function setAttribute(element: Element, name: string, value: string | null) {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function readAttribute(host: HTMLElement, name: string): string | null {
  // The official delegate also overrides getAttribute(), but read its storage
  // explicitly so this adapter does not depend on that method replacement.
  return host.getAttribute(name) ?? host.getAttribute(`data-${name}`);
}

function findReference(host: HTMLElement, id: string): Element | null {
  let root = host.getRootNode() as Document | ShadowRoot;
  // Node identity can cross realms; avoid comparing it to this window's
  // Document/ShadowRoot constructor when following the host's ancestor scope.
  while (typeof root.getElementById === 'function') {
    const target = root.getElementById(id);
    if (target) return target;
    if (root.nodeType === 9 || !('host' in root)) break;
    root = root.host.getRootNode() as Document | ShadowRoot;
  }
  return null;
}

/**
 * Material Web 2.5 forwards only selected ARIA properties to its shadow button.
 * Preserve Aervox's controlled button semantics after each real render without
 * enabling Material's automatic toggle behavior. ID references use element
 * reflection when available so they can reach the host's ancestor DOM scope.
 */
export function bindMaterialButtonSemantics(host: MaterialButtonHost): { sync(): void; dispose(): void } {
  let disposed = false;
  let pending = false;
  const rendered = new MutationObserver(sync);
  const attributes = new MutationObserver(sync);
  attributes.observe(host, { attributes: true, attributeFilter: names.flatMap(name => [name, `data-${name}`]) });

  function sync() {
    if (disposed || pending) return;
    pending = true;
    void applyAfterRender();
  }

  async function applyAfterRender() {
    try {
      await host.updateComplete;
      if (disposed) return;
      const root = host.shadowRoot;
      // Do not observe our own ARIA writes or reflected-property setters.
      // Resume observing after the synchronous patch, including replacement of
      // the real control by a later Material render.
      rendered.disconnect();
      const control = root?.querySelector<ReferenceControl>('button, a');
      if (!control) return;
      for (const name of states) setAttribute(control, name, readAttribute(host, name));
      for (const [name, property] of references) {
        const value = readAttribute(host, name);
        const ids = value?.trim().split(/\s+/).filter(Boolean) ?? [];
        const targets = ids.map(id => findReference(host, id));
        if (property in control && targets.every((target): target is Element => target !== null)) {
          const current = control[property] ?? [];
          if (current.length !== targets.length || current.some((target, index) => target !== targets[index])) {
            control[property] = targets;
          }
          if (!ids.length) setAttribute(control, name, null);
        } else {
          // Retain unresolved IDs until the surrounding Vue render provides
          // their targets; the next component update retries the reflection.
          setAttribute(control, name, value);
        }
      }
    } catch {
      // A failed Material render has no usable control. A later host/component
      // update can retry; do not introduce a second unhandled render rejection.
    } finally {
      pending = false;
      const root = host.shadowRoot;
      if (!disposed && root) rendered.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: names });
    }
  }

  sync();
  return {
    sync,
    dispose() {
      disposed = true;
      attributes.disconnect();
      rendered.disconnect();
    },
  };
}
