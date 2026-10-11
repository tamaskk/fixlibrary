import { BrowserWindow } from 'electron'
import { z } from 'zod'
import type { AppDatabase } from '../db/connection'
import { countTracks } from '../db/tracks'
import { listLibraryPage, resolveRunTargets } from '../pipeline/library'
import type { Orchestrator } from '../pipeline/orchestrator'
import type { LibraryScanner } from '../pipeline/scanner'
import { readSettings } from '../pipeline/settings'
import { createLogLimiter } from '../services/log-limiter'
import { logger } from '../services/logger'
import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc'
import type { Result } from '@shared/errors'
import type { LibraryStatus, RunStarted, ScanProgress } from '@shared/library'
import { handleIpc } from './handle'
import { createProgressThrottle, createRateGate } from './progress'

const noArguments = z.tuple([])
// The content of a request is checked by the pipeline, which answers a bad one with
// INVALID_INPUT; here only the number of arguments is fixed.
const oneUnknown = z.tuple([z.unknown()])

// At most one run is started in this time, whoever asks.
const MIN_RUN_INTERVAL_MS = 2000

// A page that asks for runs in a loop must not be able to fill the log with them.
const logRun = createLogLimiter((line) => logger.info(line), { limit: 10, windowMs: 10_000 })

export interface LibraryIpcDependencies {
  db: AppDatabase
  scanner: LibraryScanner
  orchestrator: Orchestrator
  /** The names of the functions the user can ask for. */
  functions: readonly string[]
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
  orchestrator,
  functions,
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

  const mayStart = createRateGate(MIN_RUN_INTERVAL_MS)
  handleIpc(IPC_CHANNELS.libraryRun, oneUnknown, (_event, request): Result<RunStarted> => {
    // The page names ids and functions; which tracks may run is decided here, and
    // again by the orchestrator when it builds the batch.
    const plan = resolveRunTargets(db, request, listMountedVolumes(), functions)
    if (!plan.ok) return plan
    const { trackIds, skipped, stages } = plan.value
    if (trackIds.length === 0) return { ok: false, code: 'INVALID_INPUT' }
    // Starting a run writes a row per track and job. A page that starts and cancels
    // in a loop would fill the disk and freeze the window; one start in this time is
    // all a person asks for.
    if (!mayStart()) return { ok: false, code: 'RUN_ACTIVE' }
    const started = orchestrator.start({ trackIds, stages })
    if (!started.ok) return started
    logRun(`Run requested for ${trackIds.length} tracks (${skipped} left out)`)
    return { ok: true, value: { batchId: started.value.batchId, trackIds, skipped } }
  })
}
