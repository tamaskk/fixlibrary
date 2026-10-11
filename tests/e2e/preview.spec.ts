import { createHash } from 'crypto'
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync
} from 'fs'
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

let folder: string
let userDataDir: string
let libraryFolder: string

function trackName(number: number, digits = 3): string {
  return `track-${String(number).padStart(digits, '0')}.mp3`
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function addTracks(count: number, digits = 3): void {
  for (let number = 1; number <= count; number += 1) {
    const path = join(libraryFolder, trackName(number, digits))
    copyFileSync(FIXTURE, path)
    // Every file differs, so that two files that were mixed up would show.
    appendFileSync(path, trackName(number, digits))
  }
}

/**
 * Starts the app with the stand-in stages: no real stage exists yet. They propose a
 * made-up artist and title, and rename the file once the batch is approved.
 */
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

/** Chooses the library, sets the mode to "in place", scans, and computes a batch for every track. */
async function computeBatch(app: ElectronApplication, page: Page, count: number): Promise<void> {
  await page.getByRole('button', { name: 'Beállítások megnyitása' }).click()
  const settings = page.getByRole('region', { name: 'Könyvtár' })
  // The folder dialog belongs to the OS; answer it from the main process.
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
  }, libraryFolder)
  await settings.getByRole('button', { name: 'Könyvtármappa kiválasztása' }).click()
  await expect(settings.getByTitle(libraryFolder, { exact: true })).toBeVisible()
  await settings.getByRole('switch', { name: 'Clean library mód' }).click()
  await expect(settings.getByRole('switch', { name: 'Clean library mód' })).not.toBeChecked()

  await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
  await page.getByRole('button', { name: 'Könyvtár beolvasása' }).click()
  await expect(page.getByRole('grid', { name: 'Trackek' })).toBeVisible({ timeout: 120_000 })
  await page
    .getByRole('region', { name: 'Futtatás' })
    .getByRole('button', { name: 'Futtatás a teljes könyvtáron' })
    .click()
  await expect(page.getByText(/A futás kész: [\d\s]+ track feldolgozva\./)).toBeVisible({
    timeout: 120_000
  })
  await expect(page.getByText('Egy batch jóváhagyásra vár.')).toBeVisible()
  await page.getByRole('button', { name: 'Előnézet megnyitása' }).click()
  await expect(page.getByRole('grid', { name: 'Változások' })).toBeVisible()
  expect(count).toBeGreaterThan(0)
}

function row(page: Page, name: string): Locator {
  return page.getByRole('grid', { name: 'Változások' }).getByRole('row', { name })
}

