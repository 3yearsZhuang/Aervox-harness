/**
 * CAP-033 proactive intelligence contract.
 *
 * This module is platform-neutral. It describes the device grant snapshot
 * returned by a trusted desktop observation host; it does not grant any OS
 * capability by itself.
 */

export const FULL_PROFILE_VERSION = 'full_profile_v1' as const

export const PROFILE_SOURCE_IDS = [
  'aervox.activity',
  'aervox.operation',
  'device.app_activity',
  'device.browser_activity',
  'device.input_content',
  'device.clipboard',
  'device.screen_capture',
  'filesystem.full_disk_watch',
  'external.communication',
  'device.microphone',
  'device.camera',
  'device.location',
  'device.sensors',
  'restricted.profile',
  'background.persistent',
  'action.local',
  'action.external',
  'action.privileged',
  'action.irreversible',
] as const

export type ProfileSourceId = (typeof PROFILE_SOURCE_IDS)[number]

export type ProfileOsStatus = 'granted' | 'denied' | 'prompt' | 'unavailable' | 'unknown'

export type ProfileDesiredState = 'none' | 'enabled' | 'paused' | 'revoking' | 'revoked'

export type ProfileEffectiveState = 'inactive' | 'configuring' | 'active' | 'limited' | 'suspended' | 'revoking'

export type ProfileSuspendReason =
  | 'tool_mode'
  | 'lease_expired'
  | 'local_unavailable'
  | 'watermark'
  | 'policy_mismatch'
  | 'source_revision_changed'
  | 'os_permission'
  | 'user_paused'

export interface ProfileCapabilityState {
  readonly id: ProfileSourceId
  readonly label: string
  readonly description: string
  readonly required: boolean
  /** Observation only; `granted` must come from the OS or an adapter. */
  readonly osStatus: ProfileOsStatus
  readonly reason?: string
  readonly lastVerifiedAt?: string
  readonly canRequest: boolean
}

export interface ProfilePersistenceState {
  readonly autostart: boolean
  readonly background: boolean
  readonly sleepResume: boolean
  readonly restartResume: boolean
  readonly rawRetentionDays: 7
  readonly rawDeleteAfterMemoryExtraction: true
}

export interface ProfileHostState {
  readonly available: boolean
  readonly trusted: boolean
  readonly signed: boolean
  readonly platform: string
  readonly hostId: string
  readonly localOnly: boolean
  readonly localReady: boolean
  readonly reason?: string
}

export interface ProfileActivationState {
  readonly epoch: string
  readonly expiresAt: string
  readonly lastHeartbeatAt: string
}

export interface ProactiveProfileStatus {
  readonly version: typeof FULL_PROFILE_VERSION
  readonly desiredState: ProfileDesiredState
  readonly effectiveState: ProfileEffectiveState
  readonly toolApprovalMode: 'ask' | 'full_access'
  readonly suspendReason?: ProfileSuspendReason
  readonly host: ProfileHostState
  readonly activation?: ProfileActivationState
  readonly capabilities: readonly ProfileCapabilityState[]
  readonly persistence: ProfilePersistenceState
  readonly updatedAt: string
}

export interface ProfileAuthorizationRequest {
  readonly acknowledged: boolean
  readonly enableAutostart: boolean
  readonly enableBackground: boolean
  readonly requestAllOsCapabilities: boolean
}

export interface ProfilePersistenceUpdate {
  readonly autostart?: boolean
  readonly background?: boolean
  readonly sleepResume?: boolean
  readonly restartResume?: boolean
}

export interface ProactiveExportResult {
  readonly path: string
  readonly manifest: {
    readonly schemaVersion: string
    readonly exportedAt: string
    readonly processingBoundary: 'local_only'
    readonly includeRaw: boolean
    readonly checksum: string
    readonly counts: Record<string, number>
  }
}

export interface ProactiveActivityCapture {
  readonly eventType: string
  readonly payloadText?: string
  readonly metadata?: Record<string, unknown>
}

export type ProactiveProfileClaimState = 'observed' | 'inferred' | 'user_asserted' | 'confirmed' | 'rejected'

export interface ProactiveProfileClaimView {
  readonly id: string
  readonly claimType: string
  readonly subjectKey: string
  readonly content: string
  readonly state: ProactiveProfileClaimState
  readonly confidence: number
  readonly firstObservedAt?: string | null
  readonly lastObservedAt?: string | null
  readonly updatedAt: string
}

