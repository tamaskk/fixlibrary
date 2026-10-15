import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron, expect, test } from '@playwright/test'
import { createFakeClaude } from '../../src/main/services/claude-cli.test-util'

let folder: string
let userDataDir: string

test.beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-e2e-claude-')))
  userDataDir = join(folder, 'profile')
  mkdirSync(userDataDir)
})

test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

test('a claude command chosen by hand is checked, tested, and given up again', async () => {
  // A stand-in for the command: the test never calls the real Claude.
  const fake = createFakeClaude(folder)
  fake.reply({
    answerEach: { primary: 'Unsorted', secondary: null, confidence: 50, isNewStyle: false }
  })
  // IDE terminals (VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env })
  try {
    const page = await app.firstWindow()
    // The smallest window the app supports.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1024, 640))
    await page.getByRole('button', { name: 'Beállítások', exact: true }).click()
    const claude = page.getByRole('region', { name: 'Claude' })
    await claude.scrollIntoViewIfNeeded()

    // Something that is not the command is refused, and nothing changes.
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/bin/ls'] })
    })
    await claude.getByRole('button', { name: 'claude kiválasztása' }).click()
    await expect(claude.getByText('Ez nem a claude parancs.')).toBeVisible()

    // The file dialog belongs to the OS; answer it from the main process.
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    }, fake.path)
    await claude.getByRole('button', { name: 'claude kiválasztása' }).click()
    await expect(claude.getByText('Rendben, verzió 2.1.296, bejelentkezve (max)')).toBeVisible()
    await expect(claude.getByText('A claude parancsot kézzel választottad ki.')).toBeVisible()

    // The library is empty, so the test asks about its two sample tracks.
    await claude.getByRole('button', { name: 'Teszt' }).click()
    await expect(claude.getByText(/A teszt sikerült: 2 trackből 2 kapott választ/)).toBeVisible({
      timeout: 15_000
    })
    const [call] = fake.calls()
    expect(call?.args).toContain('--strict-mcp-config')
    expect(call?.cwd.startsWith(join(userDataDir, 'claude-workdir'))).toBe(true)

    // Logged out: the page says so, with what to do, and the test cannot be started.
    fake.setLoggedIn(false)
    await page.waitForTimeout(5100)
    await claude.getByRole('button', { name: 'Claude újraellenőrzése' }).click()
    await expect(claude.getByText('Nincs bejelentkezve')).toBeVisible()
    await expect(claude.getByText(/claude auth login/)).toBeVisible()
    await expect(claude.getByRole('button', { name: 'Teszt' })).toBeDisabled()

    await claude.getByRole('button', { name: 'Automatikus keresés' }).click()
    await expect(claude.getByText('A claude parancsot kézzel választottad ki.')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
