import { lstatSync, mkdirSync } from 'fs'
import { BrowserWindow, dialog, shell } from 'electron'
import { z } from 'zod'
import type { AppDatabase } from '../db/connection'
import { testClaude, type Claude } from '../pipeline/claude'
import type { ToolChecker } from '../pipeline/system'
import type { ClaudeStatus, ClaudeTestResult } from '@shared/claude'
import type { Result } from '@shared/errors'
import { IPC_CHANNELS } from '@shared/ipc'
import { handleIpc } from './handle'
import { createRateGate } from './progress'

export interface SystemIpcDependencies {
  db: AppDatabase
  toolChecker: ToolChecker
  claude: Claude
  logFolder: string
}

const noArguments = z.tuple([])
// A test is a real call on the user's subscription: one in this time is all a person asks for.
const MIN_TEST_INTERVAL_MS = 30_000
// Choosing a command starts a login shell and the command itself.
const MIN_CHOICE_INTERVAL_MS = 2000
// Shown by the system dialog itself, so the user sees what the choice is for.
const CLAUDE_PROMPT = 'Válaszd ki a claude parancsot'

export function registerSystemIpc({
  db,
  toolChecker,
  claude,
  logFolder
}: SystemIpcDependencies): void {
  handleIpc(IPC_CHANNELS.systemCheckTools, z.tuple([z.boolean()]), (_event, force) =>
    toolChecker.check(force)
  )

  handleIpc(IPC_CHANNELS.systemOpenLogFolder, noArguments, async () => {
    // The folder is a fixed place chosen by the main process, never a path from the renderer.
    mkdirSync(logFolder, { recursive: true })
    // Opening hands the path to the OS: it must be a real folder, not a link to something else.
    if (!lstatSync(logFolder).isDirectory()) throw new Error('The log folder is not a folder')
    const failure = await shell.openPath(logFolder)
    if (failure !== '') throw new Error('The log folder could not be opened')
  })

  handleIpc(IPC_CHANNELS.systemClaudeStatus, z.tuple([z.boolean()]), (_event, force) =>
    claude.status(force)
  )

  let dialogOpen = false
  handleIpc(
    IPC_CHANNELS.systemPickClaude,
    noArguments,
    async (event): Promise<Result<ClaudeStatus> | null> => {
      // One dialog at a time: a page cannot queue them up.
      if (dialogOpen) return null
      dialogOpen = true
      try {
        // The path comes from this dialog only: a program to run is never accepted
        // from the renderer. What was picked is checked before it is used.
        const options: Electron.OpenDialogOptions = {
          title: CLAUDE_PROMPT,
          message: CLAUDE_PROMPT,
          buttonLabel: 'Kiválasztás',
          // It usually lives in a hidden folder of the home folder.
          // As picked, not what it points to: the command is usually a link.
          properties: ['openFile', 'showHiddenFiles', 'noResolveAliases']
        }
        const window = BrowserWindow.fromWebContents(event.sender)
        const picked = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options)
        const [path] = picked.filePaths
        if (picked.canceled || path === undefined) return null
        return await claude.choosePath(path)
      } finally {
        dialogOpen = false
      }
    }
  )

  const mayClear = createRateGate(MIN_CHOICE_INTERVAL_MS)
  handleIpc(IPC_CHANNELS.systemClearClaude, noArguments, async (): Promise<Result<ClaudeStatus>> =>
    mayClear() ? claude.choosePath(null) : { ok: true, value: await claude.status(false) }
  )

  const mayTest = createRateGate(MIN_TEST_INTERVAL_MS)
  let testing: Promise<ClaudeTestResult> | null = null
  handleIpc(IPC_CHANNELS.systemTestClaude, noArguments, (): Promise<ClaudeTestResult> => {
    if (testing) return testing
    if (!mayTest()) return Promise.resolve({ ok: false, reason: 'tooSoon' })
    testing = testClaude(db, claude).finally(() => {
      testing = null
    })
    return testing
  })
}
