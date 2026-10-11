import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'

// Not a real key: a made-up value that the test types in and then looks for on disk.
const FAKE_KEY = 'not-a-real-key-for-the-e2e-test'

let folder: string
let userDataDir: string
let libraryFolder: string

async function openSettings(): Promise<{ app: ElectronApplication; page: Page }> {
  // IDE terminals (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env })
  const page = await app.firstWindow()
  // The smallest window the app supports.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 640))
  await page.getByRole('button', { name: 'Beállítások', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Beállítások', level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Könyvtár' })).toBeVisible()
  return { app, page }
}

test.beforeEach(() => {
  // The app stores a folder as the file system names it, so the test uses that spelling too.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-settings-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(libraryFolder)
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('settings are saved, survive a restart, and the API key is never stored as plain text', async () => {
  const first = await openSettings()
  try {
    const { app, page } = first
    const library = page.getByRole('region', { name: 'Könyvtár' })
    const keys = page.getByRole('region', { name: 'API kulcsok' })
    const cues = page.getByRole('region', { name: 'Hot cue-k' })
    const styles = page.getByRole('region', { name: 'Stílusok' })

    // Defaults of a fresh installation.
    await expect(library.getByRole('switch', { name: 'Clean library mód' })).toBeChecked()
    await expect(page.getByLabel('Célszint')).toHaveValue('-11')
    await expect(page.getByLabel('Módszer')).toHaveValue('lossless')
    await expect(cues.getByLabel('A hot cue neve', { exact: true })).toHaveValue('Start')
    await expect(styles.getByRole('row')).toHaveCount(7)

    // The folder dialog belongs to the OS; answer it from the main process.
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    }, libraryFolder)
    await library.getByRole('button', { name: 'Könyvtármappa kiválasztása' }).click()
    await expect(library.getByTitle(libraryFolder, { exact: true })).toBeVisible()

    await library.getByRole('switch', { name: 'Clean library mód' }).click()
    await expect(library.getByRole('switch', { name: 'Clean library mód' })).not.toBeChecked()
    await expect(library.getByText('Elmentve')).toBeVisible()

    await page.getByLabel('Célszint').selectOption('-8')

    await keys.getByRole('textbox', { name: 'AcoustID API kulcs' }).fill(FAKE_KEY)
    await keys.getByRole('button', { name: 'AcoustID API kulcs mentése' }).click()
    await expect(keys.getByText('Tárolva a Keychainben')).toBeVisible()
    await expect(keys.getByRole('textbox', { name: 'AcoustID API kulcs' })).toHaveValue('')

    await cues.getByLabel('A hot cue neve', { exact: true }).fill('Intro')
    await cues.getByLabel('A hot cue neve', { exact: true }).press('Enter')
    await expect(cues.getByText('Elmentve')).toBeVisible()

    // The color control saves once a color is settled on.
    await cues.getByLabel('B hot cue színe').fill('#123456')
    await expect(cues.getByText('#123456')).toBeVisible()
    await expect(cues.getByText('Elmentve')).toBeVisible()

    await styles.getByRole('button', { name: 'Új stílus' }).click()
    await expect(styles.getByLabel('6. stílus neve')).toBeFocused()
    await styles.getByLabel('6. stílus neve').fill('Deep House')

    // Unsaved styles are not dropped silently when the user goes to another page.
    await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
    const guard = page.getByRole('dialog', { name: 'Nem mentett stílusok' })
    await expect(guard).toBeVisible()
    await guard.getByRole('button', { name: 'Maradok' }).click()
    await expect(styles.getByLabel('6. stílus neve')).toHaveValue('Deep House')

    await styles.getByRole('button', { name: 'Stílusok mentése' }).click()
    await expect(styles.getByText('Nem mentett változások')).toBeHidden()

    const system = page.getByRole('region', { name: 'Rendszer' })
    await expect(system.getByRole('listitem')).toHaveCount(4)

    await page.getByRole('heading', { name: 'Beállítások', level: 1 }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/settings-1024x640.png' })
    await page.getByRole('region', { name: 'API kulcsok' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/settings-1024x640-keys.png' })
    await page.getByRole('region', { name: 'Stílusok' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/settings-1024x640-styles.png' })
    await system.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/settings-1024x640-system.png' })
  } finally {
    await first.app.close()
  }

  // Every file the app wrote into its profile: the database, its write-ahead log,
  // and whatever Chromium keeps there.
  const files = readdirSync(userDataDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name)))
  const contains = (text: string, encoding: BufferEncoding): boolean =>
    files.some((content) => content.includes(Buffer.from(text, encoding)))
  expect(contains('secret.acoustid', 'utf8')).toBe(true)
  // As single-byte text and as the two-byte text Chromium uses in its own stores.
  expect(contains(FAKE_KEY, 'utf8')).toBe(false)
  expect(contains(FAKE_KEY, 'utf16le')).toBe(false)

  const second = await openSettings()
  try {
    const { page } = second
    const library = page.getByRole('region', { name: 'Könyvtár' })

    await expect(library.getByTitle(libraryFolder, { exact: true })).toBeVisible()
    await expect(library.getByRole('switch', { name: 'Clean library mód' })).not.toBeChecked()
    await expect(page.getByLabel('Célszint')).toHaveValue('-8')
    await expect(
      page.getByRole('region', { name: 'API kulcsok' }).getByText('Tárolva a Keychainben')
    ).toBeVisible()
    await expect(page.getByLabel('A hot cue neve', { exact: true })).toHaveValue('Intro')
    await expect(page.getByLabel('6. stílus neve')).toHaveValue('Deep House')
    await expect(page.getByLabel('B hot cue színe')).toHaveValue('#123456')
  } finally {
    await second.app.close()
  }
})
