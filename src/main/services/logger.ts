// The main process log. Everything logs through `logger`; until the app points it
// at a folder with `startFileLogging`, lines go to the console (tests, early startup).
//
// Never log a secret. Pass messages you wrote yourself and Error objects (only their
// stack is written). Never pass a request, a response, a config object or user input
// as a detail: an object is written out in full.
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
// Only the `/node` entry: `electron-log/main` registers IPC handlers of its own,
// outside the checks in src/main/ipc/handle.ts. ESLint enforces this.
import log from 'electron-log/node'

export const MAIN_LOG_FILE_NAME = 'main.log'
// docs/SECURITY.md §01: 5 files of 10 MB, rotated.
export const MAX_LOG_BYTES = 10 * 1024 * 1024
export const LOG_FILE_COUNT = 5

export interface Logger {
  info: (message: string, ...details: unknown[]) => void
  warn: (message: string, ...details: unknown[]) => void
  error: (message: string, ...details: unknown[]) => void
}

const consoleLogger: Logger = {
  info: (message, ...details) => console.info(message, ...details),
  warn: (message, ...details) => console.warn(message, ...details),
  error: (message, ...details) => console.error(message, ...details)
}

let target: Logger = consoleLogger

/** The logger every module of the main process uses. */
export const logger: Logger = {
  info: (message, ...details) => target.info(message, ...details),
  warn: (message, ...details) => target.warn(message, ...details),
  error: (message, ...details) => target.error(message, ...details)
}

/**
 * Makes room for a new log file: `main.log` becomes `main.1.log`, that one becomes
 * `main.2.log`, and so on. The oldest of `fileCount` files is deleted.
 */
export function rotateLogFiles(logFilePath: string, fileCount: number = LOG_FILE_COUNT): void {
  const extension = extname(logFilePath)
  const stem = join(dirname(logFilePath), basename(logFilePath, extension))
  const numbered = (index: number): string => `${stem}.${index}${extension}`

  rmSync(numbered(fileCount - 1), { force: true })
  for (let index = fileCount - 2; index >= 1; index -= 1) {
    if (existsSync(numbered(index))) renameSync(numbered(index), numbered(index + 1))
  }
  if (existsSync(logFilePath)) renameSync(logFilePath, numbered(1))
}

export interface FileLoggingOptions {
  /** Rotate when the file grows past this. Tests use a small value. */
  maxBytes?: number
  /** Mirror the lines on the console as well; useful while developing. */
  mirrorToConsole?: boolean
  /**
   * Also write uncaught errors and unhandled rejections to the log. After an
   * uncaught exception (not a rejection) this is called, so the app can stop
   * instead of running on in an unknown state.
   */
  onUncaughtException?: (error: Error) => void
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Sends everything logged from now on to `<folder>/main.log`, and returns that path.
 * If the folder cannot be used, logging stays on the console and null is returned:
 * a missing log must never keep the app from starting.
 */
export function startFileLogging(folder: string, options: FileLoggingOptions = {}): string | null {
  const logFilePath = join(folder, MAIN_LOG_FILE_NAME)
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    // A link would send the writes, and the renames and deletes of rotation, somewhere else.
    if (isLink(folder) || isLink(logFilePath)) throw new Error('the log path is a link')
    // A log can name files and folders of the library: for the user only, like the database.
    if (existsSync(logFilePath)) chmodSync(logFilePath, 0o600)
  } catch (error) {
    console.error('No log file, logging to the console only', error)
    return null
  }

  // Its own instance, so nothing else that uses electron-log shares these settings.
  const fileLog = log.create({ logId: `fixlibrary-${logFilePath}` })
  const file = fileLog.transports.file
  file.resolvePathFn = () => logFilePath
  file.maxSize = options.maxBytes ?? MAX_LOG_BYTES
  file.writeOptions = { flag: 'a', mode: 0o600, encoding: 'utf8' }
  file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
  file.archiveLogFn = (oldLogFile) => {
    try {
      rotateLogFiles(oldLogFile.path)
    } catch (error) {
      // If this threw, the file would stay over the limit and every later line would
      // be lost. Emptying this one file instead keeps the log going.
      console.error('The log could not be rotated; starting it over instead', error)
      oldLogFile.clear()
    }
  }
  // A write that fails would otherwise vanish without a trace.
  file.getFile().on('error', (error) => console.error('The log could not be written', error))
  fileLog.transports.console.level = options.mirrorToConsole ? 'silly' : false

  const { onUncaughtException } = options
  if (onUncaughtException) {
    fileLog.errorHandler.startCatching({
      showDialog: false,
      onError: ({ error, errorName }) => {
        const isRejection = errorName.includes('rejection')
        fileLog.error(isRejection ? 'Unhandled rejection' : 'Uncaught exception', error)
        if (!isRejection) onUncaughtException(error)
        // Logged above; electron-log need not log it a second time.
        return false
      }
    })
  }

  // The message is the argument of "%s", so a "%" inside it is never read as a
  // format instruction that would swallow one of the details.
  target = {
    info: (message, ...details) => fileLog.info('%s', message, ...details),
    warn: (message, ...details) => fileLog.warn('%s', message, ...details),
    error: (message, ...details) => fileLog.error('%s', message, ...details)
  }
  return logFilePath
}

/** Back to the console. For tests. */
export function stopFileLogging(): void {
  target = consoleLogger
}
