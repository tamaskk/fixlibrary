import { basename } from 'path'
import { z } from 'zod'
import type { Track } from '../../db/tracks'
import type { LookupCache } from '../../services/lookup/cache'
import { lookupTrack, type LookupClients, type LookupResult } from '../../services/lookup/chain'
import { UUID } from '../../services/lookup/text'
import { logger } from '../../services/logger'
import { AppError } from '@shared/errors'
import type { Proposal } from '@shared/preview'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { FINGERPRINT_STAGE, keptFingerprint } from './fingerprint'
import type { Stage, StageContext, StageResult } from './stage'

export const LOOKUP_STAGE = 'lookup'

export interface LookupStageDependencies {
  cache: LookupCache
  clients: LookupClients
}

/**
 * What a lookup found out about which recording a track is. Stored next to the
 * fields of the proposal, and written to the track when the batch is approved.
 */
export const identifiersSchema = z.object({
  acoustId: z.string().regex(UUID).nullable(),
  musicbrainzRecordingId: z.string().regex(UUID).nullable()
})

function proposalOf(track: Track, result: LookupResult): Proposal & Record<string, unknown> {
  const { confidence } = result
  if (!result.matched) {
    // Nothing sure enough was found: the tags of the file stay, and are named as
    // what they are. The row is flagged, because nobody checked these names.
    const fields: NonNullable<Proposal['fields']> = {}
    if (track.artist !== null) fields.artist = { value: track.artist, source: 'id3', confidence }
    if (track.title !== null) fields.title = { value: track.title, source: 'id3', confidence }
    // Said outright, so that the ids of an earlier answer do not stay with the row.
    return { fields, warnings: ['LOW_CONFIDENCE'], identifiers: null }
  }
  const fields: NonNullable<Proposal['fields']> = {}
  if (result.artist) fields.artist = { ...result.artist, confidence }
  if (result.title) fields.title = { ...result.title, confidence }
  if (result.album) fields.album = { ...result.album, confidence }
  if (result.label) fields.label = { ...result.label, confidence }
  if (result.year) fields.year = { ...result.year, confidence }
  return {
    fields,
    identifiers: {
      acoustId: result.acoustId,
      musicbrainzRecordingId: result.musicbrainzRecordingId
    }
  }
}

/**
 * Looks a track up online: by its fingerprint where there is one, by its names
 * otherwise. Every answer is kept, so a second run sends nothing; `context.refresh`
 * asks the services again.
 */
export function createLookupStage(dependencies: LookupStageDependencies): Stage {
  const { cache, clients } = dependencies

  async function run(context: StageContext, track: Track): Promise<StageResult> {
    const result = await lookupTrack(
      {
        fingerprint: keptFingerprint(cache, track),
        durationS: track.durationMs === null ? null : track.durationMs / 1000,
        artist: track.artist,
        title: track.title,
        fileName: basename(track.path)
      },
      clients,
      { signal: context.signal, refresh: context.refresh === true }
    )
    if (result.failed.length > 0) {
      // The app's own words only: which source, and which kind of failure.
      const sources = result.failed.map(({ source, failure }) => `${source} ${failure}`).join(', ')
      logger.warn(`Lookup of track ${track.id} went on without: ${sources}`)
    }
    // "Not found" is only true when every source was asked. With one that could not
    // be, the track fails instead, so the next run asks again; what did answer is kept.
    if (!result.matched && result.failed.length > 0) {
      throw new AppError('LOOKUP_FAILED', 'a lookup service could not be asked')
    }
    return { proposal: proposalOf(track, result) }
  }

  return {
    name: LOOKUP_STAGE,
    phase: 'compute',
    resource: 'network',
    dependsOn: [FINGERPRINT_STAGE],
    selectable: true,
    refreshable: true,
    proposes: ['artist', 'title', 'album', 'label', 'year'],
    timeoutMs: STAGE_TIMEOUTS_MS.lookup,
    warnings: ['LOW_CONFIDENCE'],
    run
  }
}
