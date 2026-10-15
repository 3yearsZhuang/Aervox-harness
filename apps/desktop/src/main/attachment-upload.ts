/**
 * Aervox｜思隅 @aervox/desktop — 附件上传 IPC 处理与鉴权（ARC-13）
 */
import type { IpcMainInvokeEvent } from 'electron'

export interface AttachmentUploadRequest {
    fileName: string
    mediaType: string
    purpose: string
    dataBase64: string
    idempotencyKey?: string
}

export function isAttachmentUploadRequest(value: unknown): value is AttachmentUploadRequest {
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

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024

export async function uploadAttachment(_event: IpcMainInvokeEvent | null, payload: unknown) {
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
    const headers: Record<string, string> = { 'Content-Type': payload.mediaType }
    const authToken = process.env.AERVOX_AUTH_TOKEN?.trim()
    if (authToken) headers.Authorization = `Bearer ${authToken}`

    const res = await fetch(`${apiBaseUrl}/v1/attachments/binary?${query.toString()}`, {
        method: 'POST',
        headers,
        body: buffer,
    })
    if (!res.ok) throw new Error(`附件上传失败（HTTP ${res.status}）`)
    return await res.json()
}
