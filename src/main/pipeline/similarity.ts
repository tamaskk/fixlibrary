// How well two tracks, or a track and a playlist, go together (T-036): by style, tempo,
// key, energy and mood, in that order of weight. Pure, for the recommendations and
// the generator to share.
import type { MoodTag } from '@shared/mood'

/** What the similarity reads of a track. A value that is not known scores 0. */
export interface SimilarityTrack {
  primaryStyleId: number | null
  secondaryStyleId: number | null
  bpm: number | null
  camelotKey: string | null
  energy: number | null
  moodTags: readonly MoodTag[] | null
}

export const SIMILARITY_WEIGHTS = {
  style: 0.35,
  bpm: 0.25,
  key: 0.2,
  energy: 0.12,
  mood: 0.08
} as const

export type SimilarityParts = Record<keyof typeof SIMILARITY_WEIGHTS, number>

// Within this the tempo is the same for mixing; from here to MAX_BPM_GAP it fades out.
const SAME_BPM_GAP = 3
const MAX_BPM_GAP = 8

/** 1 for the same primary style, 0.6 when one's primary is the other's secondary. */
export function styleScore(
  a: Pick<SimilarityTrack, 'primaryStyleId' | 'secondaryStyleId'>,
  b: Pick<SimilarityTrack, 'primaryStyleId' | 'secondaryStyleId'>
): number {
  if (a.primaryStyleId === null || b.primaryStyleId === null) return 0
  if (a.primaryStyleId === b.primaryStyleId) return 1
  if (a.primaryStyleId === b.secondaryStyleId || b.primaryStyleId === a.secondaryStyleId) {
    return 0.6
  }
  return 0
}

/** 1 within 3 BPM, falling in a line to 0 at 8 BPM. */
export function bpmScore(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0
  const gap = Math.abs(a - b)
  if (gap <= SAME_BPM_GAP) return 1
  return Math.max(0, (MAX_BPM_GAP - gap) / (MAX_BPM_GAP - SAME_BPM_GAP))
}

function camelotOf(code: string | null): { number: number; letter: string } | null {
  const match = code === null ? null : /^(1[0-2]|[1-9])([AB])$/u.exec(code)
  return match ? { number: Number(match[1]), letter: match[2] as string } : null
}

/**
 * 1 for the same Camelot key, 0.8 for a neighbour: one step around the wheel with the
 * same letter (12 and 1 are neighbours), or the same number with the other letter.
 */
export function keyScore(a: string | null, b: string | null): number {
  const x = camelotOf(a)
  const y = camelotOf(b)
  if (!x || !y) return 0
  if (x.number === y.number && x.letter === y.letter) return 1
  if (x.number === y.number) return 0.8
  const step = Math.abs(x.number - y.number)
  return x.letter === y.letter && (step === 1 || step === 11) ? 0.8 : 0
}

/** 1 − |difference| / 9 on the 1–10 scale. */
export function energyScore(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0
  return Math.max(0, 1 - Math.abs(a - b) / 9)
}

/** The Jaccard similarity of two sets of moods. */
export function moodScore(a: readonly MoodTag[] | null, b: readonly MoodTag[] | null): number {
  if (!a || !b) return 0
  const union = new Set([...a, ...b])
  if (union.size === 0) return 0
  const shared = a.filter((tag) => b.includes(tag)).length
  return shared / union.size
}

/** The weighted sum of the parts, 0 to 1. */
export function weightedScore(parts: SimilarityParts): number {
  return (Object.keys(SIMILARITY_WEIGHTS) as (keyof SimilarityParts)[]).reduce(
    (sum, part) => sum + SIMILARITY_WEIGHTS[part] * parts[part],
    0
  )
}

/** How well two tracks go together, 0 to 1. */
export function trackSimilarity(a: SimilarityTrack, b: SimilarityTrack): number {
  return weightedScore({
    style: styleScore(a, b),
    bpm: bpmScore(a.bpm, b.bpm),
    key: keyScore(a.camelotKey, b.camelotKey),
    energy: energyScore(a.energy, b.energy),
    mood: moodScore(a.moodTags, b.moodTags)
  })
}

/** What a playlist is like as a whole. */
export interface PlaylistProfile {
  /** The styles of its tracks, each pair once, with the share of the tracks that have it. */
  styles: { primaryStyleId: number | null; secondaryStyleId: number | null; share: number }[]
  /** The median tempo, or null when no track has one. */
  bpm: number | null
  keys: string[]
  /** The mean energy, or null when no track has one. */
  energy: number | null
  /** Its most frequent moods, up to three. */
  moods: MoodTag[]
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

export function buildProfile(tracks: readonly SimilarityTrack[]): PlaylistProfile {
  const pairs = new Map<string, PlaylistProfile['styles'][number]>()
  for (const track of tracks) {
    const key = `${track.primaryStyleId}/${track.secondaryStyleId}`
    const pair = pairs.get(key) ?? {
      primaryStyleId: track.primaryStyleId,
      secondaryStyleId: track.secondaryStyleId,
      share: 0
    }
    pair.share += 1 / tracks.length
    pairs.set(key, pair)
  }
  const energies = tracks.flatMap((track) => (track.energy === null ? [] : [track.energy]))
  const moodCounts = new Map<MoodTag, number>()
  for (const tag of tracks.flatMap((track) => track.moodTags ?? [])) {
    moodCounts.set(tag, (moodCounts.get(tag) ?? 0) + 1)
  }
  return {
    styles: [...pairs.values()],
    bpm: median(tracks.flatMap((track) => (track.bpm === null ? [] : [track.bpm]))),
    keys: [
      ...new Set(tracks.flatMap((track) => (track.camelotKey === null ? [] : [track.camelotKey])))
    ],
    energy:
      energies.length === 0
        ? null
        : energies.reduce((sum, value) => sum + value, 0) / energies.length,
    // The most frequent first; a tie goes by the order of the list, so the same playlist
    // always has the same moods.
    moods: [...moodCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([tag]) => tag)
  }
}

/** The parts of how well a candidate fits a playlist. */
export function profileParts(
  profile: PlaylistProfile,
  candidate: SimilarityTrack
): SimilarityParts {
  return {
    style: profile.styles.reduce((sum, pair) => sum + pair.share * styleScore(candidate, pair), 0),
    bpm: bpmScore(candidate.bpm, profile.bpm),
    key: Math.max(0, ...profile.keys.map((key) => keyScore(candidate.camelotKey, key))),
    energy: energyScore(candidate.energy, profile.energy),
    mood: profile.moods.length === 0 ? 0 : moodScore(candidate.moodTags, profile.moods)
  }
}

/** How well a candidate fits a playlist, 0 to 1. */
export function profileSimilarity(profile: PlaylistProfile, candidate: SimilarityTrack): number {
  return weightedScore(profileParts(profile, candidate))
}
