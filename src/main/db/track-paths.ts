import { isAbsolute, normalize } from 'path'

/**
 * The one spelling of a path that is stored and compared. macOS hands back
 * accented names composed or decomposed depending on where they come from;
 * without this the same file could be stored twice.
 */
export function normalizeTrackPath(filePath: string): string {
  if (!isAbsolute(filePath)) throw new Error('A track path must be absolute')
  return normalize(filePath).normalize('NFC')
}

/** The volume a normalized path lives on (`/Volumes/<name>/…`), or null for the startup disk. */
export function volumeNameOfPath(filePath: string): string | null {
  const [, root, name] = normalizeTrackPath(filePath).split('/')
  return root === 'Volumes' && name ? name : null
}
