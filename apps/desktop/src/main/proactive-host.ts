import {app, systemPreferences} from 'electron'
import {randomUUID} from 'node:crypto'
import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import type {
  ProfileActivationState,
  ProfileCapabilityState,
  ProfileDesiredState,
  ProfileEffectiveState,
  ProfileOsStatus,
  ProfilePersistenceState,
  ProfilePersistenceUpdate,
  ProfileSourceId,
  ProactiveProfileStatus,
  ProfileAuthorizationRequest,
} from '@aervox/contracts/proactive'
import {
  FULL_PROFILE_VERSION,
  PROFILE_CAPABILITY_CATALOG,
  deriveProfileEffectiveState,
} from '@aervox/contracts/proactive'

const STATE_VERSION = 1 as const
const ACTIVATION_TTL_MS = 5 * 60 * 1000

type MediaType = 'microphone' | 'camera' | 'screen'
type MediaAccessValue = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export interface ProactiveCapabilityProbeResult {
  status: ProfileOsStatus
  reason?: string
  canRequest?: boolean
}

interface PersistedProactiveState {
  version: typeof STATE_VERSION
  hostId: string
  desiredState: ProfileDesiredState
  fullAccessEnabled: boolean
  authorizedAt?: string
  revokedAt?: string
  requestedCapabilities: Partial<Record<ProfileSourceId, string>>
  revokedCapabilities: Partial<Record<ProfileSourceId, string>>
  persistence: {
    autostart: boolean
    background: boolean
    sleepResume: boolean
    restartResume: boolean
  }
  activation?: ProfileActivationState
}

export interface ProactiveHostDependencies {
  statePath?: string
  platform?: NodeJS.Platform
  now?: () => Date
  hostId?: string
  appVersion?: string
  isPackaged?: boolean
  /** Explicit development-only trust; never inferred from a renderer flag. */
  trustLocalDevHost?: boolean
  localReady?: boolean | (() => boolean)
  /** Optional first-party source adapter. A missing adapter is reported as unknown. */
  capabilityProbe?: (id: ProfileSourceId) => ProactiveCapabilityProbeResult | undefined | Promise<ProactiveCapabilityProbeResult | undefined>
  /** Optional adapter request hook for non-Electron platform capabilities. */
  requestCapability?: (id: ProfileSourceId) => void | Promise<void>
  getMediaAccessStatus?: (mediaType: MediaType) => MediaAccessValue
  askForMediaAccess?: (mediaType: 'microphone' | 'camera') => Promise<boolean>
  isTrustedAccessibilityClient?: (prompt: boolean) => boolean
  getLoginItemSettings?: () => {openAtLogin?: boolean}
  setLoginItemSettings?: (settings: {openAtLogin: boolean; openAsHidden?: boolean}) => void
}

