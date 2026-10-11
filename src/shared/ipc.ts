// Single source of truth for the renderer <-> main contract.
// Every channel is listed here; preload and main both derive their types from it.
import type { Result } from './errors'
import type {
  LibraryPage,
  LibraryPageRequest,
  LibraryStatus,
  RunRequest,
  RunTargets,
  ScanProgress,
  ScanSummary
} from './library'
import type {
  FolderKind,
  KeyService,
  KeyTestResult,
  SecretName,
  SecretStatus,
  SettingsPatch,
  SettingsSnapshot,
  Style,
  StyleInput
} from './settings'
import type { ToolCheck } from './tools'

export const IPC_CHANNELS = {
  appGetVersion: 'app:getVersion',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsPickFolder: 'settings:pickFolder',
  settingsClearFolder: 'settings:clearFolder',
  stylesList: 'styles:list',
  stylesSave: 'styles:save',
  secretsStatus: 'secrets:status',
  secretsSave: 'secrets:save',
  secretsClear: 'secrets:clear',
  secretsTest: 'secrets:test',
  systemCheckTools: 'system:checkTools',
  systemOpenLogFolder: 'system:openLogFolder',
  libraryStatus: 'library:status',
  libraryScan: 'library:scan',
  libraryFollowScan: 'library:followScan',
  libraryList: 'library:list',
  libraryRun: 'library:run'
} as const

/** Channels on which the main process tells the renderer something without being asked. */
export const IPC_EVENTS = {
  libraryScanProgress: 'library:scanProgress'
} as const

export interface FixLibraryApi {
  app: {
    getVersion: () => Promise<string>
  }
  settings: {
    get: () => Promise<SettingsSnapshot>
    update: (patch: SettingsPatch) => Promise<Result<SettingsSnapshot>>
    /**
     * Opens a folder dialog in the main process. The renderer never sends a path.
     * Resolves to null when the user cancels.
     */
    pickFolder: (kind: FolderKind) => Promise<Result<SettingsSnapshot> | null>
    /** Back to the default for this folder. */
    clearFolder: (kind: FolderKind) => Promise<Result<SettingsSnapshot>>
  }
  styles: {
    list: () => Promise<Style[]>
    /** Replaces the whole list, in the given order. */
    save: (styles: StyleInput[]) => Promise<Result<Style[]>>
  }
  secrets: {
    /** Where each key comes from. A key's value is never sent to the renderer. */
    status: () => Promise<SecretStatus>
    save: (secret: { name: SecretName; value: string }) => Promise<Result<SecretStatus>>
    clear: (name: SecretName) => Promise<SecretStatus>
    /** Asks the service whether the saved key is accepted. */
    test: (service: KeyService) => Promise<KeyTestResult>
  }
  system: {
    checkTools: (force: boolean) => Promise<ToolCheck[]>
    openLogFolder: () => Promise<void>
  }
  library: {
    status: () => Promise<LibraryStatus>
    /**
     * Scans the library folder and resolves when the scan is over. While a scan
     * is running, also one started by the app, this joins it.
     */
    scan: () => Promise<Result<ScanSummary>>
    /**
     * Resolves with the result of the scan that is running, or with null at once
     * when none is. Unlike `scan`, it never starts one.
     */
    followScan: () => Promise<Result<ScanSummary> | null>
    /** One page of the library, in path order. */
    list: (page: LibraryPageRequest) => Promise<Result<LibraryPage>>
    /**
     * Names the tracks to run on, by id only. Resolves with the tracks the main
     * process accepted; a track that cannot be processed right now is left out.
     */
    run: (request: RunRequest) => Promise<Result<RunTargets>>
    /** Calls the listener while a scan runs. Returns the function that stops it. */
    onScanProgress: (listener: (progress: ScanProgress) => void) => () => void
  }
}
