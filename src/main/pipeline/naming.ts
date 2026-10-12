// The names of a track: what its file name says, what is junk in it, and the file
// name the app gives it: `Artist feat. X - Title (Mix) [8A Am - 124 - E7].mp3`.
// Pure: nothing here reads or changes a file.
import { MAX_FILE_NAME_LENGTH, UNSAFE_TEXT, unusableNameReason } from '@shared/file-names'
import {
  FEAT_WORD,
  isJunkBracket,
  FEAT_WORD_IN_THE_OPEN,
  JUNK_ADDRESS,
  MIX_NAME,
  OWN_ANALYSIS_PART,
  TRACK_NUMBER_PREFIX,
  VINYL_SIDE_PREFIX
} from '@shared/junk-patterns'
import { keyOfCamelot } from '@shared/keys'

export interface NameParts {
  artist: string | null
  title: string | null
  /** Without its brackets: `Extended Mix`. */
  mix: string | null
}

export interface FileNameParts extends NameParts {
  /** The Camelot code of the key, or null when the track has none. */
  camelot: string | null
  bpm: number | null
  energy: number | null
  /** With its dot, as the file has it: `.mp3`. */
  extension: string
}

// A careful limit for file systems that count a name in bytes: a name of this many
// UTF-8 bytes leaves room within 255 for ` (999)` after a collision and for the temp
// name of a write.
export const MAX_FILE_NAME_BYTES = 228

// In characters and in bytes.
const MAX_MIX_LENGTH = 80
// Written as alternatives: joiners and variation selectors inside one character
// class read as parts of a combined character.
const INVISIBLE =
  /\u200d|\u200c|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]|\u034f|[\u200b\u2060\ufeff\u115f\u1160\u3164\uffa0\u2800\p{Cs}\p{Co}\p{Cn}]/gu

const BRACKETED = /\(([^()]*)\)|\[([^[\]]*)\]/g
const ALL_UNSAFE = new RegExp(UNSAFE_TEXT.source, 'gu')