export interface ProactiveDesktopBridge {
  getStatus(toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  authorize(request: ProfileAuthorizationRequest, toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  setDesiredState(desiredState: Extract<ProfileDesiredState, 'enabled' | 'paused' | 'revoked'>, toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  setPersistence(update: ProfilePersistenceUpdate, toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  requestCapability(id: ProfileSourceId, toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  deleteSource(id: ProfileSourceId, toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus>
  recordActivity(source: 'aervox.activity' | 'aervox.operation', capture: ProactiveActivityCapture): Promise<boolean>
  listClaims(): Promise<readonly ProactiveProfileClaimView[]>
  updateClaimState(claimId: string, state: Extract<ProactiveProfileClaimState, 'confirmed' | 'rejected'>): Promise<ProactiveProfileClaimView>
  exportData(includeRaw?: boolean): Promise<ProactiveExportResult | null>
  shouldKeepAlive(): Promise<boolean>
  onStatusChange(callback: (status: ProactiveProfileStatus) => void): () => void
}

export const PROFILE_CAPABILITY_CATALOG: readonly Omit<ProfileCapabilityState, 'osStatus' | 'reason' | 'lastVerifiedAt'>[] = [
  {id: 'aervox.activity', label: 'Aervox 使用', description: '工作台功能、学习时段、任务时长和提醒响应', required: true, canRequest: false},
  {id: 'aervox.operation', label: 'Aervox 操作', description: '界面与工具操作序列，用于形成操作习惯', required: true, canRequest: false},
  {id: 'device.app_activity', label: '应用与窗口', description: '前台应用、窗口、进程和活动时长', required: true, canRequest: true},
  {id: 'device.browser_activity', label: '浏览器与网页', description: '历史、标签页、网页标题和明确连接的页面', required: true, canRequest: true},
  {id: 'device.input_content', label: '键鼠与输入', description: '可验证的输入信号；受保护输入始终排除', required: true, canRequest: true},
  {id: 'device.clipboard', label: '剪贴板', description: '剪贴板变更和内容，用于上下文理解', required: true, canRequest: true},
  {id: 'device.screen_capture', label: '屏幕与视觉', description: '屏幕帧、OCR 和视觉上下文', required: true, canRequest: true},
  {id: 'filesystem.full_disk_watch', label: '文件与目录', description: '用户授权的文件、目录和持续变更', required: true, canRequest: true},
  {id: 'external.communication', label: '通信资料', description: '邮件、消息、联系人和日历连接器', required: true, canRequest: true},
  {id: 'device.microphone', label: '麦克风', description: '本地音频信号和语音上下文', required: true, canRequest: true},
  {id: 'device.camera', label: '摄像头', description: '本地视频信号和视觉上下文', required: true, canRequest: true},
  {id: 'device.location', label: '位置', description: '设备定位和位置变化', required: true, canRequest: true},
  {id: 'device.sensors', label: '其他传感器', description: '平台可提供的环境和设备信号', required: true, canRequest: true},
  {id: 'restricted.profile', label: '敏感私人资料', description: '健康、情绪、关系等用户明确选择的资料', required: true, canRequest: true},
  {id: 'background.persistent', label: '后台持续运行', description: '开机启动、应用退出后运行和休眠恢复', required: true, canRequest: true},
  {id: 'action.local', label: '本地主动操作', description: '获得单独授权的本地提醒和文件操作', required: true, canRequest: false},
  {id: 'action.external', label: '外部主动操作', description: '获得单独授权的浏览器、通信和设备操作', required: true, canRequest: false},
  {id: 'action.privileged', label: '特权主动操作', description: '获得单独授权的管理员级操作', required: true, canRequest: false},
  {id: 'action.irreversible', label: '不可逆主动操作', description: '获得单独授权的删除和其它不可逆操作', required: true, canRequest: false},
] as const

export function isProfileSourceId(value: unknown): value is ProfileSourceId {
  return typeof value === 'string' && (PROFILE_SOURCE_IDS as readonly string[]).includes(value)
}

export function hasAllRequiredProfileCapabilities(capabilities: readonly ProfileCapabilityState[]): boolean {
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]))
  return PROFILE_CAPABILITY_CATALOG
    .filter((capability) => capability.required)
    .every((capability) => byId.get(capability.id)?.osStatus === 'granted')
}

export function deriveProfileEffectiveState(input: {
  desiredState: ProfileDesiredState
  toolApprovalMode: 'ask' | 'full_access'
  host: Pick<ProfileHostState, 'available' | 'trusted' | 'localReady'>
  activation?: ProfileActivationState
  capabilities: readonly ProfileCapabilityState[]
}): ProfileEffectiveState {
  if (input.desiredState === 'revoking') return 'revoking'
  if (input.desiredState === 'none' || input.desiredState === 'revoked') return 'inactive'
  if (input.desiredState === 'paused') return 'suspended'
  if (input.toolApprovalMode !== 'full_access') return 'suspended'
  if (!input.host.available || !input.host.trusted || !input.host.localReady) return 'suspended'
  if (!hasAllRequiredProfileCapabilities(input.capabilities)) return 'limited'
  if (!input.activation) return 'suspended'
  return 'active'
}

export function profileStatusLabel(status: ProfileEffectiveState): string {
  return {
    inactive: '未启用',
    configuring: '配置中',
    active: '主动智能模式',
    limited: '主动智能模式受限',
    suspended: '主动智能已挂起',
    revoking: '正在关闭',
  }[status]
}
