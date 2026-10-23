import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
    RENDERER_ENTRY_ARGUMENT,
    rendererEntryArgument,
    rendererEntryMatches,
    trustedPreloadEntry,
} from '../src/shared/renderer-trust'

const bridge = vi.hoisted(() => ({exposeInMainWorld: vi.fn()}))
vi.mock('electron', () => ({contextBridge: bridge}))
vi.mock('../src/preload/domains/window-api', () => ({windowApi: {openExternal: vi.fn()}}))
vi.mock('../src/preload/domains/settings-api', () => ({settingsApi: {getTheme: vi.fn()}}))
vi.mock('../src/preload/domains/aervox-api', () => ({aervoxApi: {apiRequest: vi.fn(), observeTurn: vi.fn()}}))
vi.mock('../src/preload/domains/dialog-api', () => ({dialogApi: {pickDirectory: vi.fn()}}))
vi.mock('../src/preload/domains/proactive-api', () => ({proactiveApi: {getStatus: vi.fn()}}))

const mainEntry = 'file:///Applications/Aervox.app/Contents/Resources/app.asar/out/renderer/index.html'
const petEntry = 'file:///Applications/Aervox.app/Contents/Resources/app.asar/out/renderer/pet.html'
const devEntry = 'http://localhost:5179/index.html'

describe('fixed renderer document identity', () => {
    it.each([mainEntry, petEntry, devEntry])('retains query/hash changes on %s', entry => {
        expect(rendererEntryMatches(`${entry}?surface=proactive-ui#settings`, entry)).toBe(true)
        expect(rendererEntryMatches(entry, entry)).toBe(true)
    })

    it.each([
        'file:///Applications/Aervox.app/Contents/Resources/app.asar/out/renderer/pet.html',
        'file:///Applications/Aervox.app/Contents/Resources/app.asar/out/renderer/aervox-intro/index.html',
        'file:///tmp/index.html',
        'file://attacker/Applications/Aervox.app/Contents/Resources/app.asar/out/renderer/index.html',
        'about:blank',
        'data:text/html,hello',
        'blob:null/renderer',
    ])('rejects adjacent and opaque documents %s', candidate => {
        expect(rendererEntryMatches(candidate, mainEntry)).toBe(false)
    })

    it.each([
        'http://localhost:5179/attack.html',
        'http://localhost:5179/pet.html',
        'http://localhost:5179/index.html/extra',
        'http://localhost:5178/index.html',
        'http://127.0.0.1:5179/index.html',
        'https://localhost:5179/index.html',
        'http://user:password@localhost:5179/index.html',
        '//localhost:5179/index.html',
    ])('rejects development authority/path changes %s', candidate => {
        expect(rendererEntryMatches(candidate, devEntry)).toBe(false)
    })

    it('normalizes protocol and host case without widening the document', () => {
        expect(rendererEntryMatches('HTTP://LOCALHOST:5179/index.html?surface=workbench-ui', devEntry)).toBe(true)
    })

    it.each(['about:blank', 'data:text/html,hello', 'blob:null/renderer', 'javascript:alert(1)', 'not a URL'])('does not grant invalid entry %s', entry => {
        expect(rendererEntryMatches(entry, entry)).toBe(false)
    })
})

describe('preload entry arguments', () => {
    it('round trips an encoded entry and admits only its main frame', () => {
        const argv = ['electron', rendererEntryArgument(mainEntry)]
        expect(argv[1]).toBe(`${RENDERER_ENTRY_ARGUMENT}${encodeURIComponent(mainEntry)}`)
        expect(trustedPreloadEntry(argv, `${mainEntry}?surface=proactive-ui#settings`, true)).toBe(true)
        expect(trustedPreloadEntry(argv, mainEntry, false)).toBe(false)
        expect(trustedPreloadEntry(argv, petEntry, true)).toBe(false)
    })

    it.each([
        [],
        ['electron'],
        [`${RENDERER_ENTRY_ARGUMENT}%`],
        [rendererEntryArgument(mainEntry), rendererEntryArgument(mainEntry)],
        [rendererEntryArgument(mainEntry), rendererEntryArgument(petEntry)],
        [`${RENDERER_ENTRY_ARGUMENT}${encodeURIComponent('about:blank')}`],
        [`${RENDERER_ENTRY_ARGUMENT}${encodeURIComponent('not a URL')}`],
    ].map(argv => ({argv})))('fails closed for missing, malformed or duplicate arguments $argv', ({argv}) => {
        expect(trustedPreloadEntry(argv, mainEntry, true)).toBe(false)
    })
})

describe('actual preload bridge exposure', () => {
    const originalArgv = process.argv
    const originalMainFrame = Object.getOwnPropertyDescriptor(process, 'isMainFrame')

    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
    })

    afterEach(() => {
        process.argv = originalArgv
        if (originalMainFrame) Object.defineProperty(process, 'isMainFrame', originalMainFrame)
        else Reflect.deleteProperty(process, 'isMainFrame')
        vi.unstubAllGlobals()
    })

    async function load(entry: string, url: string, isMainFrame: boolean, argv?: string[]) {
        process.argv = argv ?? ['electron', rendererEntryArgument(entry)]
        Object.defineProperty(process, 'isMainFrame', {value: isMainFrame, configurable: true})
        vi.stubGlobal('location', {href: url})
        vi.stubGlobal('window', {location: {href: url}})
        await import('../src/preload/index')
    }

    it.each([mainEntry, petEntry, devEntry])('exposes the existing desktop APIs at trusted main entry %s', async entry => {
        await load(entry, `${entry}?surface=proactive-ui#settings`, true)
        expect(bridge.exposeInMainWorld).toHaveBeenCalledOnce()
        expect(bridge.exposeInMainWorld).toHaveBeenCalledWith('fairyDesktop', expect.objectContaining({
            apiRequest: expect.any(Function),
            observeTurn: expect.any(Function),
            openExternal: expect.any(Function),
            pickDirectory: expect.any(Function),
            proactive: expect.any(Object),
        }))
    })

    it.each([
        [mainEntry, mainEntry, false],
        [mainEntry, petEntry, true],
        [mainEntry, 'http://127.0.0.1:51012/attack', true],
        [devEntry, 'http://localhost:5179/attack.html', true],
        [mainEntry, 'about:blank', true],
    ] as const)('withholds the entire bridge from untrusted location/frame %s %s %s', async (entry, url, mainFrame) => {
        await load(entry, url, mainFrame)
        expect(bridge.exposeInMainWorld).not.toHaveBeenCalled()
    })

    it('withholds the bridge without a main-process entry argument', async () => {
        await load(mainEntry, mainEntry, true, ['electron'])
        expect(bridge.exposeInMainWorld).not.toHaveBeenCalled()
    })
})
