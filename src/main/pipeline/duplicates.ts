// Which tracks are copies of one recording, and which copy is the one to keep.
// Pure: it looks at what it is given and touches nothing. The check before a
// download (T-034) asks the same questions of the same functions.

export interface DuplicateCandidate {
  trackId: number
  /** The AcoustID of the recording, or null when no fingerprint match named one. */
  acoustId: string | null
  artist: string | null
  title: string | null
  /** Without its brackets: `Extended Mix`. */
  mix: string | null
  durationMs: number | null
  /** `mp3`, `wav` or `aiff`. */
  format: string
  bitrateKbps: number | null
}

/** Two copies found by their names alone may differ in length by this much. */
export const MAX_LENGTH_DIFFERENCE_MS = 2000

/**
 * Two files with one AcoustID may differ by this much: silence at an end, another
 * encoder. One answer of a lookup that puts a 3 minute file and a 7 minute file
 * under one recording is a wrong answer, not a pair of copies.
 */
export const MAX_RECORDING_LENGTH_DIFFERENCE_MS = 10_000

/**
 * A name as two spellings of it are compared: lower case, `&` read as `and`, and
 * no space more than one. Accents stay: `Tiësto` and `Tiesto` are not the same name.
 */
export function normalizeName(name: string | null): string {
  return (name ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replace(/\s+/gu, ' ')
    .trim()
}

// A track without a mix is the original, whether its name says so or not.
const ORIGINAL_MIXES = new Set(['original mix', 'original', 'original version'])

function normalizeMix(mix: string | null): string {
  const name = normalizeName(mix)
  return ORIGINAL_MIXES.has(name) ? '' : name
}

// No name holds a line break, so it can stand between the parts of a key.
const BETWEEN = '\n'

/** Everything the two rules connect, as groups of two or more, in the order given. */
function connect(candidates: readonly DuplicateCandidate[]): number[][] {
  // Each track points at a track of its group; the one that points at itself names it.
  const parent = new Map<number, number>(candidates.map(({ trackId }) => [trackId, trackId]))
  const find = (id: number): number => {
    let root = id
    for (let next = parent.get(root); next !== undefined && next !== root;) {
      root = next
      next = parent.get(root)
    }
    parent.set(id, root)
    return root
  }
  const join = (a: number, b: number): void => {
    parent.set(find(a), find(b))
  }

  /**
   * Joins the candidates of one key whose lengths lie within `span` of the shortest
   * of them, and starts anew with the first that does not: every two tracks of what
   * is joined are then that close, and a row of files each a little longer than the
   * one before cannot pull a whole folder into one group.
   */
  const joinByLength = (sameKey: readonly DuplicateCandidate[], span: number): void => {
    const timed = sameKey
      .filter((candidate) => candidate.durationMs !== null)
      .sort((a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0))
    let first: DuplicateCandidate | undefined
    for (const candidate of timed) {
      if (first && (candidate.durationMs ?? 0) - (first.durationMs ?? 0) <= span) {
        join(candidate.trackId, first.trackId)
      } else {
        first = candidate
      }
    }
    // A length that is not known speaks neither for nor against. Unless the files
    // of known length fall apart: then nothing says which of them it is a copy of.
    const longest = timed.at(-1)
    const apart = first !== undefined && longest !== undefined && first !== timed[0]
    if (apart) return
    const anchor = timed[0] ?? sameKey[0]
    for (const candidate of sameKey) {
      if (anchor && candidate.durationMs === null) join(candidate.trackId, anchor.trackId)
    }
  }
  const add = (
    buckets: Map<string, DuplicateCandidate[]>,
    key: string,
    candidate: DuplicateCandidate
  ): void => {
    const bucket = buckets.get(key)
    if (bucket) bucket.push(candidate)
    else buckets.set(key, [candidate])
  }

  const byRecording = new Map<string, DuplicateCandidate[]>()
  const byNames = new Map<string, DuplicateCandidate[]>()
  for (const candidate of candidates) {
    const mix = normalizeMix(candidate.mix)
    if (candidate.acoustId !== null && candidate.acoustId !== '') {
      add(byRecording, candidate.acoustId.toLowerCase() + BETWEEN + mix, candidate)
    }
    const artist = normalizeName(candidate.artist)
    const title = normalizeName(candidate.title)
    // A title alone names too many tracks, and a length that is not known cannot
    // be compared: neither is enough to call two files the same recording.
    if (artist === '' || title === '' || candidate.durationMs === null) continue
    add(byNames, [artist, title, mix].join(BETWEEN), candidate)
  }
  for (const recorded of byRecording.values()) {
    joinByLength(recorded, MAX_RECORDING_LENGTH_DIFFERENCE_MS)
  }
  for (const named of byNames.values()) joinByLength(named, MAX_LENGTH_DIFFERENCE_MS)

  const groups = new Map<number, number[]>()
  for (const { trackId } of candidates) {
    const root = find(trackId)
    const group = groups.get(root)
    if (group) group.push(trackId)
    else groups.set(root, [trackId])
  }
  return [...groups.values()].filter((group) => group.length > 1)
}

/**
 * The groups of copies among the candidates, each as the ids of its tracks in the
 * order they were given. Two tracks are copies of one recording when
 *
 * - they have the same AcoustID and the same mix, and their lengths, where both are
 *   known, differ by 10 s at most, or
 * - their artist, title and mix are the same once normalized, and their lengths
 *   differ by 2 s at most.
 *
 * Two mixes of a track (Extended and Radio Edit) are never copies of each other,
 * whatever else they share. Lengths are measured from the shortest file of a name:
 * of three files of 100, 102 and 104 s the first two are a group and the third is
 * not in it. Whatever rules connect them, the files of a group are never more than
 * 10 s apart in length: a group that two rules made wider is cut by length, and
 * the rules are asked again inside each part. A file of unknown length joins a
 * group only when the files of known length it could belong to are one group.
 */
export function findDuplicateGroups(candidates: readonly DuplicateCandidate[]): number[][] {
  const byId = new Map(candidates.map((candidate) => [candidate.trackId, candidate]))
  const order = new Map(candidates.map((candidate, index) => [candidate.trackId, index]))
  const result: number[][] = []
  for (const group of connect(candidates)) {
    const members = group.flatMap((id) => byId.get(id) ?? [])
    const timed = members
      .filter((candidate) => candidate.durationMs !== null)
      .sort((a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0))
    const span = (timed.at(-1)?.durationMs ?? 0) - (timed[0]?.durationMs ?? 0)
    if (span <= MAX_RECORDING_LENGTH_DIFFERENCE_MS) {
      result.push(group)
      continue
    }
    // Two rules have connected what neither would: a file joined to one by its
    // AcoustID and to another by its name. Files whose lengths lie further apart
    // than one recording can be are not one group, so the group is cut by length,
    // measured from the shortest file of each part.
    const parts: DuplicateCandidate[][] = []
    let start = -Infinity
    for (const candidate of timed) {
      const length = candidate.durationMs ?? 0
      if (length - start > MAX_RECORDING_LENGTH_DIFFERENCE_MS) {
        parts.push([])
        start = length
      }
      parts.at(-1)?.push(candidate)
    }
    // The rules are asked again inside each part: a file that hung on the group
    // only by a file that is now in another part is in no group at all. A file of
    // unknown length is asked about with every part, and stays where it belongs.
    const unknown = members.filter((candidate) => candidate.durationMs === null)
    const found = parts.flatMap((part) => connect([...part, ...unknown]))
    // One that two parts both claim is a copy of neither for sure.
    const claims = new Map<number, number>()
    for (const id of found.flat()) claims.set(id, (claims.get(id) ?? 0) + 1)
    for (const each of found) {
      const sure = each.filter((id) => claims.get(id) === 1)
      if (sure.length > 1) result.push(sure)
    }
  }
  const place = (id: number | undefined): number => order.get(id ?? -1) ?? 0
  return result
    .map((group) => [...group].sort((a, b) => place(a) - place(b)))
    .sort((a, b) => place(a[0]) - place(b[0]))
}

const LOSSLESS_FORMATS = new Set(['aiff', 'wav'])

/** True when `a` is the better copy to keep of the two. */
function isBetter(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  const lossless = (candidate: DuplicateCandidate): boolean =>
    LOSSLESS_FORMATS.has(candidate.format)
  if (lossless(a) !== lossless(b)) return lossless(a)
  // The bitrate tells two lossy files apart; of a lossless file it says nothing.
  if (!lossless(a) && (a.bitrateKbps ?? 0) !== (b.bitrateKbps ?? 0)) {
    return (a.bitrateKbps ?? 0) > (b.bitrateKbps ?? 0)
  }
  if ((a.durationMs ?? 0) !== (b.durationMs ?? 0)) {
    return (a.durationMs ?? 0) > (b.durationMs ?? 0)
  }
  // Nothing tells them apart: the one the library knew first, so the answer is
  // the same every time it is asked.
  return a.trackId < b.trackId
}

/**
 * The copy of a group the app would keep: AIFF or WAV before MP3, of two MP3s the
 * one with the higher bitrate, of two of the same quality the longer one. Returns
 * the id of its track, or null for an empty group.
 */
export function suggestKeep(members: readonly DuplicateCandidate[]): number | null {
  let best: DuplicateCandidate | null = null
  for (const member of members) {
    if (best === null || isBetter(member, best)) best = member
  }
  return best?.trackId ?? null
}
