// The folder of the app where the waveforms of the cue editor are kept (T-030): one
// `<track id>.json` per track, written by the sidecar, which is told the folder when it
// starts (`FIXLIB_PEAKS_DIR`). Only the user may read it.
import { constants } from 'fs'
import { chmod, lstat, mkdir, open, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import { MAX_PEAKS } from '@shared/rpc'

/** The waveform of a track as its file holds it, with the file it was made of. */
export interface StoredPeaks {
  peaksPerSecond: number
  durationSeconds: number
  /** The track goes on past the twenty minutes the waveform shows. */
  truncated: boolean
  fileSizeBytes: number | null
  fileMtimeMs: number | null
  peaks: number[]
}

export interface PeaksStore {
  folder: string
  /**
   * Makes the folder, only the user's; refuses a link in its place. The first time,
   * also removes what a stopped sidecar left (its temp files) and the waveforms of
   * tracks that are no more, by their exact names, plain files only.
   */
  ensure: (trackIds: () => ReadonlySet<number>) => Promise<void>
  /** The kept waveform of a track, or null when there is none the app can read. */
  read: (trackId: number) => Promise<StoredPeaks | null>
}

const PEAKS = /^([1-9][0-9]{0,15})\.json$/u
const TEMP_FILE = /^\.[1-9][0-9]{0,15}\.json\.[0-9]+\.[0-9]+\.fixlib-tmp$/u
// Twenty minutes of peaks of four digits and a comma, and the rest of the file.
const MAX_FILE_BYTES = MAX_PEAKS * 5 + 4096

const storedPeaksSchema = z.object({
  version: z.literal(1),
  peaksPerSecond: z.literal(100),
  durationSeconds: z
    .number()
    .nonnegative()
    .max(20 * 60 + 1),
  truncated: z.boolean(),
  fileSizeBytes: z.number().int().nonnegative().nullable(),
  fileMtimeMs: z.number().int().nonnegative().nullable(),
  peaks: z.array(z.number().int().min(0).max(1000)).max(MAX_PEAKS)
})

export function createPeaksStore(folder: string): PeaksStore {
  let tidied = false

  async function tidy(trackIds: ReadonlySet<number>): Promise<void> {
    for (const name of await readdir(folder)) {
      const kept = PEAKS.exec(name)
      const stale = TEMP_FILE.test(name) || (kept && !trackIds.has(Number(kept[1])))
      if (!stale) continue
      const path = join(folder, name)
      const found = await lstat(path).catch(() => null)
      if (found?.isFile()) await rm(path, { force: true })
    }
  }

  return {
    folder,
    async ensure(trackIds) {
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const stats = await lstat(folder)
      if (!stats.isDirectory()) throw new Error('the peaks folder is not a folder')
      if ((stats.mode & 0o077) !== 0) await chmod(folder, 0o700)
      if (tidied) return
      tidied = true
      await tidy(trackIds())
    },
    async read(trackId) {
      const path = join(folder, `${trackId}.json`)
      // The file itself, never a link at its place, and no more of it than peaks can take.
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      ).catch(() => null)
      if (!file) return null
      let text: string
      try {
        const stats = await file.stat()
        if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null
        const buffer = Buffer.alloc(stats.size)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        text = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await file.close()
      }
      try {
        const parsed = storedPeaksSchema.safeParse(JSON.parse(text))
        if (!parsed.success) return null
        const { peaksPerSecond, durationSeconds, truncated, fileSizeBytes, fileMtimeMs, peaks } =
          parsed.data
        return { peaksPerSecond, durationSeconds, truncated, fileSizeBytes, fileMtimeMs, peaks }
      } catch {
        // A file cut short by a crash, or not of the sidecar's: made again.
        return null
      }
    }
  }
}
