import { randomBytes } from 'crypto'
import { app, dialog, powerSaveBlocker, protocol, shell, BrowserWindow } from 'electron'
import { existsSync, realpathSync, watch as watchFolder } from 'fs'
import { lstat, readdir } from 'fs/promises'
import { cpus, homedir, tmpdir, userInfo } from 'os'
import { join, sep } from 'path'
import { optimizer, is } from '@electron-toolkit/utils'
import { closeDatabase, getDatabase, initDatabase, type AppDatabase } from './db/connection'
import { registerAppIpc } from './ipc/app'
import { registerLibraryIpc, sendScanProgress } from './ipc/library'
import { registerPipelineIpc, sendRunProgress } from './ipc/pipeline'
import { registerPreviewIpc } from './ipc/preview'
import { registerEnergyIpc } from './ipc/energy'
import { registerFullRunIpc } from './ipc/full-run'
import { registerGeneratorIpc } from './ipc/generator'
import { createRuntimeStateSender, registerPythonRuntimeIpc } from './ipc/python-runtime'
import {
  prepareRuntime,
  readManifest,
  runtimePaths,
  type RuntimeFolders,
  type RuntimePaths
} from './services/python-runtime'
import type { PythonRuntimeState } from '@shared/python-runtime'
import { registerPlaylistsIpc } from './ipc/playlists'
import { createFullRun, FULL_RUN_TICK_MS } from './pipeline/full-run'
import { readProposal } from '@shared/preview'
import { createOnlineRecs, noteInboxTrack, type OnlineRecs } from './pipeline/online-recs'
import { registerCueEditorIpc } from './ipc/cue-editor'
import { registerDownloadIpc, sendDownloads } from './ipc/download'
import { registerRekordboxIpc } from './ipc/rekordbox'
import { parseExportInWorker } from './services/rekordbox-xml-read'
import rekordboxXmlWorkerPath from './services/rekordbox-xml-worker?modulePath'
import { getRendererEntryUrl, isRendererUrl, setRendererEntry } from './ipc/handle'
import { registerSettingsIpc } from './ipc/settings'
import { registerSystemIpc } from './ipc/system'
import { createBatchFiles } from './pipeline/batch-files'
import { createClaude, type Claude } from './pipeline/claude'
import { createDownloads, findThumbnail, type Downloads } from './pipeline/download'
import {
  createInboxBatches,
  createInboxWatcher,
  inboxStages,
  type InboxWatcher
} from './pipeline/inbox'
import { createOrchestrator, type Orchestrator } from './pipeline/orchestrator'
import { commitApprovedValues, createPreview } from './pipeline/preview'
import { createLibraryScanner } from './pipeline/scanner'
import { createLookupCache } from './pipeline/lookup-cache'
import { createSecretStore, pickSecretEnv, type SecretStore } from './pipeline/secrets'
import { waitForFileWork, type FileWork } from './pipeline/shutdown'
import {
  ensureDefaultStyles,
  readSettings,
  resolveEffectiveSettings,
  type SettingsEnvironment
} from './pipeline/settings'
import { createStages, selectableStages, validateStages } from './pipeline/stages'
import { createDemoStages } from './pipeline/stages/demo'
import type { Stage } from './pipeline/stages/stage'
import { createToolChecker } from './pipeline/system'
import { resolveToolCommand, resolveToolLocations, type ToolLocations } from './services/binaries'
import { createClaudeCli } from './services/claude-cli'
import { createYtDlp } from './services/downloader'
import { readEnvFile } from './services/env-file'
import { describeError } from './services/error-text'
import { createFileOps } from './services/file-ops'
import { keychainCipher } from './services/keychain'
import { logger, maskSecretsInLog, startFileLogging } from './services/logger'
import { createAcoustIdClient } from './services/lookup/acoustid'
import { createDiscogsClient } from './services/lookup/discogs'
import { createLookupHttp } from './services/lookup/http'
import { createITunesClient } from './services/lookup/itunes'
import { createMusicBrainzClient } from './services/lookup/musicbrainz'
import { createSleepBlocker } from './services/power'
import { createTimedCache } from './services/timed-cache'
import { createCoverStore } from './services/covers'
import { createStemsStore, stemModelInstalled } from './services/stems-store'
import { AUDIO_SCHEME, createAudioHandler, originOfRendererUrl } from './services/audio-protocol'
import { createPeaksStore } from './services/peaks-store'
import { countBatchItems, findPreviewBatch, getBatch, listAllBatchItems } from './db/batches'
import { currentEnergyModel } from './pipeline/energy'
import { applyWizardAction, readWizardState } from './pipeline/rekordbox-wizard'
import { findTrackIdByPath, getTrackById, listLibraryTracks } from './db/tracks'
import { isSetAsidePath } from '@shared/duplicates'
import { createPythonBridge, type PythonBridge } from './services/python-bridge'
import {
  createMountedVolumesCache,
  isDocumentsInICloud,
  listMountedVolumes
} from './services/volumes'
import { AppError } from '@shared/errors'
import { FIXED_RESOURCE_LIMITS } from '@shared/pipeline'
import { INBOX_FOLDER_NAME, SECRET_NAMES, type SecretName } from '@shared/settings'
import {
  ENGINE_CHECK_TIMEOUT_MS,
  QUIT_FILE_WORK_WAIT_MS,
  TAG_BATCH_TIMEOUT_MS
} from '@shared/timeouts'

