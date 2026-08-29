import {ipcRenderer, type IpcRendererEvent} from 'electron'
import type {
  ProfileAuthorizationRequest,
  ProactiveActivityCapture,
  ProfileDesiredState,
  ProfilePersistenceUpdate,
  ProfileSourceId,
  ProactiveExportResult,
  HomeAssistantConnectionInput,
  ProactiveHomeEntityView,
  ProactiveIntelligenceDashboard,
  ProactiveProfileClaimState,
  ProactiveProfileClaimView,
  ProactiveProfileStatus,
  XiaomiHealthConnectionInput,
} from '@aervox/contracts/proactive'

export type ProactiveToolApprovalMode = 'ask' | 'full_access'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const profileSourceIds = new Set([
  'aervox.activity', 'aervox.operation', 'device.app_activity', 'device.browser_activity',
  'device.input_content', 'device.clipboard', 'device.screen_capture', 'filesystem.full_disk_watch',
  'external.communication', 'device.microphone', 'device.camera', 'device.location', 'device.sensors',
  'restricted.profile', 'background.persistent', 'action.local', 'action.external',
  'action.privileged', 'action.irreversible',
])
const profileDesiredStates = new Set(['none', 'enabled', 'paused', 'revoking', 'revoked'])
const profileEffectiveStates = new Set(['inactive', 'configuring', 'active', 'limited', 'suspended', 'revoking'])
const profileOsStatuses = new Set(['granted', 'denied', 'prompt', 'unavailable', 'unknown'])

/**
 * Runtime validation keeps an untrusted IPC response from becoming a
 * renderer-side permission fact. The host remains the authority.
 */
export function isProactiveProfileStatus(value: unknown): value is ProactiveProfileStatus {
  if (!isObject(value)) return false
  if (value.version !== 'full_profile_v1') return false
  if (!profileDesiredStates.has(String(value.desiredState)) || !profileEffectiveStates.has(String(value.effectiveState))) return false
  if (!isObject(value.host)
    || typeof value.host.available !== 'boolean'
    || typeof value.host.trusted !== 'boolean'
    || typeof value.host.signed !== 'boolean'
    || typeof value.host.platform !== 'string'
    || typeof value.host.hostId !== 'string'
    || typeof value.host.localOnly !== 'boolean'
    || typeof value.host.localReady !== 'boolean') return false
  if (!Array.isArray(value.capabilities) || !isObject(value.persistence)) return false
  if (typeof value.persistence.autostart !== 'boolean'
    || typeof value.persistence.background !== 'boolean'
    || typeof value.persistence.sleepResume !== 'boolean'
    || typeof value.persistence.restartResume !== 'boolean'
    || value.persistence.rawRetentionDays !== 7
    || value.persistence.rawDeleteAfterMemoryExtraction !== true) return false
  for (const capability of value.capabilities) {
    if (!isObject(capability)
      || typeof capability.id !== 'string'
      || !profileSourceIds.has(capability.id)
      || typeof capability.label !== 'string'
      || typeof capability.description !== 'string'
      || typeof capability.required !== 'boolean'
      || typeof capability.osStatus !== 'string'
      || !profileOsStatuses.has(capability.osStatus)
      || typeof capability.canRequest !== 'boolean') return false
  }
  return typeof value.updatedAt === 'string'
}

function requireStatus(value: unknown): ProactiveProfileStatus {
  if (!isProactiveProfileStatus(value)) throw new Error('invalid proactive host status')
  return value
}

function requireClaim(value: unknown): ProactiveProfileClaimView {
  if (!isObject(value)
    || typeof value.id !== 'string'
    || typeof value.claimType !== 'string'
    || typeof value.subjectKey !== 'string'
    || typeof value.content !== 'string'
    || typeof value.state !== 'string'
    || typeof value.confidence !== 'number'
    || typeof value.updatedAt !== 'string') {
    throw new Error('invalid proactive profile claim')
  }
  return value as unknown as ProactiveProfileClaimView
}

function requireDashboard(value: unknown): ProactiveIntelligenceDashboard {
  if (!isObject(value)
    || !Array.isArray(value.timeline)
    || !Array.isArray(value.projects)
    || !Array.isArray(value.workflows)
    || !Array.isArray(value.connections)
    || !Array.isArray(value.homeEntities)
    || !Array.isArray(value.health)) {
    throw new Error('invalid proactive intelligence dashboard')
  }
  return value as unknown as ProactiveIntelligenceDashboard
}

function requireHomeEntity(value: unknown): ProactiveHomeEntityView {
  if (!isObject(value)
    || typeof value.id !== 'string'
    || typeof value.connectionId !== 'string'
    || typeof value.entityId !== 'string'
    || typeof value.enabled !== 'boolean'
    || !Array.isArray(value.allowedOps)) {
    throw new Error('invalid Home Assistant entity')
  }
  return value as unknown as ProactiveHomeEntityView
}

