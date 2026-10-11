import { BrowserWindow } from 'electron'
import { z } from 'zod'
import type { AppDatabase } from '../db/connection'
import { countTracks } from '../db/tracks'
import { listLibraryPage, resolveRunTargets } from '../pipeline/library'
import type { LibraryScanner } from '../pipeline/scanner'
import { readSettings } from '../pipeline/settings'
import { createLogLimiter } from '../services/log-limiter'
import { logger } from '../services/logger'
import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc'
import type { LibraryStatus, ScanProgress } from '@shared/library'
import { handleIpc } from './handle'
import { createProgressThrottle } from './progress'

const noArguments = z.tuple([])
// The content of a request is checked by the pipeline, which answers a bad one with
// INVALID_INPUT; here only the number of arguments is fixed.
const oneUnknown = z.tuple([z.unknown()])

// A page that asks for runs in a loop must not be able to fill the log with them.
const logRun = createLogLimiter((line) => logger.info(line), { limit: 10, windowMs: 10_000 })

export interface LibraryIpcDependencies {
  db: AppDatabase
  scanner: LibraryScanner
  listMountedVolumes: () => ReadonlySet<string>
}

/** Tells the app's window how far a scan is, whoever started the scan. */
export const sendScanProgress = createProgressThrottle<ScanProgress>((progress) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.libraryScanProgress, progress)
  }
})

export function registerLibraryIpc({
  db,
  scanner,
  listMountedVolumes
}: LibraryIpcDependencies): void {
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

  handleIpc(IPC_CHANNELS.libraryList, oneUnknown, (_event, page) =>
    listLibraryPage(db, page, listMountedVolumes())
  )

  handleIpc(IPC_CHANNELS.libraryRun, oneUnknown, (_event, request) => {
    const targets = resolveRunTargets(db, request, listMountedVolumes())
    // T-009: hand the tracks to the orchestrator. Until then a run only says which
    // tracks it would process.
    if (targets.ok) {
      const { trackIds, skipped } = targets.value
      logRun(`Run requested for ${trackIds.length} tracks (${skipped} left out)`)
    }
    return targets
  })
}