let pythonBridge: PythonBridge | null = null
// Quitting: the work that must end first, and whether it has.
let stopping: Promise<void> | null = null
let readyToQuit = false
let orchestrator: Orchestrator | null = null
// Asked when quitting whether a stage is still in the middle of a file.
let fileWork: FileWork | null = null
// Kept so that quitting can stop a call to Claude that is still running.
let claudeService: Claude | null = null
// Kept so that quitting can stop the downloads that are running.
let downloads: Downloads | null = null
let onlineRecs: OnlineRecs | null = null
// Kept so that quitting can stop the full run looking at its step.
let fullRunTimer: NodeJS.Timeout | null = null
let fullRunActive: () => boolean = () => false
// The packaged runtime: unpacked on a first start before the sidecar can start (T-041).
let runtimeState: PythonRuntimeState = { status: 'checking', fraction: null }
// Resolves once the sidecar was started, or could not be: the startup work waits for it.
let pythonReady: Promise<void> = Promise.resolve()
const sendRuntimeState = createRuntimeStateSender()

function setRuntimeState(state: PythonRuntimeState): void {
  runtimeState = state
  sendRuntimeState(state)
}
// Kept so that quitting can stop watching the Inbox.
let inboxWatcher: InboxWatcher | null = null
// The API keys of the lookup services; read by the stages that ask them.
let secretStore: SecretStore | null = null

// As the lookup services ask a client to name itself.
const userAgent = (): string =>
  `FixLibrary/${app.getVersion()} (+https://github.com/tamaskk/fixlibrary)`
// How old the key values may be that are masked in the log.
const MASKED_SECRETS_MAX_AGE_MS = 5000

// How old the limits of a run may be before the settings are read again.
const LIMITS_MAX_AGE_MS = 1000
// Longer than this and a timer no longer means what it says.
const MAX_DEMO_STAGE_MS = 600_000

/** Opens the database and applies pending migrations. Returns false if the app cannot run. */
function openAppDatabase(): boolean {
  const migrationsFolder = app.isPackaged
    ? join(process.resourcesPath, 'migrations')
    : join(app.getAppPath(), 'src/main/db/migrations')
  const databasePath = join(app.getPath('userData'), 'fixlibrary.db')
  try {
    initDatabase(databasePath, migrationsFolder)
    return true
  } catch (error) {
    // Without its state the app would re-process the library, so it does not start.
    logger.error('The database could not be opened', error)
    // The file holds the undo records, so the user is told where it is and to keep it.
    dialog.showErrorBox(
      'Az adatbázis nem nyitható meg',
      `Az alkalmazás leáll. Ne töröld az adatbázist, mert a visszavonás adatai benne vannak.\n\n${databasePath}`
    )
    return false
  }
}

/** The API keys of `.env.local`, as a fallback while developing. Never read when packaged. */
function readDevelopmentSecrets(): Record<string, string> {
  if (app.isPackaged) return {}
  try {
    // Only the three key names are kept; nothing else of the file stays in memory.
    return pickSecretEnv(readEnvFile(join(app.getAppPath(), '.env.local')))
  } catch (error) {
    logger.error('The development env file could not be read', error)
    return {}
  }
}

// An app that crashes while starting must not relaunch itself in a loop.
const MIN_UPTIME_FOR_RELAUNCH_S = 30

