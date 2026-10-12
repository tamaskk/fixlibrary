import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'

// Playwright runs from the repository root. The scan needs the development Python
// environment, and the fingerprint the tools of scripts/fetch-binaries.sh.
const PYTHON = join(process.cwd(), 'python/.venv/bin/python')
const FFMPEG = join(process.cwd(), 'resources/bin/ffmpeg')
// Two copies of one track: the longer one is the one the app would keep.
const SHORTER = 'Artist - Title.wav'
const LONGER = 'Artist - Title (Original Mix).wav'
const OTHER = 'Artist - Another.wav'

let folder: string
let userDataDir: string
let libraryFolder: string

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A tone of the given length as 16 bit mono WAV. */
function writeTone(path: string, hz: number, seconds: number): void {
  const rate = 44_100
  const samples = Buffer.alloc(rate * seconds * 2)
  for (let index = 0; index < rate * seconds; index += 1) {
    samples.writeInt16LE(
      Math.round(0.5 * Math.sin((2 * Math.PI * hz * index) / rate) * 32767),
      index * 2
    )
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples.length, 40)
  writeFileSync(path, Buffer.concat([header, samples]))
}

/** Starts the app with its real stages, at the smallest window it supports. */
async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  // IDE terminals (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.FIXLIB_DEMO_STAGES
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 640))
  return { app, page }
}

test.beforeEach(() => {
  // The app stores a folder as the file system names it, so the test uses that spelling too.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-duplicates-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(libraryFolder)
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('two copies of a track are grouped, the chosen one stays, the other is set aside, and undo brings it back', async () => {
  test.skip(!existsSync(PYTHON) || !existsSync(FFMPEG), 'needs python/.venv and resources/bin')
  writeTone(join(libraryFolder, SHORTER), 220, 30)
  writeTone(join(libraryFolder, LONGER), 220, 31)
  writeTone(join(libraryFolder, OTHER), 330, 30)
  const hashes = [SHORTER, LONGER, OTHER].map((name) => sha256(join(libraryFolder, name)))
  const { app, page } = await launch()
  try {
    // No request of this test leaves the machine: the lookup services are answered
    // here, with "nothing found", whatever keys the developer has set.
    await app.evaluate(() => {
      globalThis.fetch = (async (input: unknown) => {
        const host = new URL(String(input)).hostname
        const body =
          host === 'api.acoustid.org'
            ? { status: 'ok', results: [] }
            : host === 'musicbrainz.org'
              ? { recordings: [] }
              : { results: [] }
        return new Response(JSON.stringify(body), { status: 200 })
      }) as typeof fetch
    })

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
    const bar = page.getByRole('region', { name: 'Futtatás' })
    // The search brings the lookup with it.
    await bar.getByLabel('Funkció').selectOption('duplicates')
    await bar.getByRole('button', { name: 'Futtatás a teljes könyvtáron' }).click()
    await expect(page.getByText('A futás kész: 3 track feldolgozva.')).toBeVisible({
      timeout: 120_000
    })
    await page.getByRole('button', { name: 'Előnézet megnyitása' }).click()

    // One group of the two copies; the longer one is proposed. Nothing is moved yet.
    await page.getByRole('tab', { name: /Duplikátumok/ }).click()
    const groups = page.getByRole('list', { name: 'Duplikátumcsoportok' })
    await expect(groups.getByRole('listitem')).toHaveCount(1)
    const choice = groups.getByRole('radiogroup', { name: 'Megtartandó példány: Artist – Title' })
    const shorter = choice.getByRole('radio', { name: /^Artist - Title\.wav/ })
    const longer = choice.getByRole('radio', { name: /^Artist - Title \(Original Mix\)\.wav/ })
    await expect(longer).toBeChecked()
    await expect(longer).toHaveAccessibleName(/javasolt/)
    expect(readdirSync(libraryFolder).sort()).toEqual([OTHER, LONGER, SHORTER].sort())

    // The user keeps the other copy.
    await shorter.click()
    await expect(shorter).toBeChecked()
    await expect(longer).not.toBeChecked()
    await expect(longer).toHaveAccessibleName(/_Duplicates mappába/)

    await page
      .getByRole('region', { name: 'Jóváhagyás' })
      .getByRole('button', { name: 'Jóváhagyás' })
      .click()
    const confirmation = page.getByRole('dialog', { name: 'Jóváhagyod a változásokat?' })
    // Said before anything moves, whether or not the tab was looked at.
    await expect(confirmation).toContainText('1 fájl a _Duplicates mappába kerül.')
    await confirmation.getByRole('button', { name: 'Jóváhagyás' }).click()
    await expect(page.getByText('A változások alkalmazva: 3 track.')).toBeVisible({
      timeout: 30_000
    })

    // The copy that was not kept is in _Duplicates with the bytes it had; no file is gone.
    expect(readdirSync(libraryFolder).sort()).toEqual([OTHER, SHORTER, '_Duplicates'].sort())
    expect(readdirSync(join(libraryFolder, '_Duplicates'))).toEqual([LONGER])
    expect(sha256(join(libraryFolder, '_Duplicates', LONGER))).toBe(hashes[1])
    expect(sha256(join(libraryFolder, SHORTER))).toBe(hashes[0])
    // And it is no track of the library any more, also after the folder is read again.
    const library = page.getByRole('grid', { name: 'Trackek' })
    await expect(library).toHaveAttribute('aria-rowcount', '3')
    // Asked of the app itself: the result says what the scan found and what it missed.
    const scan = await page.evaluate(() =>
      (
        window as unknown as { api: { library: { scan: () => Promise<unknown> } } }
      ).api.library.scan()
    )
    expect(scan).toMatchObject({ ok: true, value: { found: 2, added: 0, missing: 0 } })
    await page.getByRole('button', { name: 'Előnézet', exact: true }).click()
    await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
    await expect(library).toHaveAttribute('aria-rowcount', '3')
    await expect(library.getByText(LONGER, { exact: true })).toHaveCount(0)

    // Undo puts the copy back where it was.
    await page.getByRole('button', { name: 'Előnézet', exact: true }).click()
    await page.getByRole('button', { name: 'Utolsó batch visszavonása' }).click()
    await page
      .getByRole('dialog', { name: 'Visszavonod az utolsó batch-et?' })
      .getByRole('button', { name: 'Visszavonás' })
      .click()
    await expect(page.getByText(/Az utolsó batch visszavonva/)).toBeVisible({ timeout: 30_000 })
    expect(readdirSync(libraryFolder).sort()).toEqual([OTHER, LONGER, SHORTER].sort())
    expect([SHORTER, LONGER, OTHER].map((name) => sha256(join(libraryFolder, name)))).toEqual(
      hashes
    )
  } finally {
    await app.close()
  }
})
