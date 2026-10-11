import { app, shell, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { optimizer, is } from '@electron-toolkit/utils'
import { registerAppIpc } from './ipc/app'
import { createPythonBridge, type PythonBridge } from './services/python-bridge'

let pythonBridge: PythonBridge | null = null
let stoppingSidecar = false

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

app.whenReady().then(() => {
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
