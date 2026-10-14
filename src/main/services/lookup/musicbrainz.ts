// MusicBrainz: what a recording is called, by its id or by a text search.
import { z } from 'zod'
import { cachedAnswer, type LookupCache, type LookupOptions } from './cache'
import { LookupError, type LookupHttp } from './http'
import { cleanText, rawText, UUID, yearOf } from './text'

const API_URL = 'https://musicbrainz.org/ws/2/recording'
const SEARCH_LIMIT = 5

const artistCreditSchema = z
  .array(z.object({ name: rawText, joinphrase: rawText.optional() }))
  .optional()

const releaseSchema = z.object({
  id: z.string().optional(),
  title: rawText,
  status: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  'release-group': z
    .object({ 'secondary-types': z.array(z.string()).nullable().optional() })
    .nullable()
    .optional()
})

const recordingAnswerSchema = z.object({
  id: z.string(),
  title: rawText,
  length: z.number().nullable().optional(),
  'first-release-date': z.string().nullable().optional(),
  'artist-credit': artistCreditSchema,
  releases: z.array(z.unknown()).optional(),
  /** Only in a search: 0 to 100, how well the text fits. */
  score: z.number().optional()
})

const searchAnswerSchema = z.object({ recordings: z.array(z.unknown()).optional() })

const recordingSchema = z.object({
  id: z.string().regex(UUID),
  title: z.string(),
  artist: z.string(),
  durationS: z.number().nullable(),
  year: z.number().int().nullable(),
  /** The release the recording is best known from; null when it names none. */
  album: z.string().nullable(),
  /** The id of that release, which the Cover Art Archive knows its cover by. */
  releaseId: z.string().regex(UUID).nullable()
})
const keptRecordingSchema = recordingSchema.nullable()
const recordingsSchema = z.array(recordingSchema)

export type MusicBrainzRecording = z.output<typeof recordingSchema>

export interface MusicBrainzClient {
  /** The recording with this id; null when MusicBrainz has none. */
  recording: (id: string, options?: LookupOptions) => Promise<MusicBrainzRecording | null>
  /** Recordings that fit a title, and an artist if one is known; best first. */
  search: (
    artist: string | null,
    title: string,
    options?: LookupOptions
  ) => Promise<MusicBrainzRecording[]>
}

export interface MusicBrainzDependencies {
  http: LookupHttp
  cache: LookupCache
}

type Release = z.output<typeof releaseSchema>

/**
 * The release to name as the album: an official one that is not a compilation, the
 * earliest of them. A recording is often on dozens of samplers.
 */
function bestRelease(releases: readonly unknown[]): {
  album: string | null
  releaseId: string | null
} {
  const known = releases.flatMap((release) => {
    const parsed = releaseSchema.safeParse(release)
    return parsed.success ? [parsed.data] : []
  })
  const isOwn = (release: Release): boolean =>
    !(release['release-group']?.['secondary-types'] ?? []).includes('Compilation')
  const isOfficial = (release: Release): boolean => release.status === 'Official'
  const byDate = (a: Release, b: Release): number =>
    (a.date || '9999').localeCompare(b.date || '9999')
  const best =
    known.filter((release) => isOfficial(release) && isOwn(release)).sort(byDate)[0] ??
    known.filter(isOfficial).sort(byDate)[0] ??
    known.sort(byDate)[0]
  const id = best?.id
  return {
    album: cleanText(best?.title),
    releaseId: id !== undefined && UUID.test(id) ? id : null
  }
}

function toRecording(answer: unknown): MusicBrainzRecording | null {
  const parsed = recordingAnswerSchema.safeParse(answer)
  if (!parsed.success) return null
  const { data } = parsed
  const recording = {
    id: data.id,
    title: cleanText(data.title),
    artist: cleanText(
      (data['artist-credit'] ?? [])
        .map((credit) => credit.name + (credit.joinphrase ?? ''))
        .join('')
    ),
    durationS: typeof data.length === 'number' ? data.length / 1000 : null,
    year: yearOf(data['first-release-date']),
    ...bestRelease(data.releases ?? [])
  }
  const checked = recordingSchema.safeParse(recording)
  return checked.success ? checked.data : null
}

/** A phrase of a Lucene query: only the backslash and the quote need escaping in one. */
function phrase(text: string): string {
  return `"${text.replace(/[\\"]/g, '\\$&')}"`
}

export function createMusicBrainzClient(dependencies: MusicBrainzDependencies): MusicBrainzClient {
  const { http, cache } = dependencies
  return {
    async recording(id, options = {}) {
      if (!UUID.test(id)) return null
      return cachedAnswer(
        cache,
        'musicbrainz',
        `recording:${id}`,
        keptRecordingSchema,
        options,
        async () => {
          // `labels` is no include of a recording; the label comes from Discogs.
          const url = `${API_URL}/${id}?inc=artist-credits+releases+release-groups&fmt=json`
          let answer: unknown
          try {
            answer = await http.json('musicbrainz', url, { method: 'GET' }, options)
          } catch (error) {
            // An id MusicBrainz no longer has is an answer, and is kept as one.
            if (error instanceof LookupError && error.status === 404) return null
            throw error
          }
          const recording = toRecording(answer)
          if (!recording) throw new LookupError('musicbrainz', 'invalid')
          return recording
        }
      )
    },

    async search(artist, title, options = {}) {
      const query =
        artist === null
          ? `recording:${phrase(title)}`
          : `recording:${phrase(title)} AND artist:${phrase(artist)}`
      const queryKey = `search:${query.toLowerCase()}`
      return cachedAnswer(cache, 'musicbrainz', queryKey, recordingsSchema, options, async () => {
        const url = `${API_URL}?${new URLSearchParams({
          query,
          fmt: 'json',
          limit: String(SEARCH_LIMIT)
        }).toString()}`
        const answer = searchAnswerSchema.safeParse(
          await http.json('musicbrainz', url, { method: 'GET' }, options)
        )
        if (!answer.success) throw new LookupError('musicbrainz', 'invalid')
        // An entry that does not fit is left out; the others stay.
        return (answer.data.recordings ?? []).slice(0, SEARCH_LIMIT).flatMap((entry) => {
          const recording = toRecording(entry)
          return recording ? [recording] : []
        })
      })
    }
  }
}
