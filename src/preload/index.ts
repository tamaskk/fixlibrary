import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appGetVersion),
    audioReadToken: () => ipcRenderer.invoke(IPC_CHANNELS.appAudioReadToken)
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
    openLogFolder: () => ipcRenderer.invoke(IPC_CHANNELS.systemOpenLogFolder),
    claudeStatus: (force) => ipcRenderer.invoke(IPC_CHANNELS.systemClaudeStatus, force),
    pickClaude: () => ipcRenderer.invoke(IPC_CHANNELS.systemPickClaude),
    clearClaude: () => ipcRenderer.invoke(IPC_CHANNELS.systemClearClaude),
    testClaude: () => ipcRenderer.invoke(IPC_CHANNELS.systemTestClaude)
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
    refreshLookup: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewRefreshLookup, request),
    duplicates: (batchId) => ipcRenderer.invoke(IPC_CHANNELS.previewDuplicates, batchId),
    keepDuplicate: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewKeepDuplicate, request),
    coverThumbs: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewCoverThumbs, request),
    chooseCover: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewChooseCover, request),
    setChosenCover: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewSetChosenCover, request),
    // The sandboxed page cannot learn where a dropped file is; only this can.
    dropCover: (request, file) => {
      // A file that was not dropped or chosen by the user has no path: nothing to send.
      const path = webUtils.getPathForFile(file)
      if (path === '') return Promise.resolve({ ok: false, code: 'COVER_UNUSABLE' })
      return ipcRenderer.invoke(IPC_CHANNELS.previewDropCover, request, path)
    },
    setExcluded: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewSetExcluded, request),
    approve: (batchId) => ipcRenderer.invoke(IPC_CHANNELS.previewApprove, batchId),
    discard: (batchId) => ipcRenderer.invoke(IPC_CHANNELS.previewDiscard, batchId),
    undoLast: () => ipcRenderer.invoke(IPC_CHANNELS.previewUndoLast)
  },
  rekordbox: {
    writeXml: () => ipcRenderer.invoke(IPC_CHANNELS.rekordboxWriteXml),
    readExport: () => ipcRenderer.invoke(IPC_CHANNELS.rekordboxReadExport),
    wizardView: () => ipcRenderer.invoke(IPC_CHANNELS.rekordboxWizardView),
    wizardAction: (action) => ipcRenderer.invoke(IPC_CHANNELS.rekordboxWizardAction, action),
    wizardCheck: () => ipcRenderer.invoke(IPC_CHANNELS.rekordboxWizardCheck),
    wizardCueCheck: () => ipcRenderer.invoke(IPC_CHANNELS.rekordboxWizardCueCheck),
    copyPath: (which) => ipcRenderer.invoke(IPC_CHANNELS.rekordboxCopyPath, which)
  },
  cueEditor: {
    tracks: (filter) => ipcRenderer.invoke(IPC_CHANNELS.cueEditorTracks, filter),
    track: (trackId) => ipcRenderer.invoke(IPC_CHANNELS.cueEditorTrack, trackId),
    peaks: (trackId) => ipcRenderer.invoke(IPC_CHANNELS.cueEditorPeaks, trackId),
    edit: (action) => ipcRenderer.invoke(IPC_CHANNELS.cueEditorEdit, action)
  },
  download: {
    inspect: (url) => ipcRenderer.invoke(IPC_CHANNELS.downloadInspect, url),
    start: (url) => ipcRenderer.invoke(IPC_CHANNELS.downloadStart, url),
    search: (request) => ipcRenderer.invoke(IPC_CHANNELS.downloadSearch, request),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.downloadList),
    onChange: (listener) => subscribe(IPC_EVENTS.downloadChanged, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
