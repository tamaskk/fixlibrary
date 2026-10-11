import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'

// Playwright runs from the repository root.
const FIXTURE = join(process.cwd(), 'tests/fixtures/synthetic/sine.mp3')
const TRACK_COUNT = 40

let folder: string
let userDataDir: string
let libraryFolder: string

function trackName(number: number): string {
  return `track-${String(number).padStart(3, '0')}.mp3`
}

/**
 * Starts the app with the two stand-in stages that only wait: no real stage exists
 * yet, and these touch no file. `stageMs` is how long each of them takes per track.
 */
async function launch(stageMs: number): Promise<{ app: ElectronApplication; page: Page }> {
  // IDE terminals (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  env.FIXLIB_DEMO_STAGES = '1'
  env.FIXLIB_DEMO_STAGE_MS = String(stageMs)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env })
  const page = await app.firstWindow()
  // The smallest window the app supports.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 640))
  return { app, page }
}

async function scanLibrary(app: ElectronApplication, page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Beállítások megnyitása' }).click()
  const settings = page.getByRole('region', { name: 'Könyvtár' })
  // The folder dialog belongs to the OS; answer it from the main process.
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
  }, libraryFolder)
  await settings.getByRole('button', { name: 'Könyvtármappa kiválasztása' }).click()
  await expect(settings.getByTitle(libraryFolder, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
  await page.getByRole('button', { name: 'Könyvtár beolvasása' }).click()
  await expect(page.getByRole('grid', { name: 'Trackek' })).toBeVisible()
}

function row(page: Page, number: number): Locator {
  return page.getByRole('row', { name: trackName(number) })
}

async function selectTwenty(page: Page): Promise<void> {
  await row(page, 1).click()
  // Twenty rows are not all in the page at 640px: Shift with the arrow keys reaches them.
  for (let step = 0; step < 19; step += 1) await page.keyboard.press('Shift+ArrowDown')
  await expect(page.getByText('20 track kijelölve')).toBeVisible()
}

test.beforeEach(() => {
  // The app stores a folder as the file system names it, so the test uses that spelling too.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-pipeline-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(libraryFolder)
  for (let number = 1; number <= TRACK_COUNT; number += 1) {
    copyFileSync(FIXTURE, join(libraryFolder, trackName(number)))
  }
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('a run on 20 selected tracks is started, paused, resumed and finishes', async () => {
  const { app, page } = await launch(400)
  try {
    await scanLibrary(app, page)
    const bar = page.getByRole('region', { name: 'Futtatás' })
    const panel = page.getByRole('region', { name: 'Futás állapota' })
    await expect(bar.getByLabel('Funkció')).toHaveValue('all')

    await selectTwenty(page)
    await bar.getByRole('button', { name: 'Futtatás a kijelölteken' }).click()

    // Exactly the 20 tracks: two stages each make 40 steps.
    await expect(panel.getByRole('heading', { name: 'Elemzés folyamatban' })).toBeVisible()
    await expect(panel.getByText(/\/ 40 · \d+%/)).toBeVisible()
    await expect(panel.getByRole('progressbar', { name: 'Elemzés' })).toBeVisible()
    // A second run cannot be started while this one is active.
    await expect(bar.getByRole('button', { name: 'Futtatás a kijelölteken' })).toBeDisabled()
    await expect(bar.getByRole('button', { name: 'Futtatás a teljes könyvtáron' })).toBeDisabled()

    await panel.getByRole('button', { name: 'Szünet' }).click()
    await expect(panel.getByRole('heading', { name: 'Elemzés szünetel' })).toBeVisible()
    // What was running finishes; after that nothing moves while the run is paused.
    await page.waitForTimeout(1000)
    const whilePaused = await panel.getByText(/\/ 40 · \d+%/).textContent()
    await page.waitForTimeout(1500)
    expect(await panel.getByText(/\/ 40 · \d+%/).textContent()).toBe(whilePaused)
    expect(whilePaused).not.toMatch(/^40 \//)

    await panel.getByRole('button', { name: 'Folytatás' }).click()
    await expect(panel.getByRole('heading', { name: 'Elemzés folyamatban' })).toBeVisible()

    await expect(page.getByText('A futás kész: 40 lépés lefutott.')).toBeVisible({
      timeout: 20_000
    })
    await expect(panel).toHaveCount(0)
    await expect(bar.getByRole('button', { name: 'Futtatás a kijelölteken' })).toBeEnabled()
  } finally {
    await app.close()
  }
})

test('a run on the whole library is cancelled after a confirmation', async () => {
  const { app, page } = await launch(1000)
  try {
    await scanLibrary(app, page)
    const bar = page.getByRole('region', { name: 'Futtatás' })
    const panel = page.getByRole('region', { name: 'Futás állapota' })

    await bar.getByLabel('Funkció').selectOption('demoAnalyze')
    await bar.getByRole('button', { name: 'Futtatás a teljes könyvtáron' }).click()
    await expect(panel.getByText(/\/ 40 · \d+%/)).toBeVisible()

    // Asking first, and "Mégsem" leaves the run alone.
    await panel.getByRole('button', { name: 'Megszakítás' }).click()
    const dialog = page.getByRole('dialog', { name: 'Megszakítod a futást?' })
    await dialog.getByRole('button', { name: 'Mégsem' }).click()
    await expect(panel).toBeVisible()

    await panel.getByRole('button', { name: 'Megszakítás' }).click()
    await dialog.getByRole('button', { name: 'Megszakítás' }).click()

    await expect(page.getByText('A futás megszakítva. A fájljaid nem változtak.')).toBeVisible()
    await expect(panel).toHaveCount(0)
    await expect(bar.getByRole('button', { name: 'Futtatás a teljes könyvtáron' })).toBeEnabled()
  } finally {
    await app.close()
  }
})

test('a run goes on after the app was closed and started again', async () => {
  test.setTimeout(90_000)
  const first = await launch(1000)
  try {
    await scanLibrary(first.app, first.page)
    const bar = first.page.getByRole('region', { name: 'Futtatás' })
    await bar.getByRole('button', { name: 'Futtatás a teljes könyvtáron' }).click()
    // Some steps are done before the app is closed.
    await expect(
      first.page.getByRole('region', { name: 'Futás állapota' }).getByText(/^[1-9]\d* \/ 80/)
    ).toBeVisible({ timeout: 15_000 })
  } finally {
    await first.app.close()
  }

  const second = await launch(1000)
  try {
    const panel = second.page.getByRole('region', { name: 'Futás állapota' })
    // The run is taken up by itself, with what was done still counted.
    await expect(panel.getByText(/^[1-9]\d* \/ 80/)).toBeVisible({ timeout: 15_000 })
    await expect(second.page.getByText('A futás kész: 80 lépés lefutott.')).toBeVisible({
      timeout: 45_000
    })
  } finally {
    await second.app.close()
  }
})
