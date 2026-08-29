import {app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, screen, shell, systemPreferences} from 'electron'
import {createHash} from 'node:crypto'
import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {delimiter, dirname, join} from 'node:path'
import {createProactiveHost} from './proactive-host'
import {
    createProactiveSourceAdapters,
    toCapabilityProbe,
    type ProactiveWideSourceId,
} from './proactive-source-adapters'
import type {
    ProfileAuthorizationRequest,
    ProfileCapabilityState,
    ProfilePersistenceUpdate,
    ProfileSourceId,
    ProactiveProfileStatus,
} from '@aervox/contracts/proactive'
import {resolveDesktopSessionId} from './runtime-config.js'

let mainWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let appTheme: 'light' | 'dark' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
const apiBaseUrl = (process.env.AERVOX_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
let proactiveLocalReady = false
const sourceConfigPath = join(app.getPath('userData'), 'proactive', 'source-config.json')
let proactiveFileRoots = (process.env.AERVOX_PROACTIVE_FILE_ROOTS ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
let proactiveSourceAdapters = createProactiveSourceAdapters({
    systemPreferences,
    screen,
    desktopCapturer,
    fileRoots: proactiveFileRoots,
    screenCapture: {
        request: async () => {
            await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: {width: 1, height: 1},
                fetchWindowIcons: false,
            })
        },
    },
})

function rebuildProactiveSourceAdapters() {
    proactiveSourceAdapters = createProactiveSourceAdapters({
        systemPreferences,
        screen,
        desktopCapturer,
        fileRoots: proactiveFileRoots,
        screenCapture: {
            request: async () => {
                await desktopCapturer.getSources({
                    types: ['screen'],
                    thumbnailSize: {width: 1, height: 1},
                    fetchWindowIcons: false,
                })
            },
        },
    })
}

async function loadProactiveSourceConfig(): Promise<void> {
    try {
        const parsed = JSON.parse(await readFile(sourceConfigPath, 'utf8')) as {fileRoots?: unknown}
        if (Array.isArray(parsed.fileRoots)) {
            proactiveFileRoots = parsed.fileRoots.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            rebuildProactiveSourceAdapters()
        }
    } catch {
        // Missing/malformed source config keeps the explicit environment/default roots.
    }
}

async function persistProactiveSourceConfig(): Promise<void> {
    await mkdir(dirname(sourceConfigPath), {recursive: true, mode: 0o700})
    const temporaryPath = `${sourceConfigPath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify({fileRoots: proactiveFileRoots}, null, 2)}\n`, {encoding: 'utf8', mode: 0o600})
    await chmod(temporaryPath, 0o600).catch(() => undefined)
    await rename(temporaryPath, sourceConfigPath)
    await chmod(sourceConfigPath, 0o600).catch(() => undefined)
}

const proactiveHost = createProactiveHost({
    localReady: () => proactiveLocalReady,
    capabilityProbe: async (id) => {
        if (id === 'aervox.activity' || id === 'aervox.operation') {
            return {status: 'granted', reason: 'first_party_renderer_adapter_ready', canRequest: false}
        }
        if (id === 'device.clipboard') {
            return {status: 'granted', reason: 'electron_clipboard_adapter_ready', canRequest: false}
        }
        const probe = await proactiveSourceAdapters.probe(id)
        return probe ? toCapabilityProbe(probe) : undefined
    },
    requestCapability: async (id) => {
        if (id === 'filesystem.full_disk_watch') {
            const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
                title: '选择主动智能可观察的文件根目录',
                properties: ['openDirectory', 'multiSelections'],
            })
            if (!result.canceled && result.filePaths.length > 0) {
                proactiveFileRoots = [...new Set([...proactiveFileRoots, ...result.filePaths])]
                rebuildProactiveSourceAdapters()
                await persistProactiveSourceConfig()
            }
            return
        }
        if ((proactiveSourceAdapters.all.map((adapter) => adapter.sourceId) as string[]).includes(id)) {
            await proactiveSourceAdapters.request(id as ProactiveWideSourceId)
        }
    },
})

interface ProactiveServerStatus {
    desiredState: 'none' | 'enabled' | 'paused' | 'revoking' | 'revoked'
    effectiveState: 'inactive' | 'configuring' | 'active' | 'limited' | 'suspended' | 'revoking'
    reason: string
    revision: {id: string; deviceId: string} | null
    sources: Array<{id: string; sourceKey: string; state: string}>
    activationLease: {id: string; epoch: string} | null
}

interface ProactiveAuthorizationResponse {
    revision: {id: string; deviceId: string}
}

let latestProactiveStatus: ProactiveProfileStatus | null = null
function rememberProactiveStatus(status: ProactiveProfileStatus): ProactiveProfileStatus {
    latestProactiveStatus = status
    return status
}

function isLoopbackApi(): boolean {
    try {
        const hostname = new URL(apiBaseUrl).hostname.toLowerCase()
        return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
    } catch {
        return false
    }
}

function proactiveAccessTokenPath(): string {
    const configured = process.env.AERVOX_PROACTIVE_ACCESS_TOKEN_PATH?.trim()
    if (configured) return configured
    if (process.platform === 'darwin') {
        return join(os.homedir(), 'Library', 'Application Support', 'Aervox', 'proactive-access.token')
    }
    if (process.platform === 'win32') {
        return join(process.env.LOCALAPPDATA ?? join(os.homedir(), 'AppData', 'Local'), 'Aervox', 'proactive-access.token')
    }
    return join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local', 'share'), 'aervox', 'proactive-access.token')
}

