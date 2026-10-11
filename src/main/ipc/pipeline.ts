import { BrowserWindow } from 'electron'
import { z } from 'zod'
import type { Orchestrator } from '../pipeline/orchestrator'
import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc'
import type { PipelineState, RunProgress } from '@shared/pipeline'
import { handleIpc } from './handle'
import { createRateGate, PROGRESS_INTERVAL_MS } from './progress'

const noArguments = z.tuple([])

/**
 * Passes the progress of a run on at most four times a second, but never holds back
 * a report that says something new about the run itself: that it paused, went on,
 * ended, or belongs to another batch or phase. A report that is held back is not
 * lost either: the newest one goes out when its time has come, so the page is never
 * left with old numbers while the run stands still for minutes.
 */
export function createRunProgressSender(
  send: (progress: RunProgress) => void,
  now: () => number = Date.now
): (progress: RunProgress) => void {
  let lastKind: string | null = null
  let lastSentAt: number | null = null
  let held: { progress: RunProgress; timer: NodeJS.Timeout } | null = null

  function sendNow(progress: RunProgress, kind: string): void {
    if (held) clearTimeout(held.timer)
    held = null
    lastKind = kind
    lastSentAt = now()
    send(progress)
  }

  return (progress) => {
    const kind = [
      progress.batchId,
      progress.phase,
      progress.state,
      progress.pauseReason,
      // That Claude's limit was reached, or that it is asked again, is news too.
      progress.claudeRetryAt === null ? '' : 'limit'
    ].join(':')
    const waitMs = lastSentAt === null ? 0 : PROGRESS_INTERVAL_MS - (now() - lastSentAt)
    if (kind !== lastKind || waitMs <= 0) {
      sendNow(progress, kind)
      return
    }
    // The newest report replaces the one that waits; the timer keeps running.
    if (held) {
      held.progress = progress
      return
    }
    const timer = setTimeout(() => {
      if (held) sendNow(held.progress, kind)
    }, waitMs)
    // A report that waits must not keep the app from quitting.
    timer.unref()
    held = { progress, timer }
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
  // A page that pauses and resumes in a loop would write two log lines and send two
  // reports per turn; more often than this, the calls are simply not acted on.
  const mayToggle = createRateGate(PROGRESS_INTERVAL_MS)
  handleIpc(IPC_CHANNELS.pipelinePause, noArguments, () => {
    if (mayToggle()) orchestrator.pause()
  })
  handleIpc(IPC_CHANNELS.pipelineResume, noArguments, () => {
    if (mayToggle()) orchestrator.resume()
  })
  handleIpc(IPC_CHANNELS.pipelineCancel, noArguments, () => orchestrator.cancel())
}
