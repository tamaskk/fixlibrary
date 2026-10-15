import {
  copyFileSync,
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
import { crc32, deflateSync } from 'zlib'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'

// Playwright runs from the repository root. The covers are made by the development
// Python environment.
const PYTHON = join(process.cwd(), 'python/.venv/bin/python')
const FIXTURE = join(process.cwd(), 'tests/fixtures/synthetic/sine.mp3')
const NAME = 'Bicep - Glue.mp3'

let folder: string
let userDataDir: string
let libraryFolder: string

/** A PNG of one colour, written byte by byte: no image library in the test. */
function writePng(path: string, size: number): void {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const check = Buffer.alloc(4)
    check.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, check])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)])
  const pixels = Buffer.concat(Array.from({ length: size }, () => row))
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0))
    ])
  )
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
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-cover-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  mkdirSync(userDataDir)
  mkdirSync(libraryFolder)
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('a track no service has a cover for gets a placeholder, and a picture the user chose replaces it', async () => {
  test.skip(!existsSync(PYTHON), 'needs python/.venv')
  copyFileSync(FIXTURE, join(libraryFolder, NAME))
  const picture = join(folder, 'chosen.png')
  writePng(picture, 400)
  const { app, page } = await launch()
  try {
    // No request of this test leaves the machine: every service has nothing.
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
    await bar.getByLabel('Funkció').selectOption('cover')
    await bar.getByRole('button', { name: 'Futtatás a teljes könyvtáron' }).click()
    await expect(page.getByText('A futás kész: 1 track feldolgozva.')).toBeVisible({
      timeout: 120_000
    })
    await page.getByRole('button', { name: 'Előnézet megnyitása' }).click()

    // Nothing was found anywhere: the row proposes a cover the app drew.
    const row = page.getByRole('grid', { name: 'Változások' }).getByRole('row', { name: NAME })
    const drawn = row.getByRole('gridcell', { name: /Új borító: Generált/ })
    await expect(drawn).toBeVisible()
    await expect(drawn.locator('img')).toHaveCount(1)

    // The user chooses a picture of their own for the row.
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    }, picture)
    await drawn.dblclick()
    await expect(page.getByText('A borító beállítva. Jóváhagyás után kerül a fájlba.')).toBeVisible(
      {
        timeout: 30_000
      }
    )
    const chosen = row.getByRole('gridcell', { name: /Új borító: Kézi/ })
    await expect(chosen).toBeVisible()
    // The thumbnail of the chosen picture takes the place of the placeholder's.
    await expect(chosen.locator('img')).toHaveCount(1)
    await expect(chosen.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/)

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

    // The file holds one front cover, a JPEG.
    const written = readFileSync(join(libraryFolder, NAME))
    const tag = written.subarray(0, written.indexOf('APIC') + 64)
    expect(tag.indexOf('APIC')).toBeGreaterThan(-1)
    expect(tag.includes(Buffer.from('image/jpeg\0', 'latin1'))).toBe(true)
  } finally {
    await app.close()
  }
})
