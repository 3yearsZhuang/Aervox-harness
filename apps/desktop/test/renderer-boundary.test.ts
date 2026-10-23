import {EventEmitter} from 'node:events'
import {readFileSync} from 'node:fs'
import type {IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents, WebFrameMain} from 'electron'
import {describe, expect, it, vi} from 'vitest'
import {createRendererBoundary} from '../src/main/renderer-boundary'

const mainEntry = 'file:///Applications/Aervox.app/Contents/Resources/app.asar/out/renderer/index.html'
const petEntry = 'file:///Applications/Aervox.app/Contents/Resources/app.asar/out/renderer/pet.html'
const devEntry = 'http://localhost:5179/index.html'

function fakeFrame(url: string) {
    return {url, detached: false, isDestroyed: vi.fn(() => false)}
}

class Contents extends EventEmitter {
    destroyed = false
    mainFrame = fakeFrame(mainEntry)
    send = vi.fn()
    isDestroyed = vi.fn(() => this.destroyed)
    setWindowOpenHandler = vi.fn<(callback: (details: {url: string}) => {action: 'deny' | 'allow'}) => void>()
}

function fixture(entry = mainEntry) {
    const openExternal = vi.fn(async (_url: string) => undefined)
    const boundary = createRendererBoundary({openExternal})
    const contents = new Contents()
    contents.mainFrame.url = entry
    const ref = contents as unknown as WebContents
    boundary.attach(ref, entry)
    const event = (frame = contents.mainFrame) => ({sender: ref, senderFrame: frame as unknown as WebFrameMain})
    const navigate = (url: string, changes: Record<string, unknown> = {}, name = 'will-frame-navigate') => {
        const details = {url, isMainFrame: true, initiator: contents.mainFrame, preventDefault: vi.fn(), ...changes}
        contents.emit(name, details)
        return details
    }
    const popup = (url: string) => contents.setWindowOpenHandler.mock.calls[0][0]({url})
    return {boundary, contents, ref, event, navigate, popup, openExternal}
}

describe('main-frame renderer trust', () => {
    it.each([mainEntry, petEntry, devEntry])('trusts registered main/pet document %s after surface and hash changes', entry => {
        const f = fixture(entry)
        f.contents.mainFrame.url = `${entry}?surface=proactive-ui#settings`
        expect(f.boundary.isTrustedContents(f.ref)).toBe(true)
        expect(f.boundary.isTrustedEvent(f.event())).toBe(true)
    })

    it('does not infer trust from a different window or a sibling file document', () => {
        const f = fixture()
        const other = new Contents() as unknown as WebContents
        expect(f.boundary.isTrustedContents(other)).toBe(false)
        expect(f.boundary.isTrustedEvent({sender: other, senderFrame: f.event().senderFrame})).toBe(false)
        f.contents.mainFrame.url = petEntry
        expect(f.boundary.isTrustedEvent(f.event())).toBe(false)
        expect(f.boundary.isTrustedContents(f.ref)).toBe(false)
    })

    it.each(['about:blank', 'data:text/html,hello', 'http://localhost:5179/attack.html', 'http://127.0.0.1:5179/index.html', 'http://user:password@localhost:5179/index.html'])('rejects changed main frame URL %s', url => {
        const f = fixture(devEntry)
        f.contents.mainFrame.url = url
        expect(f.boundary.isTrustedEvent(f.event())).toBe(false)
        expect(f.boundary.isTrustedContents(f.ref)).toBe(false)
    })

    it('rejects even same-document child frames, missing frames, detached and destroyed frames', () => {
        const f = fixture()
        expect(f.boundary.isTrustedEvent(f.event(fakeFrame(mainEntry)))).toBe(false)
        expect(f.boundary.isTrustedEvent({sender: f.ref, senderFrame: null})).toBe(false)
        f.contents.mainFrame.detached = true
        expect(f.boundary.isTrustedEvent(f.event())).toBe(false)
        expect(f.boundary.isTrustedContents(f.ref)).toBe(false)
        f.contents.mainFrame.detached = false
        f.contents.mainFrame.isDestroyed.mockReturnValue(true)
        expect(f.boundary.isTrustedEvent(f.event())).toBe(false)
    })

    it('drops a destroyed webContents registration and permits a newly attached replacement', () => {
        const f = fixture()
        f.contents.emit('destroyed')
        expect(f.boundary.isTrustedEvent(f.event())).toBe(false)
        const replacement = new Contents()
        const replacementRef = replacement as unknown as WebContents
        f.boundary.attach(replacementRef, mainEntry)
        expect(f.boundary.isTrustedEvent({sender: replacementRef, senderFrame: replacement.mainFrame as unknown as WebFrameMain})).toBe(true)
        f.contents.destroyed = true
        expect(f.boundary.isTrustedContents(f.ref)).toBe(false)
    })
})

