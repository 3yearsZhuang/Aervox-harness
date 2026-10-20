// Opt-in Electron fixture. Uses the production registration module and native APIs.
// This is not the full Aervox application or a native Helper acceptance test.
const assert = require('node:assert/strict')
const {mkdirSync, realpathSync, writeSync} = require('node:fs')
const {join} = require('node:path')
const {app, BrowserWindow, dialog, ipcMain, shell, WebContentsView} = require('electron')
const {registerWindowIpc} = require(process.env.AERVOX_IPC_SMOKE_MODULE)

const channels = ['window:minimize', 'window:toggle-maximize', 'window:close', 'window:open-external', 'dialog:pick-directory']
const native = process.env.AERVOX_IPC_SMOKE_NATIVE === '1'
const checks = []
const nativeResults = {directorySelection: 'not-run', directoryCancellation: 'not-run', externalDispatch: 'not-run'}
let mainWindow = null
let senderWindow = null
let dispose

function record(value) {
    writeSync(1, `${JSON.stringify({pid: process.pid, ...value})}\n`)
}

function passed(name) {
    checks.push(name)
    record({type: 'check', name, status: 'passed'})
}

function fail(error) {
    record({type: 'result', passed: false, checks, native: nativeResults, error: error?.stack ?? String(error)})
    app.exit(1)
}

