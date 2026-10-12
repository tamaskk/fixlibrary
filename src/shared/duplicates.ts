// Duplicates: copies of one recording in the library, of which the user keeps one.
import { z } from 'zod'

/**
 * Where the copies that are not kept go, at the top of the library. A folder of
 * this name is no part of the library: no scan reads it, no list shows what is in
 * it, and no run works on it. The app never deletes from it; the user does.
 */
export const DUPLICATES_FOLDER = '_Duplicates'

/**
 * True for the name of that folder, in any letter case: the drives a library lives
 * on do not tell `_duplicates` from `_Duplicates`.
 */
export function isDuplicatesFolder(name: string): boolean {
  return name.toLowerCase() === DUPLICATES_FOLDER.toLowerCase()
}

/** True for a file in a folder named `_Duplicates`, at any depth. */
export function isSetAsidePath(path: string): boolean {
  return path.split('/').slice(0, -1).some(isDuplicatesFolder)
}

/** One copy of a recording, as the "Duplikátumok" tab shows it. */
export interface DuplicateMember {
  trackId: number
  /** The name of the file as it is now. */
  fileName: string
  /** The folder the file is in: two copies may have one name. */
  folder: string
  format: string
  bitrateKbps: number | null
  durationMs: number | null
  /** True for the one copy of its group that stays where it is. */
  keep: boolean
  /** True for the copy the app would keep: the best quality, then the longest. */
  suggested: boolean
  /** Taken out of the batch by the user: this copy is not moved, kept or not. */
  excluded: boolean
}

export interface DuplicateGroup {
  /** Stable while the group has the same first track. */
  id: number
  artist: string | null
  title: string | null
  mix: string | null
  members: DuplicateMember[]
}

export const keepDuplicateSchema = z.strictObject({
  batchId: z.number().int().positive(),
  trackId: z.number().int().positive()
})
export type KeepDuplicate = z.input<typeof keepDuplicateSchema>
