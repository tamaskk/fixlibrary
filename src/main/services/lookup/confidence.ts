// How sure a lookup is that a candidate is the track it was asked about.

/** A match with less confidence than this is not taken: the tags of the file stay. */
export const MATCH_CONFIDENCE = 0.7

// Two lengths that differ by no more than this are the same recording.
const LENGTH_TOLERANCE_S = 3
// Longer text is compared by its beginning: the cost grows with the product of the lengths.
const MAX_COMPARED_LENGTH = 200

export interface ArtistTitle {
  artist: string | null
  title: string | null
}

/** Text as it is compared: no case, no accents, no punctuation, single spaces. */
export function normalizeForComparison(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, MAX_COMPARED_LENGTH)
}

/** How many single-character edits turn one text into the other. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      current.push(
        Math.min(substitution, (previous[j] as number) + 1, (current[j - 1] as number) + 1)
      )
    }
    previous = current
  }
  return previous[b.length] as number
}

/** 0 to 1: how alike two texts are, by normalized Levenshtein distance. */
export function similarity(a: string, b: string): number {
  const left = normalizeForComparison(a)
  const right = normalizeForComparison(b)
  if (left === '' || right === '') return 0
  return 1 - levenshtein(left, right) / Math.max(left.length, right.length)
}

function joined({ artist, title }: ArtistTitle): string {
  return [artist, title].filter((part) => part !== null).join(' ')
}

/** How alike what is known of a track and a candidate are, by artist and title together. */
export function textSimilarity(known: ArtistTitle, candidate: ArtistTitle): number {
  // With no artist known, an artist of the candidate would only count against it.
  const compared = known.artist === null ? { artist: null, title: candidate.title } : candidate
  return similarity(joined(known), joined(compared))
}

/** 1 when both lengths are known and no more than 3 s apart, else 0. */
export function lengthMatch(aSeconds: number | null, bSeconds: number | null): number {
  if (aSeconds === null || bSeconds === null) return 0
  return Math.abs(aSeconds - bSeconds) <= LENGTH_TOLERANCE_S ? 1 : 0
}

/** For a candidate found by fingerprint. `score` is AcoustID's, 0 to 1. */
export function fingerprintConfidence(score: number, text: number, length: number): number {
  return 0.6 * score + 0.3 * text + 0.1 * length
}

/** For a candidate found by a text search. */
export function textConfidence(text: number, length: number): number {
  return 0.75 * text + 0.25 * length
}

/**
 * What is known of a track before it is looked up: its tags, or what its file name
 * says where a tag is missing (`Artist - Title.mp3`, or the whole name as the title).
 */
export function knownArtistTitle(track: {
  artist: string | null
  title: string | null
  fileName: string
}): ArtistTitle {
  if (track.title !== null) return { artist: track.artist, title: track.title }
  const stem = track.fileName
    .replace(/\.[^.]+$/, '')
    .replace(/_+/g, ' ')
    .trim()
  const dash = stem.indexOf(' - ')
  if (dash > 0) {
    return {
      artist: track.artist ?? stem.slice(0, dash).trim(),
      title: stem.slice(dash + 3).trim() || null
    }
  }
  return { artist: track.artist, title: stem || null }
}