async function until(predicate, message) {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Timed out: ${message}`)
}

const preferences = {preload: process.env.AERVOX_IPC_SMOKE_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false}
async function createWindow(role) {
    const window = new BrowserWindow({width: 480, height: 320, show: true, title: `Aervox IPC smoke ${role} ${process.pid}`, webPreferences: preferences})
    await window.loadURL(`data:text/html,${encodeURIComponent(`<title>Aervox IPC smoke ${role} ${process.pid}</title><h1>Window IPC smoke: ${role}</h1><p>PID ${process.pid}</p>`)}`)
    return window
}

async function createMain() {
    const window = await createWindow('main')
    mainWindow = window
    window.on('closed', () => { if (mainWindow === window) mainWindow = null })
    return window
}

function invoke(contents, channel, ...args) {
    return contents.executeJavaScript(`window.ipcSmoke.invoke(...${JSON.stringify([channel, ...args])})`)
}

function register() {
    return registerWindowIpc({
        ipcMain,
        getMainWindow: () => mainWindow,
        getWindowForSender: sender => BrowserWindow.fromWebContents(sender),
        openExternal: url => shell.openExternal(url),
        showOpenDialog: (window, options) => dialog.showOpenDialog(window, options),
    })
}

// Keep this isolated fixture alive while the main window is destroyed/recreated.
app.on('window-all-closed', () => {})

if (process.env.AERVOX_IPC_SMOKE_HOME) {
    const profile = join(process.env.AERVOX_IPC_SMOKE_HOME, 'profile')
    mkdirSync(profile, {recursive: true})
    app.setPath('userData', profile)
}

async function verifyWindowRouting() {
    const main = await createMain()
    senderWindow = await createWindow('sender')
    dispose = register()
    const sender = senderWindow.webContents
    for (const event of ['minimize', 'restore', 'focus', 'blur']) {
        main.on(event, () => record({type: 'native-window-event', role: 'main', event, minimized: !main.isDestroyed() && main.isMinimized()}))
    }
    app.focus({steal: true})
    main.show()
    main.focus()
    await until(() => main.isVisible() && main.isFocused(), 'main native window visible and focused')
    // loadURL waits for the renderer; let the native window finish presentation.
    await new Promise(resolve => setTimeout(resolve, 500))
    record({type: 'window-state', role: 'main', id: main.id, webContentsId: main.webContents.id, appHidden: app.isHidden(), visible: main.isVisible(), focused: main.isFocused(), fullScreen: main.isFullScreen(), minimizable: main.isMinimizable(), minimized: main.isMinimized()})
    assert.equal(await invoke(sender, 'window:minimize'), true)
    await until(() => main.isMinimized(), 'main window minimized')
    assert.equal(senderWindow.isMinimized(), false)
    main.restore()
    await until(() => !main.isMinimized(), 'main window restored')
    passed('renderer IPC minimizes the current main window')

    const mainWasMaximized = main.isMaximized()
    const senderWasMaximized = senderWindow.isMaximized()
    senderWindow.focus()
    await until(() => senderWindow.isFocused(), 'sender native window focused')
    assert.equal(typeof await invoke(sender, 'window:toggle-maximize'), 'boolean')
    await until(() => senderWindow.isMaximized() !== senderWasMaximized, 'sender window toggled')
    assert.equal(main.isMaximized(), mainWasMaximized)
    assert.equal(typeof await invoke(sender, 'window:toggle-maximize'), 'boolean')
    await until(() => senderWindow.isMaximized() === senderWasMaximized, 'sender window toggled back')
    passed('renderer IPC maximizes its sender window')

    assert.equal(await invoke(sender, 'window:close'), true)
    await until(() => main.isDestroyed() && mainWindow === null, 'main window destroyed')
    assert.equal(senderWindow.isDestroyed(), false)
    assert.equal(await invoke(sender, 'window:minimize'), true)
    assert.equal(await invoke(sender, 'window:close'), true)
    const replacement = await createMain()
    replacement.focus()
    await until(() => replacement.isVisible() && replacement.isFocused(), 'replacement native window visible and focused')
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(await invoke(sender, 'window:minimize'), true)
    await until(() => replacement.isMinimized(), 'replacement main window minimized')
    replacement.restore()
    passed('renderer IPC closes main, tolerates absence, and reads a replacement main')

    const orphanView = new WebContentsView({webPreferences: preferences})
    const orphan = orphanView.webContents
    try {
        await orphan.loadURL('data:text/html,<title>Unattached smoke renderer</title>')
        assert.equal(BrowserWindow.fromWebContents(orphan), null)
        assert.equal(await invoke(orphan, 'window:toggle-maximize'), false)
        assert.equal(await invoke(orphan, 'dialog:pick-directory'), null)
    } finally {
        orphan.close()
    }
    passed('real unattached renderer returns false/null without opening a dialog')

    for (const url of [null, 42, 'http://example.com', 'file:///tmp/file', 'javascript:void(0)']) {
        await assert.rejects(invoke(sender, 'window:open-external', url), /仅允许打开 https:\/\/ 外部链接/)
    }
    passed('real renderer IPC rejects non-HTTPS input')
}

async function verifyRegistration() {
    const sender = senderWindow.webContents
    assert.throws(() => register(), /second handler|already|duplicate/i)
    await assert.rejects(invoke(sender, 'window:open-external', 'http://example.com'), /仅允许/)
    passed('duplicate registration leaves the original real IPC handler intact')

    const oldDispose = dispose
    dispose()
    dispose()
    await assert.rejects(invoke(sender, 'window:minimize'), /No handler registered/)
    ipcMain.handle('window:close', () => 'conflicting-owner')
    try {
        assert.throws(() => register(), /second handler|already|duplicate/i)
        assert.equal(await invoke(sender, 'window:close'), 'conflicting-owner')
        await assert.rejects(invoke(sender, 'window:minimize'), /No handler registered/)
        await assert.rejects(invoke(sender, 'window:toggle-maximize'), /No handler registered/)
    } finally {
        ipcMain.removeHandler('window:close')
    }
    dispose = register()
    oldDispose()
    assert.equal(await invoke(sender, 'window:minimize'), true)
    mainWindow.restore()
    passed('partial registration rolls back only acquired channels; disposed cleanup is inert')
}

async function verifyNativeServices() {
    if (!native) return
    const expectedDirectory = realpathSync(process.env.AERVOX_IPC_SMOKE_DIRECTORY)
    const url = process.env.AERVOX_IPC_SMOKE_EXTERNAL_URL
    assert.match(url, /^https:\/\//i)
    senderWindow.show()
    senderWindow.focus()
    const context = {windowTitle: senderWindow.getTitle(), windowId: senderWindow.id, expectedDirectory, url}
    record({type: 'native-step', step: 'directory-select', ...context})
    const selected = await invoke(senderWindow.webContents, 'dialog:pick-directory')
    assert.equal(typeof selected, 'string')
    assert.equal(realpathSync(selected), expectedDirectory)
    nativeResults.directorySelection = 'passed'
    passed('real native directory picker returns the selected canonical directory')

    record({type: 'native-step', step: 'directory-cancel', ...context})
    assert.equal(await invoke(senderWindow.webContents, 'dialog:pick-directory'), null)
    nativeResults.directoryCancellation = 'passed'
    passed('real native directory picker cancellation returns null')

    record({type: 'native-step', step: 'open-external', ...context})
    assert.equal(await invoke(senderWindow.webContents, 'window:open-external', url), undefined)
    nativeResults.externalDispatch = 'passed'
    // The runner must independently observe the browser URL; dispatch alone does
    // not prove that the OS browser received or successfully loaded this page.
    passed('real shell.openExternal dispatch resolves (browser observation is separate)')
}

function verifyQuitLifecycle() {
    const order = []
    let attempts = 0
    let shutdownStarted = false
    let shutdownComplete = false
    app.on('before-quit', event => {
        order.push(`before-quit:${++attempts}`)
        if (shutdownComplete) return
        event.preventDefault()
        if (shutdownStarted) return
        shutdownStarted = true
        // Model the application's delayed before-quit shutdown using a bounded
        // asynchronous fixture. This does not start or validate a native Helper.
        void (async () => {
            await assert.rejects(invoke(senderWindow.webContents, 'window:open-external', 'http://example.com'), /仅允许/)
            order.push('handler-available-during-shutdown')
            await new Promise(resolve => setTimeout(resolve, 50))
            shutdownComplete = true
            order.push('asynchronous-shutdown-complete')
            app.quit()
        })().catch(fail)
    })
    app.once('will-quit', () => {
        try {
            order.push('will-quit')
            assert.deepEqual(order, [
                'before-quit:1', 'handler-available-during-shutdown',
                'asynchronous-shutdown-complete', 'before-quit:2', 'will-quit',
            ])
            dispose()
            dispose()
            // Registering with real ipcMain succeeds only if cleanup removed the
            // previous handlers. No private Electron handler-map inspection.
            for (const channel of channels) {
                ipcMain.handle(channel, () => undefined)
                ipcMain.removeHandler(channel)
            }
            passed('real quit lifecycle retains IPC during async before-quit and cleans at will-quit')
            record({type: 'result', passed: true, checks, native: nativeResults, lifecycle: order,
                scope: 'production window-ipc module in an isolated Electron fixture; full application and native Helper not exercised'})
        } catch (error) {
            fail(error)
        }
    })
    app.quit()
}

app.whenReady().then(async () => {
    record({type: 'ready', electron: process.versions.electron, native})
    await verifyWindowRouting()
    await verifyRegistration()
    await verifyNativeServices()
    verifyQuitLifecycle()
}).catch(fail)