let cachedProactiveAccessToken: string | undefined
async function getProactiveAccessToken(): Promise<string> {
    const configured = process.env.AERVOX_PROACTIVE_ACCESS_TOKEN?.trim()
    if (configured) return configured
    if (cachedProactiveAccessToken) return cachedProactiveAccessToken
    const token = (await readFile(proactiveAccessTokenPath(), 'utf8')).trim()
    if (token.length < 32 || token.length > 256) throw new Error('本地主动画像访问 Token 无效')
    cachedProactiveAccessToken = token
    return token
}

async function localApiHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {Accept: 'application/json', 'Content-Type': 'application/json'}
    const workspaceId = process.env.AERVOX_WORKSPACE_ID?.trim()
    const userId = process.env.AERVOX_USER_ID?.trim()
    const authToken = process.env.AERVOX_AUTH_TOKEN?.trim()
    if (workspaceId) headers['x-workspace-id'] = workspaceId
    if (userId) headers['x-user-id'] = userId
    if (authToken) headers.Authorization = `Bearer ${authToken}`
    headers['x-aervox-proactive-token'] = await getProactiveAccessToken()
    return headers
}

async function requestProactiveApi<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!isLoopbackApi()) throw new Error('主动画像 API 必须运行在本机回环地址')
    const response = await fetch(`${apiBaseUrl}${path}`, {
        method,
        headers: await localApiHeaders(),
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        redirect: 'error',
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`主动画像 API ${method} ${path} 失败（HTTP ${response.status}）${text ? `: ${text.slice(0, 240)}` : ''}`)
    return (text ? JSON.parse(text) : null) as T
}

async function refreshProactiveLocalReady(): Promise<boolean> {
    if (!isLoopbackApi()) {
        proactiveLocalReady = false
        return false
    }
    try {
        const manifest = await requestProactiveApi<{processingBoundary?: unknown}>('GET', '/v1/proactive/manifest')
        proactiveLocalReady = manifest.processingBoundary === 'local_only'
    } catch {
        proactiveLocalReady = false
    }
    return proactiveLocalReady
}

function sourcePurpose(id: ProfileSourceId): string {
    if (id.startsWith('action.')) return 'action.authorize'
    if (id === 'background.persistent') return 'profile.persist'
    return 'profile.observe'
}

function sourceGrantState(capability: ProfileCapabilityState): 'requested' | 'granted' | 'denied' {
    if (capability.osStatus === 'granted') return 'granted'
    if (capability.osStatus === 'denied' || capability.osStatus === 'unavailable') return 'denied'
    return 'requested'
}

function redactCredentialMaterial(value: string): string {
    return value
        .replace(
            /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
            '[已排除私钥]',
        )
        .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[已排除访问密钥]')
        .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, '[已排除令牌]')
        .replace(
            /\b(password|passwd|passcode|token|api[_-]?key|secret|authorization|bearer)\b\s*[:=]\s*([^\s,;]+)/gi,
            (_match, key: string) => `${key}=[已排除凭据]`,
        )
}

function profileSources(status: ProactiveProfileStatus) {
    return status.capabilities.map((capability) => ({
        sourceKey: capability.id,
        purpose: sourcePurpose(capability.id),
        scope: 'all',
        osCapability: capability.id,
        state: sourceGrantState(capability),
        mandatory: capability.required,
        grantVersion: 1,
        metadata: {
            hostId: status.host.hostId,
            osStatus: capability.osStatus,
            reason: capability.reason,
            canRequest: capability.canRequest,
        },
        grantedAt: capability.osStatus === 'granted' ? capability.lastVerifiedAt ?? status.updatedAt : null,
        lastVerifiedAt: capability.lastVerifiedAt ?? status.updatedAt,
    }))
}

function isTheme(value: unknown): value is 'light' | 'dark' {
    return value === 'light' || value === 'dark'
}

function isToolApprovalMode(value: unknown): value is 'ask' | 'full_access' {
    return value === 'ask' || value === 'full_access'
}

function readToolApprovalMode(value: unknown): 'ask' | 'full_access' {
    if (!value || typeof value !== 'object') return 'ask'
    const mode = (value as {toolApprovalMode?: unknown}).toolApprovalMode
    return isToolApprovalMode(mode) ? mode : 'ask'
}

async function getProactiveServerStatus(): Promise<ProactiveServerStatus> {
    return requestProactiveApi<ProactiveServerStatus>('GET', '/v1/proactive/status')
}

async function ingestProactiveCapture(
    sourceKey: ProfileSourceId,
    input: {payloadText?: string; payload?: unknown; contentType?: string; checksum?: string; stableId?: boolean},
): Promise<boolean> {
    if (!await refreshProactiveLocalReady()) return false
    const status = await getProactiveServerStatus()
    if (status.desiredState !== 'enabled' || !status.revision) return false
    const source = status.sources.find((grant) => grant.sourceKey === sourceKey && grant.state === 'granted')
    if (!source) return false
    const payloadText = input.payloadText === undefined
        ? undefined
        : redactCredentialMaterial(input.payloadText).slice(0, 200_000)
    const payload = input.payload
    if (payloadText === undefined && payload === undefined) return false
    if (payload !== undefined && new TextEncoder().encode(JSON.stringify(payload)).byteLength > 5 * 1024 * 1024) {
        throw new Error('主动画像捕获批次超过 5 MiB 上限')
    }
    await requestProactiveApi('POST', '/v1/proactive/captures', {
        id: input.stableId && input.checksum
            ? `pro_capture_${status.revision.id.replace(/[^a-zA-Z0-9_-]/g, '_')}_${input.checksum.slice(0, 32)}`
            : undefined,
        revisionId: status.revision.id,
        sourceGrantId: source.id,
        sourceKey,
        contentType: input.contentType ?? (payloadText !== undefined ? 'text/plain' : 'application/json'),
        payloadText,
        payload,
        checksum: input.checksum,
        observedAt: new Date().toISOString(),
    })
    return true
}

