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

// Playwright runs from the repository root. The analysis, the conversion and the tag
// writing need the development Python environment and the tools of
// scripts/fetch-binaries.sh.
const PYTHON = join(process.cwd(), 'python/.venv/bin/python')
const FFMPEG = join(process.cwd(), 'resources/bin/ffmpeg')
const OLD_NAME = '01. Artist_-_Title (Official Video) [HD].wav'
const NEW_NAME = 'Artist - Title [8A Am - 124].aiff'

let folder: string
let userDataDir: string
let libraryFolder: string

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A kick on every beat over an A minor chord, as 16 bit mono WAV. */
function writeHouseLoop(path: string, bpm: number, seconds: number): void {
  const rate = 44_100
  const beat = 60 / bpm
  const samples = Buffer.alloc(rate * seconds * 2)
  for (let index = 0; index < rate * seconds; index += 1) {
    const time = index / rate
    const sinceBeat = time % beat
    const kick = Math.sin(2 * Math.PI * 55 * sinceBeat) * Math.exp(-sinceBeat * 18)
    const pad =
      [220, 261.63, 329.63].reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * time), 0) / 3
    samples.writeInt16LE(Math.round((0.6 * kick + 0.3 * pad) * 32767), index * 2)
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
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-tags-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(libraryFolder)
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

/** The text of an ID3v2.3 frame as it stands in a file: UTF-16 with its byte order mark. */
function utf16(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

test('every function at once: a WAV becomes a named AIFF with its tags written, and undo brings the WAV back', async () => {
  test.skip(!existsSync(PYTHON) || !existsSync(FFMPEG), 'needs python/.venv and resources/bin')
  writeHouseLoop(join(libraryFolder, OLD_NAME), 124, 30)
  const before = sha256(join(libraryFolder, OLD_NAME))
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
    await bar.getByLabel('Funkció').selectOption('all')
    await bar.getByRole('button', { name: 'Futtatás a teljes könyvtáron' }).click()
    await expect(page.getByText('A futás kész: 1 track feldolgozva.')).toBeVisible({
      timeout: 120_000
    })
    await page.getByRole('button', { name: 'Előnézet megnyitása' }).click()

    // The preview shows the name the file will have; nothing is written yet.
    const row = page.getByRole('grid', { name: 'Változások' }).getByRole('row', { name: OLD_NAME })
    await expect(row.getByText(NEW_NAME, { exact: true })).toBeVisible()
    expect(readdirSync(libraryFolder)).toEqual([OLD_NAME])

    await page
      .getByRole('region', { name: 'Jóváhagyás' })
      .getByRole('button', { name: 'Jóváhagyás' })
      .click()
    await page
      .getByRole('dialog', { name: 'Jóváhagyod a változásokat?' })
      .getByRole('button', { name: 'Jóváhagyás' })
      .click()
    await expect(page.getByText('A változások alkalmazva: 1 track.')).toBeVisible({
      timeout: 60_000
    })

    // One file: an AIFF under its new name, with an ID3v2.3 tag that holds the
    // names, the tempo and the key.
    expect(readdirSync(libraryFolder)).toEqual([NEW_NAME])
    const written = readFileSync(join(libraryFolder, NEW_NAME))
    const tag = written.subarray(written.indexOf('ID3\u0003'))
    expect(written.toString('latin1', 0, 4) + written.toString('latin1', 8, 12)).toBe('FORMAIFF')
    for (const [frame, text] of [
      ['TPE1', 'Artist'],
      ['TIT2', 'Title'],
      ['TBPM', '124'],
      ['TKEY', 'Am']
    ] as const) {
      const at = tag.indexOf(frame)
      expect(at, frame).toBeGreaterThan(-1)
      // The frame header is 10 bytes, then the encoding byte, then the text.
      expect(tag.subarray(at + 11, at + 11 + utf16(text).length), frame).toEqual(utf16(text))
    }
    // The Library page shows the track by what was written, without a new scan.
    const library = page.getByRole('grid', { name: 'Trackek' })
    const listed = library.locator(`[role="row"][title$="/${NEW_NAME}"]`)
    await expect(listed).toBeVisible()
    await expect(listed.getByText('Artist', { exact: true })).toBeVisible()
    await expect(listed.getByText('Title', { exact: true })).toBeVisible()

    // Undo puts the WAV back, byte for byte, under its old name.
    await page.getByRole('button', { name: 'Előnézet', exact: true }).click()
    await page.getByRole('button', { name: 'Utolsó batch visszavonása' }).click()
    await page
      .getByRole('dialog', { name: 'Visszavonod az utolsó batch-et?' })
      .getByRole('button', { name: 'Visszavonás' })
      .click()
    await expect(page.getByText(/Az utolsó batch visszavonva/)).toBeVisible({ timeout: 30_000 })
    expect(readdirSync(libraryFolder)).toEqual([OLD_NAME])
    expect(sha256(join(libraryFolder, OLD_NAME))).toBe(before)
  } finally {
    await app.close()
  }
})