test.beforeEach(() => {
  // The app stores a folder as the file system names it, so the test uses that spelling too.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-preview-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(libraryFolder)
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('a batch of 20 tracks is edited, filtered, approved without one row, and undone', async () => {
  addTracks(20)
  const untouched = sha256(join(libraryFolder, trackName(2)))
  const first001 = sha256(join(libraryFolder, trackName(1)))
  const { app, page } = await launch()
  try {
    await computeBatch(app, page, 20)
    const grid = page.getByRole('grid', { name: 'Változások' })
    const actions = page.getByRole('region', { name: 'Jóváhagyás' })
    await expect(actions.getByText('20 track alkalmazásra vár')).toBeVisible()
    // Nothing has been written: the files are named as they were.
    expect(readdirSync(libraryFolder).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => trackName(index + 1))
    )

    // Editing a title brings the proposed file name up to date at once.
    const first = row(page, trackName(1))
    await expect(first).toContainText('Demo Artist - track 001.mp3')
    await first.getByRole('gridcell').nth(4).dblclick()
    const field = page.getByRole('textbox', { name: `${trackName(1)}: Title` })
    await field.fill('By Hand')
    await field.press('Enter')
    await expect(first).toContainText('Demo Artist - By Hand.mp3')

    // With the keys: the cell stays where it was, Enter edits it, Escape gives up.
    await expect(grid).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('textbox', { name: `${trackName(2)}: Title` })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(grid).toBeFocused()
    // Space takes the row out of the batch.
    await page.keyboard.press('Space')
    await expect(
      row(page, trackName(2)).getByRole('checkbox', { name: `${trackName(2)} alkalmazása` })
    ).not.toBeChecked()
    await expect(actions.getByText('19 track alkalmazásra vár')).toBeVisible()
    await expect(actions.getByText('1 kizárva')).toBeVisible()

    // A click on a checkbox leaves the keys with the table, on that row.
    await row(page, trackName(3))
      .getByRole('checkbox', { name: `${trackName(3)} alkalmazása` })
      .click()
    await expect(grid).toBeFocused()
    await expect(actions.getByText('2 kizárva')).toBeVisible()
    await page.keyboard.press('Space')
    await expect(actions.getByText('1 kizárva')).toBeVisible()

    // Every fifth track was proposed with too little confidence.
    await page.getByLabel('Szűrő').selectOption('lowConfidence')
    await expect(page.getByText('4 / 20')).toBeVisible()
    await expect(grid.getByRole('row')).toHaveCount(5)
    await page.getByLabel('Szűrő').selectOption('errors')
    await expect(page.getByText('Nincs a szűrőnek megfelelő sor.')).toBeVisible()
    await page.getByRole('button', { name: 'Szűrők törlése' }).click()
    await expect(grid.getByRole('row').first()).toBeVisible()

    // Approving asks first, and says what it will do.
    await actions.getByRole('button', { name: 'Jóváhagyás' }).click()
    const dialog = page.getByRole('dialog', { name: 'Jóváhagyod a változásokat?' })
    await expect(dialog).toContainText('19 track fájljai változnak, 1 kimarad.')
    await expect(dialog).toContainText('Mód: helyben.')
    // Giving up returns the focus to where it came from.
    await page.keyboard.press('Escape')
    await expect(actions.getByRole('button', { name: 'Jóváhagyás' })).toBeFocused()
    await page.keyboard.press('Enter')
    await dialog.getByRole('button', { name: 'Jóváhagyás' }).click()
    await expect(page.getByText('A változások alkalmazva: 19 track.')).toBeVisible({
      timeout: 30_000
    })

    const written = readdirSync(libraryFolder)
    expect(written).toHaveLength(20)
    expect(written).toContain('Demo Artist - By Hand.mp3')
    // The row that was taken out: the same name and the same bytes.
    expect(sha256(join(libraryFolder, trackName(2)))).toBe(untouched)
    expect(written.filter((name) => name.startsWith('track-'))).toEqual([trackName(2)])

    // And all of it can be taken back.
    await page.getByRole('button', { name: 'Előnézet', exact: true }).click()
    await page.getByRole('button', { name: 'Utolsó batch visszavonása' }).click()
    await page
      .getByRole('dialog', { name: 'Visszavonod az utolsó batch-et?' })
      .getByRole('button', { name: 'Visszavonás' })
      .click()
    await expect(page.getByText(/Az utolsó batch visszavonva: 19 fájl visszaállítva/)).toBeVisible({
      timeout: 30_000
    })
    expect(readdirSync(libraryFolder).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => trackName(index + 1))
    )
    expect(sha256(join(libraryFolder, trackName(1)))).toBe(first001)
    expect(sha256(join(libraryFolder, trackName(2)))).toBe(untouched)
  } finally {
    await app.close()
  }
})

test('a batch that is given up changes no file', async () => {
  addTracks(3)
  const { app, page } = await launch()
  try {
    await computeBatch(app, page, 3)
    const actions = page.getByRole('region', { name: 'Jóváhagyás' })

    await actions.getByRole('button', { name: 'Elvetés' }).click()
    await page
      .getByRole('dialog', { name: 'Elveted a batch-et?' })
      .getByRole('button', { name: 'Elvetés' })
      .click()

    await expect(page.getByText('A batch elvetve. A fájljaid nem változtak.')).toBeVisible()
    await expect(page.getByText(/Nincs jóváhagyásra váró batch\./)).toBeVisible()
    expect(readdirSync(libraryFolder).sort()).toEqual([1, 2, 3].map((number) => trackName(number)))
  } finally {
    await app.close()
  }
})

test('a preview of 3000 rows keeps only the rows in view in the page, and jumps to its end at once', async () => {
  test.setTimeout(300_000)
  addTracks(3000, 4)
  const { app, page } = await launch()
  try {
    await computeBatch(app, page, 3000)
    const grid = page.getByRole('grid', { name: 'Változások' })
    await expect(page.getByText('3000 track alkalmazásra vár')).toBeVisible({ timeout: 30_000 })
    await expect(grid).toHaveAttribute('aria-rowcount', '3001')
    // The header is row 1, so the batch's rows are 2 to 3001.
    const rowAt = (index: number): Locator => grid.locator(`[role="row"][aria-rowindex="${index}"]`)

    // Far fewer rows than the batch has are in the page, wherever the table stands.
    await grid.focus()
    const started = Date.now()
    await page.keyboard.press('End')
    await expect(rowAt(3001)).toBeVisible()
    const jumpMs = Date.now() - started
    expect(await grid.getByRole('row').count()).toBeLessThan(60)
    expect(jumpMs).toBeLessThan(1000)

    // Scrolling by the wheel through a few hundred rows keeps up: the row that
    // should be in view is there right after the last step.
    await page.keyboard.press('Home')
    await expect(rowAt(2)).toBeVisible()
    await grid.hover()
    for (let step = 0; step < 40; step += 1) await page.mouse.wheel(0, 360)
    // 40 steps of 10 rows: the 401st row of the batch is the first one in view.
    await expect(rowAt(403)).toBeVisible({ timeout: 500 })
    expect(await grid.getByRole('row').count()).toBeLessThan(60)
  } finally {
    await app.close()
  }
})
