import type {IpcMain, IpcMainEvent, WebContents} from 'electron'
import {rendererEntryMatches} from '../shared/renderer-trust'

type RendererEvent = Pick<IpcMainEvent, 'sender' | 'senderFrame'>

export function createRendererBoundary(deps: {openExternal(url: string): Promise<unknown>}) {
    const entries = new WeakMap<WebContents, string>()

    function isTrustedContents(contents: WebContents): boolean {
        if (contents.isDestroyed()) return false
        const entry = entries.get(contents)
        const frame = contents.mainFrame
        return !!entry && !frame.isDestroyed() && !frame.detached && rendererEntryMatches(frame.url, entry)
    }

    function isTrustedEvent(event: RendererEvent): boolean {
        return isTrustedContents(event.sender)
            && event.senderFrame !== null
            && event.senderFrame === event.sender.mainFrame
    }

    function openExternal(url: string): void {
        try {
            const parsed = new URL(url)
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return
            void deps.openExternal(parsed.href).catch(() => undefined)
        } catch {
            // Unsupported links cannot create a privileged renderer or invoke the OS.
        }
    }

    function attach(contents: WebContents, entry: string): void {
        if (!rendererEntryMatches(entry, entry)) throw new Error('invalid desktop renderer entry')
        entries.set(contents, entry)
        // Subframes (including sandboxed plugin Pages) keep their existing loading contract.
        // They cannot navigate the main document out of its fixed entry or invoke desktop IPC.
        contents.on('will-frame-navigate', event => {
            if (!event.isMainFrame || rendererEntryMatches(event.url, entry)) return
            event.preventDefault()
            if (isTrustedContents(contents) && (!event.initiator || event.initiator === contents.mainFrame)) {
                openExternal(event.url)
            }
        })
        contents.on('will-redirect', event => {
            if (event.isMainFrame && !rendererEntryMatches(event.url, entry)) event.preventDefault()
        })
        contents.setWindowOpenHandler(details => {
            if (isTrustedContents(contents)) openExternal(details.url)
            return {action: 'deny'}
        })
        contents.once('destroyed', () => entries.delete(contents))
    }

    function send(contents: WebContents | null, channel: string, ...args: unknown[]): void {
        if (contents && isTrustedContents(contents)) contents.send(channel, ...args)
    }

    /** Every desktop IPC registration goes through this guard before touching credentials or OS state. */
    function ipc(source: Pick<IpcMain, 'handle' | 'removeHandler' | 'on'>) {
        return {
            handle(channel: string, listener: Parameters<IpcMain['handle']>[1]) {
                source.handle(channel, (event, ...args) => {
                    if (!isTrustedEvent(event)) throw new Error('untrusted desktop renderer')
                    return listener(event, ...args)
                })
            },
            removeHandler(channel: string) { source.removeHandler(channel) },
            on(channel: string, listener: Parameters<IpcMain['on']>[1]) {
                source.on(channel, (event, ...args) => {
                    if (isTrustedEvent(event)) listener(event, ...args)
                })
            },
        }
    }

    return {attach, isTrustedContents, isTrustedEvent, send, ipc}
}
