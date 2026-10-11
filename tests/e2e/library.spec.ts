import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'

// Playwright runs from the repository root.
const FIXTURES = join(process.cwd(), 'tests/fixtures/synthetic')

let folder: string
let userDataDir: string
let libraryFolder: string

async function openApp(): Promise<{ app: ElectronApplication; page: Page }> {
  // IDE terminals (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env })
  const page = await app.firstWindow()
  // The smallest window the app supports.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 640))
  await expect(page.getByRole('heading', { name: 'Könyvtár', level: 1 })).toBeVisible()
  return { app, page }
}

test.beforeEach(() => {
  // The app stores a folder as the file system names it, so the test uses that spelling too.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-library-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(join(libraryFolder, 'House'), { recursive: true })
  mkdirSync(join(libraryFolder, '.Trashes'))
  copyFileSync(join(FIXTURES, 'sine.mp3'), join(libraryFolder, 'a.mp3'))
  copyFileSync(join(FIXTURES, 'sine.wav'), join(libraryFolder, 'House', 'b.wav'))
  copyFileSync(join(FIXTURES, 'sine.aiff'), join(libraryFolder, 'House', 'c.aiff'))
  // What a Mac leaves on an external drive, and what must never be listed.
  writeFileSync(join(libraryFolder, '._a.mp3'), 'AppleDouble')
  copyFileSync(join(FIXTURES, 'sine.mp3'), join(libraryFolder, '.Trashes', 'deleted.mp3'))
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('the library is scanned, rescanned for changes, and scanned again at the next start', async () => {
  const first = await openApp()
  try {
    const { app, page } = first

    // Nothing can be scanned before a folder is chosen; the page leads to Settings.
    await expect(page.getByText('Még nincs könyvtár mappa kiválasztva.')).toBeVisible()
    await page.getByRole('button', { name: 'Beállítások megnyitása' }).click()
    const settings = page.getByRole('region', { name: 'Könyvtár' })
    await expect(settings).toBeVisible()

    // The folder dialog belongs to the OS; answer it from the main process.
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    }, libraryFolder)
    await settings.getByRole('button', { name: 'Könyvtármappa kiválasztása' }).click()
    await expect(settings.getByTitle(libraryFolder, { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
    await expect(page.getByText('Még nincs beolvasott track.')).toBeVisible()
    await page.getByRole('button', { name: 'Könyvtár beolvasása' }).click()

    // Three audio files; the AppleDouble file and the trash folder are left out.
    await expect(page.getByText('3 track', { exact: true })).toBeVisible()
    await expect(page.getByText('Beolvasás kész: 3 új, 0 módosult, 0 változatlan.')).toBeVisible()

    copyFileSync(join(FIXTURES, 'sine.mp3'), join(libraryFolder, 'House', 'd.mp3'))
    rmSync(join(libraryFolder, 'a.mp3'))
    await page.getByRole('button', { name: 'Újraolvasás' }).click()

    await expect(page.getByText('Beolvasás kész: 1 új, 0 módosult, 2 változatlan.')).toBeVisible()
    await expect(page.getByText('1 track fájlja nincs a mappában.')).toBeVisible()
    await expect(page.getByText('4 track', { exact: true })).toBeVisible()
  } finally {
    await first.app.close()
  }

  copyFileSync(join(FIXTURES, 'sine.wav'), join(libraryFolder, 'e.wav'))

  // The app scans by itself when it starts; the page shows that scan's result.
  const second = await openApp()
  try {
    await expect(second.page.getByText('5 track', { exact: true })).toBeVisible()
  } finally {
    await second.app.close()
  }
})

test('a library folder that is gone is reported, and the tracks stay', async () => {
  const first = await openApp()
  try {
    const { app, page } = first
    await page.getByRole('button', { name: 'Beállítások megnyitása' }).click()
    const settings = page.getByRole('region', { name: 'Könyvtár' })
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    }, libraryFolder)
    await settings.getByRole('button', { name: 'Könyvtármappa kiválasztása' }).click()
    await expect(settings.getByTitle(libraryFolder, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
    await page.getByRole('button', { name: 'Könyvtár beolvasása' }).click()
    await expect(page.getByText('3 track', { exact: true })).toBeVisible()

    rmSync(libraryFolder, { recursive: true })
    await page.getByRole('button', { name: 'Újraolvasás' }).click()

    await expect(page.getByRole('alert')).toContainText('A könyvtár mappája nem érhető el.')
    await expect(page.getByText('3 track', { exact: true })).toBeVisible()
  } finally {
    await first.app.close()
  }
})
