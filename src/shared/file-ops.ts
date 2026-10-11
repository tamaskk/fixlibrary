// What the apply phase may do to the file of a track, and what it reports about it.

/**
 * The kinds of change a batch makes to a file. `move` renames or moves it; the
 * others replace its content, each written by the stage that owns the format.
 */
export const FILE_OPERATION_KINDS = [
  'move',
  'writeTags',
  'convert',
  'replaceAudio',
  'embedCover'
] as const
export type FileOperationKind = (typeof FILE_OPERATION_KINDS)[number]

/** Something about a file change that the user should see in the batch preview. */
export const FILE_WARNINGS = ['NAME_COLLISION'] as const
/** `NAME_COLLISION`: the wanted name was taken, so the file got ` (2)`, ` (3)`, … */
export type FileWarning = (typeof FILE_WARNINGS)[number]

/** Whether the backups or copies of a batch fit on their volume. */
export interface SpaceCheck {
  enough: boolean
  /** What the batch still has to copy, in bytes, on the volume with the least room. */
  neededBytes: number
  /** The free space of that volume, in bytes. */
  freeBytes: number
}
