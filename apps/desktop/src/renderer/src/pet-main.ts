import {createApp} from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import {configureAervoxClient, desktopTransport} from '@aervox/api-client'
import './styles/pet.css'
import PetWindow from './components/PetWindow.vue'

// 与主窗口一致走 Electron IPC 桥：主进程注入租户/鉴权头，桌宠窗口的
// 快捷对话与选择肢提交不再裸 fetch 直连 API
configureAervoxClient({transport: desktopTransport})

function applyTheme(theme: 'light' | 'dark') {
    document.documentElement.dataset.theme = theme
}

const fallbackTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
applyTheme(fallbackTheme)
window.fairyDesktop?.getTheme().then(applyTheme)
window.fairyDesktop?.onThemeChange(applyTheme)

createApp(PetWindow).use(ElementPlus).mount('#pet-app')
