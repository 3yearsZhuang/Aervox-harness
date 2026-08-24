import {createApp} from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './styles/pet.css'
import PetWindow from './components/PetWindow.vue'

function applyTheme(theme: 'light' | 'dark') {
    document.documentElement.dataset.theme = theme
}

const fallbackTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
applyTheme(fallbackTheme)
window.fairyDesktop?.getTheme().then(applyTheme)
window.fairyDesktop?.onThemeChange(applyTheme)

createApp(PetWindow).use(ElementPlus).mount('#pet-app')
