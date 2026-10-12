// Musical keys in Camelot and musical notation. python/fixlib_py/keys.py mirrors this
// table by hand; change both in the same commit.

export const KEY_SCALES = ['minor', 'major'] as const
export type KeyScale = (typeof KEY_SCALES)[number]

export interface KeyEntry {
  /** `8A`: the number of the wheel, then A for minor and B for major. */
  camelot: string
  /** `Am`, `C`: the name the app writes, one spelling per key. */
  musical: string
  /** The tonic as semitones above C, 0 to 11. */
  pitchClass: number
  scale: KeyScale
}

export const KEYS = [
  { camelot: '1A', musical: 'Abm', pitchClass: 8, scale: 'minor' },
  { camelot: '2A', musical: 'Ebm', pitchClass: 3, scale: 'minor' },
  { camelot: '3A', musical: 'Bbm', pitchClass: 10, scale: 'minor' },
  { camelot: '4A', musical: 'Fm', pitchClass: 5, scale: 'minor' },
  { camelot: '5A', musical: 'Cm', pitchClass: 0, scale: 'minor' },
  { camelot: '6A', musical: 'Gm', pitchClass: 7, scale: 'minor' },
  { camelot: '7A', musical: 'Dm', pitchClass: 2, scale: 'minor' },
  { camelot: '8A', musical: 'Am', pitchClass: 9, scale: 'minor' },
  { camelot: '9A', musical: 'Em', pitchClass: 4, scale: 'minor' },
  { camelot: '10A', musical: 'Bm', pitchClass: 11, scale: 'minor' },
  { camelot: '11A', musical: 'F#m', pitchClass: 6, scale: 'minor' },
  { camelot: '12A', musical: 'Dbm', pitchClass: 1, scale: 'minor' },
  { camelot: '1B', musical: 'B', pitchClass: 11, scale: 'major' },
  { camelot: '2B', musical: 'F#', pitchClass: 6, scale: 'major' },
  { camelot: '3B', musical: 'Db', pitchClass: 1, scale: 'major' },
  { camelot: '4B', musical: 'Ab', pitchClass: 8, scale: 'major' },
  { camelot: '5B', musical: 'Eb', pitchClass: 3, scale: 'major' },
  { camelot: '6B', musical: 'Bb', pitchClass: 10, scale: 'major' },
  { camelot: '7B', musical: 'F', pitchClass: 5, scale: 'major' },
  { camelot: '8B', musical: 'C', pitchClass: 0, scale: 'major' },
  { camelot: '9B', musical: 'G', pitchClass: 7, scale: 'major' },
  { camelot: '10B', musical: 'D', pitchClass: 2, scale: 'major' },
  { camelot: '11B', musical: 'A', pitchClass: 9, scale: 'major' },
  { camelot: '12B', musical: 'E', pitchClass: 4, scale: 'major' }
] as const satisfies readonly KeyEntry[]

export type CamelotKey = (typeof KEYS)[number]['camelot']

/** Every Camelot code, 1A to 12A and then 1B to 12B. */
export const CAMELOT_KEYS = KEYS.map((key) => key.camelot) as [CamelotKey, ...CamelotKey[]]

const NATURAL_PITCH_CLASSES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/**
 * The pitch class of a note name such as `C#`, `Db` or `A`, or null for anything
 * else. Two names of one pitch give one number, which is how `C#` and `Db` end up as
 * the same key.
 */
export function pitchClassOf(note: string): number | null {
  const match = /^([A-Ga-g])([#♯b♭]?)$/.exec(note.trim())
  if (!match) return null
  const natural = NATURAL_PITCH_CLASSES[(match[1] as string).toUpperCase()] as number
  const accidental = match[2]
  const shift = accidental === '' ? 0 : accidental === '#' || accidental === '♯' ? 1 : -1
  return (natural + shift + 12) % 12
}

/** The key with this tonic and scale, or null when the tonic is no note name. */
export function keyOf(tonic: string, scale: KeyScale): KeyEntry | null {
  const pitchClass = pitchClassOf(tonic)
  if (pitchClass === null) return null
  return KEYS.find((key) => key.pitchClass === pitchClass && key.scale === scale) ?? null
}

/** The key a Camelot code names, in any letter case, or null when it names none. */
export function keyOfCamelot(camelot: string): KeyEntry | null {
  const code = camelot.trim().toUpperCase()
  return KEYS.find((key) => key.camelot === code) ?? null
}

/** `8A Am`: both notations, as the file name and the tables show a key. */
export function formatKey(camelot: string): string | null {
  const key = keyOfCamelot(camelot)
  return key && `${key.camelot} ${key.musical}`
}
