import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  type Page
} from '@playwright/test'

// Playwright runs from the repository root.
const FIXTURE = join(process.cwd(), 'tests/fixtures/synthetic/sine.mp3')

let folder: string
let userDataDir: string
let libraryFolder: string
let inbox: string

/** The stand-in stages: they propose made-up names and rename the file on approval. */
async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  env.FIXLIB_DEMO_STAGES = '1'
  env.FIXLIB_DEMO_STAGE_MS = '1'
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 640))
  return { app, page }
}

/** Puts a file into the Inbox as a download or a copy by hand would. */
function dropIntoInbox(name: string): void {
  const path = join(inbox, name)
  copyFileSync(FIXTURE, path)
  appendFileSync(path, name)
}

async function approveInboxBatch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Könyvtár', exact: true }).click()
  await expect(page.getByText('Egy batch jóváhagyásra vár.')).toBeVisible({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Előnézet megnyitása' }).click()
  await expect(page.getByText(/Új trackek az Inboxból/)).toBeVisible()
  const actions = page.getByRole('region', { name: 'Jóváhagyás' })
  await actions.getByRole('button', { name: 'Jóváhagyás' }).click()
  const dialog = page.getByRole('dialog', { name: 'Jóváhagyod a változásokat?' })
  await expect(dialog).toContainText('Rekordbox varázsló A és B fázisa')
  await dialog.getByRole('button', { name: 'Jóváhagyás' }).click()
}

/** Waits until the stand-in has renamed the file away from its name in the Inbox. */
async function expectRenamed(name: string): Promise<void> {
  await expect.poll(() => readdirSync(inbox), { timeout: 60_000 }).not.toContain(name)
}

test.beforeEach(() => {
  // The app stores a folder as the file system names it, so the test uses that spelling too.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-inbox-')))
  userDataDir = join(folder, 'profile')
  libraryFolder = join(folder, 'Music')
  inbox = join(libraryFolder, 'Inbox')
  mkdirSync(userDataDir)
  mkdirSync(inbox, { recursive: true })
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('a file in the Inbox becomes a preview of its own, and a new one follows once it is approved', async () => {
  test.setTimeout(240_000)
  // The library is chosen first; the Inbox is watched from the next start on.
  let { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'Beállítások megnyitása' }).click()
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    }, libraryFolder)
    const settings = page.getByRole('region', { name: 'Könyvtár' })
    await settings.getByRole('button', { name: 'Könyvtármappa kiválasztása' }).click()
    await expect(settings.getByTitle(libraryFolder, { exact: true })).toBeVisible()
    await settings.getByRole('switch', { name: 'Clean library mód' }).click()
    await expect(settings.getByRole('switch', { name: 'Clean library mód' })).not.toBeChecked()
  } finally {
    await app.close()
  }

  dropIntoInbox('aaaaaaaaaaa.mp3')
  ;({ app, page } = await launch())
  try {
    await approveInboxBatch(page)
    // The stand-in renamed it; the real stages move it into its style folder.
    await expectRenamed('aaaaaaaaaaa.mp3')

    // While the app runs, a file copied in by hand is taken up too, once nothing waits.
    await expect(page.getByText('Egy batch jóváhagyásra vár.')).toBeHidden({ timeout: 60_000 })
    dropIntoInbox('copied by hand.mp3')
    await approveInboxBatch(page)
    await expectRenamed('copied by hand.mp3')
  } finally {
    await app.close()
  }
})
