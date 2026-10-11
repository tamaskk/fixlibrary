import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath, pathToFileURL } from 'url'
import type { z } from 'zod'

let rendererEntryUrl: string | null = null

/**
 * Tells the app which document is its own page. Call once, before a window loads:
 * the built renderer file, or the dev server URL while developing.
 */
export function setRendererEntry(entry: { filePath: string } | { url: string }): void {
  rendererEntryUrl = 'url' in entry ? entry.url : pathToFileURL(entry.filePath).href
}

/** The one place that knows the app's page; null until `setRendererEntry` ran. */
export function getRendererEntryUrl(): string | null {
  return rendererEntryUrl
}

/** True for the app's own page only: the dev server origin, or the one renderer file. */
export function isRendererUrl(candidate: string, entryUrl: string): boolean {
  try {
    const url = new URL(candidate)
    const entry = new URL(entryUrl)
    if (url.protocol !== entry.protocol) return false
    if (entry.protocol === 'file:') {
      // Compared as decoded paths: the same file can be written as different URLs
      // (Electron and Node escape characters such as "[" or "%" differently).
      return fileURLToPath(url) === fileURLToPath(entry)
    }
    return url.origin === entry.origin
  } catch {
    return false
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  return (
    rendererEntryUrl !== null &&
    frame !== null &&
    frame === event.sender.mainFrame &&
    isRendererUrl(frame.url, rendererEntryUrl)
  )
}

/**
 * Registers a handler that runs only for the app's own page and only with arguments
 * that fit the schema. Anything else is a bug or an attack, not an expected failure,
 * so it is rejected with a fixed message that carries no detail. Expected failures
 * are returned by the handler as a `Result`.
 */
export function handleIpc<Arguments extends unknown[], Value>(
  channel: string,
  argumentsSchema: z.ZodType<Arguments>,
  handler: (event: IpcMainInvokeEvent, ...args: Arguments) => Value | Promise<Value>
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) {
      console.error(`Rejected IPC call on ${channel}: not from the app's page`)
      throw new Error('IPC call from an unknown page')
    }
    const parsed = argumentsSchema.safeParse(args)
    if (!parsed.success) {
      console.error(`Rejected IPC call on ${channel}: invalid arguments`)
      throw new Error('Invalid IPC arguments')
    }
    try {
      return await handler(event, ...parsed.data)
    } catch (error) {
      // The detail (it can hold a file path) stays in the main process.
      console.error(`IPC handler for ${channel} failed`, error)
      throw new Error('The request failed')
    }
  })
}
