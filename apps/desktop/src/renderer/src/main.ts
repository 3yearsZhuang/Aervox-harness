import {createApp} from 'vue'
import { ElButton } from 'element-plus/es/components/button/index.mjs'
import { ElDialog } from 'element-plus/es/components/dialog/index.mjs'
import { ElDropdown, ElDropdownItem, ElDropdownMenu } from 'element-plus/es/components/dropdown/index.mjs'
import { ElTooltip } from 'element-plus/es/components/tooltip/index.mjs'
import 'element-plus/dist/index.css'
import {configureAervoxClient, desktopTransport} from '@aervox/api-client'
import './styles/shell.css'
import App from './App.vue'

// 桌面端统一走 IPC transport（无桥环境可换 fetch，见 @aervox/api-client）
configureAervoxClient({transport: desktopTransport})

const fallbackTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
document.documentElement.dataset.theme = fallbackTheme
window.fairyDesktop?.getTheme().then((theme) => {
    document.documentElement.dataset.theme = theme
})

const app = createApp(App)
const elementComponents = [
  ElButton,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElTooltip,
]
for (const comp of elementComponents) {
  app.use(comp)
}
app.mount('#app')
