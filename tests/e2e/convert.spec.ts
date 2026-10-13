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

// Playwright runs from the repository root. The conversion needs the development
// Python environment and the ffmpeg of scripts/fetch-binaries.sh.
const PYTHON = join(process.cwd(), 'python/.venv/bin/python')
const FFMPEG = join(process.cwd(), 'resources/bin/ffmpeg')
const WAV = 'Bicep - Glue.wav'
const AIFF = 'Bicep - Glue.aiff'

let folder: string
let userDataDir: string
let libraryFolder: string

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A tone of the given length as 16 bit mono WAV at 96 kHz, above what every player takes. */
function writeTone(path: string, hz: number, seconds: number): void {
  const rate = 96_000
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
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-convert-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(libraryFolder)
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

/** What the COMM chunk of an AIFF says: bits per sample, and the rate as its 10 bytes. */
function aiffFormat(path: string): { form: string; bits: number; rate: string } {
  const data = readFileSync(path)
  const comm = data.indexOf('COMM')
  return {
    form: data.toString('latin1', 0, 4) + data.toString('latin1', 8, 12),
    bits: data.readUInt16BE(comm + 14),
    rate: data.toString('hex', comm + 16, comm + 26)
  }
}

test('a 96 kHz WAV becomes a 48 kHz AIFF after approval, and undo brings the WAV back', async () => {
  test.skip(!existsSync(PYTHON) || !existsSync(FFMPEG), 'needs python/.venv and resources/bin')
  writeTone(join(libraryFolder, WAV), 220, 3)
  const before = sha256(join(libraryFolder, WAV))
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
    await expect(settings.getByRole('switch', { name: 'Clean library mód' })).not.toBeChecked()

    await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
    await page.getByRole('button', { name: 'Könyvtár beolvasása' }).click()
    await expect(page.getByRole('grid', { name: 'Trackek' })).toBeVisible({ timeout: 120_000 })
    const bar = page.getByRole('region', { name: 'Futtatás' })
    await bar.getByLabel('Funkció').selectOption('convert')
    await bar.getByRole('button', { name: 'Futtatás a teljes könyvtáron' }).click()
    await expect(page.getByText('A futás kész: 1 track feldolgozva.')).toBeVisible({
      timeout: 120_000
    })
    await page.getByRole('button', { name: 'Előnézet megnyitása' }).click()

    // The preview shows the name the file will have; nothing is written yet.
    const row = page.getByRole('grid', { name: 'Változások' }).getByRole('row', { name: WAV })
    await expect(row.getByText(AIFF, { exact: true })).toBeVisible()
    expect(readdirSync(libraryFolder)).toEqual([WAV])

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

    // The WAV is gone from the library, and an AIFF of 48 kHz and 16 bit stands there.
    expect(readdirSync(libraryFolder)).toEqual([AIFF])
    expect(aiffFormat(join(libraryFolder, AIFF))).toEqual({
      form: 'FORMAIFF',
      bits: 16,
      // 48000 as the 80 bit number an AIFF holds its rate in.
      rate: '400ebb80000000000000'
    })
    // The Library page shows the track under its new name without a new scan.
    const library = page.getByRole('grid', { name: 'Trackek' })
    await expect(library.getByText(AIFF, { exact: true })).toBeVisible()
    await expect(library).toHaveAttribute('aria-rowcount', '2')

    // Undo puts the WAV back, byte for byte.
    await page.getByRole('button', { name: 'Előnézet', exact: true }).click()
    await page.getByRole('button', { name: 'Utolsó batch visszavonása' }).click()
    await page
      .getByRole('dialog', { name: 'Visszavonod az utolsó batch-et?' })
      .getByRole('button', { name: 'Visszavonás' })
      .click()
    await expect(page.getByText(/Az utolsó batch visszavonva/)).toBeVisible({ timeout: 30_000 })
    expect(readdirSync(libraryFolder)).toEqual([WAV])
    expect(sha256(join(libraryFolder, WAV))).toBe(before)
  } finally {
    await app.close()
  }
})
