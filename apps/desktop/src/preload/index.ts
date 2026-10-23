import {contextBridge} from 'electron'
import {settingsApi} from './domains/settings-api'
import {windowApi} from './domains/window-api'
import {aervoxApi} from './domains/aervox-api'
import {dialogApi} from './domains/dialog-api'
import {proactiveApi} from './domains/proactive-api'
import {trustedPreloadEntry} from '../shared/renderer-trust'

const locationUrl = (globalThis as typeof globalThis & {location: {href: string}}).location.href
if (trustedPreloadEntry(process.argv, locationUrl, process.isMainFrame)) {
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
        observeTurn: aervoxApi.observeTurn,
        streamEvents: aervoxApi.streamEvents,
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
}
