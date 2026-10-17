// Writes the Rekordbox XML of the library (T-025): which tracks go in, what each says,
// the playlists of the styles and of the user, and the hot cues in the fixed scheme.
import { basename, extname } from 'path'
import { listAnalysesOfType } from '../db/analyses'
import { listAllCues, type Cue } from '../db/cues'
import type { AppDatabase } from '../db/connection'
import { listPlaylistsWithTracks } from '../db/playlists'
import { listStyles } from '../db/styles'
import { listLibraryTracks, type Track } from '../db/tracks'
import { logger } from '../services/logger'
import {
  saveRekordboxXml,
  writeRekordboxXml,
  type XmlCue,
  type XmlTempo,
  type XmlTrack,
  type XmlTrackKind
} from '../services/rekordbox-xml'
import { describeError } from '../services/error-text'
import { isSetAsidePath } from '@shared/duplicates'
import { AppError, type Result } from '@shared/errors'
import type { RekordboxXmlWritten } from '@shared/rekordbox'
import type { Settings } from '@shared/settings'
import { readSettings, resolveEffectiveSettings, type SettingsEnvironment } from './settings'
import { rbGridSchema } from './rekordbox-import'
import { styleComment } from './stages/style-tags'
import { titleWithMix } from './stages/write-tags'

const KINDS: Readonly<Record<Track['format'], XmlTrackKind>> = {
  mp3: 'MP3 File',
  aiff: 'AIFF File',
  wav: 'WAV File'
}

/** Text as a tag holds it: one line, or null for none. */
function text(value: string | null): string | null {
  const line = value?.replace(/\s+/gu, ' ').trim() ?? ''
  return line === '' ? null : line
}

/** The hot cues of a track in the fixed scheme: slot 1 is A, `Num` 0; the colors are the Settings'. */
function cuesOf(cues: readonly Cue[], hotCues: Settings['hotCues']): XmlCue[] {
  return cues.flatMap((cue) => {
    const scheme = hotCues[cue.slot - 1]
    if (!scheme) return []
    return [
      {
        num: cue.slot - 1,
        name: text(cue.name) ?? scheme.name,
        startSeconds: cue.positionMs / 1000,
        color: scheme.color
      }
    ]
  })
}

/** The grid of a track as `rb_grid` keeps it; none when it cannot be read. */
function gridOf(stored: unknown): XmlTempo[] {
  const parsed = rbGridSchema.safeParse(stored)
  return parsed.success ? parsed.data.tempos : []
}

/** What the XML says of a track: what its tags say, and its primary style as the genre. */
export function xmlTrackOf(
  track: Track,
  styleNames: ReadonlyMap<number, string>,
  cues: readonly XmlCue[],
  tempos: readonly XmlTempo[] = []
): XmlTrack {
  const title = text(track.title)
  const mix = text(track.mix)
  const primary = track.primaryStyleId === null ? null : styleNames.get(track.primaryStyleId)
  const secondary =
    track.secondaryStyleId === null ? null : (styleNames.get(track.secondaryStyleId) ?? null)
  return {
    id: track.id,
    // A track without a title is named by its file, as Rekordbox names it.
    name:
      titleWithMix(title ?? undefined, mix ?? undefined) ??
      basename(track.path, extname(track.path)),
    artist: text(track.artist),
    album: text(track.album),
    genre: primary ?? text(track.genre),
    label: text(track.label),
    mix,
    year: track.year,
    comments: text(styleComment(track.energy, secondary)),
    kind: KINDS[track.format],
    sizeBytes: track.fileSizeBytes,
    totalTimeSeconds: track.durationMs === null ? null : Math.round(track.durationMs / 1000),
    bitRateKbps: track.bitrateKbps,
    sampleRateHz: track.sampleRateHz,
    averageBpm: track.bpm,
    tonality: text(track.musicalKey),
    path: track.path,
    tempos,
    cues
  }
}

export interface RekordboxExportDependencies {
  db: AppDatabase
  environment: SettingsEnvironment
  listMountedVolumes: () => ReadonlySet<string>
  appVersion: string
  /** True while files of the library are being changed or scanned: the paths are not final. */
  isBusy: () => boolean
  now?: () => number
}

/**
 * Writes the XML of the whole library into the folder Settings names. Left out: a
 * copy set aside as a duplicate, a track on a drive that is not connected, and one
 * whose file is missing; Rekordbox would only list them as missing. Each style is a
 * playlist of its tracks, in the order of the list; the user's playlists go into the
 * folder "Playlists".
 */
export async function exportRekordboxXml(
  dependencies: RekordboxExportDependencies
): Promise<Result<RekordboxXmlWritten>> {
  const { db } = dependencies
  if (dependencies.isBusy()) return { ok: false, code: 'RUN_ACTIVE' }
  const settings = readSettings(db)
  const folder = resolveEffectiveSettings(settings, dependencies.environment).generatedXmlFolder

  const all = listLibraryTracks(db, dependencies.listMountedVolumes())
  // The library list leaves set-aside copies out already; asked again here, by the
  // same rule, because a copy in the XML would lead Rekordbox to a duplicate.
  const tracks = all.filter(
    (track) => !track.offline && !track.fileMissing && !isSetAsidePath(track.path)
  )
  const included = new Set(tracks.map((track) => track.id))
  const styles = listStyles(db)
  const styleNames = new Map(styles.map((style) => [style.id, style.name]))
  // Rekordbox's grid of each track, from its export (T-026): an import must not move it.
  const grids = listAnalysesOfType(db, 'rb_grid')
  const cuesByTrack = new Map<number, Cue[]>()
  for (const cue of listAllCues(db)) {
    const list = cuesByTrack.get(cue.trackId)
    if (list) list.push(cue)
    else cuesByTrack.set(cue.trackId, [cue])
  }

  const xml = writeRekordboxXml(
    {
      tracks: tracks.map((track) =>
        xmlTrackOf(
          track,
          styleNames,
          cuesOf(cuesByTrack.get(track.id) ?? [], settings.hotCues),
          gridOf(grids.get(track.id)?.result)
        )
      ),
      stylePlaylists: styles.map((style) => ({
        name: style.name,
        trackIds: tracks
          .filter((track) => track.primaryStyleId === style.id)
          .map((track) => track.id)
      })),
      playlists: listPlaylistsWithTracks(db).map((playlist) => ({
        name: playlist.name,
        trackIds: playlist.trackIds.filter((id) => included.has(id))
      }))
    },
    { appVersion: dependencies.appVersion }
  )

  try {
    const path = await saveRekordboxXml(folder, xml, {
      // The app's own default folder is made; one the user chose must be there.
      createFolder: settings.rekordbox.generatedXmlFolder === null,
      // A batch that began meanwhile may have moved files: the paths read are old.
      stillValid: () => !dependencies.isBusy()
    })
    const written = {
      path,
      tracks: tracks.length,
      skipped: all.length - tracks.length,
      writtenAt: (dependencies.now ?? Date.now)()
    }
    logger.info(`Rekordbox XML written: ${written.tracks} tracks, ${written.skipped} left out`)
    return { ok: true, value: written }
  } catch (error) {
    if (error instanceof AppError && error.code === 'RUN_ACTIVE') {
      return { ok: false, code: 'RUN_ACTIVE' }
    }
    logger.error(`The Rekordbox XML could not be written: ${describeError(error)}`)
    return { ok: false, code: 'WRITE_FAILED' }
  }
}
