import { _electron as electron, expect, test } from '@playwright/test'

test('app opens the Library page in a locked-down renderer', async () => {
  // IDE terminals (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({ args: ['.'], env })
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
