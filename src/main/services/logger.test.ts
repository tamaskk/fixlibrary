import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger, rotateLogFiles, startFileLogging, stopFileLogging } from './logger'

let folder: string

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'fixlibrary-log-'))
})

afterEach(() => {
  stopFileLogging()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('logger', () => {
  it('writes to the console until file logging has started', () => {
    // Arrange
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Act
    logger.error('before the log folder is known')

    // Assert
    expect(printed).toHaveBeenCalledWith('before the log folder is known')
  })

  it('creates main.log in the given folder, with level, message and error detail', () => {
    // Arrange
    const logFolder = join(folder, 'Logs', 'FixLibrary')
    const logFile = startFileLogging(logFolder) as string

    // Act
    logger.info('sidecar ready')
    logger.error('lookup failed', new Error('socket hang up'))
    const content = readFileSync(logFile, 'utf8')

    // Assert
    expect(logFile).toBe(join(logFolder, 'main.log'))
    expect(content).toMatch(/\[info\]\s+sidecar ready/)
    expect(content).toMatch(/\[error\]\s+lookup failed/)
    expect(content).toContain('socket hang up')
  })

  it('starts a new file when main.log grows past the limit, keeping the older lines', () => {
    // Arrange
    const logFile = startFileLogging(folder, { maxBytes: 2000 }) as string
    const line = 'x'.repeat(200)

    // Act
    for (let count = 0; count < 40; count += 1) logger.info(`${count} ${line}`)
    const files = readdirSync(folder).sort()

    // Assert
    expect(files).toContain('main.log')
    expect(files).toContain('main.1.log')
    expect(readFileSync(logFile, 'utf8')).toContain('39 ')
    expect(readFileSync(join(folder, 'main.1.log'), 'utf8')).not.toContain('39 ')
  })

  it('never keeps more than five files', () => {
    // Arrange
    startFileLogging(folder, { maxBytes: 1000 })
    const line = 'x'.repeat(300)

    // Act
    for (let count = 0; count < 200; count += 1) logger.info(`${count} ${line}`)
    const files = readdirSync(folder).sort()

    // Assert
    expect(files).toEqual(['main.1.log', 'main.2.log', 'main.3.log', 'main.4.log', 'main.log'])
  })
})

describe('a log that cannot be written as planned', () => {
  it('keeps logging when rotation is blocked, instead of going silent', () => {
    // Arrange
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // A folder where the oldest log file should go makes every rotation fail.
    mkdirSync(join(folder, 'main.4.log', 'in-the-way'), { recursive: true })
    const logFile = startFileLogging(folder, { maxBytes: 1000 }) as string
    const line = 'x'.repeat(300)

    // Act
    for (let count = 0; count < 200; count += 1) logger.info(`${count} ${line}`)

    // Assert
    expect(readFileSync(logFile, 'utf8')).toContain('199 ')
  })

  it('stays on the console, without throwing, when the log folder cannot be created', () => {
    // Arrange
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {})
    const blocked = join(folder, 'a-file-not-a-folder')
    writeFileSync(blocked, 'in the way')

    // Act
    const logFile = startFileLogging(join(blocked, 'Logs'))
    logger.error('still heard')

    // Assert
    expect(logFile).toBeNull()
    expect(printed).toHaveBeenCalledWith('still heard')
  })

  it('refuses a log file that is a link to somewhere else', () => {
    // Arrange
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const elsewhere = join(folder, 'elsewhere.txt')
    writeFileSync(elsewhere, 'not a log')
    const logFolder = join(folder, 'Logs')
    mkdirSync(logFolder)
    symlinkSync(elsewhere, join(logFolder, 'main.log'))

    // Act
    const logFile = startFileLogging(logFolder)
    logger.error('not written through the link')

    // Assert
    expect(logFile).toBeNull()
    expect(readFileSync(elsewhere, 'utf8')).toBe('not a log')
  })

  it('creates the log readable by the user only, and tightens an older one', () => {
    // Arrange
    writeFileSync(join(folder, 'main.log'), 'older line\n', { mode: 0o644 })

    // Act
    const logFile = startFileLogging(folder) as string
    logger.info('new line')

    // Assert
    expect(statSync(logFile).mode & 0o777).toBe(0o600)
  })

  it('writes a percent sign in a message as it is, and keeps the detail after it', () => {
    // Arrange
    const logFile = startFileLogging(folder) as string

    // Act
    logger.info('progress 50%s done %c', 'the detail')
    const content = readFileSync(logFile, 'utf8')

    // Assert
    expect(content).toContain('progress 50%s done %c')
    expect(content).toContain('the detail')
  })
})

describe('uncaught errors', () => {
  it('logs an uncaught exception and reports it, but only logs a rejection', () => {
    // Arrange
    const reported: Error[] = []
    const listenersBefore = {
      exception: process.listeners('uncaughtException'),
      rejection: process.listeners('unhandledRejection')
    }
    const logFile = startFileLogging(folder, {
      onUncaughtException: (error) => reported.push(error)
    }) as string
    // The handlers the logger installed, as opposed to the test runner's own.
    const added = (
      event: 'uncaughtException' | 'unhandledRejection',
      before: unknown[]
    ): ((error: Error) => void)[] =>
      (process.listeners(event as 'uncaughtException') as unknown[]).filter(
        (listener) => !before.includes(listener)
      ) as ((error: Error) => void)[]

    try {
      // Act: deliver the errors to the handlers the logger installed, as Node would.
      for (const handle of added('uncaughtException', listenersBefore.exception)) {
        handle(new Error('boom in main'))
      }
      for (const handle of added('unhandledRejection', listenersBefore.rejection)) {
        handle(new Error('promise nobody awaited'))
      }
      const content = readFileSync(logFile, 'utf8')

      // Assert
      expect(reported.map((error) => error.message)).toEqual(['boom in main'])
      expect(content).toContain('Uncaught exception')
      expect(content).toContain('boom in main')
      expect(content).toContain('Unhandled rejection')
      expect(content).toContain('promise nobody awaited')
    } finally {
      // Vitest must get its own handling of real errors back.
      for (const handle of added('uncaughtException', listenersBefore.exception)) {
        process.off('uncaughtException', handle as never)
      }
      for (const handle of added('unhandledRejection', listenersBefore.rejection)) {
        process.off('unhandledRejection', handle as never)
      }
    }
  })
})

describe('rotateLogFiles', () => {
  it('shifts every file by one and drops the oldest', () => {
    // Arrange
    const logFile = join(folder, 'main.log')
    writeFileSync(logFile, 'current')
    for (const index of [1, 2, 3, 4])
      writeFileSync(join(folder, `main.${index}.log`), `old ${index}`)

    // Act
    rotateLogFiles(logFile)

    // Assert
    expect(existsSync(logFile)).toBe(false)
    expect(readFileSync(join(folder, 'main.1.log'), 'utf8')).toBe('current')
    expect(readFileSync(join(folder, 'main.2.log'), 'utf8')).toBe('old 1')
    expect(readFileSync(join(folder, 'main.4.log'), 'utf8')).toBe('old 3')
    expect(readdirSync(folder)).toHaveLength(4)
  })

  it('does nothing harmful when there is no log yet', () => {
    // Act
    const rotate = (): void => rotateLogFiles(join(folder, 'main.log'))

    // Assert
    expect(rotate).not.toThrow()
    expect(readdirSync(folder)).toEqual([])
  })
})
