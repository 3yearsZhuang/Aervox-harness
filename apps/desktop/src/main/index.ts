import {app, BrowserWindow, ipcMain, Menu, nativeTheme, screen} from 'electron'
import {join} from 'node:path'

let mainWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let appTheme: 'light' | 'dark' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'

function isTheme(value: unknown): value is 'light' | 'dark' {
    return value === 'light' || value === 'dark'
}

function isTurnRequest(value: unknown): value is {requestId: string; content: string} {
    if (!value || typeof value !== 'object') return false
    const request = value as Record<string, unknown>
    return typeof request.requestId === 'string'
        && /^[a-zA-Z0-9_-]{8,80}$/.test(request.requestId)
        && typeof request.content === 'string'
        && request.content.trim().length > 0
        && request.content.length <= 20_000
}

async function streamAervoxTurn(event: Electron.IpcMainEvent, payload: unknown) {
    if (!isTurnRequest(payload)) return
    const {requestId, content} = payload
    const apiBaseUrl = (process.env.AERVOX_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
    const send = (message: Record<string, unknown>) => {
        if (!event.sender.isDestroyed()) event.sender.send('aervox:turn:event', {requestId, ...message})
    }

    try {
        const createResponse = await fetch(`${apiBaseUrl}/v1/sessions/desktop-demo/turns`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'Idempotency-Key': requestId,
            },
            body: JSON.stringify({
                message: {content, contentType: 'text'},
                clientVersion: '@aervox/desktop/0.2.0',
                references: [],
            }),
        })
        if (!createResponse.ok) throw new Error(`创建 Turn 失败（HTTP ${createResponse.status}）`)

        const turn = await createResponse.json() as {eventsUrl?: unknown}
        if (typeof turn.eventsUrl !== 'string' || !turn.eventsUrl.startsWith('/')) {
            throw new Error('Turn 响应缺少有效 eventsUrl')
        }

        const eventsResponse = await fetch(`${apiBaseUrl}${turn.eventsUrl}`, {headers: {Accept: 'text/event-stream'}})
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
            if (!data) return
            const turnEvent = JSON.parse(data) as Record<string, unknown>
            send({type: 'event', event: turnEvent})
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
        send({type: 'error', message: error instanceof Error ? error.message : 'Aervox 请求失败'})
    }
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
        width: 1360,
        height: 820,
        minWidth: 760,
        minHeight: 620,
        backgroundColor: '#f5f7f4',
        frame: false,
        autoHideMenuBar: true,
        title: 'Fairy Agent',
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

app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
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
    ipcMain.on('aervox:turn:start', streamAervoxTurn)
    createMainWindow()
    createPetWindow()
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow()
            createPetWindow()
        }
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
