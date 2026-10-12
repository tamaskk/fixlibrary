// Text that a lookup service sent is untrusted: it is cleaned before it is kept.
import { z } from 'zod'
import { toOneLine } from '@shared/text'

// As long as a field of a batch preview may be.
const MAX_TEXT_LENGTH = 300

// What no name holds and JSON can still carry: halves of a character, private-use
// and unassigned code points, and letters that show as nothing (Hangul fillers, the
// blank braille pattern). Such text would break a tag or a file name later on.
const UNUSABLE = /[\p{Cs}\p{Co}\p{Cn}\u115f\u1160\u3164\uffa0\u2800]+/gu

/** One clean line of at most 300 characters, composed; null when nothing is left. */
export function cleanText(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const clean = toOneLine(text.replace(UNUSABLE, '').normalize('NFC'), MAX_TEXT_LENGTH)
  return clean === '' ? null : clean
}

/** A year a release can have, from a date such as `1997-06` or a number. */
export function yearOf(date: string | number | null | undefined): number | null {
  const match = /^(\d{4})(?:\D|$)/.exec(String(date ?? ''))
  const year = match ? Number(match[1]) : 0
  return year >= 1000 && year <= 9999 ? year : null
}

/** Text of an answer before it is cleaned: bounded, so a huge value is refused early. */
export const rawText = z.string().max(10_000)

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
