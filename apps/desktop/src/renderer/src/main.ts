import {createApp} from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './styles/index.css'
import './styles/story.css'
import App from './App.vue'

const fallbackTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
document.documentElement.dataset.theme = fallbackTheme
window.fairyDesktop?.getTheme().then((theme) => {
    document.documentElement.dataset.theme = theme
})

createApp(App).use(ElementPlus).mount('#app')
