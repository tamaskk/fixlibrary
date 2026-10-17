import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'

let folder: string
let userDataDir: string

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  // IDE terminals (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env })
  const page = await app.firstWindow()
  // The smallest window the app supports.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 640))
  return { app, page }
}

/** Chooses a folder of the Rekordbox card by answering its dialog from the main process. */
async function chooseFolder(
  app: ElectronApplication,
  page: Page,
  label: string,
  picked: string
): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, picked)
  const rekordbox = page.getByRole('region', { name: 'Rekordbox' })
  await rekordbox.getByRole('button', { name: `${label} kiválasztása` }).click()
  await expect(rekordbox.getByTitle(picked, { exact: true })).toBeVisible()
}

test.beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-wizard-')))
  userDataDir = join(folder, 'profile')
  mkdirSync(userDataDir)
  mkdirSync(join(folder, 'Generated'))
  mkdirSync(join(folder, 'Exports'))
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('the wizard is walked through phase A and B, goes on where it was after a restart, passes a clean export and holds phase B without cues', async () => {
  const first = await launch()
  try {
    const { app, page } = first
    // Folders of the test, never the real ~/Documents.
    await page.getByRole('button', { name: 'Beállítások', exact: true }).click()
    await chooseFolder(app, page, 'Az app által írt XML mappája', join(folder, 'Generated'))
    await chooseFolder(app, page, 'A Rekordboxból exportált XML mappája', join(folder, 'Exports'))

    await page.getByRole('button', { name: 'Rekordbox', exact: true }).click()
    const done = page.getByRole('button', { name: 'Kész', exact: true })
    await expect(
      page.getByRole('heading', { name: 'A rekordbox xml nézet bekapcsolása' })
    ).toBeVisible()
    await done.click()
    await expect(page.getByText(join(folder, 'Generated', 'fixlibrary.xml'))).toBeVisible()
    await done.click()

    await expect(page.getByRole('heading', { name: 'Az XML megírása' })).toBeVisible()
    await expect(done).toBeDisabled()
    await page.getByRole('button', { name: 'XML írása', exact: true }).click()
    await expect(page.getByText('Az XML elkészült.')).toBeVisible()
    await done.click()
    await expect(
      page.getByRole('heading', { name: 'A rekordbox xml nézet frissítése' })
    ).toBeVisible()
  } finally {
    await first.app.close()
  }

  const second = await launch()
  try {
    const { page } = second
    await page.getByRole('button', { name: 'Rekordbox', exact: true }).click()
    // Where it was left, the setup no longer shown.
    await expect(
      page.getByRole('heading', { name: 'A rekordbox xml nézet frissítése' })
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Egyszeri beállítás' })).toHaveCount(0)
    const done = page.getByRole('button', { name: 'Kész', exact: true })
    for (const title of [
      'Trackek importja',
      'Playlistek importja',
      'Az elemzés megvárása',
      'A missing bejegyzések törlése',
      'A tagek frissítése',
      'A collection exportja'
    ]) {
      await done.click()
      await expect(page.getByRole('heading', { name: title })).toBeVisible()
    }
    await expect(page.getByText(join(folder, 'Exports'), { exact: true })).toBeVisible()
    await done.click()

    writeFileSync(
      join(folder, 'Exports', 'rekordbox.xml'),
      '<?xml version="1.0" encoding="UTF-8"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="0"/></DJ_PLAYLISTS>'
    )
    await page.getByRole('button', { name: 'Export ellenőrzése', exact: true }).click()

    // Phase B: the hot cues.
    await expect(
      page.getByRole('heading', { name: 'Az XML megírása a hot cue-kkal' })
    ).toBeVisible()
    await expect(done).toBeDisabled()
    // The check just read an XML: a write within two seconds of it is turned away.
    await expect(async () => {
      await page.getByRole('button', { name: 'XML írása', exact: true }).click()
      await expect(page.getByText('Az XML elkészült.')).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 10_000 })
    await done.click()
    await expect(page.getByRole('heading', { name: 'Hot cue-k importja' })).toBeVisible()
    await done.click()
    await expect(page.getByRole('heading', { name: 'A collection exportja' })).toBeVisible()
    await done.click()
    await expect(page.getByRole('heading', { name: 'A hot cue-k ellenőrzése' })).toBeVisible()
    // Exported after the export step was reached: an older export would not pass.
    writeFileSync(
      join(folder, 'Exports', 'rekordbox.xml'),
      '<?xml version="1.0" encoding="UTF-8"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="0"/></DJ_PLAYLISTS>'
    )
    // The XML was written moments ago: a check within two seconds of it is turned away.
    // The library is empty, so no hot cue was placed and the check cannot pass; a clean
    // check with cues is the unit tests' (rekordbox-wizard.test.ts).
    await expect(async () => {
      await page.getByRole('button', { name: 'Hot cue-k ellenőrzése', exact: true }).click()
      await expect(page.getByText('Még nincs elhelyezett hot cue.', { exact: false })).toBeVisible({
        timeout: 1000
      })
    }).toPass({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: 'A hot cue-k ellenőrzése' })).toBeVisible()
  } finally {
    await second.app.close()
  }
})
