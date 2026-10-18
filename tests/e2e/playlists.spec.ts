import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
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

// Playwright runs from the repository root.
const FIXTURE = join(process.cwd(), 'tests/fixtures/synthetic/sine.mp3')
const TRACK_COUNT = 6

let folder: string
let userDataDir: string
let libraryFolder: string

function trackName(number: number): string {
  return `track-${number}.mp3`
}

function launch(): Promise<ElectronApplication> {
  // IDE terminals (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  return electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env })
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
  await expect(page.getByRole('row', { name: trackName(TRACK_COUNT) })).toBeVisible()
}

// What the scan cannot know of a sine wave: the tempo and the key that the recommendations go by.
function giveTracksTempoAndKey(): void {
  const db = new Database(join(userDataDir, 'fixlibrary.db'))
  try {
    const set = db.prepare(
      'update tracks set bpm = ?, camelot_key = ?, artist = ?, title = ? where path like ?'
    )
    for (let number = 1; number <= TRACK_COUNT; number += 1) {
      // Track 6 fits the first three far better than track 5 does.
      const bpm = number === 5 ? 90 : 124
      const key = number === 5 ? '3B' : '8A'
      set.run(bpm, key, `Artist ${number}`, `Title ${number}`, `%/${trackName(number)}`)
    }
  } finally {
    db.close()
  }
}

test.beforeEach(() => {
  // The app stores a folder as the file system names it, so the test uses that spelling too.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-playlists-')))
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

test('a playlist is made, filled from the library, takes a recommendation and is reordered', async () => {
  let app = await launch()
  await scanLibrary(app, await app.firstWindow())
  await app.close()
  giveTracksTempoAndKey()

  app = await launch()
  try {
    const page = await app.firstWindow()
    // The smallest window the app supports.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 640))
    const nav = page.getByRole('navigation', { name: 'Oldalak' })

    // Create.
    await nav.getByRole('button', { name: 'Playlistek' }).click()
    await page.getByRole('button', { name: 'Új playlist' }).click()
    await page.getByLabel('Név').fill('Sunset set')
    await page.getByRole('button', { name: 'Létrehozás' }).click()
    await expect(page.getByRole('heading', { name: 'Sunset set' })).toBeVisible()

    // Add three tracks from the library.
    await nav.getByRole('button', { name: 'Könyvtár' }).click()
    await page.getByRole('row', { name: /Artist 1\b/ }).click()
    await page.getByRole('row', { name: /Artist 3\b/ }).click({ modifiers: ['Shift'] })
    await page.getByRole('button', { name: 'Hozzáadás a playlisthez' }).click()
    await expect(page.getByText('3 track hozzáadva: Sunset set.')).toBeVisible()

    // Take the recommendation that fits best.
    await nav.getByRole('button', { name: 'Playlistek' }).click()
    const tracks = page.getByRole('list').filter({ has: page.getByText('Artist 1 - Title 1') })
    await expect(tracks.getByRole('listitem')).toHaveCount(3)
    await page.getByRole('button', { name: 'Artist 6 - Title 6 hozzáadása a playlisthez' }).click()
    await expect(tracks.getByRole('listitem')).toHaveCount(4)

    // Move it to the top.
    for (let step = 0; step < 3; step += 1) {
      await page.getByRole('button', { name: 'Artist 6 - Title 6 mozgatása feljebb' }).click()
    }
    await expect(tracks.getByRole('listitem').first()).toContainText('Artist 6 - Title 6')
    await expect(
      page.getByRole('button', { name: 'Artist 6 - Title 6 mozgatása feljebb' })
    ).toBeDisabled()
  } finally {
    await app.close()
  }
})