/**
 * After an uncaught exception the app is in an unknown state, and it must not go on
 * like that while it may be writing library files. The error is already in the log;
 * the user is told, and the app starts again (or stops, if it has only just started).
 */
function stopAfterUncaughtException(): void {
  const relaunch = process.uptime() >= MIN_UPTIME_FOR_RELAUNCH_S
  dialog.showErrorBox(
    'Váratlan hiba történt',
    relaunch
      ? 'Az alkalmazás újraindul. A részletek a logban vannak.'
      : 'Az alkalmazás leáll. A részletek a logban vannak.'
  )
  try {
    // Puts the running jobs back in line without counting an attempt: this crash is
    // the app's, not theirs.
    orchestrator?.shutdown()
  } catch (error) {
    logger.error('The run could not be put aside', error)
  }
  orchestrator = null
  claudeService?.stop()
  closeDatabase()
  // Not when the user was quitting anyway: the app must not come back by itself.
  if (relaunch && stopping === null && !readyToQuit) app.relaunch()
  // The sidecar ends by itself when its input closes.
  app.exit(1)
}

/** The facts about this machine the settings go by. */
function createSettingsEnvironment(): SettingsEnvironment {
  return {
    homeDir: homedir(),
    cpuCount: cpus().length,
    appDataDir: app.getPath('userData'),
    // Asked afresh every time: iCloud can be turned on while the app runs.
    get documentsSynced() {
      return isDocumentsInICloud(homedir())
    }
  }
}

function registerSettingsAndSystemIpc(): void {
  const db = getDatabase()
  ensureDefaultStyles(db)

  const secrets = createSecretStore({
    db,
    cipher: keychainCipher,
    devEnv: readDevelopmentSecrets(),
    keyCheck: { userAgent: userAgent() }
  })
  secretStore = secrets
  // Decrypting asks the Keychain, so the values are read for a few seconds at a time.
  maskSecretsInLog(
    createTimedCache(
      () => SECRET_NAMES.flatMap((name) => secrets.read(name) ?? []),
      MASKED_SECRETS_MAX_AGE_MS
    )
  )
  registerSettingsIpc({
    db,
    secrets,
    environment: createSettingsEnvironment()
  })
  const cli = createClaudeCli({
    // The app's own folder; every call runs in a new, empty folder inside it.
    workDir: join(app.getPath('userData'), 'claude-workdir'),
    homeDir: homedir(),
    userName: userInfo().username
  })
  const claude = createClaude({ db, cli })
  claudeService = claude
  // What a run that was killed left in the working folder goes first.
  void cli.cleanUp()
  // Asked once at startup, so the log says whether Claude can be used; the Settings
  // page reads the same answer.
  void claude
    .status(false)
    .then((status) =>
      logger.info(
        status.ok
          ? `Claude ready, version ${status.version}`
          : `Claude cannot be used: ${status.reason}`
      )
    )
    .catch((error: unknown) => logger.error(`Claude could not be checked: ${describeError(error)}`))
  registerSystemIpc({
    db,
    claude,
    toolChecker: createToolChecker(toolLocations()),
    logFolder: app.getPath('logs')
  })
}

/** Where the packaged app keeps its runtime archive, and where it unpacks it (T-041). */
function runtimeFolders(): RuntimeFolders {
  return {
    bundleDir: join(process.resourcesPath, 'python'),
    baseDir: join(app.getPath('userData'), 'python')
  }
}

/** The runtime the packaged app runs, unpacked or not yet; null in development. */
function packagedRuntime(): RuntimePaths | null {
  if (!app.isPackaged) return null
  const { bundleDir, baseDir } = runtimeFolders()
  const manifest = readManifest(bundleDir)
  return manifest === null ? null : runtimePaths(baseDir, manifest.version)
}

function toolLocations(): ToolLocations {
  return resolveToolLocations({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    runtimePython: packagedRuntime()?.python ?? null
  })
}

