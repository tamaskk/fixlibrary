import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
  expect(tables.count).toBe(12)

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
