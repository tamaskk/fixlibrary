import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type FixLibraryApi } from '@shared/ipc'

// The preload runs sandboxed: only `electron` may be required at runtime.
// Never expose ipcRenderer itself, only the typed functions below.
const api: FixLibraryApi = {
  app: {
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appGetVersion)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
    pickFolder: (kind) => ipcRenderer.invoke(IPC_CHANNELS.settingsPickFolder, kind),
    clearFolder: (kind) => ipcRenderer.invoke(IPC_CHANNELS.settingsClearFolder, kind)
  },
  styles: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.stylesList),
    save: (styles) => ipcRenderer.invoke(IPC_CHANNELS.stylesSave, styles)
  },
  secrets: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.secretsStatus),
    save: (secret) => ipcRenderer.invoke(IPC_CHANNELS.secretsSave, secret),
    clear: (name) => ipcRenderer.invoke(IPC_CHANNELS.secretsClear, name),
    test: (service) => ipcRenderer.invoke(IPC_CHANNELS.secretsTest, service)
  },
  system: {
    checkTools: (force) => ipcRenderer.invoke(IPC_CHANNELS.systemCheckTools, force),
    openLogFolder: () => ipcRenderer.invoke(IPC_CHANNELS.systemOpenLogFolder)
  }
}

contextBridge.exposeInMainWorld('api', api)
