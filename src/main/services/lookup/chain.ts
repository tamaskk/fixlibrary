// The lookup of one track: AcoustID by fingerprint, MusicBrainz for the names, and
// Discogs for the label and the year. A source that cannot be asked is left out,
// and the others go on.
import type { AcoustIdClient } from './acoustid'
import type { LookupOptions } from './cache'
import {
  fingerprintConfidence,
  knownArtistTitle,
  lengthMatch,
  MATCH_CONFIDENCE,
  similarity,
  textConfidence,
  textSimilarity,
  type ArtistTitle
} from './confidence'
import type { DiscogsClient, DiscogsRelease } from './discogs'
import { LookupError, type LookupFailure, type LookupSource } from './http'
import type { MusicBrainzClient, MusicBrainzRecording } from './musicbrainz'

/** A source whose names can end up in a field. AcoustID only says which recording it is. */
export type FieldOrigin = 'musicbrainz' | 'discogs'

export interface Found<T> {
  value: T
  source: FieldOrigin
}

export interface LookupInput {
  /** What the sidecar made of the audio; null when there is none. */
  fingerprint: { fingerprint: string; duration: number } | null
  durationS: number | null
  /** The tags of the file as the last scan read them. */
  artist: string | null
  title: string | null
  fileName: string
}

export interface LookupResult {
  /** 0 to 1: how sure the best candidate is. 0 when no source named one. */
  confidence: number
  /** True when the candidate is sure enough to take; only then are there fields. */
  matched: boolean
  artist?: Found<string>
  title?: Found<string>
  album?: Found<string>
  label?: Found<string>
  year?: Found<number>
  acoustId: string | null
  musicbrainzRecordingId: string | null
  /** The sources that were asked and gave an answer. */
  answered: LookupSource[]
  /** The sources that could not be asked, with why. */
  failed: { source: LookupSource; failure: LookupFailure }[]
}

export interface LookupClients {
  acoustid: AcoustIdClient
  musicbrainz: MusicBrainzClient
  discogs: DiscogsClient
}

interface Candidate extends ArtistTitle {
  artist: string
  title: string
  source: FieldOrigin
  confidence: number
  album: string | null
  year: number | null
  acoustId: string | null
  musicbrainzRecordingId: string | null
}

// A Discogs release is taken for the same release as the candidate from this on.
const SAME_RELEASE_SIMILARITY = 0.8

/** `Artist - Title` of a Discogs release; an artist may carry `(2)` or `*` there. */
function splitDiscogsTitle(title: string): ArtistTitle {
  const dash = title.indexOf(' - ')
  if (dash <= 0) return { artist: null, title }
  const artist = title
    .slice(0, dash)
    .replace(/\s*\(\d+\)$/, '')
    .replace(/\*$/, '')
    .trim()
  return { artist: artist || null, title: title.slice(dash + 3).trim() || null }
}

