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

const ROOT = join(__dirname, '..', '..')
const PYTHON = join(ROOT, 'python', '.venv', 'bin', 'python')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg')

let folder: string
let userDataDir: string
let libraryFolder: string

/**
 * A steady tone and its octave, as 16 bit mono WAV: its level is the same in every part
 * of it, so a reading of A and one of B differ by the gain alone.
 */
function writeSteadyTone(path: string, seconds: number): void {
  const rate = 44_100
  const samples = Buffer.alloc(rate * seconds * 2)
  for (let index = 0; index < rate * seconds; index += 1) {
    const time = index / rate
    const value =
      0.4 * Math.sin(2 * Math.PI * 220 * time) + 0.2 * Math.sin(2 * Math.PI * 440 * time)
    samples.writeInt16LE(Math.round(value * 32767), index * 2)
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

test.beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-ab-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(libraryFolder)
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

/** The level the player reads, in dB: the mean of a few readings a third of a second apart. */
async function levelOf(page: Page): Promise<number> {
  const readings: number[] = []
  for (let index = 0; index < 4; index += 1) {
    await page.waitForTimeout(300)
    const text = await page.getByTestId('ab-level').textContent()
    readings.push(Number((text ?? '').replace(' dB', '').replace('−', '-').replace(',', '.')))
  }
  return readings.reduce((sum, value) => sum + value, 0) / readings.length
}

test('plays the original and the normalized version from one place, by the planned gain', async () => {
  test.skip(!existsSync(PYTHON) || !existsSync(FFMPEG), 'needs python/.venv and resources/bin')
  writeSteadyTone(join(libraryFolder, 'loop.wav'), 30)

  const { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'Beállítások megnyitása' }).click()
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    }, libraryFolder)
    const settings = page.getByRole('region', { name: 'Könyvtár' })
    await settings.getByRole('button', { name: 'Könyvtármappa kiválasztása' }).click()
    await expect(settings.getByTitle(libraryFolder, { exact: true })).toBeVisible()
    // A target below the loop, so that its gain lowers it: a raise would clip.
    const loudness = page.getByRole('region', { name: 'Hangosság' })
    await loudness.getByLabel('Célszint').selectOption({ label: 'Egyedi érték' })
    const custom = loudness.getByLabel('Egyedi célszint (LUFS)')
    await custom.fill('-20')
    await custom.press('Tab')
    await expect(loudness.getByText('Elmentve')).toBeVisible()
    await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
    await page.getByRole('button', { name: 'Könyvtár beolvasása' }).click()
    await expect(page.getByRole('grid', { name: 'Trackek' })).toBeVisible({ timeout: 60_000 })

    const bar = page.getByRole('region', { name: 'Futtatás' })
    await bar.getByLabel('Funkció').selectOption({ label: 'Hangerő-normalizálás' })
    await bar.getByRole('button', { name: 'Futtatás a teljes könyvtáron' }).click()
    await expect(page.getByText('A futás kész: 1 track feldolgozva.')).toBeVisible({
      timeout: 120_000
    })
    await page.getByRole('button', { name: 'Előnézet megnyitása' }).click()

    // The A/B cell of the row opens the player.
    const row = page
      .getByRole('grid', { name: 'Változások' })
      .getByRole('row', { name: 'loop.wav' })
    await row.getByText('A/B', { exact: true }).dblclick()
    const player = page.getByRole('dialog', { name: 'Meghallgatás' })
    await expect(player).toBeVisible()

    // The values are the row's own.
    const table = player.getByRole('table', { name: 'Mért értékek' })
    await expect(table.getByRole('row', { name: /Loudness \(LUFS\)/ })).toBeVisible()

    await expect(player.getByRole('button', { name: 'Lejátszás' })).toBeEnabled({ timeout: 10_000 })
    await player.getByRole('button', { name: 'Lejátszás' }).click()
    await expect(player.getByRole('button', { name: 'Szünet' })).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1500)
    const levelA = await levelOf(page)
    const placeA = await player.getByLabel('Hely').textContent()

    await page.keyboard.press('b')
    await expect(player.getByRole('button', { name: 'B: normalizált' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.waitForTimeout(1500)
    const levelB = await levelOf(page)
    const placeB = await player.getByLabel('Hely').textContent()

    // B is A by the planned gain (±0,5 dB), and the switch did not go back in time.
    const planned = await player
      .getByRole('row', { name: /Gain és különbség/ })
      .getByRole('cell')
      .last()
      .textContent()
    const gain = Number(
      (planned ?? '').split(' dB')[0]?.replace('−', '-').replace(',', '.').replace('+', '')
    )
    expect(Number.isFinite(levelA) && Number.isFinite(levelB)).toBe(true)
    expect(levelB - levelA).toBeGreaterThan(gain - 0.5)
    expect(levelB - levelA).toBeLessThan(gain + 0.5)
    expect((placeB ?? '') >= (placeA ?? '')).toBe(true)

    await page.keyboard.press('a')
    await expect(player.getByRole('button', { name: 'A: eredeti' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.keyboard.press('Escape')
    await expect(player).toBeHidden()
  } finally {
    await app.close()
  }
})
