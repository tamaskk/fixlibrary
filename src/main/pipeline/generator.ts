// The playlist generator (T-039): a list of tracks of the library that can be mixed one
// into the next and follows an energy curve and an order of styles. A beam search keeps
// the five best partial lists at every place, so one poor choice does not lead the
// list into a dead end the way picking the best next track alone would.
import type { AppDatabase } from '../db/connection'
import { listStyles } from '../db/styles'
import { listLibraryTracks, type Track } from '../db/tracks'
import {
  createPlaylistPromptTask,
  type PlaylistPromptAnswer
} from '../services/claude-prompts/playlist-prompt'
import type { Claude } from './claude'
import type { OnlineRecs } from './online-recs'
import { editPlaylist, itemOf } from './playlists'
import { keyScore, moodScore } from './similarity'
import { energyAt } from '@shared/energy-curves'
import { AppError, type Result } from '@shared/errors'
import {
  ALTERNATIVE_COUNT,
  MAX_SET_TRACKS,
  type AlternativesRequest,
  type GapTarget,
  type GeneratedEntry,
  type GeneratorParams,
  type GeneratorResult,
  type PromptParams,
  type SaveRequest
} from '@shared/generator'
import type { MoodTag } from '@shared/mood'
import type { PlaylistTrackItem } from '@shared/playlists'

const BEAM_WIDTH = 5
// The best next tracks each partial list is continued with.
const EXPANSIONS = 8
const MAX_BPM_STEP = 3
// Around each change of style, this much of the set on either side takes both styles.
const STYLE_OVERLAP = 0.05
// A gap costs more than any track gains, so a list with fewer gaps always wins.
const GAP_PENALTY = 1
const DEFAULT_TRACK_MS = 6 * 60 * 1000
const MAX_PLACES = MAX_SET_TRACKS * 2
const WEIGHTS = { style: 0.45, energy: 0.45, mood: 0.1 } as const

/** A track the generator can place: one with a tempo, a key and an energy. */
export interface GeneratorTrack {
  id: number
  bpm: number
  camelotKey: string
  energy: number
  durationMs: number | null
  primaryStyleId: number | null
  secondaryStyleId: number | null
  moodTags: readonly MoodTag[] | null
}

/** The rule two neighbours of the list keep: a key that mixes, and 3 BPM at most apart. */
export function mixesWith(
  a: Pick<GeneratorTrack, 'bpm' | 'camelotKey'>,
  b: Pick<GeneratorTrack, 'bpm' | 'camelotKey'>
): boolean {
  return Math.abs(a.bpm - b.bpm) <= MAX_BPM_STEP && keyScore(a.camelotKey, b.camelotKey) > 0
}

/** The styles the set takes at t: one of the order, two around a change. */
export function stylesAt(styleIds: readonly number[], t: number): number[] {
  if (styleIds.length === 0) return []
  const at = (x: number): number =>
    styleIds[Math.min(styleIds.length - 1, Math.max(0, Math.floor(x * styleIds.length)))] as number
  return [...new Set([at(t - STYLE_OVERLAP), at(t), at(t + STYLE_OVERLAP)])]
}

function styleFit(track: GeneratorTrack, accepted: readonly number[]): number {
  if (accepted.length === 0) return 1
  if (track.primaryStyleId !== null && accepted.includes(track.primaryStyleId)) return 1
  if (track.secondaryStyleId !== null && accepted.includes(track.secondaryStyleId)) return 0.6
  return 0
}

/** How well a track fits a place of the set, 0 to 1. */
export function placeScore(track: GeneratorTrack, t: number, params: GeneratorParams): number {
  const target = energyAt(params.energyProfile, t, params.customCurve)
  const mood = params.moods.length === 0 ? 1 : moodScore(track.moodTags, params.moods)
  return (
    WEIGHTS.style * styleFit(track, stylesAt(params.styleIds, t)) +
    WEIGHTS.energy * (1 - Math.abs(track.energy - target) / 9) +
    WEIGHTS.mood * mood
  )
}