function startBridge(runtime: {
  python: string
  cwd: string
  modelsDir: string
  torchHome: string
}): void {
  const locations = toolLocations()
  pythonBridge = createPythonBridge({
    pythonPath: runtime.python,
    cwd: runtime.cwd,
    logDir: app.getPath('logs'),
    // The sidecar decodes and fingerprints with the app's own tools and with nothing else.
    ffmpegPath: resolveToolCommand('ffmpeg', locations)?.command,
    fpcalcPath: resolveToolCommand('fpcalc', locations)?.command,
    mp3gainPath: resolveToolCommand('mp3gain', locations)?.command,
    coversDir: coversFolder(),
    stemsDir: stemsFolder(),
    peaksDir: peaksFolder(),
    modelsDir: runtime.modelsDir,
    // Nothing of the app downloads into it; set so that no part of torch ever writes to
    // `~/.cache` instead.
    torchHome: runtime.torchHome
  })
  pythonBridge.start()
  pythonBridge
    .call('ping', {})
    .then(({ version }) => logger.info(`Python sidecar ready, fixlib_py ${version}`))
    .catch((error: unknown) => logger.error('Python sidecar did not answer ping', error))
}

/** The packaged app: the runtime unpacked first when this version has none yet. */
async function prepareRuntimeAndStart(): Promise<void> {
  const prepared = await prepareRuntime(runtimeFolders(), setRuntimeState)
  if (prepared.ok) {
    const { python, dir, modelsDir, torchHome } = prepared.value
    startBridge({ python, cwd: dir, modelsDir, torchHome })
  }
}

function startPythonSidecar(): void {
  if (app.isPackaged) {
    pythonReady = prepareRuntimeAndStart()
    return
  }
  const pythonDir = join(app.getAppPath(), 'python')
  const pythonPath = join(pythonDir, '.venv/bin/python')
  setRuntimeState({ status: 'ready', fraction: 1 })
  if (!existsSync(pythonPath)) {
    logger.error('Python sidecar not started: no development environment in python/.venv')
    return
  }
  startBridge({
    python: pythonPath,
    cwd: pythonDir,
    modelsDir: modelsFolder(),
    torchHome: join(app.getPath('userData'), 'torch')
  })
}

/**
 * True for a file that tests generated: under the system's temp folder, or in the
 * synthetic fixtures of the repository. The stand-in rename works on nothing else,
 * so a development build cannot rename a real library by accident.
 */
function isGeneratedFile(path: string): boolean {
  const roots = [tmpdir(), join(app.getAppPath(), 'tests/fixtures/synthetic')].flatMap((root) => {
    try {
      return [realpathSync.native(root)]
    } catch {
      return []
    }
  })
  return roots.some((root) => path.startsWith(root + sep))
}

/** Where covers are kept between runs: a folder of the app's own, never of the library. */
function coversFolder(): string {
  return join(app.getPath('userData'), 'covers')
}

/** What yt-dlp writes on the way to a finished MP3, and the thumbnails of downloads (T-034). */
function downloadFolders(): { temp: string; thumbnails: string } {
  return {
    temp: join(app.getPath('userData'), 'download-tmp'),
    thumbnails: join(app.getPath('userData'), 'thumbnails')
  }
}

function stemsFolder(): string {
  return join(app.getPath('userData'), 'stems')
}

function peaksFolder(): string {
  return join(app.getPath('userData'), 'peaks')
}

/** `resources/models` in development; the packaged app gets its models with T-041. */
function modelsFolder(): string {
  // The packaged app has the model inside its runtime (T-041).
  return packagedRuntime()?.modelsDir ?? join(app.getAppPath(), 'resources/models')
}

/**
 * The stages a run can use. In development, `FIXLIB_DEMO_STAGES=1` puts stand-ins in
 * the place of the real stages: two that propose made-up values and one that renames
 * the file to the proposed name once the batch is approved. They read no audio, so
 * the run, the preview and the apply phase can be tried and tested end to end in
 * seconds, on files that are no music. The packaged app never has them.
 */