async function syncActivation(
    localStatus: ProactiveProfileStatus,
    serverStatus?: ProactiveServerStatus,
): Promise<ProactiveServerStatus | null> {
    if (!localStatus.activation || localStatus.toolApprovalMode !== 'full_access') return serverStatus ?? null
    const current = serverStatus ?? await getProactiveServerStatus()
    if (!current.revision) return current
    if (current.activationLease?.epoch === localStatus.activation.epoch) {
        await requestProactiveApi('POST', `/v1/proactive/activation/${encodeURIComponent(current.activationLease.id)}/heartbeat`, {
            localReady: localStatus.host.localReady,
            fullAccessSnapshot: true,
            metadata: {hostId: localStatus.host.hostId, platform: localStatus.host.platform},
        })
    } else {
        await requestProactiveApi('POST', '/v1/proactive/activation', {
            revisionId: current.revision.id,
            deviceId: localStatus.host.hostId,
            epoch: localStatus.activation.epoch,
            localReady: localStatus.host.localReady,
            fullAccessSnapshot: true,
            metadata: {hostId: localStatus.host.hostId, platform: localStatus.host.platform},
        })
    }
    return getProactiveServerStatus()
}

async function syncAuthorization(localStatus: ProactiveProfileStatus): Promise<ProactiveServerStatus> {
    const authorized = await requestProactiveApi<ProactiveAuthorizationResponse>('POST', '/v1/proactive/authorize', {
        acknowledged: true,
        fullAccessConfirmed: true,
        toolApprovalMode: 'full_access',
        deviceId: localStatus.host.hostId,
        profileVersion: localStatus.version,
        manifest: {
            profileVersion: localStatus.version,
            hostId: localStatus.host.hostId,
            sources: localStatus.capabilities.map((capability) => capability.id),
        },
        sources: profileSources(localStatus),
    })
    const serverStatus = await getProactiveServerStatus()
    if (serverStatus.revision?.id !== authorized.revision.id) {
        throw new Error('主动画像授权修订未成为当前修订')
    }
    return (await syncActivation(localStatus, serverStatus)) ?? serverStatus
}

async function syncCapability(localStatus: ProactiveProfileStatus, sourceId: ProfileSourceId): Promise<void> {
    const serverStatus = await getProactiveServerStatus()
    const serverGrant = serverStatus.sources.find((source) => source.sourceKey === sourceId)
    const capability = localStatus.capabilities.find((source) => source.id === sourceId)
    if (!serverGrant || !capability) return
    await requestProactiveApi('PATCH', `/v1/proactive/sources/${encodeURIComponent(serverGrant.id)}`, {
        state: sourceGrantState(capability),
        lastVerifiedAt: capability.lastVerifiedAt ?? localStatus.updatedAt,
        metadata: {
            hostId: localStatus.host.hostId,
            osStatus: capability.osStatus,
            reason: capability.reason,
            canRequest: capability.canRequest,
        },
    })
}

async function endServerActivation(reason: string): Promise<void> {
    const serverStatus = await getProactiveServerStatus()
    if (!serverStatus.activationLease) return
    await requestProactiveApi(
        'POST',
        `/v1/proactive/activation/${encodeURIComponent(serverStatus.activationLease.id)}/end`,
        {reason},
    )
}

async function compositeProactiveStatus(toolApprovalMode: 'ask' | 'full_access'): Promise<ProactiveProfileStatus> {
    await refreshProactiveLocalReady()
    const localStatus = await proactiveHost.getStatus(toolApprovalMode)
    if (!proactiveLocalReady) return rememberProactiveStatus(localStatus)
    try {
        let serverStatus = await getProactiveServerStatus()
        if (toolApprovalMode !== 'full_access' && serverStatus.activationLease) {
            await endServerActivation('tool_mode_disabled')
            serverStatus = await getProactiveServerStatus()
        }
        if (localStatus.activation && localStatus.desiredState === 'enabled') {
            serverStatus = (await syncActivation(localStatus, serverStatus)) ?? serverStatus
        }
        if (localStatus.effectiveState === 'active' && serverStatus.effectiveState !== 'active') {
            return rememberProactiveStatus({
                ...localStatus,
                effectiveState: serverStatus.effectiveState === 'limited' ? 'limited' : 'suspended',
                suspendReason: serverStatus.effectiveState === 'limited' ? 'os_permission' : 'watermark',
            })
        }
        return rememberProactiveStatus(localStatus)
    } catch {
        proactiveLocalReady = false
        return rememberProactiveStatus(await proactiveHost.getStatus(toolApprovalMode))
    }
}

let lastClipboardChecksum: string | undefined
async function pollProactiveClipboard(): Promise<void> {
    if (!proactiveHost.shouldCollect()) return
    const clipboardGrant = latestProactiveStatus?.capabilities.find((capability) => capability.id === 'device.clipboard')
    if (clipboardGrant?.osStatus !== 'granted') return
    const text = clipboard.readText()
    if (!text) return
    const sanitized = redactCredentialMaterial(text)
    const checksum = createHash('sha256').update(sanitized, 'utf8').digest('hex')
    if (checksum === lastClipboardChecksum) return
    lastClipboardChecksum = checksum
    await ingestProactiveCapture('device.clipboard', {
        payloadText: sanitized,
        payload: {checksum, adapter: 'electron-clipboard-v1'},
        contentType: 'text/plain',
        checksum,
        stableId: true,
    })
}

const scheduledWideSources: readonly ProactiveWideSourceId[] = [
    'device.screen_capture',
    'device.browser_activity',
    'filesystem.full_disk_watch',
    'device.app_activity',
]

