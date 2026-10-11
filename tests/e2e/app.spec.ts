import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import Database from 'better-sqlite3'

let userDataDir: string

// A private profile per test: the developer's own database is never touched.
function launchApp(): Promise<ElectronApplication> {
  // IDE terminals (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  return electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env })
}

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-'))
})

test.afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

test('app opens the Library page in a locked-down renderer', async () => {
  const app = await launchApp()
  try {
    const page = await app.firstWindow()

    await expect(page).toHaveTitle('FixLibrary')
    await expect(page.getByRole('heading', { name: 'Könyvtár' })).toBeVisible()

    const globals = await page.evaluate(() => {
      const scope = window as unknown as Record<string, unknown>
      return { require: typeof scope.require, api: typeof scope.api }
    })
    expect(globals).toEqual({ require: 'undefined', api: 'object' })
  } finally {
    await app.close()
  }
})

test('the window cannot be taken to another page', async () => {
  // Another local file is the case that matters: it is what a file dropped on the
  // window would load, and it needs no network.
  const otherPage = join(userDataDir, 'other.html')
  writeFileSync(otherPage, '<!doctype html><title>Other</title><h1>Other page</h1>')

  const app = await launchApp()
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Könyvtár' })).toBeVisible()

    // Playwright would wait for a navigation that never happens, so the window is
    // driven and asked from the main process.
    const state = await app.evaluate(async ({ BrowserWindow }, target) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      if (!contents) throw new Error('no window')
      // Resolves when the app has decided about the navigation, either way.
      const decided = new Promise<string>((resolve) => {
        contents.once('will-navigate', (event) =>
          setImmediate(() => resolve(event.defaultPrevented ? 'blocked' : 'allowed'))
        )
      })
      await contents.executeJavaScript(`window.location.href = ${JSON.stringify(target)}; null`)
      const decision = await decided
      await new Promise((resolve) => setTimeout(resolve, 300))
      return {
        decision,
        url: contents.getURL(),
        heading: (await contents.executeJavaScript(
          'document.querySelector("h1")?.textContent ?? null'
        )) as string | null,
        hasApi: (await contents.executeJavaScript('typeof window.api')) as string
      }
    }, pathToFileURL(otherPage).href)

    expect(state.decision).toBe('blocked')
    expect(state.url).toMatch(/renderer\/index\.html$/)
    expect(state.heading).toBe('Könyvtár')
    expect(state.hasApi).toBe('object')
  } finally {
    await app.close()
  }
})

test('first start creates the database, and a later start keeps its data', async () => {
  const databasePath = join(userDataDir, 'fixlibrary.db')

  const firstRun = await launchApp()
  try {
    await firstRun.firstWindow()
  } finally {
    await firstRun.close()
  }

  const afterFirstRun = new Database(databasePath)
  const tables = afterFirstRun
    .prepare(
      "select count(*) as count from sqlite_master where type = 'table' and name not like 'sqlite_%' and substr(name, 1, 2) != '__'"
    )
    .get() as { count: number }
  afterFirstRun
    .prepare('insert into settings (key, value, updated_at) values (?, ?, ?)')
    .run('e2e.marker', '"kept"', Date.now())
  afterFirstRun.close()
  expect(tables.count).toBe(14)

  const secondRun = await launchApp()
  try {
    await secondRun.firstWindow()
  } finally {
    await secondRun.close()
  }

  const afterSecondRun = new Database(databasePath, { readonly: true })
  const marker = afterSecondRun
    .prepare('select value from settings where key = ?')
    .get('e2e.marker')
  afterSecondRun.close()
  expect(marker).toEqual({ value: '"kept"' })
})
