import { BrowserWindow } from 'electron'
import { z } from 'zod'
import type { Orchestrator } from '../pipeline/orchestrator'
import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc'
import type { PipelineState, RunProgress } from '@shared/pipeline'
import { handleIpc } from './handle'
import { PROGRESS_INTERVAL_MS } from './progress'

const noArguments = z.tuple([])

/**
 * Passes the progress of a run on at most four times a second, but never holds back
 * a report that says something new about the run itself: that it paused, went on,
 * ended, or belongs to another batch or phase. A run may stand still for minutes
 * after such a report, and the page would show the old state all that time.
 */
export function createRunProgressSender(
  send: (progress: RunProgress) => void,
  now: () => number = Date.now
): (progress: RunProgress) => void {
  let lastKind: string | null = null
  let lastSentAt: number | null = null
  return (progress) => {
    const kind = [progress.batchId, progress.phase, progress.state, progress.pauseReason].join(':')
    const time = now()
    const tooSoon = lastSentAt !== null && time - lastSentAt < PROGRESS_INTERVAL_MS
    if (kind === lastKind && tooSoon) return
    lastKind = kind
    lastSentAt = time
    send(progress)
  }
}

/** Tells the app's window how far a run is. */
export const sendRunProgress = createRunProgressSender((progress) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.pipelineProgress, progress)
  }
})

export interface PipelineIpcDependencies {
  orchestrator: Orchestrator
  /** The names of the functions the user can ask for. */
  functions: readonly string[]
}

export function registerPipelineIpc({ orchestrator, functions }: PipelineIpcDependencies): void {
  handleIpc(IPC_CHANNELS.pipelineState, noArguments, (): PipelineState => ({
    functions: [...functions],
    progress: orchestrator.progress()
  }))
  handleIpc(IPC_CHANNELS.pipelinePause, noArguments, () => orchestrator.pause())
  handleIpc(IPC_CHANNELS.pipelineResume, noArguments, () => orchestrator.resume())
  handleIpc(IPC_CHANNELS.pipelineCancel, noArguments, () => orchestrator.cancel())
}
