/**
 * Compatibility entry point for UI consumers. The neutral CAP-033 contract
 * lives in @aervox/contracts so Electron main/preload never depend on Vue.
 */
export {
  FULL_PROFILE_VERSION,
  PROFILE_SOURCE_IDS,
  PROFILE_CAPABILITY_CATALOG,
  deriveProfileEffectiveState,
  hasAllRequiredProfileCapabilities,
  isProfileSourceId,
  profileStatusLabel,
} from '@aervox/contracts'

export type {
  ProfileSourceId,
  ProfileOsStatus,
  ProfileDesiredState,
  ProfileEffectiveState,
  ProfileSuspendReason,
  ProfileCapabilityState,
  ProfilePersistenceState,
  ProfileHostState,
  ProfileActivationState,
  ProactiveProfileStatus,
  ProfileAuthorizationRequest,
  ProfilePersistenceUpdate,
  ProactiveExportResult,
  ProactiveActivityCapture,
  ProactiveProfileClaimState,
  ProactiveProfileClaimView,
  ProactiveDesktopBridge,
} from '@aervox/contracts'