function availableStages(db: AppDatabase): Stage[] {
  if (app.isPackaged || process.env['FIXLIB_DEMO_STAGES'] !== '1') {
    const cache = createLookupCache(db)
    const http = createLookupHttp({ userAgent: userAgent() })
    const secret = (name: SecretName): string | undefined => secretStore?.read(name)
    return createStages({
      db,
      python: () => pythonBridge,
      bpmRange: () => readSettings(db).analysis,
      loudnessSettings: () => readSettings(db).loudness,
      cache,
      // Without an AcoustID key a fingerprint has nowhere to go.
      wanted: () => secret('acoustid') !== undefined,
      clients: {
        acoustid: createAcoustIdClient({ http, cache, apiKey: () => secret('acoustid') }),
        musicbrainz: createMusicBrainzClient({ http, cache }),
        discogs: createDiscogsClient({
          http,
          cache,
          credentials: () => {
            const key = secret('discogsKey')
            const discogsSecret = secret('discogsSecret')
            return key !== undefined && discogsSecret !== undefined
              ? { key, secret: discogsSecret }
              : undefined
          }
        })
      },
      covers: createCoverStore(coversFolder()),
      stems: createStemsStore(stemsFolder()),
      modelInstalled: () => stemModelInstalled(modelsFolder()),
      coverClients: { itunes: createITunesClient({ http, cache }), images: http },
      thumbnailOf: (track) =>
        findThumbnail(
          track.path,
          readSettings(db).library.rootFolder,
          downloadFolders().thumbnails
        ),
      claude: () => claudeService
    })
  }
  const ms = Number(process.env['FIXLIB_DEMO_STAGE_MS'])
  const usable = Number.isInteger(ms) && ms >= 1 && ms <= MAX_DEMO_STAGE_MS
  return createDemoStages(usable ? ms : undefined, { mayRename: isGeneratedFile })
}