function tidy(text: string): string {
  return (
    text
      .replace(/\(\s*\)|\[\s*\]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      // The end is only looked for from where it starts, so a long text is read once.
      .replace(/^[\s\-–—_.,;]+|(?<![\s\-–—_,;])[\s\-–—_,;]+$/g, '')
      .trim()
  )
}

function orNull(text: string): string | null {
  const tidied = tidy(text)
  return tidied === '' ? null : tidied
}

// No name is longer than this. What is: a tag or a file name made to keep the
// patterns below busy, which cannot be stopped once they run.
const MAX_CLEANED_LENGTH = 1000

/** A text without junk: bracketed leftovers of video titles, and web addresses. */
export function removeJunk(given: string): string {
  const text = given.slice(0, MAX_CLEANED_LENGTH)
  const withoutBrackets = text.replace(BRACKETED, (whole, round?: string, square?: string) =>
    isJunkBracket(round ?? square ?? '') ? ' ' : whole
  )
  return tidy(withoutBrackets.replace(JUNK_ADDRESS, ' '))
}

/**
 * What a file name says of its track, by the usual patterns: `Artist - Title`,
 * `01. Artist - Title`, `Artist_-_Title`. Without a dash the whole name is the title.
 */
export function parseFileName(fileName: string): NameParts {
  const stem = fileName.slice(0, MAX_CLEANED_LENGTH).replace(/\.[^.\s]{1,5}$/, '')
  const spaced = stem
    .replace(/_/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const named = spaced
    .replace(TRACK_NUMBER_PREFIX, '')
    .replace(VINYL_SIDE_PREFIX, '')
    // A file the app has named before: what it wrote is no part of the title.
    .replace(OWN_ANALYSIS_PART, '')
  const dash = /\s[-–—]\s/.exec(named)
  if (!dash) return { artist: null, title: orNull(named), mix: null }
  return {
    artist: orNull(named.slice(0, dash.index)),
    title: orNull(named.slice(dash.index + dash[0].length)),
    mix: null
  }
}

const FEAT_SOURCE = FEAT_WORD.source
// `(feat. X)` or `[ft X]`: a bracketed part that starts with the word.
const FEAT_BRACKET = new RegExp(`[(\\[]\\s*${FEAT_SOURCE}\\s+([^\\s()[\\]][^()[\\]]*)[)\\]]`, 'i')
// ` feat. X` in the open: up to the next bracket, the next dash between spaces
// (`Song feat. X - Radio Edit`), or the end.
const FEAT_OPEN = new RegExp(
  `\\s${FEAT_WORD_IN_THE_OPEN.source}\\s+([^\\s()[\\]](?:(?!\\s[-–—]\\s)[^()[\\]])*)`,
  'i'
)
// What stands between the names of an artist: `A feat. B`, `A & B`, `A, B`.
const BETWEEN_ARTISTS = /\s*(?:,|&|\bfeat\.|\band\b|\bvs\.?)\s*/i

/** True when an artist names this guest already, as a whole name. */
function namesGuest(artist: string, guest: string): boolean {
  const wanted = guest.toLowerCase()
  return (
    artist.toLowerCase() === wanted ||
    artist.split(BETWEEN_ARTISTS).some((name) => name.trim().toLowerCase() === wanted)
  )
}
// The word between two names, as in `Artist ft X`. Alone at either end it is part
// of a name: `Ft Lauderdale`, `The Feat`.
const FEAT_BETWEEN = new RegExp(`(?<=\\S\\s)${FEAT_SOURCE}(?=\\s+\\S)`, 'gi')

export type NameField = keyof NameParts

/** Takes the guests out of a text: `Title (feat. X)` gives `Title` and `X`. */
function takeGuests(text: string): { rest: string; guests: string[] } {
  const guests: string[] = []
  let rest = text
  for (;;) {
    const match = FEAT_BRACKET.exec(rest) ?? FEAT_OPEN.exec(rest)
    const guest = match ? tidy(match[1] ?? '') : ''
    if (!match || guest === '') return { rest, guests }
    guests.push(guest)
    rest = tidy(rest.slice(0, match.index) + ' ' + rest.slice(match.index + match[0].length))
  }
}

/**
 * Takes the mix out of a title: the last bracketed part that names one. With a mix
 * known already, only its double is taken out; a part that names another version
 * stays in the title, so two versions never end up with one name.
 */
function takeMix(title: string, known: string): { rest: string; mix: string | null } {
  const parts = [...title.matchAll(BRACKETED)]
  for (const part of parts.reverse()) {
    const content = (part[1] ?? part[2] ?? '').trim()
    if (!MIX_NAME.test(content)) continue
    if (known !== '' && content.toLowerCase() !== known.toLowerCase()) continue
    const start = part.index ?? 0
    return {
      rest: tidy(title.slice(0, start) + ' ' + title.slice(start + part[0].length)),
      mix: content
    }
  }
  return { rest: title, mix: null }
}

/**
 * The names of a track as the app writes them. Junk goes; `ft`, `feat` and
 * `featuring` become `feat.`; a guest named in the title moves to the end of the
 * artist; a mix named in the title becomes the mix. `(Original Mix)` is a mix like
 * any other and stays.
 *
 * A name in `keep` is one the user set: it comes back as it went in, and nothing is
 * taken out of it or put into it. So a mix stays in a kept title, a guest stays in
 * the title of a kept artist, and a kept mix takes nothing from the title.
 */
export function cleanNames(
  names: NameParts,
  { keep = [] }: { keep?: readonly NameField[] } = {}
): NameParts {
  const kept = (field: NameField): boolean => keep.includes(field)
  let artist = names.artist === null || kept('artist') ? '' : removeJunk(names.artist)
  // What the app wrote into a file name may have been copied into a tag by hand.
  let title =
    names.title === null || kept('title')
      ? ''
      : removeJunk(names.title).replace(OWN_ANALYSIS_PART, '')
  let mix =
    names.mix === null || kept('mix')
      ? ''
      : tidy(removeJunk(names.mix).replace(/^[([]|[)\]]$/g, ''))

  if (!kept('title') && !kept('mix')) {
    const fromTitle = takeMix(title, mix)
    title = fromTitle.rest
    if (mix === '' && fromTitle.mix !== null) mix = fromTitle.mix
    // The same mix named again in the title goes too, or a second run would find it.
    for (let double = takeMix(title, mix); mix !== '' && double.mix !== null;) {
      title = double.rest
      double = takeMix(title, mix)
    }
  }
  if (!kept('artist')) {
    artist = artist.replace(FEAT_BETWEEN, 'feat.')
    if (!kept('title')) {
      const fromTitle = takeGuests(title)
      title = fromTitle.rest
      for (const guest of fromTitle.guests) {
        // Not twice: tags often name the guest in both places.
        if (namesGuest(artist, guest)) continue
        artist = artist === '' ? guest : `${artist} feat. ${guest}`
      }
    }
  }
  return {
    artist: kept('artist') ? names.artist : orNull(artist),
    title: kept('title') ? names.title : orNull(title),
    mix: kept('mix') ? names.mix : orNull(mix)
  }
}

// What a file system refuses, or reads as something else. `/` and `:` are refused
// by macOS itself; the others by exFAT, which external drives often have.
function fitForFileName(text: string): string {
  return (
    text
      .normalize('NFC')
      // Joiners and halves of characters go without a trace: a space in their
      // place would pull an emoji or a word apart. So does what shows as nothing
      // (fillers, the blank braille pattern, variation selectors) and what no name
      // holds (private-use and unassigned code points): two names that differ only
      // in those would look the same.
      .replace(INVISIBLE, '')
      .replace(ALL_UNSAFE, ' ')
      // Every kind of space is a plain one: `Daft Punk` with a no-break space would
      // be another name that looks the same.
      .replace(/\s/g, ' ')
      .replace(/[/:\\|*<>]/g, '-')
      .replace(/"/g, "'")
      .replace(/\?/g, '')
      .replace(/ {2,}/g, ' ')
      .trim()
  )
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function fits(name: string): boolean {
  return name.length <= MAX_FILE_NAME_LENGTH && utf8Bytes(name) <= MAX_FILE_NAME_BYTES
}

/**
 * `[8A Am - 124 - E7]`: the key, then the tempo and the energy if they are known.
 * Empty without a key. The part always starts with a key, which is how a file name
 * that is read again is known to carry one (`OWN_ANALYSIS_PART`).
 */
function analysisPart({ camelot, bpm, energy }: FileNameParts): string {
  const key = camelot === null ? null : keyOfCamelot(camelot)
  if (!key) return ''
  // Only what the preview would accept as a tempo and an energy: a row of the
  // database is not checked when it is read.
  const tempo = bpm !== null && Number.isFinite(bpm) && bpm >= 20 && bpm <= 400
  const level = energy !== null && Number.isInteger(energy) && energy >= 1 && energy <= 10
  const parts = [
    `${key.camelot} ${key.musical}`,
    tempo ? String(Math.round(bpm)) : null,
    level ? `E${energy}` : null
  ].filter((part) => part !== null)
  return ` [${parts.join(' - ')}]`
}

/**
 * True for a name as `formatFileName` builds one: what the rename may write. Stricter
 * than the rule for names a library file may have, which also has to accept the
 * names files have already.
 */
export function isBuiltFileName(name: string): boolean {
  return (
    unusableNameReason(name, 'file') === null &&
    fits(name) &&
    !/[\\|*<>"?]/.test(name) &&
    // No space but the plain one, and none in front.
    !/[^\S ]|^ /.test(name) &&
    name === name.replace(INVISIBLE, '')
  )
}

/**
 * The file name of a track: `Artist - Title (Mix) [8A Am - 124 - E7].mp3`. Parts
 * that are not known are left out. A name that is too long loses the end of its
 * title, then of its artist; the bracketed part and the extension always stay.
 * Null when there is nothing to name the file by.
 */
export function formatFileName(parts: FileNameParts): string | null {
  // No part of a name is longer than this; composing far more would take seconds.
  const given = (part: string | null): string =>
    part === null ? '' : fitForFileName(part.slice(0, MAX_CLEANED_LENGTH))
  const artist = given(parts.artist)
  const title = given(parts.title)
  // A mix is a few words. One that is not would leave no room for the names.
  let mixCharacters = Array.from(given(parts.mix)).slice(0, MAX_MIX_LENGTH)
  while (utf8Bytes(mixCharacters.join('')) > MAX_MIX_LENGTH) {
    mixCharacters = mixCharacters.slice(0, -1)
  }
  const mix = mixCharacters.join('').trim()
  if (title === '' && artist === '') return null
  const tail = `${mix === '' ? '' : ` (${mix})`}${analysisPart(parts)}${parts.extension}`

  const build = (shownArtist: string, shownTitle: string): string => {
    const names = [shownArtist, shownTitle].filter((part) => part !== '').join(' - ')
    // A name must not start with a dot: the scanner would take the file for hidden.
    return `${names}${tail}`.replace(/^[.\s]+/, '').normalize('NFC')
  }

  // Cut by character, never through the middle of one. Nothing longer than a whole
  // name can stay, so that much is cut at once and the rest character by character.
  let shownArtist = Array.from(artist).slice(0, MAX_FILE_NAME_LENGTH)
  let shownTitle = Array.from(title).slice(0, MAX_FILE_NAME_LENGTH)
  let name = build(artist, title)
  while (!fits(name) && (shownTitle.length > 1 || shownArtist.length > 1)) {
    if (shownTitle.length > 1) shownTitle = shownTitle.slice(0, -1)
    else shownArtist = shownArtist.slice(0, -1)
    name = build(shownArtist.join('').trim(), shownTitle.join('').trim())
  }
  return fits(name) && unusableNameReason(name, 'file') === null ? name : null
}