export async function lookupTrack(
  input: LookupInput,
  clients: LookupClients,
  options: LookupOptions = {}
): Promise<LookupResult> {
  const known = knownArtistTitle(input)
  const answered = new Set<LookupSource>()
  const failed: LookupResult['failed'] = []

  /** Asks one source. A source that cannot be asked is noted, and the chain goes on. */
  async function ask<T>(source: LookupSource, request: () => Promise<T | null>): Promise<T | null> {
    try {
      const answer = await request()
      if (answer !== null) answered.add(source)
      return answer
    } catch (error) {
      // A lookup that was given up is not a source that failed.
      if (!(error instanceof LookupError) || options.signal?.aborted) throw error
      if (!failed.some((entry) => entry.source === source)) {
        failed.push({ source, failure: error.failure })
      }
      return null
    }
  }

  const fromRecording = (
    recording: MusicBrainzRecording,
    confidence: number,
    acoustId: string | null
  ): Candidate => ({
    artist: recording.artist,
    title: recording.title,
    source: 'musicbrainz',
    confidence,
    album: recording.album,
    year: recording.year,
    acoustId,
    musicbrainzRecordingId: recording.id
  })

  let candidate: Candidate | null = null

  // 1. By fingerprint: the best match of AcoustID, named by MusicBrainz.
  if (input.fingerprint) {
    const { fingerprint, duration } = input.fingerprint
    const matches = await ask('acoustid', () =>
      clients.acoustid.lookup(fingerprint, duration, options)
    )
    // The best match that names a recording: AcoustID knows some fingerprints only by id.
    const best = matches?.find((match) => match.recordings.length > 0)
    if (best) {
      // One fingerprint can belong to several recordings: the one named most like
      // what is known of the track is asked about.
      const closest = [...best.recordings].sort(
        (a, b) => textSimilarity(known, b) - textSimilarity(known, a)
      )[0] as (typeof best.recordings)[number]
      const recording = await ask('musicbrainz', () =>
        clients.musicbrainz.recording(closest.id, options)
      )
      if (recording) {
        const confidence = fingerprintConfidence(
          best.score,
          textSimilarity(known, recording),
          lengthMatch(input.durationS, recording.durationS)
        )
        candidate = fromRecording(recording, confidence, best.acoustId)
      }
    }
  }

  // 2. Without a sure match by fingerprint: a text search for what is known of the
  // track. Also after a match that is not sure enough to take, which a wrong tag or a
  // recording without a length makes of a good fingerprint; the surer of the two stays.
  if ((!candidate || candidate.confidence < MATCH_CONFIDENCE) && known.title !== null) {
    const title = known.title
    const found = await ask('musicbrainz', () =>
      clients.musicbrainz.search(known.artist, title, options)
    )
    for (const recording of found ?? []) {
      const confidence = textConfidence(
        textSimilarity(known, recording),
        lengthMatch(input.durationS, recording.durationS)
      )
      if (!candidate || confidence > candidate.confidence) {
        candidate = fromRecording(recording, confidence, null)
      }
    }
  }

  // 3. Discogs: the label and the year of a match, or a candidate where there is none.
  let release: DiscogsRelease | null = null
  const matchedSoFar = candidate !== null && candidate.confidence >= MATCH_CONFIDENCE
  const asked: ArtistTitle = matchedSoFar ? (candidate as Candidate) : known
  if (asked.artist !== null && asked.title !== null) {
    const { artist, title } = asked
    const releases = await ask('discogs', () => clients.discogs.search(artist, title, options))
    const wanted = `${artist} ${title}`
    const scored = (releases ?? [])
      .map((entry) => {
        const named = splitDiscogsTitle(entry.title)
        return { entry, alike: similarity(wanted, `${named.artist ?? ''} ${named.title ?? ''}`) }
      })
      .sort((a, b) => b.alike - a.alike)[0]
    if (scored && matchedSoFar) {
      if (scored.alike >= SAME_RELEASE_SIMILARITY) release = scored.entry
    } else if (scored) {
      // Discogs knows no length of a track, so only the text counts.
      const confidence = textConfidence(scored.alike, 0)
      const named = splitDiscogsTitle(scored.entry.title)
      if (
        named.artist !== null &&
        named.title !== null &&
        (!candidate || confidence > candidate.confidence)
      ) {
        release = scored.entry
        candidate = {
          artist: named.artist,
          title: named.title,
          source: 'discogs',
          confidence,
          album: null,
          year: null,
          acoustId: null,
          musicbrainzRecordingId: null
        }
      }
    }
  }

  const result: LookupResult = {
    confidence: candidate?.confidence ?? 0,
    matched: false,
    acoustId: null,
    musicbrainzRecordingId: null,
    answered: [...answered],
    failed
  }
  // 4. Below 70% nothing is taken: the tags of the file stay.
  if (!candidate || candidate.confidence < MATCH_CONFIDENCE) return result

  const { source } = candidate
  result.matched = true
  result.artist = { value: candidate.artist, source }
  result.title = { value: candidate.title, source }
  result.acoustId = candidate.acoustId
  result.musicbrainzRecordingId = candidate.musicbrainzRecordingId
  if (candidate.album !== null) result.album = { value: candidate.album, source }
  if (candidate.year !== null) result.year = { value: candidate.year, source }
  if (release?.label != null) result.label = { value: release.label, source: 'discogs' }
  if (result.year === undefined && release?.year != null) {
    result.year = { value: release.year, source: 'discogs' }
  }
  return result
}
