/**
 * Makes untrusted text fit for one line of a log or of the UI: control characters,
 * line and paragraph separators and invisible formatting characters (such as the
 * ones that reverse the reading direction) become spaces, and the result is capped.
 */
export function toOneLine(text: string, maxLength: number): string {
  const oneLine = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  // Counted and cut by code point, so a character outside the basic plane is never halved.
  const characters = Array.from(oneLine)
  return characters.length <= maxLength
    ? oneLine
    : `${characters.slice(0, maxLength - 1).join('')}…`
}
