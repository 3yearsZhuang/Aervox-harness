import {contextBridge} from 'electron'
import {settingsApi} from './domains/settings-api'
import {windowApi} from './domains/window-api'
import {aervoxApi} from './domains/aervox-api'
import {dialogApi} from './domains/dialog-api'

contextBridge.exposeInMainWorld('fairyDesktop', {
    minimize: windowApi.minimize,
    toggleMaximize: windowApi.toggleMaximize,
    close: windowApi.close,
    onPetCommand: windowApi.onPetCommand,
    getTheme: settingsApi.getTheme,
    setTheme: settingsApi.setTheme,
    onThemeChange: settingsApi.onThemeChange,
    streamTurn: aervoxApi.streamTurn,
    apiRequest: aervoxApi.apiRequest,
    pickDirectory: dialogApi.pickDirectory,
    domains: {
        settings: settingsApi,
        window: windowApi,
        aervox: aervoxApi,
        dialog: dialogApi,
    },
})
