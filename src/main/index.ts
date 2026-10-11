import { app, dialog, shell, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { optimizer, is } from '@electron-toolkit/utils'
import { closeDatabase, initDatabase } from './db/connection'
import { registerAppIpc } from './ipc/app'
import { createPythonBridge, type PythonBridge } from './services/python-bridge'

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
    console.error('The database could not be opened', error)
    // The file holds the undo records, so the user is told where it is and to keep it.
    dialog.showErrorBox(
      'Az adatbázis nem nyitható meg',
      `Az alkalmazás leáll. Ne töröld az adatbázist, mert a visszavonás adatai benne vannak.\n\n${databasePath}`
    )
    return false
  }
}

function startPythonSidecar(): void {
  // Development only: the packaged runtime and its path come with T-041.
  const pythonDir = join(app.getAppPath(), 'python')
  const pythonPath = join(pythonDir, '.venv/bin/python')
  if (app.isPackaged || !existsSync(pythonPath)) {
    console.error('Python sidecar not started: no development environment in python/.venv')
    return
  }

  pythonBridge = createPythonBridge({ pythonPath, cwd: pythonDir, logDir: app.getPath('logs') })
  pythonBridge.start()
  pythonBridge
    .call('ping', {})
    .then(({ version }) => console.info(`Python sidecar ready, fixlib_py ${version}`))
    .catch((error: unknown) => console.error('Python sidecar did not answer ping', error))
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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

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

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  if (!openAppDatabase()) {
    app.quit()
    return
  }
  registerAppIpc()
  startPythonSidecar()
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
