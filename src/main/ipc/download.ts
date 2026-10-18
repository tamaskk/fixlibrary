import { BrowserWindow } from 'electron'
import { z } from 'zod'
import type { Downloads } from '../pipeline/download'
import type { DownloadItem } from '@shared/download'
import type { Result } from '@shared/errors'
import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc'
import { handleIpc } from './handle'
import { createRateGate, PROGRESS_INTERVAL_MS } from './progress'

const noArguments = z.tuple([])
// The content is checked by the pipeline: an address it does not take is refused there.
const oneUnknown = z.tuple([z.unknown()])

// Each asks yt-dlp, which starts a process: a page asking in a loop must not start
// one after another. Five pasted addresses are asked about in about two seconds.
const MIN_QUESTION_INTERVAL_MS = 300

/**
 * Passes the list on at most four times a second, and always the newest one last:
 * the end of a download must reach the page even when it came right after a step.
 */
export function createDownloadSender(
  send: (items: DownloadItem[]) => void,
  now: () => number = Date.now
): (items: DownloadItem[]) => void {
  let latest: DownloadItem[] = []
  let timer: NodeJS.Timeout | null = null
  let lastSentAt = -Infinity
  return (items) => {
    latest = items
    if (timer !== null) return
    timer = setTimeout(
      () => {
        timer = null
        lastSentAt = now()
        send(latest)
      },
      Math.max(0, lastSentAt + PROGRESS_INTERVAL_MS - now())
    )
  }
}

export const sendDownloads = createDownloadSender((items) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.downloadChanged, items)
  }
})

const tooSoon: Result<never> = { ok: false, code: 'RUN_ACTIVE' }

export function registerDownloadIpc(downloads: Downloads): void {
  const mayAsk = createRateGate(MIN_QUESTION_INTERVAL_MS)

  handleIpc(IPC_CHANNELS.downloadInspect, oneUnknown, (_event, url) =>
    mayAsk() ? downloads.inspect(url) : tooSoon
  )
  handleIpc(IPC_CHANNELS.downloadStart, oneUnknown, (_event, url) => downloads.start(url))
  handleIpc(IPC_CHANNELS.downloadSearch, oneUnknown, (_event, request) =>
    mayAsk() ? downloads.search(request) : tooSoon
  )
  handleIpc(IPC_CHANNELS.downloadList, noArguments, () => downloads.list())
}