/** The tracks of the library the generator can use: analysed, playable, in the tempo range. */
export function generatorTracksOf(
  tracks: readonly Track[],
  params: Pick<GeneratorParams, 'bpmRange' | 'length'>
): GeneratorTrack[] {
  const [low, high] = params.bpmRange
  return tracks.flatMap((track) => {
    const { bpm, camelotKey, energy } = track
    if (bpm === null || camelotKey === null || energy === null) return []
    if (track.offline || track.fileMissing || bpm < low || bpm > high) return []
    // A set measured in minutes needs to know how long its tracks are.
    if (params.length.unit === 'minutes' && track.durationMs === null) return []
    return [
      {
        id: track.id,
        bpm,
        camelotKey,
        energy,
        durationMs: track.durationMs,
        primaryStyleId: track.primaryStyleId,
        secondaryStyleId: track.secondaryStyleId,
        moodTags: track.moodTags
      }
    ]
  })
}

/** One place of a list: a track, or a gap and what it should have been like. */
export type Place =
  | { kind: 'track'; track: GeneratorTrack; t: number }
  | { kind: 'gap'; target: Omit<GapTarget, 'styleName'>; t: number }

interface Beam {
  places: Place[]
  /** The last track placed: the next one is judged against it, also after a gap. */
  last: GeneratorTrack | null
  used: Set<number>
  score: number
  elapsedMs: number
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] as number
}

/**
 * Where on the curve a track of this length is put: the middle of it. A set counted in
 * tracks has places of equal size.
 */
function timeOf(
  params: GeneratorParams,
  place: number,
  elapsedMs: number,
  durationMs: number
): number {
  return params.length.unit === 'tracks'
    ? (place + 0.5) / params.length.value
    : (elapsedMs + durationMs / 2) / (params.length.value * 60_000)
}

function isDone(params: GeneratorParams, beam: Beam): boolean {
  if (beam.places.length >= MAX_PLACES) return true
  return params.length.unit === 'tracks'
    ? beam.places.length >= params.length.value
    : beam.elapsedMs >= params.length.value * 60_000
}

/**
 * Generates a list. Every two neighbours mix (`mixesWith`), each track is in the
 * tempo range and in the list once. A place no track can take becomes a gap, and the
 * next place is judged against the track before the gap.
 */
export function generateList(library: readonly GeneratorTrack[], params: GeneratorParams): Place[] {
  const typicalMs =
    median(library.flatMap((track) => (track.durationMs === null ? [] : [track.durationMs]))) ??
    DEFAULT_TRACK_MS
  const [low, high] = params.bpmRange
  let beams: Beam[] = [{ places: [], last: null, used: new Set(), score: 0, elapsedMs: 0 }]
  while (beams.some((beam) => !isDone(params, beam))) {
    const next: Beam[] = []
    for (const beam of beams) {
      if (isDone(params, beam)) {
        next.push(beam)
        continue
      }
      const place = beam.places.length
      const scored = library
        .filter(
          (track) => !beam.used.has(track.id) && (beam.last === null || mixesWith(beam.last, track))
        )
        .map((track) => {
          const t = timeOf(params, place, beam.elapsedMs, track.durationMs ?? typicalMs)
          return { track, t, score: placeScore(track, t, params) }
        })
        .sort((a, b) => b.score - a.score || a.track.id - b.track.id)
        .slice(0, EXPANSIONS)
      for (const { track, t, score } of scored) {
        next.push({
          places: [...beam.places, { kind: 'track', track, t }],
          last: track,
          used: new Set(beam.used).add(track.id),
          score: beam.score + score,
          elapsedMs: beam.elapsedMs + (track.durationMs ?? typicalMs)
        })
      }
      if (scored.length === 0) {
        const t = timeOf(params, place, beam.elapsedMs, typicalMs)
        next.push({
          ...beam,
          places: [
            ...beam.places,
            {
              kind: 'gap',
              t,
              target: {
                styleId: stylesAt(params.styleIds, t)[0] ?? null,
                bpm: beam.last?.bpm ?? Math.round((low + high) / 2),
                camelotKey: beam.last?.camelotKey ?? null,
                energy: Math.round(energyAt(params.energyProfile, t, params.customCurve) * 10) / 10
              }
            }
          ],
          score: beam.score - GAP_PENALTY,
          elapsedMs: beam.elapsedMs + typicalMs
        })
      }
    }
    // Lists of different lengths are compared by their mean, so short tracks gain nothing.
    const mean = (beam: Beam): number => beam.score / Math.max(1, beam.places.length)
    beams = next.sort((a, b) => mean(b) - mean(a)).slice(0, BEAM_WIDTH)
  }
  return beams[0]?.places ?? []
}

