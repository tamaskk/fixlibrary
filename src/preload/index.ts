import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS, type FixLibraryApi } from '@shared/ipc'

// The preload runs sandboxed: only `electron` may be required at runtime.
// Never expose ipcRenderer itself, only the typed functions below.
/**
 * Passes what the main process sends on one fixed channel on to the page: the
 * payload only, never the event with its sender. Returns the function that stops it.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  if (typeof listener !== 'function') throw new TypeError('The listener must be a function')
  const forward = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, forward)
  return () => {
    ipcRenderer.removeListener(channel, forward)
  }
}

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
  },
  library: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.libraryStatus),
    scan: () => ipcRenderer.invoke(IPC_CHANNELS.libraryScan),
    followScan: () => ipcRenderer.invoke(IPC_CHANNELS.libraryFollowScan),
    list: (page) => ipcRenderer.invoke(IPC_CHANNELS.libraryList, page),
    run: (request) => ipcRenderer.invoke(IPC_CHANNELS.libraryRun, request),
    onScanProgress: (listener) => subscribe(IPC_EVENTS.libraryScanProgress, listener)
  },
  pipeline: {
    state: () => ipcRenderer.invoke(IPC_CHANNELS.pipelineState),
    pause: () => ipcRenderer.invoke(IPC_CHANNELS.pipelinePause),
    resume: () => ipcRenderer.invoke(IPC_CHANNELS.pipelineResume),
    cancel: () => ipcRenderer.invoke(IPC_CHANNELS.pipelineCancel),
    onProgress: (listener) => subscribe(IPC_EVENTS.pipelineProgress, listener)
  },
  preview: {
    state: () => ipcRenderer.invoke(IPC_CHANNELS.previewState),
    rows: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewRows, request),
    edit: (edit) => ipcRenderer.invoke(IPC_CHANNELS.previewEdit, edit),
    setExcluded: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewSetExcluded, request),
    approve: (batchId) => ipcRenderer.invoke(IPC_CHANNELS.previewApprove, batchId),
    discard: (batchId) => ipcRenderer.invoke(IPC_CHANNELS.previewDiscard, batchId),
    undoLast: () => ipcRenderer.invoke(IPC_CHANNELS.previewUndoLast)
  }
}

contextBridge.exposeInMainWorld('api', api)
