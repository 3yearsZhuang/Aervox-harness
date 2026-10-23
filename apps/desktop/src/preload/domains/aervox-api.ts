import {ipcRenderer, type IpcRendererEvent} from 'electron'
import type {UploadedAttachment} from '@aervox/api-client/transport'

export interface ApiRequestResult<T = unknown> {
    status: number
    ok: boolean
    json: T | null
    text: string
}

export const aervoxApi = {
    streamEvents: (path: string, callback: (message: unknown) => void) => {
        const requestId = crypto.randomUUID()
        let stopped = false
        const stop = () => {
            if (stopped) return
            stopped = true
            ipcRenderer.removeListener('aervox:events:event', listener)
            ipcRenderer.send('aervox:events:cancel', requestId)
        }
        const listener = (_event: IpcRendererEvent, message: unknown) => {
            if (!message || typeof message !== 'object' || (message as {requestId?: unknown}).requestId !== requestId) return
            const type = (message as {type?: unknown}).type
            try { callback(message) } finally { if (type === 'closed' || type === 'error') stop() }
        }
        ipcRenderer.on('aervox:events:event', listener)
        ipcRenderer.send('aervox:events:start', { requestId, path })
        return stop
    },
    streamTurn: (content: string, options: {
        sessionId?: string; toolApprovalMode: 'ask' | 'full_access';
        attachments?: Array<{attachmentId: string; name?: string; mediaType?: string}>;
        requestId?: string; idempotencyKey?: string; metadata?: Record<string, unknown>;
    }, callback: (message: unknown) => void | Promise<void>) => {
        const requestId = options.requestId ?? crypto.randomUUID();
        // Structured clone rejects functions and uncloneable metadata before IPC.
        const payload = JSON.parse(JSON.stringify({ ...options, requestId, content }));
        return subscribeTurn('aervox:turn:start', payload, callback);
    },
    observeTurn: (turnId: string, options: {requestId: string; afterEventId?: string}, callback: (message: unknown) => void | Promise<void>) =>
        subscribeTurn('aervox:turn:observe', { ...options, turnId }, callback),
    /** CR-027：通知主进程中止在途 Turn 请求（渲染层空闲超时或 UI 主动放弃时调用） */
    cancelTurn: (requestId: string) => {
        ipcRenderer.send('aervox:turn:cancel', requestId)
    },
    apiRequest: <T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
        ipcRenderer.invoke('aervox:api:request', {method, path, body, headers}) as Promise<ApiRequestResult<T>>,
    uploadAttachment: (payload: {fileName: string; mediaType: string; purpose: string; dataBase64: string; idempotencyKey?: string}) =>
        ipcRenderer.invoke('aervox:attachment:upload', payload) as Promise<UploadedAttachment>,
}

/** Each acknowledged event is processed before main reads another upstream event. */
function subscribeTurn(channel: string, payload: {requestId: string; [key: string]: unknown}, callback: (message: unknown) => void | Promise<void>) {
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        ipcRenderer.removeListener('aervox:turn:event', listener);
        ipcRenderer.send('aervox:turn:cancel', payload.requestId);
    };
    let queue = Promise.resolve();
    const listener = (_event: IpcRendererEvent, message: unknown) => {
        if (!message || typeof message !== 'object' || (message as {requestId?: unknown}).requestId !== payload.requestId) return;
        const envelope = message as {type?: unknown; deliveryId?: unknown};
        queue = queue.then(async () => {
            if (stopped) return;
            try {
                await callback(message);
                if (typeof envelope.deliveryId === 'number') ipcRenderer.send('aervox:turn:ack', {requestId: payload.requestId, deliveryId: envelope.deliveryId});
            } catch {
                if (typeof envelope.deliveryId === 'number') ipcRenderer.send('aervox:turn:ack', {requestId: payload.requestId, deliveryId: envelope.deliveryId, error: 'consumer_failed'});
                stop();
            } finally {
                if (envelope.type === 'closed' || envelope.type === 'error') stop();
            }
        });
    };
    ipcRenderer.on('aervox:turn:event', listener);
    ipcRenderer.send(channel, payload);
    return stop;
}
