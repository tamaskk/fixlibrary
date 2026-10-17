// The beats, bars and phrases of Rekordbox's grid, and where a cue lands on them (T-030).
// The same counting as `beats_of` in fixlib_py/analysis/structure.py, which places the
// automatic cues: a beat from each marker on, its place in the bar from the marker's
// `battito`, a phrase every eight bars from the first downbeat.

/** One beat marker of the grid, as `rb_grid` keeps it. */
export interface GridMarker {
  /** Where the marker is, in seconds. */
  inizio: number
  bpm: number
  /** The meter, `4/4`. */
  metro: string
  /** Which beat of the bar the marker is on, 1 the downbeat. */
  battito: number
}

/** How strongly a line of the grid is drawn. */
export type BeatLevel = 'beat' | 'bar' | 'phrase'

export interface GridBeat {
  /** Seconds from the start of the track. */
  time: number
  level: BeatLevel
}

/** Bars of a phrase, as the structure counts them. */
export const PHRASE_BARS = 8

// As the structure stops: twenty minutes of beats at 240 BPM.
const MAX_BEATS = 20 * 60 * 4

function beatsPerBarOf(metro: string): number {
  const head = /^(\d{1,2})\//u.exec(metro)?.[1]
  const beats = head === undefined ? 4 : Number(head)
  return beats >= 1 && beats <= 16 ? beats : 4
}

/** Every beat of the grid up to `durationSeconds`, each with its level, in time order. */
export function beatsOf(grid: readonly GridMarker[], durationSeconds: number): GridBeat[] {
  const markers = [...grid]
    .filter((marker) => marker.bpm > 0 && marker.inizio >= 0)
    .sort((a, b) => a.inizio - b.inizio)
  const beats: GridBeat[] = []
  let bars = 0
  markers.forEach((marker, index) => {
    const end = markers[index + 1]?.inizio ?? durationSeconds
    const period = 60 / marker.bpm
    const perBar = beatsPerBarOf(marker.metro)
    for (let count = 0; beats.length < MAX_BEATS; count += 1) {
      const time = marker.inizio + count * period
      // The next marker takes over a hair before its own time: no doubled beat.
      if (time >= end - 1e-6) break
      const place = ((marker.battito - 1 + count) % perBar) + 1
      let level: BeatLevel = 'beat'
      if (place === 1) {
        level = bars % PHRASE_BARS === 0 ? 'phrase' : 'bar'
        bars += 1
      }
      beats.push({ time, level })
    }
  })
  return beats
}

// How long a track is taken to be for its grid, when its row knows no length: as long
// as the structure and the waveform go.
const UNKNOWN_DURATION_S = 20 * 60

/** The length the grid of a track is counted to, in seconds. */
export function gridDurationSeconds(durationMs: number | null): number {
  return durationMs && durationMs > 0 ? durationMs / 1000 : UNKNOWN_DURATION_S
}

/** How a cue is let go: onto the nearest beat, or with Shift onto the nearest bar start. */
export type SnapMode = 'beat' | 'bar'

/**
 * The beat a cue let go at `seconds` lands on: the nearest beat, or the nearest start
 * of a bar (a phrase start is one too). Null for a grid without such a beat.
 */
export function snapToGrid(
  beats: readonly GridBeat[],
  seconds: number,
  mode: SnapMode
): number | null {
  let best: number | null = null
  for (const beat of beats) {
    if (mode === 'bar' && beat.level === 'beat') continue
    if (best === null || Math.abs(beat.time - seconds) < Math.abs(best - seconds)) best = beat.time
  }
  return best
}
