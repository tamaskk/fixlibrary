import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

// Playwright runs from the repository root. The real stage needs the development
// Python environment and the tools of scripts/fetch-binaries.sh.
const PYTHON = join(process.cwd(), 'python/.venv/bin/python')
const FFMPEG = join(process.cwd(), 'resources/bin/ffmpeg')
const TRACK = 'loop.wav'

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
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-bpm-key-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(libraryFolder)
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('a track is analysed, its key is corrected in the preview, and both reach the library', async () => {
  test.skip(!existsSync(PYTHON) || !existsSync(FFMPEG), 'needs python/.venv and resources/bin')
  writeHouseLoop(join(libraryFolder, TRACK), 124, 30)
  const before = sha256(join(libraryFolder, TRACK))
  const { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'Beállítások megnyitása' }).click()
    const settings = page.getByRole('region', { name: 'Könyvtár' })
    // The folder dialog belongs to the OS; answer it from the main process.
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    }, libraryFolder)
    await settings.getByRole('button', { name: 'Könyvtármappa kiválasztása' }).click()
    await expect(settings.getByTitle(libraryFolder, { exact: true })).toBeVisible()
    await settings.getByRole('switch', { name: 'Clean library mód' }).click()
    // The tempo range is a setting, with the default of the spec.
    const analysis = page.getByRole('region', { name: 'Elemzés' })
    await expect(analysis.getByLabel('Legkisebb BPM')).toHaveValue('85')
    await expect(analysis.getByLabel('Legnagyobb BPM')).toHaveValue('175')

    await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
    await page.getByRole('button', { name: 'Könyvtár beolvasása' }).click()
    await expect(page.getByRole('grid', { name: 'Trackek' })).toBeVisible({ timeout: 120_000 })
    const bar = page.getByRole('region', { name: 'Futtatás' })
    await bar.getByLabel('Funkció').selectOption('bpmKey')
    await bar.getByRole('button', { name: 'Futtatás a teljes könyvtáron' }).click()
    await expect(page.getByText('A futás kész: 1 track feldolgozva.')).toBeVisible({
      timeout: 120_000
    })
    await page.getByRole('button', { name: 'Előnézet megnyitása' }).click()

    // The preview shows what was measured.
    const row = page.getByRole('grid', { name: 'Változások' }).getByRole('row', { name: TRACK })
    await expect(row.getByText('124', { exact: true })).toBeVisible()
    await expect(row.getByText('8A Am', { exact: true })).toBeVisible()

    // The key can be set by hand, and that is what is kept.
    await row.getByText('8A Am', { exact: true }).dblclick()
    await page.getByRole('combobox', { name: `${TRACK}: Key` }).selectOption('11B')
    await expect(row.getByText('11B A', { exact: true })).toBeVisible()

    await page
      .getByRole('region', { name: 'Jóváhagyás' })
      .getByRole('button', { name: 'Jóváhagyás' })
      .click()
    await page
      .getByRole('dialog', { name: 'Jóváhagyod a változásokat?' })
      .getByRole('button', { name: 'Jóváhagyás' })
      .click()
    await expect(page.getByText('A változások alkalmazva: 1 track.')).toBeVisible({
      timeout: 30_000
    })

    await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
    const track = page.getByRole('grid', { name: 'Trackek' }).getByRole('row', { name: TRACK })
    await expect(track.getByText('124,0', { exact: true })).toBeVisible()
    await expect(track.getByText('11B', { exact: true })).toBeVisible()
    // Analysis reads and the approval writes the track's row: the file is what it was.
    expect(sha256(join(libraryFolder, TRACK))).toBe(before)
  } finally {
    await app.close()
  }
})
