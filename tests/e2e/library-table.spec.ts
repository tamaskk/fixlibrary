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
const TRACK_COUNT = 300

let folder: string
let userDataDir: string
let libraryFolder: string

function trackName(number: number): string {
  return `track-${String(number).padStart(3, '0')}.mp3`
}

async function openScannedLibrary(): Promise<{ app: ElectronApplication; page: Page }> {
  // IDE terminals (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env })
  const page = await app.firstWindow()
  // The smallest window the app supports.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 640))

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
  return { app, page }
}

function row(page: Page, number: number): Locator {
  return page.getByRole('row', { name: trackName(number) })
}

test.beforeEach(() => {
  // The app stores a folder as the file system names it, so the test uses that spelling too.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-table-')))
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

test('tracks are selected with click, Shift, Cmd and Cmd+A', async () => {
  const { app, page } = await openScannedLibrary()
  try {
    const grid = page.getByRole('grid', { name: 'Trackek' })
    const run = page.getByRole('region', { name: 'Futtatás' })

    // Only the rows near the visible part exist in the page.
    await expect(grid).toHaveAttribute('aria-rowcount', String(TRACK_COUNT + 1))
    expect(await grid.getByRole('row').count()).toBeLessThan(60)
    await expect(run.getByText('Nincs kijelölt track')).toBeVisible()
    await expect(run.getByRole('button', { name: 'Futtatás a kijelölteken' })).toBeDisabled()

    // A click and a Shift click select the range between them.
    await row(page, 3).click()
    await expect(run.getByText('1 track kijelölve')).toBeVisible()
    await row(page, 12).click({ modifiers: ['Shift'] })
    await expect(run.getByText('10 track kijelölve')).toBeVisible()

    // Cmd adds and removes single rows.
    await row(page, 5).click({ modifiers: ['Meta'] })
    await expect(run.getByText('9 track kijelölve')).toBeVisible()
    await expect(row(page, 5)).toHaveAttribute('aria-selected', 'false')
    for (const number of [1, 2, 5, 13, 14, 15, 16, 17, 18, 19, 20]) {
      await row(page, number).click({ modifiers: ['Meta'] })
    }
    await expect(run.getByText('20 track kijelölve')).toBeVisible()
    await expect(row(page, 20)).toHaveAttribute('aria-selected', 'true')
    await expect(row(page, 21)).toHaveAttribute('aria-selected', 'false')

    // With a selection a run can be started on it; the run itself is covered by
    // pipeline.spec.ts and bpm-key.spec.ts.
    await expect(run.getByLabel('Funkció')).toBeEnabled()
    await expect(run.getByLabel('Funkció').getByRole('option')).toHaveText([
      'Minden funkció',
      'Online lookup',
      'BPM és key elemzés',
      'Fájlnév és névtisztítás'
    ])
    await expect(run.getByRole('button', { name: 'Futtatás a kijelölteken' })).toBeEnabled()
    await expect(run.getByRole('button', { name: 'Futtatás a teljes könyvtáron' })).toBeEnabled()

    // Cmd+A selects every row of the table, also the ones that are not in the page.
    await grid.focus()
    await page.keyboard.press('Meta+a')
    await expect(run.getByText(`${TRACK_COUNT} track kijelölve`)).toBeVisible()

    // The arrow keys move through the rows; Shift extends the selection.
    // Home also brings the first rows back into the page: the table had scrolled on.
    await page.keyboard.press('Home')
    await expect(row(page, 1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await expect(run.getByText('2 track kijelölve')).toBeVisible()
    await expect(row(page, 2)).toHaveAttribute('aria-selected', 'true')
    await expect(row(page, 3)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')
    await expect(run.getByText('Nincs kijelölt track')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the table is searched, filtered and sorted, and Cmd+A then selects what is shown', async () => {
  const { app, page } = await openScannedLibrary()
  try {
    const grid = page.getByRole('grid', { name: 'Trackek' })
    const run = page.getByRole('region', { name: 'Futtatás' })

    await page.getByLabel('Keresés').fill('TRACK-01')
    await expect(page.getByText('10 / 300')).toBeVisible()
    await expect(grid.getByRole('row')).toHaveCount(11)

    await grid.focus()
    await page.keyboard.press('Meta+a')
    await expect(run.getByText('10 track kijelölve')).toBeVisible()

    // Sorting by title turns the order around on the second click.
    const title = grid.getByRole('columnheader', { name: 'Title' })
    await title.getByRole('button').click()
    await expect(title).toHaveAttribute('aria-sort', 'ascending')
    await title.getByRole('button').click()
    await expect(title).toHaveAttribute('aria-sort', 'descending')
    await expect(grid.getByRole('row').nth(1)).toContainText(trackName(19))

    // At the smallest window the format column gives its room to the title; a wider
    // window shows it.
    await expect(grid.getByRole('columnheader', { name: 'Formátum' })).toHaveCount(0)
    await expect(grid).toHaveAttribute('aria-colcount', '8')
    expect(await grid.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800))
    await expect(grid.getByRole('columnheader', { name: 'Formátum' })).toBeVisible()
    await expect(grid).toHaveAttribute('aria-colcount', '9')
    expect(await grid.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

    // Nothing matches: the table gives way to a line that says so.
    await page.getByLabel('Állapot').selectOption('offline')
    await expect(page.getByText('Nincs a keresésnek és a szűrőknek megfelelő track.')).toBeVisible()
    await page.getByRole('button', { name: 'Szűrők törlése' }).click()
    await expect(grid).toHaveAttribute('aria-rowcount', String(TRACK_COUNT + 1))
  } finally {
    await app.close()
  }
})