export interface ProactiveHost {
  initialize(): Promise<void>
  getStatus(toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  authorize(request: ProfileAuthorizationRequest, toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  setDesiredState(desiredState: Extract<ProfileDesiredState, 'enabled' | 'paused' | 'revoked'>, toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  setPersistence(update: ProfilePersistenceUpdate, toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  requestCapability(id: ProfileSourceId, toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  revokeCapability(id: ProfileSourceId, toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  shouldCollect(): boolean
  shouldKeepAlive(): boolean
}

const defaultDependencies = (): Required<Pick<ProactiveHostDependencies,
  'platform' | 'now' | 'appVersion' | 'isPackaged' | 'localReady' | 'getMediaAccessStatus' | 'askForMediaAccess'
  | 'isTrustedAccessibilityClient' | 'getLoginItemSettings' | 'setLoginItemSettings'>> => ({
  platform: process.platform,
  now: () => new Date(),
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  localReady: false,
  getMediaAccessStatus: (mediaType) => systemPreferences.getMediaAccessStatus(mediaType),
  askForMediaAccess: (mediaType) => systemPreferences.askForMediaAccess(mediaType),
  isTrustedAccessibilityClient: (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt),
  getLoginItemSettings: () => app.getLoginItemSettings(),
  setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
})

function defaultStatePath(): string {
  return join(app.getPath('userData'), 'proactive', 'control-state.json')
}

function isDesiredState(value: unknown): value is ProfileDesiredState {
  return value === 'none' || value === 'enabled' || value === 'paused' || value === 'revoking' || value === 'revoked'
}

function toOsStatus(value: unknown): ProfileOsStatus {
  if (value === 'granted') return 'granted'
  if (value === 'denied' || value === 'restricted') return 'denied'
  if (value === 'not-determined') return 'prompt'
  return 'unknown'
}

function safeDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function isSourceId(value: string): value is ProfileSourceId {
  return PROFILE_CAPABILITY_CATALOG.some((capability) => capability.id === value)
}

function emptyState(hostId: string): PersistedProactiveState {
  return {
    version: STATE_VERSION,
    hostId,
    desiredState: 'none',
    fullAccessEnabled: false,
    requestedCapabilities: {},
    revokedCapabilities: {},
    persistence: {
      autostart: false,
      background: false,
      sleepResume: true,
      restartResume: true,
    },
  }
}

function parseState(raw: string, fallbackHostId: string): PersistedProactiveState {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedProactiveState>
    if (parsed.version !== STATE_VERSION || !isDesiredState(parsed.desiredState)) return emptyState(fallbackHostId)
    const requestedCapabilities: Partial<Record<ProfileSourceId, string>> = {}
    const revokedCapabilities: Partial<Record<ProfileSourceId, string>> = {}
    if (parsed.requestedCapabilities && typeof parsed.requestedCapabilities === 'object') {
      for (const [id, requestedAt] of Object.entries(parsed.requestedCapabilities)) {
        if (isSourceId(id) && typeof requestedAt === 'string' && safeDate(requestedAt)) requestedCapabilities[id] = new Date(requestedAt).toISOString()
      }
    }
    if (parsed.revokedCapabilities && typeof parsed.revokedCapabilities === 'object') {
      for (const [id, revokedAt] of Object.entries(parsed.revokedCapabilities)) {
        if (isSourceId(id) && typeof revokedAt === 'string' && safeDate(revokedAt)) revokedCapabilities[id] = new Date(revokedAt).toISOString()
      }
    }
    const persistence = parsed.persistence && typeof parsed.persistence === 'object' ? parsed.persistence : {}
    return {
      version: STATE_VERSION,
      hostId: typeof parsed.hostId === 'string' && parsed.hostId.length > 0 ? parsed.hostId : fallbackHostId,
      desiredState: parsed.desiredState,
      fullAccessEnabled: parsed.fullAccessEnabled === true,
      authorizedAt: safeDate(parsed.authorizedAt),
      revokedAt: safeDate(parsed.revokedAt),
      requestedCapabilities,
      revokedCapabilities,
      persistence: {
        autostart: persistence.autostart === true,
        background: persistence.background === true,
        sleepResume: persistence.sleepResume !== false,
        restartResume: persistence.restartResume !== false,
      },
      activation: parsed.activation && typeof parsed.activation === 'object'
        && typeof parsed.activation.epoch === 'string'
        && typeof parsed.activation.expiresAt === 'string'
        && typeof parsed.activation.lastHeartbeatAt === 'string'
        ? {
          epoch: parsed.activation.epoch,
          expiresAt: new Date(parsed.activation.expiresAt).toISOString(),
          lastHeartbeatAt: new Date(parsed.activation.lastHeartbeatAt).toISOString(),
        }
        : undefined,
    }
  } catch {
    return emptyState(fallbackHostId)
  }
}

function clonePersistence(state: PersistedProactiveState): ProfilePersistenceState {
  return {
    autostart: state.persistence.autostart,
    background: state.persistence.background,
    sleepResume: state.persistence.sleepResume,
    restartResume: state.persistence.restartResume,
    rawRetentionDays: 7,
    rawDeleteAfterMemoryExtraction: true,
  }
}

function mediaCapabilityStatus(
  dependencies: Required<Pick<ProactiveHostDependencies, 'getMediaAccessStatus' | 'platform' | 'isTrustedAccessibilityClient'>>,
  id: ProfileSourceId,
): {status: ProfileOsStatus; reason?: string; canRequest: boolean} {
  if (id === 'device.microphone' || id === 'device.camera' || id === 'device.screen_capture') {
    const mediaType = id === 'device.microphone' ? 'microphone' : id === 'device.camera' ? 'camera' : 'screen'
    try {
      return {status: toOsStatus(dependencies.getMediaAccessStatus(mediaType)), canRequest: mediaType !== 'screen'}
    } catch (error) {
      return {status: 'unknown', reason: error instanceof Error ? error.message : 'media_permission_unavailable', canRequest: mediaType !== 'screen'}
    }
  }

  if (id === 'device.app_activity' || id === 'device.input_content') {
    if (dependencies.platform !== 'darwin') {
      return {status: 'unknown', reason: 'platform_permission_probe_unimplemented', canRequest: false}
    }
    try {
      const granted = dependencies.isTrustedAccessibilityClient(false)
      return {status: granted ? 'granted' : 'denied', reason: granted ? undefined : 'accessibility_permission_required', canRequest: true}
    } catch (error) {
      return {status: 'unknown', reason: error instanceof Error ? error.message : 'accessibility_probe_unavailable', canRequest: true}
    }
  }

  return {status: 'unknown', reason: 'source_adapter_not_connected', canRequest: false}
}

export function createProactiveHost(input: ProactiveHostDependencies = {}): ProactiveHost {
  const defaults = defaultDependencies()
  const isPackaged = defaults.isPackaged
  const dependencies = {
    ...defaults,
    ...input,
    isPackaged,
    statePath: input.statePath ?? defaultStatePath(),
    hostId: input.hostId ?? `desktop-${randomUUID()}`,
    // 开发信任规则（显式关闭优先）：
    // - AERVOX_TRUST_LOCAL_DEV_HOST=0 → 强制不受信（恢复挂起，等同 `aervox dev` 显式关闭）；
    // - 显式 1 → 信任；未设置时：开发构建（未打包）默认信任本地未签名 Host，
    //   与 `aervox dev full/desktop` 的默认语义一致，避免启动方式不同导致信任判定差异。
    trustLocalDevHost: input.trustLocalDevHost
      ?? (process.env.AERVOX_TRUST_LOCAL_DEV_HOST === '0'
        ? false
        : process.env.AERVOX_TRUST_LOCAL_DEV_HOST === '1' || !isPackaged),
  }
  let state = emptyState(dependencies.hostId)

  /** 采集/保活要求激活租约仍然有效：租约过期或未建立即视为挂起，防止挂断后继续采集 */
  const activationLeaseActive = (): boolean => {
    const activation = state.activation
    if (!activation) return false
    return new Date(activation.expiresAt).getTime() > Date.now()
  }
  let initialized = false
  let initializationPromise: Promise<void> | undefined
  let mutationQueue = Promise.resolve()

  const persist = async (): Promise<void> => {
    const path = dependencies.statePath
    await mkdir(dirname(path), {recursive: true})
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {encoding: 'utf8', mode: 0o600})
    await chmod(temporaryPath, 0o600).catch(() => undefined)
    await rename(temporaryPath, path)
    await chmod(path, 0o600).catch(() => undefined)
  }

  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return
    if (!initializationPromise) {
      initializationPromise = (async () => {
        try {
          state = parseState(await readFile(dependencies.statePath, 'utf8'), dependencies.hostId)
        } catch {
          state = emptyState(dependencies.hostId)
        }
        // Keep the OS login-item setting as the source of truth for autostart.
        try {
          state.persistence.autostart = dependencies.getLoginItemSettings().openAtLogin === true
        } catch {
          // Some Linux desktop environments do not implement login item settings.
        }
        initialized = true
      })()
    }
    await initializationPromise
  }

  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationQueue
    let resolveNext: (() => void) | undefined
    mutationQueue = new Promise<void>((resolve) => { resolveNext = resolve })
    await previous
    try {
      return await operation()
    } finally {
      resolveNext?.()
    }
  }

  const localReady = (): boolean => {
    try {
      return typeof dependencies.localReady === 'function' ? dependencies.localReady() : dependencies.localReady
    } catch {
      return false
    }
  }

  const hostState = () => {
    const signed = dependencies.isPackaged === true
    const trusted = signed || dependencies.trustLocalDevHost === true
    return {
      available: true,
      // Development builds are intentionally visible as untrusted for activation purposes.
      trusted,
      signed,
      platform: dependencies.platform,
      hostId: state.hostId,
      localOnly: true,
      localReady: localReady(),
      reason: signed ? undefined : trusted ? 'explicit_local_development_trust' : 'unsigned_development_host',
    }
  }

  const capabilityStates = async (): Promise<ProfileCapabilityState[]> => Promise.all(PROFILE_CAPABILITY_CATALOG.map(async (catalog) => {
    let probe = mediaCapabilityStatus(dependencies, catalog.id)
    let customApplied = false
    if (dependencies.capabilityProbe) {
      try {
        const custom = await dependencies.capabilityProbe(catalog.id)
        if (custom) {
          customApplied = true
          const validStatus: ProfileOsStatus = custom.status === 'granted' || custom.status === 'denied'
            || custom.status === 'prompt' || custom.status === 'unavailable' || custom.status === 'unknown'
            ? custom.status
            : 'unknown'
          probe = {
            status: validStatus,
            reason: custom.reason,
            canRequest: custom.canRequest ?? probe.canRequest,
          }
        }
      } catch (error) {
        customApplied = true
        probe = {status: 'unknown', reason: error instanceof Error ? error.message : 'capability_probe_failed', canRequest: false}
      }
    }
    if (!customApplied && (catalog.id === 'aervox.activity' || catalog.id === 'aervox.operation')) {
      probe = {status: 'unknown', reason: 'renderer_observation_adapter_not_connected', canRequest: false}
    }
    if (!customApplied && catalog.id === 'background.persistent') {
      probe = {
        status: state.persistence.background ? 'granted' : 'denied',
        reason: state.persistence.background ? undefined : 'background_persistence_not_enabled',
        canRequest: true,
      }
    }
    if (!customApplied && catalog.id.startsWith('action.')) {
      const granted = Boolean(state.authorizedAt && state.requestedCapabilities[catalog.id])
      probe = {
        status: granted ? 'granted' : 'prompt',
        reason: granted ? undefined : 'full_profile_action_grant_required',
        canRequest: false,
      }
    }
    if (state.revokedCapabilities[catalog.id]) {
      probe = {
        status: 'denied',
        reason: 'user_revoked',
        canRequest: !catalog.id.startsWith('action.'),
      }
    }
    return {
      ...catalog,
      osStatus: probe.status,
      reason: probe.reason,
      lastVerifiedAt: dependencies.now().toISOString(),
      canRequest: probe.canRequest,
    }
  }))

  const maybeRefreshActivation = (toolApprovalMode: 'ask' | 'full_access', capabilities: readonly ProfileCapabilityState[], now: Date): void => {
    const host = hostState()
    const ready = state.desiredState === 'enabled'
      && state.fullAccessEnabled
      && toolApprovalMode === 'full_access'
      && host.available
      && host.trusted
      && host.localReady
    if (!ready) {
      state.activation = undefined
      return
    }
    const existing = state.activation
    const expiresAt = new Date(now.getTime() + ACTIVATION_TTL_MS).toISOString()
    if (existing && new Date(existing.expiresAt).getTime() > now.getTime()) {
      state.activation = {...existing, expiresAt, lastHeartbeatAt: now.toISOString()}
      return
    }
    state.activation = {epoch: randomUUID(), expiresAt, lastHeartbeatAt: now.toISOString()}
  }

  const status = async (toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus> => {
    await ensureInitialized()
    const fullAccessEnabled = toolApprovalMode === 'full_access'
    if (state.fullAccessEnabled !== fullAccessEnabled) {
      state.fullAccessEnabled = fullAccessEnabled
      if (!fullAccessEnabled) state.activation = undefined
      await persist()
    }
    const now = dependencies.now()
    const capabilities = await capabilityStates()
    maybeRefreshActivation(toolApprovalMode, capabilities, now)
    const host = hostState()
    const effectiveState: ProfileEffectiveState = deriveProfileEffectiveState({
      desiredState: state.desiredState,
      toolApprovalMode,
      host,
      activation: state.activation,
      capabilities,
    })
    const suspendReason = effectiveState === 'suspended'
      ? state.desiredState === 'paused'
        ? 'user_paused'
        : toolApprovalMode !== 'full_access'
          ? 'tool_mode'
          : !host.localReady || !host.trusted
            ? 'local_unavailable'
            : 'lease_expired'
      : effectiveState === 'limited' ? 'os_permission' : undefined
    return {
      version: FULL_PROFILE_VERSION,
      desiredState: state.desiredState,
      effectiveState,
      toolApprovalMode,
      suspendReason,
      host,
      activation: state.activation,
      capabilities,
      persistence: clonePersistence(state),
      updatedAt: now.toISOString(),
    }
  }

  const requestMediaOrAccessibility = async (id: ProfileSourceId): Promise<void> => {
    try {
      if (dependencies.requestCapability) await dependencies.requestCapability(id)
      if (id === 'device.microphone' || id === 'device.camera') {
        await dependencies.askForMediaAccess(id === 'device.microphone' ? 'microphone' : 'camera')
      } else if (id === 'device.app_activity' || id === 'device.input_content') {
        if (dependencies.platform === 'darwin') dependencies.isTrustedAccessibilityClient(true)
      }
    } catch {
      // The subsequent status probe records the real denied/unknown state.
    }
  }

  return {
    async initialize() {
      await ensureInitialized()
    },
    getStatus: status,
    async authorize(request, toolApprovalMode) {
      return mutate(async () => {
        await ensureInitialized()
        if (!request.acknowledged) throw new Error('profile_authorization_acknowledgement_required')
        if (toolApprovalMode !== 'full_access') throw new Error('full_access_confirmation_required')
        const now = dependencies.now().toISOString()
        state.fullAccessEnabled = true
        state.authorizedAt ??= now
        state.revokedAt = undefined
        state.revokedCapabilities = {}
        state.desiredState = 'enabled'
        for (const capability of PROFILE_CAPABILITY_CATALOG) state.requestedCapabilities[capability.id] = now
        await setPersistenceInternal(request.enableAutostart, request.enableBackground, undefined, undefined)
        if (request.requestAllOsCapabilities) {
          await Promise.all([
            requestMediaOrAccessibility('device.microphone'),
            requestMediaOrAccessibility('device.camera'),
            requestMediaOrAccessibility('device.app_activity'),
            requestMediaOrAccessibility('device.input_content'),
          ])
        }
        await persist()
        return status(toolApprovalMode)
      })
    },
    async setDesiredState(desiredState, toolApprovalMode) {
      return mutate(async () => {
        await ensureInitialized()
        if (desiredState === 'enabled' && !state.authorizedAt) throw new Error('profile_authorization_required')
        if (desiredState === 'enabled' && toolApprovalMode !== 'full_access') throw new Error('full_access_confirmation_required')
        state.desiredState = desiredState
        if (desiredState === 'revoked') {
          state.revokedAt = dependencies.now().toISOString()
          state.activation = undefined
        }
        await persist()
        return status(toolApprovalMode)
      })
    },
    async setPersistence(update, toolApprovalMode) {
      return mutate(async () => {
        await ensureInitialized()
        await setPersistenceInternal(update.autostart, update.background, update.sleepResume, update.restartResume)
        await persist()
        return status(toolApprovalMode)
      })
    },
    async requestCapability(id, toolApprovalMode) {
      return mutate(async () => {
        await ensureInitialized()
        if (!isSourceId(id)) throw new Error('unknown_profile_capability')
        delete state.revokedCapabilities[id]
        await requestMediaOrAccessibility(id)
        await persist()
        return status(toolApprovalMode)
      })
    },
    async revokeCapability(id, toolApprovalMode) {
      return mutate(async () => {
        await ensureInitialized()
        if (!isSourceId(id)) throw new Error('unknown_profile_capability')
        state.revokedCapabilities[id] = dependencies.now().toISOString()
        state.activation = undefined
        await persist()
        return status(toolApprovalMode)
      })
    },
    shouldCollect() {
      return state.fullAccessEnabled && state.desiredState === 'enabled' && activationLeaseActive()
    },
    shouldKeepAlive() {
      return state.fullAccessEnabled && state.persistence.background && state.desiredState === 'enabled' && activationLeaseActive()
    },
  }

  async function setPersistenceInternal(autostart?: boolean, background?: boolean, sleepResume?: boolean, restartResume?: boolean): Promise<void> {
    if (autostart !== undefined) {
      try {
        dependencies.setLoginItemSettings({openAtLogin: autostart, openAsHidden: true})
        const observed = dependencies.getLoginItemSettings().openAtLogin
        state.persistence.autostart = observed === true
      } catch {
        state.persistence.autostart = false
      }
    }
    if (background !== undefined) state.persistence.background = background
    if (sleepResume !== undefined) state.persistence.sleepResume = sleepResume
    if (restartResume !== undefined) state.persistence.restartResume = restartResume
  }
}