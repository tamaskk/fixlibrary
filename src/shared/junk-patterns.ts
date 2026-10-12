// What is thrown out of a track name: the leftovers of download sites and video
// titles. Every pattern is narrow on purpose. A word such as "Audio" or "Lyrics" is
// junk only as a whole bracketed phrase, never inside a title.

/**
 * What a bracketed part of a name holds when the whole part is junk, brackets and
 * all. Matched against the text between `(…)` or `[…]`, without case.
 */
export const JUNK_BRACKET_CONTENTS: readonly RegExp[] = [
  /^official\s+(?:music\s+|lyrics?\s+)?(?:video|audio|visuali[sz]er)$/i,
  /^(?:visuali[sz]er|lyrics?\s+video|lyrics|audio|video|premiere)$/i,
  /^(?:hd|hq|4k|\d{2,4}\s?kbps|out\s+now)$/i,
  /^free\s+(?:download|dl)$/i
]

/** True for the content of a bracketed part that is thrown out whole. */
export function isJunkBracket(content: string): boolean {
  const text = content.trim()
  return JUNK_BRACKET_CONTENTS.some((pattern) => pattern.test(text))
}

/**
 * A web address: `http…`, `www.…`, or a word that ends in a common domain. The word
 * is only looked for from where a word starts, so a long text is read once.
 */
export const JUNK_ADDRESS =
  /(?:https?:\/\/[^\s()[\]]+|www\.[^\s()[\]]+|(?<![^\s()[\]])[^\s()[\]]+\.(?:com|net|org)(?=$|[\s()[\]]))/gi

/**
 * A track number in front of a file name: a number with a leading zero (`01 `,
 * `01.`), a number with a dot or a bracket and a space (`1. `, `12) `), or one or two
 * digits and a dash in front of `Artist - Title` (`7 - Artist - Title`). Anything
 * else is left alone, because numbers are names too: `50 Cent`, `2 Unlimited`,
 * `808 State`, `311 - Amber`, `50.Cent`, `3.14`.
 */
export const TRACK_NUMBER_PREFIX =
  /^(?:0\d\s*[.)]\s*|0\d\s+-\s+|0\d\s+|\d{1,3}[.)]\s+|\d{1,2}\s+-\s+(?=\S.*\s-\s))(?=\S)/

/**
 * The side and number of a vinyl rip in front of a file name: `A1 `, `B2 `. Only
 * taken off a name that goes on as `Artist - Title`, so `U2` and `B2B` stay.
 */
export const VINYL_SIDE_PREFIX = /^[A-D][1-9]\s+(?=\S.*\s-\s)/

/**
 * What the app itself writes at the end of a file name: `[8A Am - 124 - E7]`. Taken
 * off a file name that is read again, so that a file named once is not given the
 * part a second time; with it goes the ` (2)` a name collision put after it. It
 * starts with a key, which the app never leaves out: a bare number in brackets
 * (`[303]`, `[1999]`) is part of a title.
 */
export const OWN_ANALYSIS_PART =
  /(?<!\s)\s*\[(?:1[0-2]|[1-9])[AB] [A-G][#b]?m?(?: - \d{2,3})?(?: - E(?:10|[1-9]))?\](?: \(\d{1,3}\))?$/

/**
 * The word in front of a guest where no bracket marks it: `Title feat. X`. Only as
 * it is written on purpose, with its dot or in full. A bare `ft` or `feat` in a
 * title is as often a word of the title: `Trip to Ft Lauderdale`, `6 ft Under`.
 */
export const FEAT_WORD_IN_THE_OPEN = /(?:\bfeaturing\b|\bfeat\.|\bft\.)/i

/**
 * What names a mix inside a bracketed part: `Original Mix`, `X Remix`, `Radio Edit`.
 * Such a part is kept: it becomes the mix of the track.
 */
export const MIX_NAME =
  /\b(?:mix|remix|re-?mix|edit|re-?edit|version|dub|rework|bootleg|mash-?up|vip|instrumental|acapella|a\s?cappella|flip|refix|remaster(?:ed)?|live)\b/i

/** `feat.` as people write it: `ft`, `ft.`, `feat`, `feat.`, `featuring`, in any case. */
export const FEAT_WORD = /\b(?:featuring|feat|ft)\b\.?/i
