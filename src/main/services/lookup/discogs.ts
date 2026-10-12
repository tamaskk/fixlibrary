// Discogs: the label and the year of a release, and a second opinion on its name.
import { z } from 'zod'
import { cachedAnswer, type LookupCache, type LookupOptions } from './cache'
import { LookupError, type LookupHttp } from './http'
import { cleanText, rawText, yearOf } from './text'

const SEARCH_URL = 'https://api.discogs.com/database/search'
const SEARCH_LIMIT = 5

const answerSchema = z.object({ results: z.array(z.unknown()).optional() })

const resultSchema = z.object({
  title: rawText,
  year: z.union([z.string(), z.number()]).nullable().optional(),
  label: z.array(rawText).nullable().optional()
})

const releaseSchema = z.object({
  /** As Discogs names a release: `Artist - Title`. */
  title: z.string(),
  year: z.number().int().nullable(),
  label: z.string().nullable()
})
const releasesSchema = z.array(releaseSchema)

export type DiscogsRelease = z.output<typeof releaseSchema>

export interface DiscogsClient {
  /** Releases that fit an artist and a title, best first; null when no key is set. */
  search: (
    artist: string,
    title: string,
    options?: LookupOptions
  ) => Promise<DiscogsRelease[] | null>
}

export interface DiscogsDependencies {
  http: LookupHttp
  cache: LookupCache
  credentials: () => { key: string; secret: string } | undefined
}

export function createDiscogsClient(dependencies: DiscogsDependencies): DiscogsClient {
  const { http, cache } = dependencies
  return {
    async search(artist, title, options = {}) {
      const credentials = dependencies.credentials()
      if (credentials === undefined) return null
      const q = `${artist} ${title}`
      return cachedAnswer(
        cache,
        'discogs',
        `search:${q.toLowerCase()}`,
        releasesSchema,
        options,
        async () => {
          const url = `${SEARCH_URL}?${new URLSearchParams({
            q,
            type: 'release',
            per_page: String(SEARCH_LIMIT)
          }).toString()}`
          const headers = {
            Authorization: `Discogs key=${credentials.key}, secret=${credentials.secret}`
          }
          const answer = answerSchema.safeParse(
            await http.json('discogs', url, { method: 'GET', headers }, options)
          )
          if (!answer.success) throw new LookupError('discogs', 'invalid')
          // An entry that does not fit is left out; the others stay.
          return (answer.data.results ?? []).slice(0, SEARCH_LIMIT).flatMap((entry) => {
            const result = resultSchema.safeParse(entry)
            const release = result.success && {
              title: cleanText(result.data.title),
              year: yearOf(result.data.year),
              label: cleanText(result.data.label?.[0])
            }
            const checked = releaseSchema.safeParse(release)
            return checked.success ? [checked.data] : []
          })
        }
      )
    }
  }
}
