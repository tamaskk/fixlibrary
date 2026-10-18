// The Inbox (T-035): audio files that land in `<library root>/Inbox`, downloaded or
// copied there by hand, go through the functions of the app as one batch on their own,
// and into their style folders once the user approves its preview. Watched with
// `fs.watch`, and listed again every minute for what a watch can miss (a drive that
// sends no events, a folder made after the start).
import { dirname, extname, join } from 'path'
import { CUES_STAGE } from './stages/cues'
import { MOOD_STAGE } from './stages/mood'
import { STEMS_STAGE } from './stages/stems'
import { logger } from '../services/logger'
import { AUDIO_EXTENSIONS } from '@shared/file-names'
import { INBOX_FOLDER_NAME } from '@shared/settings'

/** A file is taken this long after it last changed, so its writing has surely ended. */
export const INBOX_SETTLE_MS = 10_000
/** How often the folder is listed again, and looked for while it is not there. */
export const INBOX_RECHECK_MS = 60_000
/** How long a batch waits before it asks again whether it may start. */
export const INBOX_RETRY_MS = 15_000

// Stems take hours and would keep the preview away; hot cues need Rekordbox's grid,
// which a new track gets only from the wizard; the moods would make every file a call
// to Claude, whose limit must not hold an Inbox preview up. All run later, by hand.
const LEFT_OUT_STAGES: readonly string[] = [STEMS_STAGE, CUES_STAGE, MOOD_STAGE]

/** The functions an Inbox batch runs: every one the user could ask for, but those three. */
export function inboxStages(selectable: readonly string[]): string[] {
  return selectable.filter((name) => !LEFT_OUT_STAGES.includes(name))
}

/** True for the name of an audio file the Inbox takes: not hidden, an audio extension. */
export function isInboxAudio(name: string): boolean {
  if (name.startsWith('.') || name.includes('/')) return false
  const extension = extname(name).toLowerCase()
  return AUDIO_EXTENSIONS.some((each) => each === extension)
}

/** True for a track whose file lies right in the Inbox of this library. */
export function isInInbox(path: string, libraryRoot: string | null): boolean {
  if (libraryRoot === null) return false
  return dirname(path).normalize('NFC') === join(libraryRoot, INBOX_FOLDER_NAME).normalize('NFC')
}

export interface InboxBatchDependencies {
  /** Scans the library, so that the new files are tracks. False when the scan failed. */
  scan: () => Promise<boolean>
  trackIdOf: (path: string) => number | undefined
  /** Starts a run of these tracks; false when none could start now. */
  start: (trackIds: number[]) => boolean
}

/**
 * What the watcher hands its files to: a scan, then one run of their tracks. A track
 * is taken once while the app runs: the name a batch gives a file in the Inbox, before
 * it moves it into its style folder, is no new track.
 */
export function createInboxBatches(
  dependencies: InboxBatchDependencies
): (paths: string[]) => Promise<boolean> {
  const taken = new Set<number>()
  return async (paths) => {
    if (!(await dependencies.scan())) return false
    const trackIds = [
      ...new Set(paths.flatMap((path) => dependencies.trackIdOf(path) ?? []))
    ].filter((id) => !taken.has(id))
    if (trackIds.length === 0) return true
    if (!dependencies.start(trackIds)) return false
    for (const id of trackIds) taken.add(id)
    return true
  }
}

export interface FileStamp {
  size: number
  mtimeMs: number
}

export interface InboxDependencies {
  /** `<library root>/Inbox`, or null while no library is chosen. */
  folder: () => string | null
  /**
   * Watches the folder; throws when it cannot. Returns what ends the watch. `onEnd`
   * is called once when the watch ends by itself (the folder went away).
   */
  watch: (folder: string, onChange: (name: string | null) => void, onEnd: () => void) => () => void
  /** The names in the folder; none when it is not there. */
  list: (folder: string) => Promise<string[]>
  /** The size and time of a regular file, or null for anything else or nothing. */
  stamp: (path: string) => Promise<FileStamp | null>
  /** Whether a batch may start now: no run, no batch waiting for approval, no scan. */
  idle: () => boolean
  /**
   * Starts the batch of these files. False when it could not start now; they are
   * then offered again later.
   */
  process: (paths: string[]) => Promise<boolean>
}

export interface InboxWatcher {
  start: () => void
  /** Looks at the folder again now: after a download, or when the library changed. */
  refresh: () => void
  stop: () => void
}

