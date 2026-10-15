// The style decision for a track, from what Claude answered: the rules the app keeps
// whatever Claude says. Pure: no database, no call.
import type { StyleAnswer } from '../services/claude-prompts/style'
import { levenshtein } from '../services/lookup/confidence'
import {
  NEW_STYLE_PALETTE,
  newStyleNameSchema,
  styleKey,
  UNSORTED_STYLE_NAME,
  type Style
} from '@shared/settings'

export { styleKey }

/** Below this (0 to 100) the primary style is not taken: the track is Unsorted. */
export const STYLE_CONFIDENCE = 70

/** The style of the list a name means, if any. */
export function findStyle(name: string, styles: readonly Style[]): Style | undefined {
  const key = styleKey(name)
  return styles.find((style) => styleKey(style.name) === key)
}

/** A style the track is to have: one of the list, or a new one named by Claude. */
export type ChosenStyle = { id: number } | { newName: string }

export interface StyleDecision {
  /** The primary style; Unsorted is a style of the list too. Null only without an Unsorted. */
  primary: ChosenStyle | null
  secondary: { id: number } | null
  /** 0 to 1. */
  confidence: number
  /** True when the track is Unsorted for want of genre data or certainty. */
  unsorted: boolean
}

/**
 * What a track's style is to be. Unsorted when there is no genre to go by, when
 * Claude is less than 70% sure, or when it named no style that may be taken: a new
 * style only where Claude says it is new, where one of the track's own genres names
 * it, where its name is one a folder of the app may have, and never a house style
 * (the house styles are the user's list). A name that differs from one of the list only in case,
 * spaces or hyphens is that style. The secondary style is one of the list, other
 * than the primary, or none.
 */
export function decideStyle(
  answer: Omit<StyleAnswer, 'id'> | null,
  styles: readonly Style[],
  genres: readonly string[]
): StyleDecision {
  const unsortedStyle = styles.find((style) => style.name === UNSORTED_STYLE_NAME)
  const unsorted: StyleDecision = {
    primary: unsortedStyle ? { id: unsortedStyle.id } : null,
    secondary: null,
    confidence: answer === null ? 0 : answer.confidence / 100,
    unsorted: true
  }
  if (answer === null || genres.length === 0 || answer.confidence < STYLE_CONFIDENCE) {
    return unsorted
  }
  const known = findStyle(answer.primary, styles)
  let primary: ChosenStyle
  if (known) {
    if (known.name === UNSORTED_STYLE_NAME) return unsorted
    primary = { id: known.id }
  } else {
    const name = newStyleNameSchema.safeParse(answer.primary)
    // A new style needs the track's own genres to name it, so that the text of a
    // track cannot talk the app into a style nothing about the track supports.
    const named = new Set(genres.flatMap(genreParts).map(styleKey))
    if (
      !answer.isNewStyle ||
      !name.success ||
      isHouseName(name.data) ||
      !named.has(styleKey(name.data))
    ) {
      return unsorted
    }
    primary = { newName: name.data }
  }
  const second = answer.secondary === null ? undefined : findStyle(answer.secondary, styles)
  const secondary =
    second &&
    second.name !== UNSORTED_STYLE_NAME &&
    !(primary && 'id' in primary && primary.id === second.id)
      ? { id: second.id }
      : null
  return { primary, secondary, confidence: answer.confidence / 100, unsorted: false }
}

/**
 * True for a name of a house style, also misspelled: a word within one letter of
 * "house" (`Hous`, `H0use`), or "house" anywhere in it (`Techhouse`). The house
 * styles are the user's list; the app adds none.
 */
export function isHouseName(name: string): boolean {
  if (styleKey(name).includes('house')) return true
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .some((word) => word.length >= 4 && word.length <= 6 && levenshtein(word, 'house') <= 1)
}

/** The names a genre text holds: `Hip-Hop/Rap` is `Hip-Hop` and `Rap`. */
function genreParts(genre: string): string[] {
  return genre
    .split(/[/,;|]/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** The color a style the app adds gets: the first of the palette no style has, else in turn. */
export function nextStyleColor(styles: readonly Style[]): string {
  const used = new Set(styles.map((style) => style.color.toLowerCase()))
  const free = NEW_STYLE_PALETTE.find((color) => !used.has(color))
  return free ?? (NEW_STYLE_PALETTE[styles.length % NEW_STYLE_PALETTE.length] as string)
}

/**
 * The color a new style is to get, by its name: one of the palette's colors no style
 * has (all of them when every one is taken), picked by the name. The same name gets
 * the same color whenever it is asked, so the placeholder drawn in a run and the
 * style created on approval agree; two new names mostly get two colors.
 */
export function newStyleColor(name: string, styles: readonly Style[]): string {
  const used = new Set(styles.map((style) => style.color.toLowerCase()))
  const free = NEW_STYLE_PALETTE.filter((color) => !used.has(color))
  const colors = free.length > 0 ? free : [...NEW_STYLE_PALETTE]
  let hash = 0
  for (const letter of styleKey(name)) hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) >>> 0
  return colors[hash % colors.length] as string
}
