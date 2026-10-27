import type { InjectionKey, Ref } from 'vue';

/** A confirmation cannot outlive its requesting dialog. */
export const materialDialogOpenKey: InjectionKey<Readonly<Ref<boolean>>> = Symbol('materialDialogOpen');
