import {createApp} from 'vue'
import {createAervoxClient, provideAervoxClient, desktopTransport} from '@aervox/api-client'
import {UISurfaceHost} from '@aervox/ui-host'
import defaultSurface from '@aervox/plugin-companion-ui'

// 与主窗口一致走 Electron IPC 桥：主进程注入鉴权头，桌宠窗口的
// 快捷对话与选择肢提交不再裸 fetch 直连 API
const client = createAervoxClient({ sessionId: 'web_default', sessionStorage: null, transport: desktopTransport, platform: {
    setTheme: window.fairyDesktop?.setTheme,
    onPetCommand: window.fairyDesktop?.onPetCommand,
    pickDirectory: window.fairyDesktop?.pickDirectory,
    proactive: window.fairyDesktop?.proactive,
} })

function applyTheme(theme: 'light' | 'dark') {
    document.documentElement.dataset.theme = theme
}

const fallbackTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
applyTheme(fallbackTheme)
window.fairyDesktop?.getTheme().then(applyTheme)
window.fairyDesktop?.onThemeChange(applyTheme)

const app = createApp(UISurfaceHost, {
    plugin: defaultSurface,
    surface: 'companion',
    platform: 'desktop',
    requestClose: () => window.close(),
    requestReload: () => window.location.reload(),
})
provideAervoxClient(client, app)
app.mount('#pet-app')
