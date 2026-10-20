// Single source of truth for the renderer <-> main contract.
// Every channel is listed here; preload and main both derive their types from it.
import type { ClaudeStatus, ClaudeTestResult } from './claude'
import type {
  CueEditAction,
  CueEditorFilter,
  CueEditorListItem,
  CueEditorPeaks,
  CueEditorTrack
} from './cue-editor'
import type {
  DownloadInspection,
  DownloadItem,
  DownloadSearch,
  DownloadSearchHit
} from './download'
import type { DuplicateGroup, KeepDuplicate } from './duplicates'
import type { CalibrationRating, CalibrationView } from './energy'
import type { FullRunStart, FullRunView } from './full-run'
import type {
  AlternativesRequest,
  GapTarget,
  GeneratorParams,
  GeneratorResult,
  PromptParams,
  SaveRequest
} from './generator'
import type {
  OnlineDownloadOutcome,
  OnlineRecommendation,
  OnlineRecsState,
  PlaylistAction,
  PlaylistEditResult,
  PlaylistSummary,
  PlaylistTrackItem,
  PlaylistView
} from './playlists'
import type { Result } from './errors'
import type {
  LibraryPage,
  LibraryPageRequest,
  LibraryStatus,
  RunRequest,
  RunStarted,
  ScanProgress,
  ScanSummary
} from './library'
import type { PipelineState, RunProgress } from './pipeline'
import type {
  ApproveOutcome,
  CoverThumbs,
  CoverThumbsRequest,
  PreviewTrack,
  PreviewEdit,
  PreviewRefresh,
  PreviewExclude,
  PreviewPage,
  PreviewRow,
  PreviewRowsRequest,
  PreviewState,
  UndoOutcome
} from './preview'
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
import type { RekordboxExportCheck, RekordboxXmlWritten } from './rekordbox'
import type {
  CopyablePath,
  WizardAction,
  WizardCheckResult,
  WizardCueCheckResult,
  WizardState,
  WizardView
} from './rekordbox-wizard'
import type { ToolCheck } from './tools'

export const IPC_CHANNELS = {
  appGetVersion: 'app:getVersion',
  appAudioReadToken: 'app:audioReadToken',
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
  systemClaudeStatus: 'system:claudeStatus',
  systemPickClaude: 'system:pickClaude',
  systemClearClaude: 'system:clearClaude',
  systemTestClaude: 'system:testClaude',
  libraryStatus: 'library:status',
  libraryScan: 'library:scan',
  libraryFollowScan: 'library:followScan',
  libraryList: 'library:list',
  libraryRun: 'library:run',
  pipelineState: 'pipeline:state',
  pipelinePause: 'pipeline:pause',
  pipelineResume: 'pipeline:resume',
  pipelineCancel: 'pipeline:cancel',
  previewState: 'preview:state',
  previewRows: 'preview:rows',
  previewEdit: 'preview:edit',
  previewRefreshLookup: 'preview:refreshLookup',
  previewSetExcluded: 'preview:setExcluded',
  previewDuplicates: 'preview:duplicates',
  previewKeepDuplicate: 'preview:keepDuplicate',
  previewCoverThumbs: 'preview:coverThumbs',
  previewChooseCover: 'preview:chooseCover',
  previewSetChosenCover: 'preview:setChosenCover',
  previewDropCover: 'preview:dropCover',
  previewApprove: 'preview:approve',
  previewDiscard: 'preview:discard',
  previewUndoLast: 'preview:undoLast',
  rekordboxWriteXml: 'rekordbox:writeXml',
  rekordboxReadExport: 'rekordbox:readExport',
  rekordboxWizardView: 'rekordbox:wizardView',
  rekordboxWizardAction: 'rekordbox:wizardAction',
  rekordboxWizardCheck: 'rekordbox:wizardCheck',
  rekordboxWizardCueCheck: 'rekordbox:wizardCueCheck',
  rekordboxCopyPath: 'rekordbox:copyPath',
  cueEditorTracks: 'cue-editor:tracks',
  cueEditorTrack: 'cue-editor:track',
  cueEditorPeaks: 'cue-editor:peaks',
  cueEditorEdit: 'cue-editor:edit',
  energyCalibration: 'energy:calibration',
  energyRate: 'energy:rate',
  energyFit: 'energy:fit',
  energyNewSample: 'energy:newSample',
  playlistsList: 'playlists:list',
  playlistsView: 'playlists:view',
  playlistsEdit: 'playlists:edit',
  playlistsOnlineLast: 'playlists:onlineLast',
  playlistsOnlineRequest: 'playlists:onlineRequest',
  playlistsOnlineDownload: 'playlists:onlineDownload',
  fullRunView: 'full-run:view',
  fullRunStart: 'full-run:start',
  fullRunStop: 'full-run:stop',
  generatorParsePrompt: 'generator:parsePrompt',
  generatorGenerate: 'generator:generate',
  generatorAlternatives: 'generator:alternatives',
  generatorSave: 'generator:save',
  generatorGapRecs: 'generator:gapRecs',
  generatorGapDownload: 'generator:gapDownload',
  downloadInspect: 'download:inspect',
  downloadStart: 'download:start',
  downloadSearch: 'download:search',
  downloadList: 'download:list'
} as const

