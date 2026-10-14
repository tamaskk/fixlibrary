// Covers live in one folder of the app (`userData/covers`), each under a name built
// from a SHA-1: of the address it was downloaded from, or of the picture a file holds.
// A name is all that crosses to the sidecar or the page; fixlib_py/cover.py has the
// same rules.

const HASH = '[0-9a-f]{40}'

export const COVER_NAMES = {
  /** A 600 × 600 JPEG the app made, ready to be embedded. */
  cover: new RegExp(`^${HASH}\\.jpg$`),
  /** A small JPEG of a cover, for the preview. */
  thumb: new RegExp(`^${HASH}\\.thumb\\.jpg$`),
  /** A picture as a service sent it, before the sidecar made a cover of it. */
  download: new RegExp(`^${HASH}\\.download$`)
} as const

export type CoverNameKind = keyof typeof COVER_NAMES

export function isCoverName(name: unknown, kind: CoverNameKind): name is string {
  return typeof name === 'string' && COVER_NAMES[kind].test(name)
}

/** The size from which a cover a file holds already is kept as it is. */
export const MIN_KEPT_COVER_SIZE = 300

/** Where a new cover came from, as the preview names it. */
export const COVER_SOURCES = ['itunes', 'coverartarchive', 'discogs'] as const
export type CoverSource = (typeof COVER_SOURCES)[number]