function registerLibraryAndPipeline(): void {
  const db = getDatabase()
  const environment = createSettingsEnvironment()
  // Set once the file rules exist, a few lines below.
  let reconcileBeforeScan: (() => Promise<number>) | null = null
  let restoredOriginals: (() => Promise<ReadonlySet<string>>) | null = null
  const scanner = createLibraryScanner({
    db,
    environment,
    listMountedVolumes,
    onProgress: sendScanProgress,
    // Also while quitting: a file step may still be ending after the wait for it ran out.
    isChangingFiles: () => stopping !== null || (orchestrator?.changingFiles() ?? false),
    // Before every scan, also one asked for from the page or after a drive came
    // back: a file that an interrupted batch renamed would be taken for a new track.
    knownFiles: async () => (await restoredOriginals?.()) ?? new Set<string>(),
    beforeScan: async () => {
      const found = (await reconcileBeforeScan?.()) ?? 0
      if (found > 0) {
        logger.info(`${found} tracks were told where an interrupted batch left their files`)
      }
    },
    readTags: async (paths) => {
      if (!pythonBridge) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
      const { files } = await pythonBridge.call(
        'tags.read',
        { paths },
        { timeoutMs: TAG_BATCH_TIMEOUT_MS }
      )
      return files
    },
    isEngineAlive: async () => {
      if (!pythonBridge) return false
      return pythonBridge.call('ping', {}, { timeoutMs: ENGINE_CHECK_TIMEOUT_MS }).then(
        () => true,
        () => false
      )
    }
  })

  // The folders of the library as the settings name them now: the only places a
  // file may be changed in.
  const folders = (): ReturnType<Parameters<typeof createBatchFiles>[0]['folders']> => {
    const settings = readSettings(db)
    return {
      libraryRoot: settings.library.rootFolder,
      cleanLibraryFolder: settings.library.cleanLibraryFolder,
      backupFolder: resolveEffectiveSettings(settings, environment).backupFolder
    }
  }
  const batchFiles = createBatchFiles({
    db,
    fileOps: createFileOps({
      allowedRoots: () =>
        Object.values(folders()).filter((folder): folder is string => folder !== null)
    }),
    folders,
    listMountedVolumes
  })
  fileWork = batchFiles
  reconcileBeforeScan = () => batchFiles.reconcileInterrupted()
  restoredOriginals = () => batchFiles.restoredOriginals()

  let startupDone = false
  const stages = availableStages(db)
  // A mistake in the stages is a bug of this build: better to stop here than to run them.
  validateStages(stages)
  const runs = createOrchestrator({
    db,
    stages,
    // Asked for whenever a job could start, so a changed worker count applies to a
    // running run; read from the settings at most once a second.
    limits: createTimedCache(
      () => ({
        ...FIXED_RESOURCE_LIMITS,
        cpu: resolveEffectiveSettings(readSettings(db), environment).workerCount
      }),
      LIMITS_MAX_AGE_MS
    ),
    listMountedVolumes,
    mode: () => readSettings(db).library.mode,
    batchFiles,
    // Until the startup work below is over, and during every scan.
    libraryBusy: () => !startupDone || scanner.isRunning(),
    onTrackApplied: (batchId, trackId) => commitApprovedValues(db, batchId, trackId),
    onProgress: sendRunProgress,
    onBusyChange: createSleepBlocker(powerSaveBlocker)
  })
  orchestrator = runs
  const functions = selectableStages(stages)
  // A failure here must not keep the window from opening: the run stays where it is
  // in the database, and the next start tries again.
  const takeUpRun = (): void => {
    try {
      runs.recover()
    } catch (error) {
      logger.error('The interrupted run could not be taken up', error)
    }
  }

  // The scanner above always asks afresh: it decides whether tracks are marked missing.
  registerLibraryIpc({
    db,
    scanner,
    orchestrator: runs,
    functions,
    listMountedVolumes: createMountedVolumesCache(1000)
  })
  registerPipelineIpc({ orchestrator: runs, functions })
  registerRekordboxIpc({
    db,
    environment,
    listMountedVolumes,
    appVersion: app.getVersion(),
    // The paths in the XML must be where the files are: not while a batch moves them.
    isBusy: () => runs.changingFiles() || scanner.isRunning(),
    // An export is untrusted and may be large: its parse costs a worker, not the app.
    parseExport: (bytes) => parseExportInWorker(rekordboxXmlWorkerPath, bytes)
  })
  // Asked on every range a player reads, and every edit: not of the drives each time.
  const cachedVolumes = createMountedVolumesCache(1000)
  const cueEditor = {
    db,
    listMountedVolumes: cachedVolumes,
    python: () => pythonBridge,
    peaks: createPeaksStore(peaksFolder())
  }
  registerCueEditorIpc(cueEditor)
  registerEnergyIpc({ db, python: () => pythonBridge })
  const tools = toolLocations()
  const ytDlp = createYtDlp(() => resolveToolCommand('yt-dlp', tools))
  downloads = createDownloads({
    ytDlp,
    folders: () => ({ libraryRoot: readSettings(db).library.rootFolder, ...downloadFolders() }),
    ffmpeg: () => {
      const ffmpeg = resolveToolCommand('ffmpeg', tools)?.command
      return ffmpeg !== undefined && existsSync(ffmpeg) ? ffmpeg : null
    },
    libraryTracks: () => listLibraryTracks(db, cachedVolumes()),
    onChange: (items) => {
      sendDownloads(items)
      // A finished download is looked for at once, not at the next listing.
      if (items.some((item) => item.state === 'done')) inboxWatcher?.refresh()
    }
  })
  registerDownloadIpc(downloads)
  onlineRecs = createOnlineRecs({
    db,
    listMountedVolumes: cachedVolumes,
    claude: () => claudeService,
    ytDlp,
    downloads: () => downloads
  })
  registerPlaylistsIpc({ db, listMountedVolumes: cachedVolumes }, onlineRecs)
  registerGeneratorIpc({
    db,
    listMountedVolumes: cachedVolumes,
    claude: () => claudeService,
    onlineRecs: () => onlineRecs
  })
  // New files of the Inbox become a batch of their own once nothing else runs or waits
  // for approval, so a batch of the user's is never given up for one.
  inboxWatcher = createInboxWatcher({
    folder: () => {
      const root = readSettings(db).library.rootFolder
      return root === null ? null : join(root, INBOX_FOLDER_NAME)
    },
    watch: (folder, onChange, onEnd) => {
      const watcher = watchFolder(folder, (_event, name) =>
        onChange(typeof name === 'string' ? name : null)
      )
      watcher.on('error', () => {
        watcher.close()
        onEnd()
      })
      return () => watcher.close()
    },
    list: (folder) => readdir(folder),
    stamp: async (path) => {
      const stats = await lstat(path).catch(() => null)
      return stats?.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null
    },
    idle: () =>
      startupDone &&
      runs.progress() === null &&
      !runs.changingFiles() &&
      !scanner.isRunning() &&
      findPreviewBatch(db) === undefined &&
      // A full run takes its batches one after another; none of the Inbox comes between.
      !fullRunActive(),
    // The scan makes the files tracks; the run decides which of them it can take.
    process: createInboxBatches({
      scan: async () => (await scanner.scan()).ok,
      trackIdOf: (path) => {
        const trackId = findTrackIdByPath(db, path)
        // A download of an online recommendation is known by its file name (T-038).
        if (trackId !== undefined) noteInboxTrack(db, path, trackId)
        return trackId
      },
      start: (trackIds) => {
        const started = runs.start({ trackIds, stages: inboxStages(functions) })
        if (started.ok) {
          logger.info(`Inbox batch ${started.value.batchId} started for ${trackIds.length} tracks`)
        }
        return started.ok
      }
    })
  })
  // The page plays a track by its id; the main process looks the file up.
  protocol.handle(
    AUDIO_SCHEME,
    createAudioHandler({
      appOrigin: () => originOfRendererUrl(getRendererEntryUrl()),
      readToken: audioReadToken,
      pathOfTrack: (trackId) => {
        const track = getTrackById(db, trackId, cachedVolumes())
        return track && !track.offline && !track.fileMissing && !isSetAsidePath(track.path)
          ? track.path
          : null
      }
    })
  )
  const preview = createPreview({
    db,
    stages,
    orchestrator: runs,
    batchFiles,
    listMountedVolumes,
    covers: createCoverStore(coversFolder()),
    python: () => pythonBridge
  })
  registerPreviewIpc(preview)
  const fullRun = createFullRun({
    db,
    libraryTrackIds: () => listLibraryTracks(db, cachedVolumes()).map((track) => track.id),
    startBatch: (request) => runs.start(request),
    batchStatus: (batchId) => getBatch(db, batchId)?.status,
    discardBatch: (batchId) => preview.discard(batchId).ok,
    hasProposals: (batchId) =>
      listAllBatchItems(db, batchId).some(
        (item) => Object.keys(readProposal(item.after).fields ?? {}).length > 0
      ),
    cancelBatch: (batchId) => {
      if (runs.progress()?.batchId === batchId) runs.cancel()
    },
    previewBatchId: () => findPreviewBatch(db)?.id ?? null,
    runBusy: () => runs.progress() !== null || runs.changingFiles(),
    batchCounts: (batchId) => countBatchItems(db, batchId),
    computeStages: () => inboxStages(functions),
    hasEnergyModel: () => currentEnergyModel(db) !== null,
    wizardState: () => readWizardState(db),
    restartWizard: async () =>
      (await applyWizardAction({ db, environment }, { type: 'restart' })).ok,
    ready: () => startupDone
  })
  fullRunActive = () => fullRun.active()
  registerFullRunIpc(fullRun)
  fullRunTimer = setInterval(() => void fullRun.tick(), FULL_RUN_TICK_MS)

  // In this order, so that no two of them work on the drive at the same time: what
  // interrupted writes left behind is removed, the tracks of an interrupted batch are
  // told where their files are, then the library is scanned for what changed since
  // the last run, then a run that was interrupted goes on. Without a
  // chosen folder there is nothing to scan, and a drive that is not connected ends
  // the scan at once.
  void (async () => {
    try {
      // The scan reads tags through the sidecar, which a first start unpacks first.
      await pythonReady
      await batchFiles.removeTempFiles()
      if (readSettings(db).library.rootFolder !== null) {
        const result = await scanner.scan()
        if (result.ok) {
          const { found, added, updated, missing, unreadable } = result.value
          logger.info(
            `Startup scan: ${found} files, ${added} new, ${updated} changed, ${missing} missing, ${unreadable} unreadable`
          )
        } else {
          logger.warn(`Startup scan did not finish: ${result.code}`)
        }
      }
    } catch (error) {
      logger.error(`The startup work on the library stopped: ${describeError(error)}`)
    } finally {
      // Whatever happened above, the interrupted run is taken up and the app is usable.
      startupDone = true
      takeUpRun()
      inboxWatcher?.start()
    }
  })()
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'FixLibrary',
    backgroundColor: '#0b0b0d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only hand http(s) links to the OS; anything else could launch a local handler.
    if (/^https?:\/\//.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devServerUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const rendererFile = join(__dirname, '../renderer/index.html')
  setRendererEntry(devServerUrl ? { url: devServerUrl } : { filePath: rendererFile })

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(rendererFile)
  }
}