/**
 * Up to five tracks that could take the place of the one at `index`: each mixes with
 * the tracks on both sides, is in the tempo range and not in the list yet.
 */
export function alternativesAt(
  library: readonly GeneratorTrack[],
  params: GeneratorParams,
  list: readonly (number | null)[],
  index: number
): GeneratorTrack[] {
  const byId = new Map(library.map((track) => [track.id, track]))
  const neighbour = (at: number): GeneratorTrack | undefined => {
    const id = list[at]
    return id === null || id === undefined ? undefined : byId.get(id)
  }
  const before = neighbour(index - 1)
  const after = neighbour(index + 1)
  const held = new Set(list.flatMap((id) => (id === null ? [] : [id])))
  const typicalMs = DEFAULT_TRACK_MS
  const lengthOf = (id: number | null): number =>
    (id === null ? undefined : byId.get(id)?.durationMs) ?? typicalMs
  const elapsedMs = list.slice(0, index).reduce<number>((sum, id) => sum + lengthOf(id), 0)
  return library
    .filter(
      (track) =>
        !held.has(track.id) &&
        (before === undefined || mixesWith(before, track)) &&
        (after === undefined || mixesWith(track, after))
    )
    .map((track) => ({
      track,
      score: placeScore(
        track,
        timeOf(params, index, elapsedMs, track.durationMs ?? typicalMs),
        params
      )
    }))
    .sort((a, b) => b.score - a.score || a.track.id - b.track.id)
    .slice(0, ALTERNATIVE_COUNT)
    .map(({ track }) => track)
}

export interface GeneratorDependencies {
  db: AppDatabase
  listMountedVolumes: () => ReadonlySet<string>
  /** Null before Claude was set up. */
  claude: () => Pick<Claude, 'ask'> | null
  onlineRecs: () => Pick<OnlineRecs, 'requestGap' | 'downloadGap'> | null
}

function libraryOf(dependencies: GeneratorDependencies): Track[] {
  return listLibraryTracks(dependencies.db, dependencies.listMountedVolumes())
}

/** The list as the page shows it. */
export function generate(
  dependencies: GeneratorDependencies,
  params: GeneratorParams
): GeneratorResult {
  const tracks = libraryOf(dependencies)
  const byId = new Map(tracks.map((track) => [track.id, track]))
  const styles = new Map(listStyles(dependencies.db).map((style) => [style.id, style.name]))
  const places = generateList(generatorTracksOf(tracks, params), params)
  const entries: GeneratedEntry[] = places.flatMap((place): GeneratedEntry[] => {
    const targetEnergy = energyAt(params.energyProfile, place.t, params.customCurve)
    if (place.kind === 'gap') {
      const { styleId } = place.target
      return [
        {
          kind: 'gap',
          target: {
            ...place.target,
            styleName: styleId === null ? null : (styles.get(styleId) ?? null)
          }
        }
      ]
    }
    const track = byId.get(place.track.id)
    return track === undefined ? [] : [{ kind: 'track', item: itemOf(track, styles), targetEnergy }]
  })
  const deviations = places.flatMap((place) =>
    place.kind === 'track'
      ? [Math.abs(place.track.energy - energyAt(params.energyProfile, place.t, params.customCurve))]
      : []
  )
  return {
    entries,
    gaps: places.filter((place) => place.kind === 'gap').length,
    totalMs: places.reduce(
      (sum, place) => sum + (place.kind === 'track' ? (place.track.durationMs ?? 0) : 0),
      0
    ),
    meanEnergyDeviation:
      deviations.length === 0
        ? null
        : deviations.reduce((sum, value) => sum + value, 0) / deviations.length
  }
}

