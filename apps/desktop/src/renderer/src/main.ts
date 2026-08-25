import {createApp} from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import {configureAervoxClient, desktopTransport} from '@aervox/api-client'
import '@aervox/ui'
import './styles/shell.css'
import App from './App.vue'

// 桌面端统一走 IPC transport（无桥环境可换 fetch，见 @aervox/api-client）
configureAervoxClient({transport: desktopTransport})

const fallbackTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
document.documentElement.dataset.theme = fallbackTheme
window.fairyDesktop?.getTheme().then((theme) => {
    document.documentElement.dataset.theme = theme
})

createApp(App).use(ElementPlus).mount('#app')
