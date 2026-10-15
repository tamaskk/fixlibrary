// Discogs: the label, the year, the genres and the cover of a release, and a second
// opinion on its name.
import { z } from 'zod'
import { cachedAnswer, type LookupCache, type LookupOptions } from './cache'
import { isImageUrl, LookupError, type LookupHttp } from './http'
import { cleanText, rawText, yearOf } from './text'

const SEARCH_URL = 'https://api.discogs.com/database/search'
const SEARCH_LIMIT = 5

const answerSchema = z.object({ results: z.array(z.unknown()).optional() })

const resultSchema = z.object({
  title: rawText,
  year: z.union([z.string(), z.number()]).nullable().optional(),
  label: z.array(rawText).nullable().optional(),
  cover_image: rawText.nullable().optional(),
  genre: z.array(rawText).nullable().optional(),
  style: z.array(rawText).nullable().optional()
})

// As many genres and styles of a release as a decision needs; each a short name.
const MAX_GENRES = 10
const MAX_GENRE_LENGTH = 60

function namesOf(list: readonly string[] | null | undefined): string[] {
  const names = (list ?? []).flatMap((name) => {
    const clean = cleanText(name)
    return clean !== null && clean.length <= MAX_GENRE_LENGTH ? [clean] : []
  })
  return [...new Set(names)].slice(0, MAX_GENRES)
}

const releaseSchema = z.object({
  /** As Discogs names a release: `Artist - Title`. */
  title: z.string(),
  year: z.number().int().nullable(),
  label: z.string().nullable(),
  /** What Discogs files the release under: broad genres (`Electronic`) and styles (`Deep House`). */
  genres: z.array(z.string().max(MAX_GENRE_LENGTH)).max(MAX_GENRES),
  styles: z.array(z.string().max(MAX_GENRE_LENGTH)).max(MAX_GENRES),
  /** The primary picture of the release; null when it has none Discogs serves. */
  image: z
    .string()
    .refine((url) => isImageUrl('discogs', url))
    .nullable()
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
              label: cleanText(result.data.label?.[0]),
              genres: namesOf(result.data.genre),
              styles: namesOf(result.data.style),
              // A release without a picture is answered with a placeholder of
              // another host, which this leaves out.
              image:
                typeof result.data.cover_image === 'string' &&
                isImageUrl('discogs', result.data.cover_image)
                  ? result.data.cover_image
                  : null
            }
            const checked = releaseSchema.safeParse(release)
            return checked.success ? [checked.data] : []
          })
        }
      )
    }
  }
}