// The window shows the app's own page and nothing else. Without this, a file dropped
// on the window or a changed `location` would load another document, and the preload
// would hand that document the whole `window.api`.
app.on('web-contents-created', (_event, contents) => {
  const stayOnApp = (event: Electron.Event, url: string): void => {
    const appPage = getRendererEntryUrl()
    // A reload of the app's own page is the one navigation that is allowed.
    if (appPage === null || !isRendererUrl(url, appPage)) event.preventDefault()
  }
  contents.on('will-navigate', stayOnApp)
  contents.on('will-redirect', stayOnApp)
  contents.on('will-attach-webview', (event) => event.preventDefault())
  // No document of a frame: the page has none of its own, and one put in by anything
  // else must not run beside it.
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) event.preventDefault()
  })
})

// Two instances would share one database and could process the same library twice.
const isOnlyInstance = app.requestSingleInstanceLock()
if (!isOnlyInstance) app.quit()

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows()
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.focus()
})

// The token of this launch that lets the app's page read the samples it plays (T-033).
const audioReadToken = randomBytes(16).toString('hex')

// Before the app is ready, as Electron asks: the scheme the page plays tracks from, with
// byte ranges so the player can seek. It serves audio only (T-030).
protocol.registerSchemesAsPrivileged([
  // CORS for the app's own page only (the handler names it), so that the A/B player of
  // T-033 can read the audio through Web Audio; fetch stays refused (no supportFetchAPI,
  // and the CSP's connect-src).
  {
    scheme: AUDIO_SCHEME,
    privileges: { standard: true, secure: true, stream: true, corsEnabled: true }
  }
])

