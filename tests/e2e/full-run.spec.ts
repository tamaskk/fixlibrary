import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import Database from 'better-sqlite3'
import { ENERGY_ANALYZER_VERSION } from '../../src/shared/rpc'

// Playwright runs from the repository root.
const FIXTURE = join(process.cwd(), 'tests/fixtures/synthetic/sine.mp3')
const TRACK_COUNT = 4

let folder: string
let userDataDir: string
let libraryFolder: string

/** The app with the stand-in stages, which have no stems and no cues to make. */
async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  // IDE terminals (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  env.FIXLIB_DEMO_STAGES = '1'
  env.FIXLIB_DEMO_STAGE_MS = '1'
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
  await expect(page.getByRole('grid', { name: 'Trackek' })).toBeVisible({ timeout: 60_000 })
}

// A calibrated model, so that the run does not stop at the calibration.
function keepEnergyModel(): void {
  const db = new Database(join(userDataDir, 'fixlibrary.db'))
  try {
    const model = {
      model: {
        names: ['loudness'],
        means: [0],
        scales: [1],
        weights: [1],
        intercept: 5,
        looMae: 1
      },
      analyzerVersion: ENERGY_ANALYZER_VERSION,
      library: { low: 0, high: 10 },
      styles: {},
      ratedCount: 10,
      fittedAt: 0
    }
    db.prepare('insert or replace into settings (key, value, updated_at) values (?, ?, ?)').run(
      'energyModel',
      JSON.stringify(model),
      Date.now()
    )
  } finally {
    db.close()
  }
}

test.beforeEach(() => {
  // The app stores a folder as the file system names it, so the test uses that spelling too.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-full-run-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(libraryFolder)
  for (let number = 1; number <= TRACK_COUNT; number += 1) {
    const path = join(libraryFolder, `track-${number}.mp3`)
    copyFileSync(FIXTURE, path)
    appendFileSync(path, String(number))
  }
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('a full run computes, waits for the approval, applies, and goes on at Rekordbox after a restart', async () => {
  let { app, page } = await launch()
  await scanLibrary(app, page)
  await app.close()
  keepEnergyModel()

  ;({ app, page } = await launch())
  try {
    await page.getByRole('button', { name: 'Teljes futtatás' }).click()
    const dialog = page.getByRole('dialog', { name: 'Teljes futtatás' })
    await expect(dialog).toContainText('A teljes könyvtáron (4 track)')
    await dialog.getByRole('button', { name: 'Indítás' }).click()

    const panel = page.getByRole('region', { name: 'Teljes futtatás' })
    const steps = panel.getByRole('list', { name: 'A teljes futtatás lépései' })
    await expect(steps).toBeVisible()
    await expect(steps.getByText('Kalibráció')).toHaveCount(0)
    await expect(steps.locator('[aria-current="step"]')).toHaveText(/Előnézet/, { timeout: 30_000 })

    // The approval is the user's, on the preview page.
    await panel.getByRole('button', { name: 'Előnézet megnyitása' }).click()
    const actions = page.getByRole('region', { name: 'Jóváhagyás' })
    await actions.getByRole('button', { name: 'Jóváhagyás' }).click()
    await page
      .getByRole('dialog', { name: 'Jóváhagyod a változásokat?' })
      .getByRole('button', { name: 'Jóváhagyás' })
      .click()
    // The stand-in stages fail some tracks on purpose; the run goes on all the same.
    await expect(page.getByText(/A változások alkalmazva/)).toBeVisible({
      timeout: 30_000
    })

    await page
      .getByRole('navigation', { name: 'Oldalak' })
      .getByRole('button', { name: 'Könyvtár' })
      .click()
    await expect(steps.locator('[aria-current="step"]')).toHaveText(/Rekordbox A/, {
      timeout: 30_000
    })
    await expect(panel.getByRole('button', { name: 'Rekordbox varázsló' })).toBeVisible()
  } finally {
    await app.close()
  }

  // Closed at the Rekordbox step, it is there again after a restart.
  ;({ app, page } = await launch())
  try {
    const steps = page.getByRole('list', { name: 'A teljes futtatás lépései' })
    await expect(steps.locator('[aria-current="step"]')).toHaveText(/Rekordbox A/, {
      timeout: 30_000
    })
    await page.getByRole('button', { name: 'Leállítás' }).click()
    await expect(page.getByText('A teljes futást leállítottad.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Teljes futtatás' })).toBeEnabled()
  } finally {
    await app.close()
  }
})
