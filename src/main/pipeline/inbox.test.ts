import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createInboxBatches,
  createInboxWatcher,
  inboxStages,
  isInInbox,
  INBOX_RECHECK_MS,
  INBOX_RETRY_MS,
  INBOX_SETTLE_MS,
  isInboxAudio,
  type FileStamp,
  type InboxWatcher
} from './inbox'

const INBOX = '/Music/Inbox'

interface FakeInbox {
  files: Map<string, FileStamp>
  /** What the watch was told, as fs.watch would say it. */
  emit: (name: string | null) => void
  endWatch: () => void
  watches: number
  idle: boolean
  accept: boolean
  processed: string[][]
}

let inbox: FakeInbox
let watcher: InboxWatcher

function createFake(): FakeInbox {
  const fake: FakeInbox = {
    files: new Map(),
    emit: () => {},
    endWatch: () => {},
    watches: 0,
    idle: true,
    accept: true,
    processed: []
  }
  watcher = createInboxWatcher({
    folder: () => INBOX,
    watch: (_folder, onChange, onEnd) => {
      fake.watches += 1
      fake.emit = onChange
      fake.endWatch = onEnd
      return () => {}
    },
    list: async () => [...fake.files.keys()],
    stamp: async (path) => fake.files.get(path.slice(INBOX.length + 1)) ?? null,
    idle: () => fake.idle,
    process: async (paths) => {
      fake.processed.push(paths)
      return fake.accept
    }
  })
  return fake
}

beforeEach(() => {
  vi.useFakeTimers()
  inbox = createFake()
})

afterEach(() => {
  watcher.stop()
  vi.useRealTimers()
})

describe('the Inbox watcher', () => {
  it('takes a new file 10 s after it last changed', async () => {
    // Arrange
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    inbox.files.set('abc.mp3', { size: 10, mtimeMs: 1 })

    // Act
    inbox.emit('abc.mp3')
    await vi.advanceTimersByTimeAsync(INBOX_SETTLE_MS - 1)
    const early = inbox.processed.length
    await vi.advanceTimersByTimeAsync(1)

    // Assert
    expect(early).toBe(0)
    expect(inbox.processed).toEqual([[join(INBOX, 'abc.mp3')]])
  })

  it('waits again while the file is still being written', async () => {
    // Arrange
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    inbox.files.set('abc.mp3', { size: 10, mtimeMs: 1 })
    inbox.emit('abc.mp3')
    await vi.advanceTimersByTimeAsync(5_000)

    // Act
    inbox.files.set('abc.mp3', { size: 20, mtimeMs: 2 })
    inbox.emit('abc.mp3')
    await vi.advanceTimersByTimeAsync(INBOX_SETTLE_MS - 1)
    const early = inbox.processed.length
    await vi.advanceTimersByTimeAsync(1)

    // Assert
    expect(early).toBe(0)
    expect(inbox.processed).toHaveLength(1)
  })

  it('takes the files that are in the Inbox at the start', async () => {
    // Arrange
    inbox.files.set('a.mp3', { size: 1, mtimeMs: 1 })
    inbox.files.set('b.aiff', { size: 1, mtimeMs: 1 })
    inbox.files.set('cover.jpg', { size: 1, mtimeMs: 1 })
    inbox.files.set('.hidden.mp3', { size: 1, mtimeMs: 1 })

    // Act
    watcher.start()
    await vi.advanceTimersByTimeAsync(INBOX_SETTLE_MS)

    // Assert
    expect(inbox.processed.flat().sort()).toEqual([join(INBOX, 'a.mp3'), join(INBOX, 'b.aiff')])
  })

  it('waits while the app is busy, and offers the files again', async () => {
    // Arrange
    inbox.idle = false
    inbox.files.set('a.mp3', { size: 1, mtimeMs: 1 })
    watcher.start()
    await vi.advanceTimersByTimeAsync(INBOX_SETTLE_MS)

    // Act
    inbox.idle = true
    await vi.advanceTimersByTimeAsync(INBOX_RETRY_MS)

    // Assert
    expect(inbox.processed).toEqual([[join(INBOX, 'a.mp3')]])
  })

  it('offers a file once: a batch that was given up does not come back', async () => {
    // Arrange
    inbox.files.set('a.mp3', { size: 1, mtimeMs: 1 })
    watcher.start()
    await vi.advanceTimersByTimeAsync(INBOX_SETTLE_MS)

    // Act
    await vi.advanceTimersByTimeAsync(INBOX_RECHECK_MS * 3)

    // Assert
    expect(inbox.processed).toHaveLength(1)
  })

  it('offers again a file that could not be started', async () => {
    // Arrange
    inbox.accept = false
    inbox.files.set('a.mp3', { size: 1, mtimeMs: 1 })
    watcher.start()
    await vi.advanceTimersByTimeAsync(INBOX_SETTLE_MS)

    // Act
    inbox.accept = true
    await vi.advanceTimersByTimeAsync(INBOX_RETRY_MS)

    // Assert
    expect(inbox.processed).toHaveLength(2)
  })

  it('offers a file that settled while a batch was being started', async () => {
    // Arrange: the first start takes as long as a slow scan.
    let finishFirst: (started: boolean) => void = () => {}
    const offered: string[][] = []
    watcher.stop()
    watcher = createInboxWatcher({
      folder: () => INBOX,
      watch: (_folder, onChange) => {
        inbox.emit = onChange
        return () => {}
      },
      list: async () => [...inbox.files.keys()],
      stamp: async (path) => inbox.files.get(path.slice(INBOX.length + 1)) ?? null,
      idle: () => true,
      process: (paths) => {
        offered.push(paths)
        return offered.length === 1
          ? new Promise((resolve) => (finishFirst = resolve))
          : Promise.resolve(true)
      }
    })
    inbox.files.set('a.mp3', { size: 1, mtimeMs: 1 })
    watcher.start()
    await vi.advanceTimersByTimeAsync(INBOX_SETTLE_MS)
    inbox.files.set('b.mp3', { size: 1, mtimeMs: 1 })
    inbox.emit('b.mp3')
    await vi.advanceTimersByTimeAsync(INBOX_SETTLE_MS)

    // Act
    finishFirst(true)
    await vi.advanceTimersByTimeAsync(INBOX_RETRY_MS)

    // Assert
    expect(offered).toEqual([[join(INBOX, 'a.mp3')], [join(INBOX, 'b.mp3')]])
  })

  it('finds by its listing a file the watch said nothing of', async () => {
    // Arrange
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)

    // Act
    inbox.files.set('quiet.mp3', { size: 1, mtimeMs: 1 })
    await vi.advanceTimersByTimeAsync(INBOX_RECHECK_MS + INBOX_SETTLE_MS)

    // Assert
    expect(inbox.processed).toEqual([[join(INBOX, 'quiet.mp3')]])
  })

  it('watches again once a watch has ended', async () => {
    // Arrange
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)

    // Act
    inbox.endWatch()
    await vi.advanceTimersByTimeAsync(INBOX_RECHECK_MS)

    // Assert
    expect(inbox.watches).toBe(2)
  })

  it('forgets a file that went away before it settled', async () => {
    // Arrange
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    inbox.files.set('a.mp3', { size: 1, mtimeMs: 1 })
    inbox.emit('a.mp3')

    // Act
    inbox.files.delete('a.mp3')
    await vi.advanceTimersByTimeAsync(INBOX_SETTLE_MS)

    // Assert
    expect(inbox.processed).toEqual([])
  })
})

