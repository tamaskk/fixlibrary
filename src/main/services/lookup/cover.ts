// Where a cover for a track may be found, in the order the places are tried: iTunes
// Search by artist and title, the Cover Art Archive by the MusicBrainz release of a
// sure match, and the picture Discogs has of that release.
import type { CoverSource } from '@shared/covers'
import type { LookupOptions } from './cache'
import type { LookupResult } from './chain'
import { MATCH_CONFIDENCE, similarity } from './confidence'
import { LookupError, type LookupSource } from './http'
import type { ITunesClient, ITunesSong } from './itunes'

/** An iTunes song is taken for the track from this on, by artist and by title alike. */
export const COVER_NAME_SIMILARITY = 0.8

const COVER_ART_ARCHIVE = 'https://coverartarchive.org/release'

export interface CoverQuery {
  artist: string | null
  title: string | null
  mix: string | null
}

export interface CoverCandidate {
  source: CoverSource
  /** The address of the picture, on a host `isImageUrl` accepts for the source. */
  url: string
}

export interface CoverSearch {
  /** The places to try, best first; a later one is worked out only when it is asked for. */
  candidates: AsyncIterable<CoverCandidate>
  /** The sources that could not be asked. */
  failed: Set<LookupSource>
}

/** How alike an iTunes song is to the track: the lesser of artist and title. */
export function songLikeness(query: CoverQuery, song: ITunesSong): number {
  if (query.artist === null || query.title === null) return 0
  // iTunes names the mix in the title, as a tag does: either way is the track.
  const titles = [query.title]
  if (query.mix !== null) titles.push(`${query.title} (${query.mix})`)
  const title = Math.max(...titles.map((known) => similarity(known, song.title)))
  return Math.min(similarity(query.artist, song.artist), title)
}

/**
 * The covers that may be the track's. `lookup` is the lookup of the track (kept
 * answers mostly), asked only when iTunes has nothing that fits.
 */
export function findCover(
  query: CoverQuery,
  itunes: ITunesClient,
  lookup: () => Promise<LookupResult | null>,
  options: LookupOptions = {}
): CoverSearch {
  const failed = new Set<LookupSource>()

  async function ask<T>(source: LookupSource, request: () => Promise<T>): Promise<T | null> {
    try {
      return await request()
    } catch (error) {
      if (!(error instanceof LookupError) || options.signal?.aborted) throw error
      failed.add(source)
      return null
    }
  }

  async function* candidates(): AsyncGenerator<CoverCandidate> {
    const { artist, title } = query
    if (artist !== null && title !== null) {
      const songs = (await ask('itunes', () => itunes.search(artist, title, options))) ?? []
      const fitting = songs
        .map((song) => ({ song, likeness: songLikeness(query, song) }))
        .filter(({ song, likeness }) => song.artwork !== null && likeness >= COVER_NAME_SIMILARITY)
        .sort((a, b) => b.likeness - a.likeness)
      for (const { song } of fitting) yield { source: 'itunes', url: song.artwork as string }
    }
    const found = await lookup()
    if (!found) return
    for (const entry of found.failed) failed.add(entry.source)
    if (!found.matched || found.confidence < MATCH_CONFIDENCE) return
    if (found.musicbrainzReleaseId !== null) {
      yield {
        source: 'coverartarchive',
        url: `${COVER_ART_ARCHIVE}/${found.musicbrainzReleaseId}/front-1200`
      }
    }
    if (found.discogsImage !== null) yield { source: 'discogs', url: found.discogsImage }
  }

  return { candidates: candidates(), failed }
}