/** Channels on which the main process tells the renderer something without being asked. */
export const IPC_EVENTS = {
  libraryScanProgress: 'library:scanProgress',
  pipelineProgress: 'pipeline:progress',
  downloadChanged: 'download:changed'
} as const

export interface FixLibraryApi {
  app: {
    getVersion: () => Promise<string>
    /**
     * The token of this launch that lets the A/B player read the samples it plays
     * (`fixlib-audio://track/<id>?read=<token>`, T-033). Given to the app's own page only.
     */
    audioReadToken: () => Promise<string>
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
    /** Whether the `claude` command is there, up to date and logged in. Never its path. */
    claudeStatus: (force: boolean) => Promise<ClaudeStatus>
    /**
     * Opens a file dialog in the main process to choose the `claude` command by hand.
     * The renderer never sends a path. Resolves to null when the user cancels.
     */
    pickClaude: () => Promise<Result<ClaudeStatus> | null>
    /** Back to the command the login shell finds. */
    clearClaude: () => Promise<Result<ClaudeStatus>>
    /** One real call with up to five tracks of the library, to see that Claude answers. */
    testClaude: () => Promise<ClaudeTestResult>
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
     * Starts a run of the named functions on the tracks, which are named by id only.
     * Resolves with the tracks the main process took into the run; a track that
     * cannot be processed right now is left out.
     */
    run: (request: RunRequest) => Promise<Result<RunStarted>>
    /** Calls the listener while a scan runs. Returns the function that stops it. */
    onScanProgress: (listener: (progress: ScanProgress) => void) => () => void
  }
  pipeline: {
    state: () => Promise<PipelineState>
    /** No new job starts; the running ones finish. Does nothing without a run. */
    pause: () => Promise<void>
    resume: () => Promise<void>
    /** Ends the run at once; nothing it computed is kept for approval. */
    cancel: () => Promise<void>
    /** Calls the listener as a run goes on, and once more when it has ended. */
    onProgress: (listener: (progress: RunProgress) => void) => () => void
  }
  preview: {
    /** The batch that waits for approval, and whether a batch can be undone. */
    state: () => Promise<PreviewState>
    /** One page of the rows of the batch that waits for approval. */
    rows: (request: PreviewRowsRequest) => Promise<Result<PreviewPage>>
    /**
     * Sets one field of one row by hand. Resolves with the row as it is afterwards:
     * what follows from the field, such as the file name, is brought up to date.
     */
    edit: (edit: PreviewEdit) => Promise<Result<PreviewRow>>
    /** Asks the online services again about one row of the batch that waits. */
    refreshLookup: (request: PreviewRefresh) => Promise<Result<PreviewRow>>
    /** The groups of duplicates in the batch that waits for approval. */
    duplicates: (batchId: number) => Promise<Result<DuplicateGroup[]>>
    /**
     * Makes one copy the one its group keeps. Resolves with the groups as they are
     * afterwards. The track is named by id only; no file is touched before approval.
     */
    keepDuplicate: (request: KeepDuplicate) => Promise<Result<DuplicateGroup[]>>
    /** The old and the new cover of some rows of the batch that waits for approval. */
    coverThumbs: (request: CoverThumbsRequest) => Promise<Result<CoverThumbs[]>>
    /**
     * Asks for a picture for one row in a dialog of the main process. Resolves to true
     * when one was chosen; main keeps it for `setChosenCover`.
     */
    chooseCover: (request: PreviewTrack) => Promise<boolean>
    /** Makes the picture chosen in the last dialog the cover of that row. */
    setChosenCover: (request: PreviewTrack) => Promise<Result<PreviewRow>>
    /**
     * Makes a picture the user dropped on a row its cover. The page hands over the
     * dropped file; only the preload learns where it is, and only main reads it.
     */
    dropCover: (request: PreviewTrack, file: File) => Promise<Result<PreviewRow>>
    /** Takes rows out of the batch, or back in. Tracks are named by id only. */
    setExcluded: (request: PreviewExclude) => Promise<Result<PreviewState>>
    /**
     * Starts writing the rows that were left in. This is the only call that makes
     * the app change files, and it acts on the one batch that waits for approval.
     */
    approve: (batchId: number) => Promise<Result<ApproveOutcome>>
    /** Gives the batch up; nothing it proposed is written. */
    discard: (batchId: number) => Promise<Result<PreviewState>>
    /** Puts the files of the last batch that wrote back to what they were. */
    undoLast: () => Promise<Result<UndoOutcome>>
  }
  rekordbox: {
    /**
     * Writes the XML of the library into the folder Settings names, for Rekordbox to
     * import. Refused while files are being changed or scanned.
     */
    writeXml: () => Promise<Result<RekordboxXmlWritten>>
    /**
     * Reads the newest XML Rekordbox exported into the folder Settings names, keeps
     * the grids of the library's tracks, and says what is missing or not analysed.
     */
    readExport: () => Promise<Result<RekordboxExportCheck>>
    /** Where the user is in the wizard, and the paths its steps name. */
    wizardView: () => Promise<WizardView>
    /** A step done, back to a step, or phase A again. */
    wizardAction: (action: WizardAction) => Promise<Result<WizardState>>
    /** Reads the newest export and judges it; a clean one ends phase A. */
    wizardCheck: () => Promise<Result<WizardCheckResult>>
    /** Reads the newest export and checks the hot cues and the grid; a clean one ends the wizard. */
    wizardCueCheck: () => Promise<Result<WizardCueCheckResult>>
    /**
     * Copies the app's XML path or the export folder to the clipboard; the page names
     * which, the main process the path. False when asked again too soon.
     */
    copyPath: (which: CopyablePath) => Promise<boolean>
  }
  playlists: {
    /** Every playlist, in the order they were made, with its track count. */
    list: () => Promise<PlaylistSummary[]>
    /** One playlist with its tracks, what they add up to and ten tracks that fit; null if gone. */
    view: (playlistId: number) => Promise<PlaylistView | null>
    /** Creates, renames, deletes or changes the tracks of a playlist. */
    edit: (action: PlaylistAction) => Promise<Result<PlaylistEditResult>>
    /** The online recommendations last found for a playlist in this session, and whether they are being asked for. */
    onlineLast: (playlistId: number) => Promise<OnlineRecsState>
    /** Asks Claude for tracks that fit and checks each on YouTube; takes a minute or so. */
    onlineRequest: (playlistId: number) => Promise<Result<OnlineRecommendation[]>>
    /**
     * Downloads a recommendation; its track joins the playlist once its Inbox batch is
     * approved. A low bitrate or a copy in the library is asked about unless `confirmed`.
     */
    onlineDownload: (
      playlistId: number,
      url: string,
      confirmed: boolean
    ) => Promise<Result<OnlineDownloadOutcome>>
  }
  fullRun: {
    /** The full run that goes on or ended last, or null when none was started. */
    view: () => Promise<FullRunView | null>
    /** Starts one on the selected tracks, or with `trackIds: null` on the whole library. */
    start: (request: FullRunStart) => Promise<Result<FullRunView>>
    /** Ends it where it is; the batch of its step is left as it is. */
    stop: () => Promise<void>
  }
  generator: {
    /** Reads a prompt into the fields it names, and the styles it named that the user has not. */
    parsePrompt: (
      prompt: string
    ) => Promise<Result<{ params: PromptParams; unknownStyles: string[] }>>
    generate: (params: GeneratorParams) => Promise<GeneratorResult>
    /** Up to five tracks that could take a place of the list and still mix with its neighbours. */
    alternatives: (request: AlternativesRequest) => Promise<Result<PlaylistTrackItem[]>>
    /** Saves the tracks of the list as a new playlist; how many were skipped. */
    save: (request: SaveRequest) => Promise<Result<{ playlistId: number; skipped: number }>>
    /** Online recommendations for a gap, by what the missing track should be like. */
    gapRecs: (target: GapTarget) => Promise<Result<OnlineRecommendation[]>>
    /** Downloads a recommendation for a gap into the Inbox. */
    gapDownload: (url: string, confirmed: boolean) => Promise<Result<OnlineDownloadOutcome>>
  }
  energy: {
    /** The calibration sample, the ratings given, and the kept model. */
    calibration: () => Promise<CalibrationView>
    /** Keeps the user's 1–10 rating of a track of the sample; answers the count rated. */
    rate: (rating: CalibrationRating) => Promise<Result<{ ratedCount: number }>>
    /** Fits the model to the ratings and sets the scale of every style. */
    fit: () => Promise<Result<CalibrationView>>
    /** Chooses a new sample; the ratings given stay. */
    newSample: () => Promise<CalibrationView>
  }
  cueEditor: {
    /** The tracks with Rekordbox's grid, as the filter asks, by file name. */
    tracks: (filter: CueEditorFilter) => Promise<CueEditorListItem[]>
    /** One track's grid and cues. The audio is played from `fixlib-audio://track/<id>`. */
    track: (trackId: number) => Promise<Result<CueEditorTrack>>
    /** The waveform of a track, made by the sidecar the first time. */
    peaks: (trackId: number) => Promise<Result<CueEditorPeaks>>
    /** Places, deletes or releases one cue; the main process snaps it to the grid. */
    edit: (action: CueEditAction) => Promise<Result<CueEditorTrack>>
  }
  download: {
    /**
     * Asks yt-dlp what one address is: its title, its bitrate, and a track of the
     * library it may be a copy of. Only a single YouTube or SoundCloud track.
     */
    inspect: (url: string) => Promise<Result<DownloadInspection>>
    /** Puts an address that was inspected in line; resolves with the whole list. */
    start: (url: string) => Promise<Result<DownloadItem[]>>
    /** Ten hits of the service, not downloaded. */
    search: (request: DownloadSearch) => Promise<Result<DownloadSearchHit[]>>
    list: () => Promise<DownloadItem[]>
    /** Calls the listener whenever a download changes. */
    onChange: (listener: (items: DownloadItem[]) => void) => () => void
  }
}
