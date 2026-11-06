/** Shared companion visuals without the workbench component or global workbench theme. */
export { default as CompanionAvatar } from './components/CompanionAvatar.vue';
export { getAvailableLive2DModels } from './live2d/available-models';
export { DEFAULT_AERVOX_MODEL, type AervoxLive2DModel } from './live2d/model';
export { useCompanionAvatarBinding, type CompanionAvatarBindingState } from './composables/useCompanionAvatarBinding';
export { default as UserQuestionComposer } from './components/UserQuestionComposer.vue';
export { default as AervoxBrandMark } from './components/AervoxBrandMark.vue';
export { default as AervoxCompanionMark } from './components/AervoxCompanionMark.vue';
export { default as Live2DPet } from './components/Live2DPet.vue';
export { readCompanionIdentity } from './utils/companion-identity';
export type { SurfaceNavigation } from './surface-navigation';
export { useSessionHistory } from './composables/useSessionHistory';
export { useSessionDraft } from './composables/session-draft';