app.whenReady().then(() => {
  if (!isOnlyInstance) return

  // First of all, so that whatever goes wrong during startup is in the log file.
  startFileLogging(app.getPath('logs'), {
    mirrorToConsole: is.dev,
    onUncaughtException: stopAfterUncaughtException
  })
  logger.info(`FixLibrary ${app.getVersion()} starting`)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  if (!openAppDatabase()) {
    app.quit()
    return
  }
  registerAppIpc({ audioReadToken })
  registerPythonRuntimeIpc({
    state: () => runtimeState,
    retry: () => {
      if (runtimeState.status === 'failed') pythonReady = prepareRuntimeAndStart()
    }
  })
  registerSettingsAndSystemIpc()
  startPythonSidecar()
  registerLibraryAndPipeline()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Tells everything that runs to stop. Each step on its own: one that fails must not
 * keep the next from running.
 */
function tellWorkToStop(): void {
  try {
    // The running jobs are told to stop and put back in line, so the next start goes
    // on with the run. The orchestrator stays known until the file work has ended:
    // it is what keeps a scan from starting meanwhile.
    orchestrator?.shutdown()
  } catch (error) {
    logger.error('The run could not be put aside', error)
  }
  try {
    // No `claude` process outlives the app.
    claudeService?.stop()
  } catch (error) {
    logger.error('The call to Claude could not be stopped', error)
  }
  // It only aborts and sets a flag: nothing in it can throw.
  onlineRecs?.stop()
  if (fullRunTimer !== null) clearInterval(fullRunTimer)
  try {
    // A download stopped half way leaves only files of the app's own temp folder.
    downloads?.stopAll()
  } catch (error) {
    logger.error('The downloads could not be stopped', error)
  }
  inboxWatcher?.stop()
}

/** Everything that must end while the database is still open. */
async function stopBeforeQuit(): Promise<void> {
  tellWorkToStop()
  try {
    // A stage that was told to stop still finishes the file step it is in, and
    // writes down what it did: the database stays open until then.
    const ended =
      fileWork === null ||
      (await waitForFileWork(fileWork, QUIT_FILE_WORK_WAIT_MS, () =>
        logger.info('Quitting waits for the undo that is under way')
      ))
    if (!ended) logger.warn('Quitting while a stage is still working on a file')
  } catch (error) {
    logger.error('Waiting for the file work failed', error)
  }
  orchestrator = null
  try {
    // No Python process outlives the app.
    await pythonBridge?.stop()
  } catch (error) {
    logger.error('The sidecar could not be stopped', error)
  }
  pythonBridge = null
}

app.on('before-quit', (event) => {
  if (readyToQuit) return
  // Nothing to wait for: the app quits as it always did, at once.
  if (stopping === null && !pythonBridge && !fileWork?.busy()) {
    tellWorkToStop()
    orchestrator = null
    readyToQuit = true
    return
  }
  // Held until the work above has ended; a second request during the wait is held too.
  event.preventDefault()
  stopping ??= stopBeforeQuit().finally(() => {
    readyToQuit = true
    app.quit()
  })
})

app.on('will-quit', () => {
  closeDatabase()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
