import { app, dialog, shell, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { cpus, homedir } from 'os'
import { join } from 'path'
import { optimizer, is } from '@electron-toolkit/utils'
import { closeDatabase, getDatabase, initDatabase } from './db/connection'
import { registerAppIpc } from './ipc/app'
import { registerLibraryIpc, sendScanProgress } from './ipc/library'
import { getRendererEntryUrl, isRendererUrl, setRendererEntry } from './ipc/handle'
import { registerSettingsIpc } from './ipc/settings'
import { registerSystemIpc } from './ipc/system'
import { createLibraryScanner } from './pipeline/scanner'
import { createSecretStore, pickSecretEnv } from './pipeline/secrets'
import { ensureDefaultStyles, readSettings } from './pipeline/settings'
import { createToolChecker } from './pipeline/system'
import { resolveToolLocations } from './services/binaries'
import { readEnvFile } from './services/env-file'
import { keychainCipher } from './services/keychain'
import { logger, startFileLogging } from './services/logger'
import { createPythonBridge, type PythonBridge } from './services/python-bridge'
import { listMountedVolumes } from './services/volumes'
import { AppError } from '@shared/errors'
import { TAG_BATCH_TIMEOUT_MS } from '@shared/timeouts'

let pythonBridge: PythonBridge | null = null
let stoppingSidecar = false

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
  closeDatabase()
  if (relaunch) app.relaunch()
  // The sidecar ends by itself when its input closes.
  app.exit(1)
}

function registerSettingsAndSystemIpc(): void {
  const db = getDatabase()
  ensureDefaultStyles(db)

  const secrets = createSecretStore({
    db,
    cipher: keychainCipher,
    devEnv: readDevelopmentSecrets(),
    keyCheck: {
      userAgent: `FixLibrary/${app.getVersion()} (+https://github.com/tamaskk/fixlibrary)`
    }
  })
  registerSettingsIpc({
    db,
    secrets,
    environment: { homeDir: homedir(), cpuCount: cpus().length }
  })
  registerSystemIpc({
    toolChecker: createToolChecker(
      resolveToolLocations({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath
      })
    ),
    logFolder: app.getPath('logs')
  })
}

function startPythonSidecar(): void {
  // Development only: the packaged runtime and its path come with T-041.
  const pythonDir = join(app.getAppPath(), 'python')
  const pythonPath = join(pythonDir, '.venv/bin/python')
  if (app.isPackaged || !existsSync(pythonPath)) {
    logger.error('Python sidecar not started: no development environment in python/.venv')
    return
  }

  pythonBridge = createPythonBridge({ pythonPath, cwd: pythonDir, logDir: app.getPath('logs') })
  pythonBridge.start()
  pythonBridge
    .call('ping', {})
    .then(({ version }) => logger.info(`Python sidecar ready, fixlib_py ${version}`))
    .catch((error: unknown) => logger.error('Python sidecar did not answer ping', error))
}

function registerLibrary(): void {
  const db = getDatabase()
  const scanner = createLibraryScanner({
    db,
    environment: { homeDir: homedir(), cpuCount: cpus().length },
    listMountedVolumes,
    onProgress: sendScanProgress,
    readTags: async (paths) => {
      if (!pythonBridge) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
      const { files } = await pythonBridge.call(
        'tags.read',
        { paths },
        { timeoutMs: TAG_BATCH_TIMEOUT_MS }
      )
      return files
    }
  })
  registerLibraryIpc({ db, scanner })

  // Picks up what changed on the drive since the last run. Without a chosen folder
  // there is nothing to scan, and a drive that is not connected ends the scan at once.
  if (readSettings(db).library.rootFolder === null) return
  void scanner.scan().then((result) => {
    if (result.ok) {
      const { found, added, updated, missing, unreadable } = result.value
      logger.info(
        `Startup scan: ${found} files, ${added} new, ${updated} changed, ${missing} missing, ${unreadable} unreadable`
      )
    } else {
      logger.warn(`Startup scan did not finish: ${result.code}`)
    }
  })
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
  registerAppIpc()
  registerSettingsAndSystemIpc()
  startPythonSidecar()
  registerLibrary()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  if (!pythonBridge) return
  // Hold the quit until the sidecar is gone, so no Python process outlives the app.
  // A second quit request during the wait is held back too.
  event.preventDefault()
  if (stoppingSidecar) return
  stoppingSidecar = true
  void pythonBridge.stop().finally(() => {
    pythonBridge = null
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