describe('renderer navigation and external links', () => {
    it.each([mainEntry, petEntry, devEntry])('allows reload and surface navigation at own entry %s', entry => {
        const f = fixture(entry)
        const details = f.navigate(`${entry}?surface=proactive-ui#settings`)
        expect(details.preventDefault).not.toHaveBeenCalled()
        expect(f.openExternal).not.toHaveBeenCalled()
    })

    it.each(['https://example.com/path?q=1', 'HTTP://example.com/path?q=1'])('blocks main navigation and opens normal external URL %s in the system browser', async url => {
        const f = fixture()
        const details = f.navigate(url)
        expect(details.preventDefault).toHaveBeenCalledOnce()
        expect(f.openExternal).toHaveBeenCalledOnce()
        expect(f.openExternal).toHaveBeenCalledWith(new URL(url).href)
    })

    it.each(['file:///tmp/index.html', 'javascript:alert(1)', 'data:text/html,hello', 'blob:null/renderer', 'mailto:someone@example.com', 'not a URL'])('blocks non-browser destination %s without OS side effects', url => {
        const f = fixture()
        const details = f.navigate(url)
        expect(details.preventDefault).toHaveBeenCalledOnce()
        expect(f.openExternal).not.toHaveBeenCalled()
    })

    it('blocks a 302 redirect away from the entry without opening a browser', () => {
        const f = fixture(devEntry)
        const allowed = f.navigate(`${devEntry}?surface=proactive-ui`, {}, 'will-redirect')
        expect(allowed.preventDefault).not.toHaveBeenCalled()
        const details = f.navigate('https://attacker.example/landing', {}, 'will-redirect')
        expect(details.preventDefault).toHaveBeenCalledOnce()
        expect(f.openExternal).not.toHaveBeenCalled()
    })

    it('retains intro and sandbox iframe loading without granting IPC or main-navigation authority', () => {
        const f = fixture()
        const iframe = fakeFrame('http://127.0.0.1:3000/v1/plugins/demo/pages/settings/index.html')
        const childLoad = f.navigate(iframe.url, {isMainFrame: false, initiator: f.contents.mainFrame})
        expect(childLoad.preventDefault).not.toHaveBeenCalled()
        expect(f.boundary.isTrustedEvent(f.event(iframe))).toBe(false)
        const takeover = f.navigate('https://example.com', {initiator: iframe})
        expect(takeover.preventDefault).toHaveBeenCalledOnce()
        expect(f.openExternal).not.toHaveBeenCalled()
    })

    it.each(['https://example.com/path', 'HTTP://example.com/path'])('denies popup creation and retains ordinary browser external link %s', url => {
        const f = fixture()
        expect(f.popup(url)).toEqual({action: 'deny'})
        expect(f.openExternal).toHaveBeenCalledWith(new URL(url).href)
    })

    it.each(['file:///tmp/index.html', 'javascript:alert(1)', 'data:text/html,hello', 'about:blank'])('denies non-browser popup %s', url => {
        const f = fixture()
        expect(f.popup(url)).toEqual({action: 'deny'})
        expect(f.openExternal).not.toHaveBeenCalled()
    })

    it('does not open popups or browser destinations after the renderer has left its entry', () => {
        const f = fixture()
        f.contents.mainFrame.url = 'https://attacker.example'
        expect(f.popup('https://example.com')).toEqual({action: 'deny'})
        const details = f.navigate('https://example.com')
        expect(details.preventDefault).toHaveBeenCalledOnce()
        expect(f.openExternal).not.toHaveBeenCalled()
    })
})

