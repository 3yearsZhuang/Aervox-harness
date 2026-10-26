import { inject, type InjectionKey } from 'vue';

/** Explicit platform choice; viewport size never enables a different UI system. */
export const material3ContextKey: InjectionKey<boolean> = Symbol.for('aervox.material3');
export function useMaterial3(): boolean { return inject(material3ContextKey, false); }
