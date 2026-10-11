import { BrowserWindow } from 'electron'
import { z } from 'zod'
import type { AppDatabase } from '../db/connection'
import { countTracks } from '../db/tracks'
import type { LibraryScanner } from '../pipeline/scanner'
import { readSettings } from '../pipeline/settings'
import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc'
import type { LibraryStatus, ScanProgress } from '@shared/library'
import { handleIpc } from './handle'
import { createProgressThrottle } from './progress'

const noArguments = z.tuple([])

export interface LibraryIpcDependencies {
  db: AppDatabase
  scanner: LibraryScanner
}

/** Tells the app's window how far a scan is, whoever started the scan. */
export const sendScanProgress = createProgressThrottle<ScanProgress>((progress) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.libraryScanProgress, progress)
  }
})

export function registerLibraryIpc({ db, scanner }: LibraryIpcDependencies): void {
  handleIpc(IPC_CHANNELS.libraryStatus, noArguments, (): LibraryStatus => ({
    rootChosen: readSettings(db).library.rootFolder !== null,
    trackCount: countTracks(db),
    scanning: scanner.isRunning()
  }))

  // Resolves when the scan is over. While one runs, this joins it: the page that
  // opens during the scan at startup gets that scan's result.
  handleIpc(IPC_CHANNELS.libraryScan, noArguments, () => scanner.scan())

  // For the page that opens while the app is scanning by itself: it gets that scan's
  // result without the risk of starting a second scan if the first has just ended.
  handleIpc(IPC_CHANNELS.libraryFollowScan, noArguments, () => scanner.current())
}