export const proactiveApi = {
  getStatus: async (toolApprovalMode: ProactiveToolApprovalMode): Promise<ProactiveProfileStatus> =>
    requireStatus(await ipcRenderer.invoke('proactive:status', {toolApprovalMode})),

  authorize: async (request: ProfileAuthorizationRequest, toolApprovalMode: ProactiveToolApprovalMode): Promise<ProactiveProfileStatus> =>
    requireStatus(await ipcRenderer.invoke('proactive:authorize', {...request, toolApprovalMode})),

  setDesiredState: async (desiredState: Extract<ProfileDesiredState, 'enabled' | 'paused' | 'revoked'>, toolApprovalMode: ProactiveToolApprovalMode): Promise<ProactiveProfileStatus> =>
    requireStatus(await ipcRenderer.invoke('proactive:desired-state', {desiredState, toolApprovalMode})),

  setPersistence: async (update: ProfilePersistenceUpdate, toolApprovalMode: ProactiveToolApprovalMode): Promise<ProactiveProfileStatus> =>
    requireStatus(await ipcRenderer.invoke('proactive:persistence', {update, toolApprovalMode})),

  requestCapability: async (id: ProfileSourceId, toolApprovalMode: ProactiveToolApprovalMode): Promise<ProactiveProfileStatus> =>
    requireStatus(await ipcRenderer.invoke('proactive:capability:request', {id, toolApprovalMode})),

  deleteSource: async (id: ProfileSourceId, toolApprovalMode: ProactiveToolApprovalMode): Promise<ProactiveProfileStatus> =>
    requireStatus(await ipcRenderer.invoke('proactive:source:delete', {id, toolApprovalMode})),

  recordActivity: async (
    source: 'aervox.activity' | 'aervox.operation',
    capture: ProactiveActivityCapture,
  ): Promise<boolean> => ipcRenderer.invoke('proactive:activity', {source, capture}) as Promise<boolean>,

  listClaims: async (): Promise<readonly ProactiveProfileClaimView[]> => {
    const value = await ipcRenderer.invoke('proactive:claims:list') as unknown
    if (!Array.isArray(value)) throw new Error('invalid proactive profile claim list')
    return value.map(requireClaim)
  },

  updateClaimState: async (
    claimId: string,
    state: Extract<ProactiveProfileClaimState, 'confirmed' | 'rejected'>,
  ): Promise<ProactiveProfileClaimView> => requireClaim(
    await ipcRenderer.invoke('proactive:claims:state', {claimId, state}),
  ),

  getIntelligenceDashboard: async (): Promise<ProactiveIntelligenceDashboard> =>
    requireDashboard(await ipcRenderer.invoke('proactive:intelligence:dashboard')),

  connectHomeAssistant: (input: HomeAssistantConnectionInput): Promise<unknown> =>
    ipcRenderer.invoke('proactive:ha:connect', input),

  syncHomeAssistant: (connectionId: string): Promise<unknown> =>
    ipcRenderer.invoke('proactive:ha:sync', {connectionId}),

  configureHomeAssistantEntity: async (
    connectionId: string,
    entityId: string,
    patch: {enabled?: boolean; sensitive?: boolean; allowedOps?: string[]},
  ): Promise<ProactiveHomeEntityView> => requireHomeEntity(
    await ipcRenderer.invoke('proactive:ha:entity', {connectionId, entityId, patch}),
  ),

  deleteHomeAssistant: (connectionId: string): Promise<boolean> =>
    ipcRenderer.invoke('proactive:ha:delete', {connectionId}) as Promise<boolean>,

  connectXiaomiHealth: (input: XiaomiHealthConnectionInput): Promise<unknown> =>
    ipcRenderer.invoke('proactive:xiaomi:connect', input),

  syncXiaomiHealth: (connectionId: string, localDate?: string): Promise<unknown> =>
    ipcRenderer.invoke('proactive:xiaomi:sync', {connectionId, localDate}),

  deleteXiaomiHealth: (connectionId: string): Promise<boolean> =>
    ipcRenderer.invoke('proactive:xiaomi:delete', {connectionId}) as Promise<boolean>,

  exportData: async (includeRaw = false): Promise<ProactiveExportResult | null> => {
    const result = await ipcRenderer.invoke('proactive:export', {includeRaw}) as unknown
    if (result === null) return null
    if (!isObject(result) || typeof result.path !== 'string' || !isObject(result.manifest)) {
      throw new Error('invalid proactive export result')
    }
    return result as unknown as ProactiveExportResult
  },

  shouldKeepAlive: (): Promise<boolean> => ipcRenderer.invoke('proactive:keep-alive') as Promise<boolean>,

  onStatusChange: (callback: (status: ProactiveProfileStatus) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, value: unknown) => {
      if (isProactiveProfileStatus(value)) callback(value)
    }
    ipcRenderer.on('proactive:status:changed', listener)
    return () => ipcRenderer.removeListener('proactive:status:changed', listener)
  },
}
