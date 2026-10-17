import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
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

const ROOT = join(__dirname, '..', '..')
const PYTHON = join(ROOT, 'python', '.venv', 'bin', 'python')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg')

let folder: string
let userDataDir: string
let libraryFolder: string

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

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.FIXLIB_DEMO_STAGES
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 640))
  return { app, page }
}

/** The hot cues of the one track, and its locked fields, as the database has them. */
function stored(): { cues: { slot: number; positionMs: number }[]; locked: string[] } {
  const db = new Database(join(userDataDir, 'fixlibrary.db'), { readonly: true })
  try {
    const cues = db
      .prepare('select slot, position_ms as positionMs from cues order by slot')
      .all() as { slot: number; positionMs: number }[]
    const row = db.prepare('select locked_fields as locked from tracks').get() as {
      locked: string
    }
    return { cues, locked: JSON.parse(row.locked) as string[] }
  } finally {
    db.close()
  }
}

test.beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-cues-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(libraryFolder)
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('places, moves and deletes hot cues on the waveform, each on the grid, and saves them at once', async () => {
  test.skip(!existsSync(PYTHON) || !existsSync(FFMPEG), 'needs python/.venv and resources/bin')
  writeHouseLoop(join(libraryFolder, 'loop.wav'), 120, 30)

  // A first start: the library is scanned.
  const first = await launch()
  try {
    const { app, page } = first
    await page.getByRole('button', { name: 'Beállítások megnyitása' }).click()
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    }, libraryFolder)
    const settings = page.getByRole('region', { name: 'Könyvtár' })
    await settings.getByRole('button', { name: 'Könyvtármappa kiválasztása' }).click()
    await expect(settings.getByTitle(libraryFolder, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
    await page.getByRole('button', { name: 'Könyvtár beolvasása' }).click()
    await expect(page.getByRole('grid', { name: 'Trackek' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('loop.wav')).toBeVisible()
  } finally {
    await first.app.close()
  }

  // Rekordbox's grid, as the wizard reads it from an export: 120 BPM from the start.
  const db = new Database(join(userDataDir, 'fixlibrary.db'))
  const { id } = db.prepare('select id from tracks').get() as { id: number }
  db.prepare(
    'insert into analyses (track_id, type, result, analyzer_version, created_at) values (?, ?, ?, ?, ?)'
  ).run(
    id,
    'rb_grid',
    JSON.stringify({
      tempos: [{ inizio: 0, bpm: 120, metro: '4/4', battito: 1 }],
      exportedAt: 1,
      readAt: 2
    }),
    'rekordbox-xml',
    Date.now()
  )
  db.close()

  const second = await launch()
  try {
    const { page } = second
    await page.getByRole('button', { name: 'Cue-k', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'loop.wav' })).toBeVisible()
    const waveform = page.getByRole('application', { name: 'Waveform' })
    await expect(waveform.locator('canvas').first()).toBeVisible({ timeout: 60_000 })

    // An empty slot: its button, then a click on the waveform.
    await page.getByRole('button', { name: '+ A' }).click()
    const box = await waveform.boundingBox()
    if (!box) throw new Error('no waveform')
    await page.mouse.click(box.x + 93, box.y + box.height / 2)
    await expect(page.getByRole('button', { name: /^A Start/ })).toBeVisible()
    const placed = stored()
    expect(placed.cues).toHaveLength(1)
    expect(placed.cues[0]?.positionMs % 500).toBe(0)
    expect(placed.locked).toEqual(['cue:1'])

    // Dragged with Shift held, it lands on the start of a bar.
    const marker = waveform.locator('[data-slot="1"]')
    const at = await marker.boundingBox()
    if (!at) throw new Error('no marker')
    await page.keyboard.down('Shift')
    await page.mouse.move(at.x + 4, at.y + at.height / 2)
    await page.mouse.down()
    await page.mouse.move(at.x + 120, at.y + at.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await expect
      .poll(() => stored().cues[0]?.positionMs, { timeout: 5000 })
      .not.toBe(placed.cues[0]?.positionMs)
    expect((stored().cues[0]?.positionMs ?? 1) % 2000).toBe(0)

    // The arrow keys move the chosen cue on the waveform by a bar with Shift.
    const before = stored().cues[0]?.positionMs ?? 0
    await page.getByRole('button', { name: /^A Start/ }).click()
    await waveform.focus()
    await page.keyboard.press('Shift+ArrowRight')
    await expect.poll(() => stored().cues[0]?.positionMs, { timeout: 5000 }).toBe(before + 2000)

    // A click on its marker plays from its place; Backspace deletes it, the slot stays
    // empty, and the delete can be taken back.
    await waveform.locator('[data-slot="1"]').click()
    await expect(page.getByRole('button', { name: 'Szünet' })).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Space')
    await page.keyboard.press('Backspace')
    await expect(page.getByRole('button', { name: /^\+ A, kézzel ürítve/ })).toBeVisible()
    expect(stored()).toEqual({ cues: [], locked: ['cue:1'] })
    await page.getByRole('button', { name: 'A visszavonása' }).click()
    await expect(page.getByRole('button', { name: /^A Start/ })).toBeVisible()
    expect(stored().cues).toEqual([{ slot: 1, positionMs: before + 2000 }])

    // The track list is one stop for Tab; the arrows go through it.
    const listbox = page.getByRole('listbox', { name: 'Trackek' })
    await listbox.focus()
    await page.keyboard.press('End')
    await expect(listbox.getByRole('option', { selected: true })).toHaveText(/loop\.wav/)

    // A waveform made once comes from the cache: within a second.
    await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
    await page.getByRole('button', { name: 'Cue-k', exact: true }).click()
    await expect(waveform.locator('canvas').first()).toBeVisible({ timeout: 1000 })
  } finally {
    await second.app.close()
  }
})
