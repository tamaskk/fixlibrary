// What the Library page reads, and which tracks a run may work on.
import { basename, dirname } from 'path'
import type { AppDatabase } from '../db/connection'
import { countTracks, listTrackAvailability, listTracks, type Track } from '../db/tracks'
import type { Result } from '@shared/errors'
import {
  libraryPageRequestSchema,
  runRequestSchema,
  type LibraryPage,
  type LibraryTrack,
  type RunTargets
} from '@shared/library'

function toLibraryTrack(track: Track): LibraryTrack {
  return {
    id: track.id,
    fileName: basename(track.path),
    folder: dirname(track.path),
    format: track.format,
    durationMs: track.durationMs,
    artist: track.artist,
    title: track.title,
    bpm: track.bpm,
    camelotKey: track.camelotKey,
    energy: track.energy,
    styleId: track.primaryStyleId,
    coverStatus: track.coverStatus,
    stageStatus: track.stageStatus,
    offline: track.offline,
    fileMissing: track.fileMissing
  }
}

/** One page of the library in path order, with the size of the whole library. */
export function listLibraryPage(
  db: AppDatabase,
  request: unknown,
  mountedVolumes: ReadonlySet<string>
): Result<LibraryPage> {
  const page = libraryPageRequestSchema.safeParse(request)
  if (!page.success) return { ok: false, code: 'INVALID_INPUT' }
  return {
    ok: true,
    value: {
      tracks: listTracks(db, page.data, mountedVolumes).map(toLibraryTrack),
      total: countTracks(db)
    }
  }
}

/**
 * The tracks a run would process. The renderer only names ids; which of them exist
 * and can be worked on is decided here. A track whose drive is not connected, or
 * whose file the last scan did not find, is never processed.
 */
export function resolveRunTargets(
  db: AppDatabase,
  request: unknown,
  mountedVolumes: ReadonlySet<string>
): Result<RunTargets> {
  const parsed = runRequestSchema.safeParse(request)
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }

  const tracks = listTrackAvailability(db, mountedVolumes)
  const runnable = new Set(
    tracks.filter((track) => !track.offline && !track.fileMissing).map((track) => track.id)
  )
  if (parsed.data.scope === 'library') {
    const trackIds = tracks.filter((track) => runnable.has(track.id)).map((track) => track.id)
    return { ok: true, value: { trackIds, skipped: tracks.length - trackIds.length } }
  }

  const asked = [...new Set(parsed.data.trackIds)]
  const trackIds = asked.filter((id) => runnable.has(id))
  return { ok: true, value: { trackIds, skipped: asked.length - trackIds.length } }
}