describe('privileged IPC and outbound messages', () => {
    function ipcFixture() {
        const f = fixture()
        const handles = new Map<string, Parameters<IpcMain['handle']>[1]>()
        const listeners = new Map<string, Parameters<IpcMain['on']>[1]>()
        const raw = {
            handle: vi.fn((channel: string, handler: Parameters<IpcMain['handle']>[1]) => {handles.set(channel, handler)}),
            on: vi.fn((channel: string, listener: Parameters<IpcMain['on']>[1]) => {listeners.set(channel, listener)}),
            removeHandler: vi.fn((channel: string) => {handles.delete(channel)}),
        }
        const ipc = f.boundary.ipc(raw as unknown as Pick<IpcMain, 'handle' | 'on' | 'removeHandler'>)
        return {...f, ipc, raw, handles, listeners}
    }

    it.each(['theme:set', 'window:close', 'dialog:pick-directory', 'proactive:authorize', 'aervox:api:request', 'aervox:attachment:upload'])('checks invoke sender before privileged %s side effects', async channel => {
        const f = ipcFixture()
        const privileged = vi.fn(async (_event, value) => value)
        f.ipc.handle(channel, privileged)
        const invoke = f.handles.get(channel)!
        await expect(invoke(f.event() as IpcMainInvokeEvent, 'accepted')).resolves.toBe('accepted')
        expect(privileged).toHaveBeenCalledOnce()
        f.contents.mainFrame.url = 'https://attacker.example'
        await expect(Promise.resolve().then(() => invoke(f.event() as IpcMainInvokeEvent, 'blocked'))).rejects.toThrow('untrusted desktop renderer')
        expect(privileged).toHaveBeenCalledOnce()
        f.ipc.removeHandler(channel)
        expect(f.raw.removeHandler).toHaveBeenCalledWith(channel)
    })

    it.each(['aervox:events:start', 'aervox:events:cancel', 'aervox:turn:start', 'aervox:turn:observe', 'aervox:turn:ack', 'aervox:turn:cancel'])('silently rejects untrusted send event %s', channel => {
        const f = ipcFixture()
        const privileged = vi.fn()
        f.ipc.on(channel, privileged)
        const listener = f.listeners.get(channel)!
        listener(f.event() as IpcMainEvent, 'accepted')
        expect(privileged).toHaveBeenCalledOnce()
        listener(f.event(fakeFrame(mainEntry)) as IpcMainEvent, 'blocked iframe')
        f.contents.mainFrame.url = 'https://attacker.example'
        listener(f.event() as IpcMainEvent, 'blocked navigation')
        expect(privileged).toHaveBeenCalledOnce()
    })

    it('sends broadcasts only to the currently trusted main document', () => {
        const f = fixture()
        f.boundary.send(f.ref, 'theme:changed', 'dark')
        expect(f.contents.send).toHaveBeenCalledWith('theme:changed', 'dark')
        f.contents.mainFrame.url = 'https://attacker.example'
        f.boundary.send(f.ref, 'proactive:status:changed', {secret: true})
        f.boundary.send(null, 'theme:changed', 'light')
        expect(f.contents.send).toHaveBeenCalledOnce()
    })
})

describe('desktop composition-root IPC coverage', () => {
    it('registers all 34 desktop capabilities through the shared sender guard', () => {
        const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
        const windowIpc = readFileSync(new URL('../src/main/window-ipc.ts', import.meta.url), 'utf8')
        expect(main).not.toMatch(/\bipcMain\.(?:handle|on)\s*\(/)
        expect(main).toMatch(/\bdesktopIpc\s*=\s*rendererBoundary\.ipc\(ipcMain\)/)
        expect(main).toMatch(/registerWindowIpc\(\{\s*ipcMain:\s*desktopIpc,/)
        const mainChannels = [...main.matchAll(/desktopIpc\.(?:handle|on)\('([^']+)'/g)].map(match => match[1])
        const windowChannels = [...windowIpc.matchAll(/\bhandle\('([^']+)'/g)].map(match => match[1])
        const expected = [
            'theme:get', 'theme:set',
            'window:minimize', 'window:toggle-maximize', 'window:close', 'window:open-external', 'dialog:pick-directory',
            'proactive:status', 'proactive:authorize', 'proactive:desired-state', 'proactive:persistence',
            'proactive:capability:request', 'proactive:source:delete', 'proactive:activity',
            'proactive:claims:list', 'proactive:claims:state', 'proactive:intelligence:dashboard',
            'proactive:ha:connect', 'proactive:ha:sync', 'proactive:ha:entity', 'proactive:ha:delete',
            'proactive:xiaomi:connect', 'proactive:xiaomi:sync', 'proactive:xiaomi:delete', 'proactive:export', 'proactive:keep-alive',
            'aervox:events:start', 'aervox:events:cancel', 'aervox:turn:start', 'aervox:turn:observe', 'aervox:turn:ack', 'aervox:turn:cancel',
            'aervox:api:request', 'aervox:attachment:upload',
        ]
        expect([...mainChannels, ...windowChannels].sort()).toEqual(expected.sort())
        expect(new Set([...mainChannels, ...windowChannels]).size).toBe(34)
    })
})
