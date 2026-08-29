import {contextBridge} from 'electron'
import {settingsApi} from './domains/settings-api'
import {windowApi} from './domains/window-api'
import {aervoxApi} from './domains/aervox-api'
import {dialogApi} from './domains/dialog-api'
import {proactiveApi} from './domains/proactive-api'

contextBridge.exposeInMainWorld('fairyDesktop', {
    minimize: windowApi.minimize,
    toggleMaximize: windowApi.toggleMaximize,
    close: windowApi.close,
    openExternal: windowApi.openExternal,
    onPetCommand: windowApi.onPetCommand,
    getTheme: settingsApi.getTheme,
    setTheme: settingsApi.setTheme,
    onThemeChange: settingsApi.onThemeChange,
    streamTurn: aervoxApi.streamTurn,
    cancelTurn: aervoxApi.cancelTurn,
    apiRequest: aervoxApi.apiRequest,
    uploadAttachment: aervoxApi.uploadAttachment,
    pickDirectory: dialogApi.pickDirectory,
    proactive: proactiveApi,
    domains: {
        settings: settingsApi,
        window: windowApi,
        aervox: aervoxApi,
        dialog: dialogApi,
        proactive: proactiveApi,
    },
})
