// What the Library page reads, and which tracks a run may work on.
import { basename, dirname } from 'path'
import type { AppDatabase } from '../db/connection'
import { countTracks, listTrackAvailability, listTracks, type Track } from '../db/tracks'
import type { Result } from '@shared/errors'
import {
  libraryPageRequestSchema,
  MAX_RUN_STAGES,
  MAX_RUN_TRACKS,
  runRequestSchema,
  type LibraryPage,
  type LibraryTrack,
  type RunTargets
} from '@shared/library'

import { toOneLine } from '@shared/text'

/** The tracks to run on and the functions that were asked for. */
export interface RunPlan extends RunTargets {
  stages: string[]
}

// As long as a file name and a path can be on macOS.
const MAX_NAME_LENGTH = 255
const MAX_FOLDER_LENGTH = 1024

function toLibraryTrack(track: Track): LibraryTrack {
  return {
    id: track.id,
    // For display only: a file name may hold a line break or characters that turn
    // the reading direction around, and would then read as something else.
    fileName: toOneLine(basename(track.path), MAX_NAME_LENGTH),
    folder: toOneLine(dirname(track.path), MAX_FOLDER_LENGTH),
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
 * The tracks a run processes. The renderer only names ids; which of them exist
 * and can be worked on is decided here. A track whose drive is not connected, or
 * whose file the last scan did not find, is never processed.
 */
export function resolveRunTargets(
  db: AppDatabase,
  request: unknown,
  mountedVolumes: ReadonlySet<string>,
  /** The functions a user can ask for. Any other name is refused, whatever it is. */
  selectable: readonly string[]
): Result<RunPlan> {
  // Before the schema looks at every element: a list far too long is refused at once.
  const { trackIds: ids, stages: names } = (request ?? {}) as {
    trackIds?: unknown
    stages?: unknown
  }
  if (Array.isArray(ids) && ids.length > MAX_RUN_TRACKS) return { ok: false, code: 'INVALID_INPUT' }
  if (Array.isArray(names) && names.length > MAX_RUN_STAGES) {
    return { ok: false, code: 'INVALID_INPUT' }
  }
  const parsed = runRequestSchema.safeParse(request)
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
  // A page offers only these, but a page is not to be trusted: a stage that is not
  // meant to be asked for (an apply stage, say) must not get into a batch this way.
  if (!parsed.data.stages.every((name) => selectable.includes(name))) {
    return { ok: false, code: 'INVALID_INPUT' }
  }

  const tracks = listTrackAvailability(db, mountedVolumes)
  const runnable = new Set(
    tracks.filter((track) => !track.offline && !track.fileMissing).map((track) => track.id)
  )
  if (parsed.data.scope === 'library') {
    const trackIds = tracks.filter((track) => runnable.has(track.id)).map((track) => track.id)
    return {
      ok: true,
      value: { trackIds, skipped: tracks.length - trackIds.length, stages: parsed.data.stages }
    }
  }

  const asked = [...new Set(parsed.data.trackIds)]
  const trackIds = asked.filter((id) => runnable.has(id))
  return {
    ok: true,
    value: { trackIds, skipped: asked.length - trackIds.length, stages: parsed.data.stages }
  }
}
