import { createHash, randomUUID } from 'crypto'
import { basename } from 'path'
import { z } from 'zod'
import type { AppDatabase } from '../../db/connection'
import { listJobStageNames } from '../../db/jobs'
import type { Track } from '../../db/tracks'
import type { CoverStore } from '../../services/covers'
import type { LookupCache } from '../../services/lookup/cache'
import { lookupTrack, type LookupClients } from '../../services/lookup/chain'
import { findCover, type CoverCandidate, type CoverQuery } from '../../services/lookup/cover'
import { LookupError, type LookupHttp } from '../../services/lookup/http'
import type { ITunesClient } from '../../services/lookup/itunes'
import { logger } from '../../services/logger'
import type { PythonBridge } from '../../services/python-bridge'
import { COVER_NAMES, MIN_KEPT_COVER_SIZE } from '@shared/covers'
import { AppError } from '@shared/errors'
import type { PreviewField, PreviewValue, Proposal } from '@shared/preview'
import { COVER_RPC_TIMEOUT_MS, STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { CONVERT_FILE_STAGE } from './convert'
import { keptFingerprint } from './fingerprint'
import { LOOKUP_STAGE } from './lookup'
import { SET_ASIDE_STAGE } from './set-aside'
import type { Stage, StageContext, StageResult } from './stage'
import { takesTags, WRITE_TAGS_STAGE } from './write-tags'

export const COVER_STAGE = 'cover'
export const EMBED_COVER_STAGE = 'embedCover'

export interface CoverStageDependencies {
  /** Null while this installation has no sidecar to ask. */
  python: () => Pick<PythonBridge, 'call'> | null
  covers: CoverStore
  cache: LookupCache
  clients: LookupClients
  coverClients: { itunes: ITunesClient; images: Pick<LookupHttp, 'image'> }
}

const thumbName = z.string().regex(COVER_NAMES.thumb)

/**
 * What the cover stage keeps for the preview next to the proposed field: the
 * thumbnail of the new cover, and the cover the file holds now.
 */
export const coverDetailsSchema = z.object({
  thumb: thumbName,
  before: z
    .object({
      width: z.number().int().positive().nullable(),
      height: z.number().int().positive().nullable(),
      thumb: thumbName.nullable()
    })
    .nullable()
})

export type CoverDetails = z.output<typeof coverDetailsSchema>

type Made = { cover: string; thumb: string } | { unreachable: boolean }

/** A text field as the batch holds it now: the proposal, or the track's own value. */
function textOf(proposal: Proposal, field: PreviewField, own: PreviewValue): string | null {
  const proposed = proposal.fields?.[field]
  const value = proposed === undefined ? own : proposed.value
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function queryOf(track: Track, proposal: Proposal): CoverQuery {
  return {
    artist: textOf(proposal, 'artist', track.artist),
    title: textOf(proposal, 'title', track.title),
    mix: textOf(proposal, 'mix', track.mix)
  }
}

function stemOf(url: string): string {
  return createHash('sha1').update(url).digest('hex')
}

/**
 * Finds a cover for a track that has none, or one smaller than 300 × 300, and makes
 * the 600 × 600 JPEG it is to get. A cover of 300 × 300 or more stays as it is. The
 * places are tried in order (iTunes, the Cover Art Archive, Discogs) until one gives
 * a picture the sidecar can make a cover of. Pictures are kept in the covers folder
 * by the hash of their address, so a second run downloads nothing. A track with no
 * cover found keeps what it has, with a warning. Reads the file only.
 */
export function createCoverStage(dependencies: CoverStageDependencies): Stage {
  const { covers, cache, clients, coverClients } = dependencies

  // The cover of one address that is being made. Tracks of one release share the
  // address of its picture and run at the same time: they wait for one download.
  const making = new Map<string, Promise<Made>>()

  /** The cover made of one address: the names, or why there is none. */
  async function make(
    python: Pick<PythonBridge, 'call'>,
    candidate: CoverCandidate,
    stem: string,
    signal: AbortSignal
  ): Promise<Made> {
    const kept = { cover: `${stem}.jpg`, thumb: `${stem}.thumb.jpg` }
    if ((await covers.has(kept.cover, 'cover')) && (await covers.has(kept.thumb, 'thumb'))) {
      return kept
    }
    let bytes: Buffer
    try {
      bytes = await coverClients.images.image(candidate.source, candidate.url, { signal })
    } catch (error) {
      if (!(error instanceof LookupError) || signal.aborted) throw error
      // A picture that is not there (the archive has no front cover of every
      // release), or one a server will not give, is no failure: the next place is
      // asked. A service that could not be reached, or was busy, is one.
      return { unreachable: error.failure === 'unreachable' || error.failure === 'busy' }
    }
    const download = `${stem}.download`
    await covers.save(download, 'download', bytes)
    try {
      const made = await python.call(
        'cover.prepare',
        { source: download },
        { timeoutMs: COVER_RPC_TIMEOUT_MS }
      )
      return { cover: made.cover, thumb: made.thumb }
    } catch (error) {
      // The sidecar refused the picture: too small, or no picture at all.
      if (error instanceof AppError && error.code === 'PYTHON_ERROR') return { unreachable: false }
      throw error
    } finally {
      await covers.remove(download, 'download')
    }
  }

  /** The cover made of one candidate, or null when the candidate gives none. */
  async function coverOf(
    python: Pick<PythonBridge, 'call'>,
    candidate: CoverCandidate,
    failed: Set<string>,
    signal: AbortSignal
  ): Promise<{ cover: string; thumb: string } | null> {
    const stem = stemOf(candidate.url)
    let made: Made | null = null
    const pending = making.get(stem)
    if (pending) {
      // What another track gave up on, this one tries itself.
      made = await pending.catch(() => null)
      if (signal.aborted) throw signal.reason
    }
    if (made === null) {
      const attempt = make(python, candidate, stem, signal)
      making.set(stem, attempt)
      try {
        made = await attempt
      } finally {
        if (making.get(stem) === attempt) making.delete(stem)
      }
    }
    if ('cover' in made) return made
    if (made.unreachable) failed.add(candidate.source)
    return null
  }

  async function run(context: StageContext, track: Track): Promise<StageResult | void> {
    // A WAV gets its cover once it is an AIFF; a copy set aside gets none.
    if (!takesTags(track.path)) return
    const python = dependencies.python()
    if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
    await covers.ensure()
    const { cover: held } = await python.call(
      'cover.inspect',
      { path: track.path },
      { timeoutMs: COVER_RPC_TIMEOUT_MS }
    )
    if (
      held !== null &&
      held.width !== null &&
      held.height !== null &&
      Math.min(held.width, held.height) >= MIN_KEPT_COVER_SIZE
    ) {
      return
    }
    const options = { signal: context.signal, refresh: context.refresh === true }
    const search = findCover(
      queryOf(track, context.proposal),
      coverClients.itunes,
      () =>
        lookupTrack(
          {
            fingerprint: keptFingerprint(cache, track),
            durationS: track.durationMs === null ? null : track.durationMs / 1000,
            artist: track.artist,
            title: track.title,
            fileName: basename(track.path)
          },
          clients,
          options
        ),
      options
    )
    const failed = new Set<string>(search.failed)
    for await (const candidate of search.candidates) {
      const made = await coverOf(python, candidate, failed, context.signal)
      if (!made) continue
      const details: CoverDetails = { thumb: made.thumb, before: held }
      return {
        proposal: {
          fields: { cover: { value: made.cover, source: candidate.source } },
          cover: details
        }
      }
    }
    for (const source of search.failed) failed.add(source)
    if (failed.size > 0) {
      logger.warn(`Cover of track ${track.id} not found without: ${[...failed].join(', ')}`)
      // "No cover" is only true when every place was asked; the next run asks again.
      throw new AppError('LOOKUP_FAILED', 'a cover service could not be asked')
    }
    return { proposal: { warnings: ['NO_COVER'], cover: null } }
  }

  return {
    name: COVER_STAGE,
    phase: 'compute',
    resource: 'network',
    dependsOn: [],
    // A lookup in the same run may name the track better, and asks MusicBrainz and
    // Discogs first: what the cover needs of them is kept by then.
    after: [LOOKUP_STAGE],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.cover,
    warnings: ['NO_COVER'],
    run
  }
}

export interface EmbedCoverStageDependencies {
  db: AppDatabase
  python: () => Pick<PythonBridge, 'call'> | null
}

/** The cover the batch proposes for a track, or null. */
export function proposedCover(proposal: Proposal): string | null {
  const value = proposal.fields?.cover?.value
  return typeof value === 'string' ? value : null
}

/**
 * Embeds the cover the batch found as the one front cover of the file, in place of
 * every picture it held. When the tags of the track are written in the same batch,
 * the cover went in with them and the file is not touched again; otherwise this is
 * the one write, after the original was backed up or copied.
 */
export function createEmbedCoverStage(dependencies: EmbedCoverStageDependencies): Stage {
  return {
    name: EMBED_COVER_STAGE,
    phase: 'apply',
    resource: 'io',
    dependsOn: [COVER_STAGE],
    after: [CONVERT_FILE_STAGE, SET_ASIDE_STAGE, WRITE_TAGS_STAGE],
    selectable: false,
    timeoutMs: STAGE_TIMEOUTS_MS.embedCover,
    run: async ({ files, proposal, batchId }, track) => {
      if (!files) throw new Error('an apply stage must be given its files')
      const copy = await files.ensureCleanCopy()
      const numbered = copy.collided
        ? { proposal: { warnings: ['NAME_COLLISION' as const] } }
        : undefined
      const cover = proposedCover(proposal)
      if (cover === null || !takesTags(track.path)) return numbered
      // The tags of the batch carried the cover: this stage runs only after they
      // were written. Asking the file would ask the original in the clean library,
      // which never gets it, and write the copy a second time.
      if (listJobStageNames(dependencies.db, batchId).includes(WRITE_TAGS_STAGE)) return numbered
      const python = dependencies.python()
      if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
      const fields = { cover }
      const { changed } = await python.call(
        'tags.would_change',
        { path: track.path, fields },
        { timeoutMs: STAGE_TIMEOUTS_MS.tags }
      )
      if (!changed) return numbered
      const source = await files.workingPath()
      await files.replaceContent(async (tempPath, signal) => {
        const jobId = randomUUID()
        await python.call(
          'tags.write',
          { src: source, dst: tempPath, fields, jobId },
          { timeoutMs: STAGE_TIMEOUTS_MS.tags, job: { id: jobId, signal } }
        )
      })
      return numbered
    }
  }
}