describe('inboxStages', () => {
  it('runs every function but the stems and the hot cues', () => {
    // Act
    const stages = inboxStages(['bpmKey', 'stems', 'cues', 'lookup', 'organize'])

    // Assert
    expect(stages).toEqual(['bpmKey', 'lookup', 'organize'])
  })
})

describe('isInboxAudio', () => {
  it.each([
    ['a.mp3', true],
    ['A.AIFF', true],
    ['a.wav', true],
    ['a.webm', false],
    ['a.mp3.part', false],
    ['.a.mp3', false]
  ])('%s is %s', (name, taken) => {
    // Act
    const audio = isInboxAudio(name)

    // Assert
    expect(audio).toBe(taken)
  })
})

describe('isInInbox', () => {
  it('is true only right in the Inbox of the library', () => {
    // Act
    const inside = isInInbox('/Music/Inbox/a.mp3', '/Music')
    const deeper = isInInbox('/Music/Inbox/x/a.mp3', '/Music')
    const styled = isInInbox('/Music/House/a.mp3', '/Music')
    const noLibrary = isInInbox('/Music/Inbox/a.mp3', null)

    // Assert
    expect([inside, deeper, styled, noLibrary]).toEqual([true, false, false, false])
  })
})

describe('createInboxBatches', () => {
  it('scans, then runs the tracks of the files, each track once', async () => {
    // Arrange
    const ids = new Map([
      ['/Music/Inbox/a.mp3', 1],
      ['/Music/Inbox/Artist - Title.mp3', 1],
      ['/Music/Inbox/b.mp3', 2]
    ])
    const started: number[][] = []
    const process = createInboxBatches({
      scan: async () => true,
      trackIdOf: (path) => ids.get(path),
      start: (trackIds) => {
        started.push(trackIds)
        return true
      }
    })

    // Act
    const first = await process(['/Music/Inbox/a.mp3', '/Music/Inbox/gone.mp3'])
    // The batch renamed a.mp3 in the Inbox: the same track under a new name.
    const renamed = await process(['/Music/Inbox/Artist - Title.mp3', '/Music/Inbox/b.mp3'])

    // Assert
    expect([first, renamed]).toEqual([true, true])
    expect(started).toEqual([[1], [2]])
  })

  it('takes nothing when the scan or the start fails, so the files come again', async () => {
    // Arrange
    let scans = 0
    const process = createInboxBatches({
      scan: async () => (scans += 1) > 1,
      trackIdOf: () => 1,
      start: () => false
    })

    // Act
    const scanFailed = await process(['/Music/Inbox/a.mp3'])
    const startFailed = await process(['/Music/Inbox/a.mp3'])

    // Assert
    expect([scanFailed, startFailed]).toEqual([false, false])
  })
})
