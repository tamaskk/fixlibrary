import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type FixLibraryApi } from '@shared/ipc'

// The preload runs sandboxed: only `electron` may be required at runtime.
// Never expose ipcRenderer itself, only the typed functions below.
const api: FixLibraryApi = {
  app: {
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appGetVersion)
  }
}

contextBridge.exposeInMainWorld('api', api)