export function createInboxWatcher(dependencies: InboxDependencies): InboxWatcher {
  let watched: string | null = null
  let unwatch: (() => void) | null = null
  let recheck: NodeJS.Timeout | null = null
  let retry: NodeJS.Timeout | null = null
  let processing = false
  // Per name, the file as it was when its wait began.
  const settling = new Map<string, { timer: NodeJS.Timeout; stamp: FileStamp | null }>()
  // Per path, the stamp of a file that settled and waits for a batch.
  const pending = new Map<string, string>()
  // Files handed to a batch, by path and stamp: offered once until they change.
  const handed = new Set<string>()

  const keyOf = (path: string, stamp: FileStamp): string =>
    `${path}\n${stamp.size}\n${stamp.mtimeMs}`

  function schedule(folder: string, name: string, stamp: FileStamp | null): void {
    const waiting = settling.get(name)
    if (waiting) clearTimeout(waiting.timer)
    const timer = setTimeout(() => void settle(folder, name), INBOX_SETTLE_MS)
    settling.set(name, { timer, stamp: stamp ?? waiting?.stamp ?? null })
  }

  async function settle(folder: string, name: string): Promise<void> {
    const before = settling.get(name)?.stamp ?? null
    settling.delete(name)
    if (folder !== watched) return
    const path = join(folder, name)
    const now = await dependencies.stamp(path)
    if (now === null) return
    // Still being written, with no event that said so: wait once more.
    if (before === null || before.size !== now.size || before.mtimeMs !== now.mtimeMs) {
      schedule(folder, name, now)
      return
    }
    const key = keyOf(path, now)
    if (handed.has(key)) return
    pending.set(path, key)
    void offer()
  }

  async function offer(): Promise<void> {
    if (processing || pending.size === 0) return
    if (retry !== null) {
      clearTimeout(retry)
      retry = null
    }
    const later = (): void => {
      retry ??= setTimeout(() => {
        retry = null
        void offer()
      }, INBOX_RETRY_MS)
    }
    if (!dependencies.idle()) {
      later()
      return
    }
    processing = true
    const offered = new Map(pending)
    try {
      if (await dependencies.process([...offered.keys()])) {
        for (const [path, key] of offered) {
          handed.add(key)
          if (pending.get(path) === key) pending.delete(path)
        }
      } else {
        later()
      }
    } catch (error) {
      logger.error('The Inbox batch could not be started', error)
      later()
    } finally {
      processing = false
    }
    // What settled while the batch was being started is offered once that one has.
    if (pending.size > 0) later()
  }

  /** A file the watch says changed: its wait starts again from how it is now. */
  async function changed(folder: string, name: string): Promise<void> {
    const stamp = await dependencies.stamp(join(folder, name))
    if (folder === watched) schedule(folder, name, stamp)
  }

  async function look(folder: string): Promise<void> {
    const names = await dependencies.list(folder).catch(() => [])
    for (const name of names) {
      if (!isInboxAudio(name) || settling.has(name)) continue
      const path = join(folder, name)
      const stamp = await dependencies.stamp(path)
      if (stamp === null || handed.has(keyOf(path, stamp)) || pending.has(path)) continue
      schedule(folder, name, stamp)
    }
  }

  function refresh(): void {
    const folder = dependencies.folder()
    if (folder !== watched) {
      unwatch?.()
      unwatch = null
      for (const { timer } of settling.values()) clearTimeout(timer)
      settling.clear()
      pending.clear()
      watched = folder
    }
    if (folder === null) return
    if (unwatch === null) {
      try {
        const ended = (): void => {
          unwatch = null
        }
        unwatch = dependencies.watch(
          folder,
          (name) => {
            if (name === null) void look(folder)
            else if (isInboxAudio(name)) void changed(folder, name)
          },
          ended
        )
      } catch {
        // Not there yet: the next look tries again.
        unwatch = null
      }
    }
    void look(folder)
  }

  return {
    start() {
      refresh()
      recheck ??= setInterval(refresh, INBOX_RECHECK_MS)
    },
    refresh,
    stop() {
      if (recheck !== null) clearInterval(recheck)
      if (retry !== null) clearTimeout(retry)
      recheck = null
      retry = null
      unwatch?.()
      unwatch = null
      for (const { timer } of settling.values()) clearTimeout(timer)
      settling.clear()
    }
  }
}
