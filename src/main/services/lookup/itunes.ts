// iTunes Search: songs that fit an artist and a title, with the address of their cover.
import { z } from 'zod'
import { cachedAnswer, type LookupCache, type LookupOptions } from './cache'
import { isImageUrl, LookupError, type LookupHttp } from './http'
import { cleanText, rawText } from './text'

const SEARCH_URL = 'https://itunes.apple.com/search'
const SEARCH_LIMIT = 5
// The artwork of a song is named by its size; the same picture comes at 600 px.
const SMALL_ARTWORK = '/100x100bb.'
const COVER_ARTWORK = '/600x600bb.'

const answerSchema = z.object({ results: z.array(z.unknown()).optional() })

const resultSchema = z.object({
  artistName: rawText,
  trackName: rawText,
  artworkUrl100: rawText.nullable().optional()
})

const songSchema = z.object({
  artist: z.string(),
  title: z.string(),
  /** The 600 px cover; null when the song names none from the host covers come from. */
  artwork: z
    .string()
    .refine((url) => isImageUrl('itunes', url))
    .nullable()
})
const songsSchema = z.array(songSchema)

export type ITunesSong = z.output<typeof songSchema>

export interface ITunesClient {
  /** Songs that fit an artist and a title, as iTunes ranks them. */
  search: (artist: string, title: string, options?: LookupOptions) => Promise<ITunesSong[]>
}

export interface ITunesDependencies {
  http: LookupHttp
  cache: LookupCache
}

function artworkOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.includes(SMALL_ARTWORK)) return null
  const large = url.replace(SMALL_ARTWORK, COVER_ARTWORK)
  return isImageUrl('itunes', large) ? large : null
}

export function createITunesClient(dependencies: ITunesDependencies): ITunesClient {
  const { http, cache } = dependencies
  return {
    async search(artist, title, options = {}) {
      const term = `${artist} ${title}`
      return cachedAnswer(
        cache,
        'itunes',
        `search:${term.toLowerCase()}`,
        songsSchema,
        options,
        async () => {
          const url = `${SEARCH_URL}?${new URLSearchParams({
            term,
            entity: 'song',
            limit: String(SEARCH_LIMIT)
          }).toString()}`
          const answer = answerSchema.safeParse(
            await http.json('itunes', url, { method: 'GET' }, options)
          )
          if (!answer.success) throw new LookupError('itunes', 'invalid')
          // An entry that does not fit is left out; the others stay.
          return (answer.data.results ?? []).slice(0, SEARCH_LIMIT).flatMap((entry) => {
            const result = resultSchema.safeParse(entry)
            const song = result.success && {
              artist: cleanText(result.data.artistName),
              title: cleanText(result.data.trackName),
              artwork: artworkOf(result.data.artworkUrl100)
            }
            const checked = songSchema.safeParse(song)
            return checked.success ? [checked.data] : []
          })
        }
      )
    }
  }
}
