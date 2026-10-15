// Which names a file or a folder of the library may get, and which text is safe to
// show and to build a name from. One rule for the preview that shows a name and for
// the code that gives it to a file, so the two cannot disagree.

/**
 * Characters that text shown to the user or put into a name must not hold: control
 * characters, line and paragraph separators, and every invisible formatting
 * character (the ones that turn the reading direction around, the zero-width ones,
 * the soft hyphen, tag characters) plus the Hangul filler, which shows as nothing.
 * Two texts that differ only in those would look the same.
 */
export const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}ㅤ]/u

// The longest name a file may get, in UTF-16 units as APFS and exFAT count them: it
// leaves room for ` (999)` and for the temp name of a later write.
export const MAX_FILE_NAME_LENGTH = 220

export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.aif', '.aiff'] as const

/** The extension of a name with its dot, in lower case; empty when it has none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // A leading dot starts a hidden name, not an extension.
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * Why a name cannot be given to a file or a folder of the library, or null if it can.
 * The text a name is built from (tags, lookups) is not to be trusted.
 */
export function unusableNameReason(name: string, kind: 'file' | 'folder'): string | null {
  if (name.length === 0 || name === '.' || name === '..') return 'it is empty or a dot name'
  if (name.length > MAX_FILE_NAME_LENGTH) return 'it is too long'
  if (name.includes('/') || name.includes(':')) return 'it holds a path separator'
  if (UNSAFE_TEXT.test(name)) return 'it holds an invisible or control character'
  // Hidden from the scanner, and a temp name would be deleted at the next start.
  if (name.startsWith('.')) return 'it starts with a dot'
  if (name.endsWith(' ') || name.endsWith('.')) return 'it ends with a space or a dot'
  if (name !== name.normalize('NFC')) return 'it is not composed (NFC)'
  if (kind === 'file' && !(AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(name))) {
    return 'it is not an audio file name'
  }
  return null
}

// What a folder name may not hold on any drive the library can be on.
const FOLDER_UNSAFE = /[/\\:*?<>|"]/gu
const UNSAFE_TEXT_ALL = new RegExp(UNSAFE_TEXT.source, 'gu')

/**
 * The name of the folder of a style: the style's name with what a folder name may
 * not hold made a hyphen, composed, without dots or spaces at its ends. Null when
 * nothing usable is left.
 */
export function folderNameOf(name: string): string | null {
  // What shows as nothing goes before the name is composed: composed after, it stays so.
  const folder = name
    .replace(UNSAFE_TEXT_ALL, '')
    .normalize('NFC')
    .replace(FOLDER_UNSAFE, '-')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s.]+|[\s.]+$/gu, '')
  return folder !== '' && unusableNameReason(folder, 'folder') === null ? folder : null
}
