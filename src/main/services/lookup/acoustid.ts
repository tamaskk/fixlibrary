// AcoustID: which recordings a fingerprint belongs to.
import { createHash } from 'crypto'
import { z } from 'zod'
import { cachedAnswer, type LookupCache, type LookupOptions } from './cache'
import { LookupError, type LookupHttp } from './http'
import { cleanText, rawText, UUID } from './text'

const LOOKUP_URL = 'https://api.acoustid.org/v2/lookup'
const INVALID_KEY_CODE = 4
// More than this is noise: the first results are the best ones.
const MAX_MATCHES = 5
const MAX_RECORDINGS = 10

const answerSchema = z.object({
  status: z.string(),
  error: z.object({ code: z.number().optional() }).optional(),
  results: z
    .array(
      z.object({
        id: z.string(),
        score: z.number(),
        recordings: z
          .array(
            z.object({
              id: z.string(),
              title: rawText.optional(),
              duration: z.number().nullable().optional(),
              artists: z.array(z.object({ name: rawText })).optional()
            })
          )
          .optional()
      })
    )
    .optional()
})

const matchSchema = z.object({
  acoustId: z.string().regex(UUID),
  /** 0 to 1: how well the fingerprint fits. */
  score: z.number().min(0).max(1),
  recordings: z.array(
    z.object({
      /** The MusicBrainz id of the recording. */
      id: z.string().regex(UUID),
      title: z.string().nullable(),
      artist: z.string().nullable(),
      durationS: z.number().nullable()
    })
  )
})
const matchesSchema = z.array(matchSchema)

export type AcoustIdMatch = z.output<typeof matchSchema>

export interface AcoustIdClient {
  /** The matches of a fingerprint, best first; null when no key is set. */
  lookup: (
    fingerprint: string,
    durationS: number,
    options?: LookupOptions
  ) => Promise<AcoustIdMatch[] | null>
}

export interface AcoustIdDependencies {
  http: LookupHttp
  cache: LookupCache
  apiKey: () => string | undefined
}

function toMatches(answer: z.output<typeof answerSchema>): AcoustIdMatch[] {
  const matches: AcoustIdMatch[] = []
  for (const result of answer.results ?? []) {
    const match = {
      acoustId: result.id,
      score: result.score,
      recordings: (result.recordings ?? []).slice(0, MAX_RECORDINGS).flatMap((recording) =>
        UUID.test(recording.id)
          ? [
              {
                id: recording.id,
                title: cleanText(recording.title),
                artist: cleanText(recording.artists?.map((artist) => artist.name).join(', ')),
                durationS: recording.duration ?? null
              }
            ]
          : []
      )
    }
    // An entry that does not fit is left out; the others stay.
    if (matchSchema.safeParse(match).success) matches.push(match)
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, MAX_MATCHES)
}

export function createAcoustIdClient(dependencies: AcoustIdDependencies): AcoustIdClient {
  const { http, cache } = dependencies
  return {
    async lookup(fingerprint, durationS, options = {}) {
      const key = dependencies.apiKey()
      if (key === undefined) return null
      // A fingerprint is a few thousand characters: the query is named by its hash.
      const queryKey = `${createHash('sha256').update(fingerprint).digest('hex')}:${durationS}`
      return cachedAnswer(cache, 'acoustid', queryKey, matchesSchema, options, async () => {
        // In the body, not the URL, so the key cannot end up in a proxy or server log line.
        const body = new URLSearchParams({
          client: key,
          format: 'json',
          meta: 'recordings',
          duration: String(durationS),
          fingerprint
        })
        const answer = answerSchema.safeParse(
          // AcoustID answers a key it does not know with a 400 that says so in its JSON.
          await http.json(
            'acoustid',
            LOOKUP_URL,
            { method: 'POST', body, errorsAsJson: true },
            options
          )
        )
        if (!answer.success) throw new LookupError('acoustid', 'invalid')
        if (answer.data.status !== 'ok') {
          const refused = answer.data.error?.code === INVALID_KEY_CODE
          throw new LookupError('acoustid', refused ? 'refused' : 'invalid')
        }
        return toMatches(answer.data)
      })
    }
  }
}