async function pollProactiveWideSources(): Promise<void> {
    if (!proactiveHost.shouldCollect()) return
    const localStatus = await proactiveHost.getStatus('full_access')
    for (const sourceId of scheduledWideSources) {
        const capability = localStatus.capabilities.find((item) => item.id === sourceId)
        if (capability?.osStatus !== 'granted') continue
        const batch = await proactiveSourceAdapters.capture(sourceId, {
            includeContent: sourceId === 'device.screen_capture',
            allowSensitiveContent: sourceId === 'device.screen_capture',
            roots: sourceId === 'filesystem.full_disk_watch' ? proactiveFileRoots : undefined,
            includePaths: false,
            maxItems: 100,
            maxDepth: 4,
        })
        for (const record of batch.records) {
            const payload = {
                eventType: record.eventType,
                payload: record.payload,
                metadata: record.metadata,
                adapterBatch: {complete: batch.complete, reason: batch.reason},
            }
            const canonical = JSON.stringify({sourceId, payload, payloadText: record.payloadText ?? ''})
            const checksum = createHash('sha256').update(canonical, 'utf8').digest('hex')
            await ingestProactiveCapture(sourceId, {
                payloadText: record.payloadText,
                payload,
                contentType: record.contentType,
                checksum,
                stableId: true,
            })
        }
    }
}

function isProfileSourceId(value: unknown): value is ProfileSourceId {
    return typeof value === 'string' && [
        'aervox.activity', 'aervox.operation', 'device.app_activity', 'device.browser_activity',
        'device.input_content', 'device.clipboard', 'device.screen_capture', 'filesystem.full_disk_watch',
        'external.communication', 'device.microphone', 'device.camera', 'device.location',
        'device.sensors', 'restricted.profile', 'background.persistent', 'action.local',
        'action.external', 'action.privileged', 'action.irreversible',
    ].includes(value)
}

function isProfileAuthorizationRequest(value: unknown): value is ProfileAuthorizationRequest {
    if (!value || typeof value !== 'object') return false
    const request = value as Record<string, unknown>
    return typeof request.acknowledged === 'boolean'
        && typeof request.enableAutostart === 'boolean'
        && typeof request.enableBackground === 'boolean'
        && typeof request.requestAllOsCapabilities === 'boolean'
}

function isProfilePersistenceUpdate(value: unknown): value is ProfilePersistenceUpdate {
    if (!value || typeof value !== 'object') return false
    const update = value as Record<string, unknown>
    return ['autostart', 'background', 'sleepResume', 'restartResume'].every((key) =>
        update[key] === undefined || typeof update[key] === 'boolean')
}