export function alternatives(
  dependencies: GeneratorDependencies,
  request: AlternativesRequest
): Result<PlaylistTrackItem[]> {
  if (request.index >= request.list.length) return { ok: false, code: 'INVALID_INPUT' }
  const tracks = libraryOf(dependencies)
  const byId = new Map(tracks.map((track) => [track.id, track]))
  const styles = new Map(listStyles(dependencies.db).map((style) => [style.id, style.name]))
  // The neighbours are judged as they are, also outside the tempo range of now.
  const library = generatorTracksOf(tracks, { ...request.params, bpmRange: [0, Infinity] })
  const found = alternativesAt(library, request.params, request.list, request.index).filter(
    (track) => track.bpm >= request.params.bpmRange[0] && track.bpm <= request.params.bpmRange[1]
  )
  return {
    ok: true,
    value: found.flatMap((track) => {
      const full = byId.get(track.id)
      return full === undefined ? [] : [itemOf(full, styles)]
    })
  }
}

/** Reads a prompt into the fields it names. Styles the user does not have are named apart. */
export async function parsePrompt(
  dependencies: GeneratorDependencies,
  prompt: string
): Promise<Result<{ params: PromptParams; unknownStyles: string[] }>> {
  const claude = dependencies.claude()
  if (claude === null) return { ok: false, code: 'CLAUDE_FAILED' }
  const styles = listStyles(dependencies.db)
  const byName = new Map(styles.map((style) => [style.name.toLowerCase(), style.id]))
  let answer: Omit<PlaylistPromptAnswer, 'id'>
  try {
    answer = await claude.ask(createPlaylistPromptTask(styles.map((style) => style.name)), {
      prompt
    })
  } catch (error) {
    if (error instanceof AppError) return { ok: false, code: error.code }
    throw error
  }
  const params: PromptParams = {}
  const styleIds = answer.styles.flatMap((name) => {
    const id = byName.get(name.toLowerCase())
    return id === undefined ? [] : [id]
  })
  if (styleIds.length > 0) params.styleIds = [...new Set(styleIds)]
  if (answer.minutes !== null && answer.minutes >= 10) {
    params.length = { unit: 'minutes', value: answer.minutes }
  } else if (answer.tracks !== null && answer.tracks >= 2) {
    params.length = { unit: 'tracks', value: answer.tracks }
  }
  if (answer.bpmMin !== null && answer.bpmMax !== null && answer.bpmMin <= answer.bpmMax) {
    params.bpmRange = [answer.bpmMin, answer.bpmMax]
  }
  if (answer.energyProfile !== null) params.energyProfile = answer.energyProfile
  if (answer.moods.length > 0) params.moods = answer.moods as MoodTag[]
  return {
    ok: true,
    value: {
      params,
      unknownStyles: answer.styles.filter((name) => !byName.has(name.toLowerCase()))
    }
  }
}

/** Saves the tracks of a list as a new playlist, in their order; the gaps are left out. */
export function saveAsPlaylist(
  dependencies: GeneratorDependencies,
  request: SaveRequest & { name: string }
): Result<{ playlistId: number; skipped: number }> {
  const deps = { db: dependencies.db, listMountedVolumes: dependencies.listMountedVolumes }
  const created = editPlaylist(deps, { action: 'create', name: request.name })
  if (!created.ok) return created
  const playlistId = created.value.view?.id
  if (playlistId === undefined) return { ok: false, code: 'UNEXPECTED' }
  const added = editPlaylist(deps, { action: 'add', playlistId, trackIds: request.trackIds })
  if (!added.ok) return added
  return { ok: true, value: { playlistId, skipped: added.value.skipped } }
}
