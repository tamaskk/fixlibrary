import { lstatSync, mkdirSync } from 'fs'
import { shell } from 'electron'
import { z } from 'zod'
import type { ToolChecker } from '../pipeline/system'
import { IPC_CHANNELS } from '@shared/ipc'
import { handleIpc } from './handle'

export interface SystemIpcDependencies {
  toolChecker: ToolChecker
  logFolder: string
}

export function registerSystemIpc({ toolChecker, logFolder }: SystemIpcDependencies): void {
  handleIpc(IPC_CHANNELS.systemCheckTools, z.tuple([z.boolean()]), (_event, force) =>
    toolChecker.check(force)
  )

  handleIpc(IPC_CHANNELS.systemOpenLogFolder, z.tuple([]), async () => {
    // The folder is a fixed place chosen by the main process, never a path from the renderer.
    mkdirSync(logFolder, { recursive: true })
    // Opening hands the path to the OS: it must be a real folder, not a link to something else.
    if (!lstatSync(logFolder).isDirectory()) throw new Error('The log folder is not a folder')
    const failure = await shell.openPath(logFolder)
    if (failure !== '') throw new Error('The log folder could not be opened')
  })
}