function objectInput(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function requiredConnectionId(value: unknown): string {
    const input = objectInput(value)
    const connectionId = input?.connectionId
    if (typeof connectionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(connectionId)) {
        throw new Error('invalid proactive integration connection id')
    }
    return connectionId
}

function validatedHomeAssistantInput(value: unknown): Record<string, unknown> {
    const input = objectInput(value)
    if (!input || typeof input.endpoint !== 'string' || typeof input.accessToken !== 'string') {
        throw new Error('invalid Home Assistant connection')
    }
    if (input.endpoint.length > 2048 || input.accessToken.length < 8 || input.accessToken.length > 4096) {
        throw new Error('invalid Home Assistant connection')
    }
    return input
}

function validatedXiaomiInput(value: unknown): Record<string, unknown> {
    const input = objectInput(value)
    if (!input || typeof input.apiBaseUrl !== 'string' || typeof input.accessToken !== 'string') {
        throw new Error('invalid Xiaomi Health connection')
    }
    if (input.apiBaseUrl.length > 2048 || input.accessToken.length < 8 || input.accessToken.length > 4096) {
        throw new Error('invalid Xiaomi Health connection')
    }
    return input
}

function parseProactiveActivity(value: unknown): {
    source: 'aervox.activity' | 'aervox.operation'
    eventType: string
    payloadText?: string
    metadata?: Record<string, unknown>
} | null {
    if (!value || typeof value !== 'object') return null
    const input = value as Record<string, unknown>
    if (input.source !== 'aervox.activity' && input.source !== 'aervox.operation') return null
    if (!input.capture || typeof input.capture !== 'object') return null
    const capture = input.capture as Record<string, unknown>
    if (typeof capture.eventType !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(capture.eventType)) return null
    if (capture.payloadText !== undefined && (typeof capture.payloadText !== 'string' || capture.payloadText.length > 200_000)) return null
    if (capture.metadata !== undefined && (typeof capture.metadata !== 'object' || capture.metadata === null || Array.isArray(capture.metadata))) return null
    return {
        source: input.source,
        eventType: capture.eventType,
        payloadText: capture.payloadText as string | undefined,
        metadata: capture.metadata as Record<string, unknown> | undefined,
    }
}

function broadcastProactiveStatus(status: unknown) {
    for (const window of [mainWindow, petWindow]) {
        if (!window?.isDestroyed()) window.webContents.send('proactive:status:changed', status)
    }
}

function isTrustedRenderer(event: Electron.IpcMainInvokeEvent): boolean {
    const owner = BrowserWindow.fromWebContents(event.sender)
    return owner === mainWindow || owner === petWindow
}

function isTurnAttachment(value: unknown): value is {attachmentId: string; name?: string; mediaType?: string} {
    if (!value || typeof value !== 'object') return false
    const item = value as Record<string, unknown>
    return typeof item.attachmentId === 'string'
        && item.attachmentId.length > 0
        && item.attachmentId.length <= 128
        && (item.name === undefined || (typeof item.name === 'string' && item.name.length <= 200))
        && (item.mediaType === undefined || (typeof item.mediaType === 'string' && item.mediaType.length <= 100))
}

function isTurnRequest(value: unknown): value is {
    requestId: string
    content: string
    toolApprovalMode?: 'ask' | 'full_access'
    attachments?: Array<{attachmentId: string; name?: string; mediaType?: string}>
} {
    if (!value || typeof value !== 'object') return false
    const request = value as Record<string, unknown>
    return typeof request.requestId === 'string'
        && /^[a-zA-Z0-9_-]{8,80}$/.test(request.requestId)
        && typeof request.content === 'string'
        && request.content.trim().length > 0
        && request.content.length <= 20_000
        && (request.toolApprovalMode === undefined
            || request.toolApprovalMode === 'ask'
            || request.toolApprovalMode === 'full_access')
        && (request.attachments === undefined
            || (Array.isArray(request.attachments) && request.attachments.length <= 20 && request.attachments.every(isTurnAttachment)))
}

/** CR-027：在途 Turn 请求的中止控制器（requestId → controller），供渲染层空闲超时/主动放弃时中止上游 */
const activeTurnRequests = new Map<string, AbortController>()

async function streamAervoxTurn(event: Electron.IpcMainEvent, payload: unknown) {
    if (!isTurnRequest(payload)) return
    const {requestId, content} = payload
    const toolApprovalMode = payload.toolApprovalMode ?? 'ask'
    const sessionId = resolveDesktopSessionId(process.env.AERVOX_SESSION_ID)
    const send = (message: Record<string, unknown>) => {
        if (!event.sender.isDestroyed()) event.sender.send('aervox:turn:event', {requestId, ...message})
    }
    const controller = new AbortController()
    activeTurnRequests.set(requestId, controller)
    const unregister = () => {
        if (activeTurnRequests.get(requestId) === controller) activeTurnRequests.delete(requestId)
    }

    try {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Idempotency-Key': requestId,
        }
        const workspaceId = process.env.AERVOX_WORKSPACE_ID?.trim()
        const userId = process.env.AERVOX_USER_ID?.trim()
        const authToken = process.env.AERVOX_AUTH_TOKEN?.trim()
        if (workspaceId) headers['x-workspace-id'] = workspaceId
        if (userId) headers['x-user-id'] = userId
        if (authToken) headers.Authorization = `Bearer ${authToken}`

        const createResponse = await fetch(`${apiBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                message: {content, contentType: 'text', ...(payload.attachments ? {attachments: payload.attachments} : {})},
                clientVersion: '@aervox/desktop/0.2.0',
                toolApprovalMode,
                references: [],
            }),
            signal: controller.signal,
        })
        if (!createResponse.ok) throw new Error(`创建 Turn 失败（HTTP ${createResponse.status}）`)

        const turn = await createResponse.json() as {eventsUrl?: unknown}
        if (typeof turn.eventsUrl !== 'string' || !turn.eventsUrl.startsWith('/')) {
            throw new Error('Turn 响应缺少有效 eventsUrl')
        }

        const eventsResponse = await fetch(`${apiBaseUrl}${turn.eventsUrl}`, {
            headers: {Accept: 'text/event-stream'},
            signal: controller.signal,
        })
        if (!eventsResponse.ok || !eventsResponse.body) {
            throw new Error(`读取 Turn 事件失败（HTTP ${eventsResponse.status}）`)
        }

        const reader = eventsResponse.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        const consumeFrame = (frame: string) => {
            const data = frame.split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('')
            if (!data) {
                // SSE 注释心跳帧（`: ping`）：转发为桥消息，维持渲染层空闲超时计时（CR-027）
                send({type: 'heartbeat'})
                return
            }
            const turnEvent = JSON.parse(data) as Record<string, unknown>
            send({type: 'event', event: turnEvent})
            if (turnEvent.eventType === 'emote' && petWindow && !petWindow.isDestroyed()) {
                petWindow.webContents.send('pet:command', turnEvent.data)
            }
        }

        while (true) {
            const {done, value} = await reader.read()
            buffer += decoder.decode(value ?? new Uint8Array(), {stream: !done})
            const frames = buffer.split(/\r?\n\r?\n/)
            buffer = frames.pop() ?? ''
            for (const frame of frames) consumeFrame(frame)
            if (done) break
        }
        if (buffer.trim()) consumeFrame(buffer)
        send({type: 'closed'})
    } catch (error) {
        // 渲染层主动取消（空闲超时/UI 放弃）时不再回发 error，避免对已收敛的 UI 重复报错
        if (!controller.signal.aborted) {
            send({type: 'error', message: error instanceof Error ? error.message : 'Aervox 请求失败'})
        }
    } finally {
        unregister()
    }
}

function isApiRequest(value: unknown): value is {method?: string; path: string; body?: unknown; headers?: Record<string, string>} {
    if (!value || typeof value !== 'object') return false
    const req = value as Record<string, unknown>
    if (typeof req.path !== 'string') return false
    if (!req.path.startsWith('/') || req.path.includes('://')) return false // 防 SSRF：仅允许站内相对路径
    if (req.method !== undefined && typeof req.method !== 'string') return false
    if (req.headers !== undefined && (typeof req.headers !== 'object' || Array.isArray(req.headers))) return false
    return true
}

async function proxyApiRequest(_event: Electron.IpcMainInvokeEvent, payload: unknown) {
    if (!isApiRequest(payload)) return {status: 400, ok: false, json: null, text: 'invalid api request'}
    const method = (payload.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {Accept: 'application/json'}
    const workspaceId = process.env.AERVOX_WORKSPACE_ID?.trim()
    const userId = process.env.AERVOX_USER_ID?.trim()
    const authToken = process.env.AERVOX_AUTH_TOKEN?.trim()
    if (workspaceId) headers['x-workspace-id'] = workspaceId
    if (userId) headers['x-user-id'] = userId
    if (authToken) headers.Authorization = `Bearer ${authToken}`
    const idempotencyKey = payload.headers?.['Idempotency-Key']
    if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) headers['Idempotency-Key'] = idempotencyKey

    let body: string | undefined
    if (method !== 'GET' && payload.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(payload.body)
    }

    try {
        const res = await fetch(`${apiBaseUrl}${payload.path}`, {method, headers, body})
        const text = await res.text()
        let json: unknown = null
        try {
            json = text ? JSON.parse(text) : null
        } catch {
            json = null
        }
        return {status: res.status, ok: res.ok, json, text}
    } catch (error) {
        return {status: 0, ok: false, json: null, text: error instanceof Error ? error.message : 'request failed'}
    }
}

/** 多模态输入：附件上传请求校验（renderer → 主进程 → API 二进制端点） */
function isAttachmentUploadRequest(value: unknown): value is {
    fileName: string
    mediaType: string
    purpose: string
    dataBase64: string
    idempotencyKey?: string
} {
    if (!value || typeof value !== 'object') return false
    const req = value as Record<string, unknown>
    return typeof req.fileName === 'string'
        && req.fileName.length > 0
        && req.fileName.length <= 200
        && typeof req.mediaType === 'string'
        && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(req.mediaType)
        && typeof req.purpose === 'string'
        && req.purpose.length > 0
        && req.purpose.length <= 40
        && typeof req.dataBase64 === 'string'
        && req.dataBase64.length > 0
        && (req.idempotencyKey === undefined || typeof req.idempotencyKey === 'string')
}

const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024

async function uploadAttachment(_event: Electron.IpcMainInvokeEvent, payload: unknown) {
    if (!isAttachmentUploadRequest(payload)) throw new Error('invalid upload request')
    const buffer = Buffer.from(payload.dataBase64, 'base64')
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_ATTACHMENT_SIZE_BYTES) {
        throw new Error(`附件大小超出限制（≤10MB）`)
    }
    const apiBaseUrl = (process.env.AERVOX_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
    const query = new URLSearchParams({
        fileName: payload.fileName,
        mediaType: payload.mediaType,
        purpose: payload.purpose,
    })
    if (payload.idempotencyKey) query.set('idempotencyKey', payload.idempotencyKey)
    const headers: Record<string, string> = {'Content-Type': payload.mediaType}
    const workspaceId = process.env.AERVOX_WORKSPACE_ID?.trim()
    const userId = process.env.AERVOX_USER_ID?.trim()
    if (workspaceId) headers['x-workspace-id'] = workspaceId
    if (userId) headers['x-user-id'] = userId

    const res = await fetch(`${apiBaseUrl}/v1/attachments/binary?${query.toString()}`, {
        method: 'POST',
        headers,
        body: buffer,
    })
    if (!res.ok) throw new Error(`附件上传失败（HTTP ${res.status}）`)
    return await res.json()
}

function broadcastTheme() {
    for (const window of [mainWindow, petWindow]) {
        if (!window?.isDestroyed()) { // @ts-ignore
            window.webContents.send('theme:changed', appTheme)
        }
    }
}

function rendererUrl(page: string) {
    const baseUrl = process.env.ELECTRON_RENDERER_URL
    return baseUrl ? `${baseUrl}/${page}` : undefined
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 880,
        minWidth: 760,
        minHeight: 620,
        backgroundColor: '#f5f7f4',
        frame: false,
        autoHideMenuBar: true,
        title: 'Aervox｜思隅',
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        },
    })
    const url = rendererUrl('index.html')
    if (url) mainWindow.loadURL(url)
    else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    mainWindow.on('closed', () => {
        petWindow?.close();
        mainWindow = null
    })
}

function createPetWindow() {
    petWindow = new BrowserWindow({
        width: 300,
        height: 380,
        minWidth: 300,
        minHeight: 380,
        maxWidth: 300,
        maxHeight: 380,
        frame: false,
        transparent: true,
        resizable: false,
        movable: true,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        },
    })
    petWindow.setAlwaysOnTop(true, 'floating')
    const {workArea} = screen.getPrimaryDisplay()
    petWindow.setPosition(workArea.x + workArea.width - 320, workArea.y + workArea.height - 400)
    const url = rendererUrl('pet.html')
    if (url) petWindow.loadURL(url)
    else petWindow.loadFile(join(__dirname, '../renderer/pet.html'))
    petWindow.on('closed', () => {
        petWindow = null
    })
}

app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    await loadProactiveSourceConfig()
    await proactiveHost.initialize()
    await refreshProactiveLocalReady()
    ipcMain.handle('theme:get', () => appTheme)
    ipcMain.handle('theme:set', (_event, theme: unknown) => {
        if (!isTheme(theme)) return appTheme
        appTheme = theme
        nativeTheme.themeSource = appTheme
        broadcastTheme()
        return appTheme
    })
    ipcMain.handle('window:minimize', () => {
        mainWindow?.minimize()
        return true
    })
    ipcMain.handle('window:toggle-maximize', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window) return false
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        return window.isMaximized()
    })
    ipcMain.handle('window:close', () => {
        mainWindow?.destroy()
        return true
    })
    // 外链经系统浏览器打开（如牛客每日一题）：仅放行 https 协议
    ipcMain.handle('window:open-external', (_event, url: unknown) => {
        if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
            throw new Error('仅允许打开 https:// 外部链接')
        }
        return shell.openExternal(url)
    })
    // 「选择文件夹」：本地语音模型路径 / 音色目录（CR-011 阶段 3）
    ipcMain.handle('dialog:pick-directory', async (event) => {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window) return null
        const result = await dialog.showOpenDialog(window, {
            title: '选择文件夹',
            properties: ['openDirectory', 'createDirectory'],
        })
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    })
    // CAP-033: the renderer can only observe a broker snapshot. It cannot
    // manufacture an OS grant or write the control state directly.
    ipcMain.handle('proactive:status', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        return compositeProactiveStatus(readToolApprovalMode(payload))
    })
    ipcMain.handle('proactive:authorize', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        if (!isProfileAuthorizationRequest(payload)) throw new Error('invalid proactive authorization request')
        const toolApprovalMode = readToolApprovalMode(payload)
        if (!await refreshProactiveLocalReady()) throw new Error('本地主动画像 Vault 尚未就绪')
        const status = await proactiveHost.authorize(payload, toolApprovalMode)
        await syncAuthorization(status)
        const composite = await compositeProactiveStatus(toolApprovalMode)
        broadcastProactiveStatus(composite)
        return composite
    })
    ipcMain.handle('proactive:desired-state', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        if (!payload || typeof payload !== 'object') throw new Error('invalid proactive desired state request')
        const desiredState = (payload as {desiredState?: unknown}).desiredState
        if (desiredState !== 'enabled' && desiredState !== 'paused' && desiredState !== 'revoked') {
            throw new Error('invalid proactive desired state')
        }
        const toolApprovalMode = readToolApprovalMode(payload)
        const status = await proactiveHost.setDesiredState(desiredState, toolApprovalMode)
        if (await refreshProactiveLocalReady()) {
            const serverStatus = await getProactiveServerStatus()
            if (serverStatus.revision) {
                await requestProactiveApi('POST', '/v1/proactive/desired-state', {desiredState})
                if (desiredState === 'enabled') await syncActivation(status)
                else await endServerActivation(`desired_${desiredState}`)
            } else if (desiredState === 'enabled') {
                await syncAuthorization(status)
            }
        }
        const composite = await compositeProactiveStatus(toolApprovalMode)
        broadcastProactiveStatus(composite)
        return composite
    })
    ipcMain.handle('proactive:persistence', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        if (!payload || typeof payload !== 'object') throw new Error('invalid proactive persistence request')
        const update = (payload as {update?: unknown}).update
        if (!isProfilePersistenceUpdate(update)) throw new Error('invalid proactive persistence update')
        const toolApprovalMode = readToolApprovalMode(payload)
        const status = await proactiveHost.setPersistence(update, toolApprovalMode)
        if (await refreshProactiveLocalReady()) {
            await syncCapability(status, 'background.persistent')
        }
        const composite = await compositeProactiveStatus(toolApprovalMode)
        broadcastProactiveStatus(composite)
        return composite
    })
    ipcMain.handle('proactive:capability:request', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        if (!payload || typeof payload !== 'object') throw new Error('invalid proactive capability request')
        const id = (payload as {id?: unknown}).id
        if (!isProfileSourceId(id)) throw new Error('invalid proactive capability id')
        const toolApprovalMode = readToolApprovalMode(payload)
        const status = await proactiveHost.requestCapability(id, toolApprovalMode)
        if (await refreshProactiveLocalReady()) await syncCapability(status, id)
        const composite = await compositeProactiveStatus(toolApprovalMode)
        broadcastProactiveStatus(composite)
        return composite
    })
    ipcMain.handle('proactive:source:delete', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        if (!payload || typeof payload !== 'object') throw new Error('invalid proactive source deletion request')
        const id = (payload as {id?: unknown}).id
        if (!isProfileSourceId(id)) throw new Error('invalid proactive capability id')
        if (!await refreshProactiveLocalReady()) throw new Error('本地主动画像 Vault 尚未就绪')
        const serverStatus = await getProactiveServerStatus()
        const source = serverStatus.sources.find((grant) => grant.sourceKey === id)
        if (!source) throw new Error('主动画像来源授权不存在')
        await requestProactiveApi('DELETE', `/v1/proactive/sources/${encodeURIComponent(source.id)}/data`)
        const toolApprovalMode = readToolApprovalMode(payload)
        await proactiveHost.revokeCapability(id, toolApprovalMode)
        const composite = await compositeProactiveStatus(toolApprovalMode)
        broadcastProactiveStatus(composite)
        return composite
    })
    ipcMain.handle('proactive:activity', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        const activity = parseProactiveActivity(payload)
        if (!activity) throw new Error('invalid proactive activity capture')
        return ingestProactiveCapture(activity.source, {
            payloadText: activity.payloadText,
            payload: {eventType: activity.eventType, metadata: activity.metadata ?? {}},
            contentType: activity.payloadText === undefined ? 'application/json' : 'text/plain',
        })
    })
    ipcMain.handle('proactive:claims:list', async (event) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        if (!await refreshProactiveLocalReady()) throw new Error('本地主动画像 Vault 尚未就绪')
        const result = await requestProactiveApi<{items: unknown[]}>('GET', '/v1/proactive/claims?limit=50')
        return result.items
    })
    ipcMain.handle('proactive:claims:state', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        if (!payload || typeof payload !== 'object') throw new Error('invalid proactive claim state request')
        const {claimId, state} = payload as {claimId?: unknown; state?: unknown}
        if (typeof claimId !== 'string' || claimId.length === 0 || (state !== 'confirmed' && state !== 'rejected')) {
            throw new Error('invalid proactive claim state request')
        }
        return requestProactiveApi(
            'POST',
            `/v1/proactive/claims/${encodeURIComponent(claimId)}/state`,
            {state},
        )
    })
    ipcMain.handle('proactive:intelligence:dashboard', async (event) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        if (!await refreshProactiveLocalReady()) throw new Error('本地主动画像 Vault 尚未就绪')
        return requestProactiveApi('GET', '/v1/proactive/intelligence/dashboard')
    })
    ipcMain.handle('proactive:ha:connect', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        return requestProactiveApi('POST', '/v1/proactive/integrations/home-assistant', validatedHomeAssistantInput(payload))
    })
    ipcMain.handle('proactive:ha:sync', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        const connectionId = requiredConnectionId(payload)
        return requestProactiveApi('POST', `/v1/proactive/integrations/home-assistant/${encodeURIComponent(connectionId)}/sync`)
    })
    ipcMain.handle('proactive:ha:entity', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        const input = objectInput(payload)
        const connectionId = requiredConnectionId(payload)
        const entityId = input?.entityId
        const patch = objectInput(input?.patch)
        if (typeof entityId !== 'string' || entityId.length > 255 || !patch) throw new Error('invalid Home Assistant entity update')
        if (patch.allowedOps !== undefined && (!Array.isArray(patch.allowedOps) || patch.allowedOps.some((item) => typeof item !== 'string'))) {
            throw new Error('invalid Home Assistant allowed operations')
        }
        return requestProactiveApi(
            'PATCH',
            `/v1/proactive/integrations/home-assistant/${encodeURIComponent(connectionId)}/entities/${encodeURIComponent(entityId)}`,
            patch,
        )
    })
    ipcMain.handle('proactive:ha:delete', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        const connectionId = requiredConnectionId(payload)
        await requestProactiveApi('DELETE', `/v1/proactive/integrations/home-assistant/${encodeURIComponent(connectionId)}`)
        return true
    })
    ipcMain.handle('proactive:xiaomi:connect', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        return requestProactiveApi('POST', '/v1/proactive/integrations/xiaomi-health', validatedXiaomiInput(payload))
    })
    ipcMain.handle('proactive:xiaomi:sync', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        const input = objectInput(payload)
        const connectionId = requiredConnectionId(payload)
        const localDate = input?.localDate
        if (localDate !== undefined && (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate))) {
            throw new Error('invalid Xiaomi Health sync date')
        }
        return requestProactiveApi(
            'POST',
            `/v1/proactive/integrations/xiaomi-health/${encodeURIComponent(connectionId)}/sync`,
            localDate ? {localDate} : {},
        )
    })
    ipcMain.handle('proactive:xiaomi:delete', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        const connectionId = requiredConnectionId(payload)
        await requestProactiveApi('DELETE', `/v1/proactive/integrations/xiaomi-health/${encodeURIComponent(connectionId)}`)
        return true
    })
    ipcMain.handle('proactive:export', async (event, payload: unknown) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        if (!await refreshProactiveLocalReady()) throw new Error('本地主动画像 Vault 尚未就绪')
        const includeRaw = Boolean(payload && typeof payload === 'object' && (payload as {includeRaw?: unknown}).includeRaw === true)
        const exported = await requestProactiveApi<{manifest: Record<string, unknown>; data: unknown}>(
            'GET',
            `/v1/proactive/export?includeRaw=${includeRaw ? 'true' : 'false'}`,
        )
        const owner = BrowserWindow.fromWebContents(event.sender)
        const result = await dialog.showSaveDialog(owner ?? undefined, {
            title: '导出主动智能画像数据',
            defaultPath: `aervox-proactive-export-${new Date().toISOString().slice(0, 10)}.json`,
            filters: [{name: 'JSON', extensions: ['json']}],
        })
        if (result.canceled || !result.filePath) return null
        await writeFile(result.filePath, `${JSON.stringify(exported, null, 2)}\n`, {encoding: 'utf8', mode: 0o600})
        await chmod(result.filePath, 0o600).catch(() => undefined)
        return {path: result.filePath, manifest: exported.manifest}
    })
    ipcMain.handle('proactive:keep-alive', (event) => {
        if (!isTrustedRenderer(event)) throw new Error('untrusted proactive renderer')
        return proactiveHost.shouldKeepAlive()
    })
    ipcMain.on('aervox:turn:start', streamAervoxTurn)
    // CR-027：中止在途 Turn 请求（渲染层空闲超时收敛后调用，避免幽灵回合继续消耗上游 tokens）
    ipcMain.on('aervox:turn:cancel', (_event, requestId: unknown) => {
        if (typeof requestId !== 'string') return
        const controller = activeTurnRequests.get(requestId)
        if (!controller) return
        activeTurnRequests.delete(requestId)
        controller.abort()
    })
    ipcMain.handle('aervox:api:request', proxyApiRequest)
    ipcMain.handle('aervox:attachment:upload', uploadAttachment)
    createMainWindow()
    createPetWindow()
    const proactiveHeartbeat = async (notifyUser = false) => {
        if (!proactiveHost.shouldCollect()) return
        try {
            const status = await compositeProactiveStatus('full_access')
            broadcastProactiveStatus(status)
            if (notifyUser && Notification.isSupported()) {
                const state = status.effectiveState === 'active'
                    ? '主动智能模式已恢复'
                    : status.effectiveState === 'limited'
                        ? '主动智能模式已恢复，但部分来源仍需处理'
                        : '主动智能模式当前已挂起'
                new Notification({title: 'Aervox 主动智能', body: state}).show()
            }
        } catch (error) {
            if (notifyUser && Notification.isSupported()) {
                new Notification({
                    title: 'Aervox 主动智能恢复失败',
                    body: error instanceof Error ? error.message : '本地 Host 无法恢复',
                }).show()
            }
            throw error
        }
    }
    void proactiveHeartbeat(true).catch(() => undefined)
    setInterval(() => {
        void proactiveHeartbeat().catch(() => undefined)
    }, 60_000)
    setInterval(() => {
        void pollProactiveClipboard().catch(() => undefined)
    }, 3_000)
    void pollProactiveWideSources().catch(() => undefined)
    setInterval(() => {
        void pollProactiveWideSources().catch(() => undefined)
    }, 5 * 60_000)
    powerMonitor.on('resume', () => {
        void proactiveHeartbeat(true).catch(() => undefined)
    })
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow()
            createPetWindow()
        }
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !proactiveHost.shouldKeepAlive()) app.quit()
})
