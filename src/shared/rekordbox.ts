// What the renderer and the main process share about the Rekordbox XML (T-025).

/** The name of the XML the app writes into the folder Settings names. */
export const REKORDBOX_XML_FILE_NAME = 'fixlibrary.xml'

/**
 * Why the folder of the XML is a poor place for it: a drive that may not be there when
 * Rekordbox imports, or a folder a sync service changes under Rekordbox's feet. Null
 * when nothing is known against it.
 */
export type XmlFolderWarning = 'external' | 'cloud' | null

/** What writing the XML did. */
export interface RekordboxXmlWritten {
  /** Where the XML is, to show and to give Rekordbox. */
  path: string
  /** The tracks in its collection. */
  tracks: number
  /**
   * Tracks of the library left out: on a drive that is not connected, or missing. A
   * copy set aside as a duplicate is no part of the library and is not counted.
   */
  skipped: number
  /** When it was written, in ms since the epoch. */
  writtenAt: number
}

/** A track of the library, as a check of the export names it. */
export interface CheckedTrack {
  trackId: number
  path: string
}

/** How many there are, and the first of them: a list may be thousands long. */
export interface CheckedList<T> {
  count: number
  items: T[]
}

/** At most this many entries of a list of the check go to the page. */
export const MAX_CHECK_ITEMS = 200

/**
 * What reading Rekordbox's export found (T-026), for the wizard of T-027: which
 * tracks of the library it lacks, which of its entries point at no file, and which
 * tracks Rekordbox has not analysed (no grid). Paths and names are made fit for one
 * line in the main process.
 */
export interface RekordboxExportCheck {
  /** The name of the export that was read. */
  fileName: string
  /** When Rekordbox wrote it, in ms since the epoch. */
  exportedAt: number
  /** Tracks in its collection. */
  tracks: number
  /** Its entries that were not read: not what Rekordbox writes. */
  skipped: number
  /** Tracks of the library it has, by path. */
  matched: number
  /** Tracks of the library it does not have. */
  notInExport: CheckedList<CheckedTrack>
  /** Where its entries point at a file that is not there ("missing" in Rekordbox). */
  missingFiles: CheckedList<string>
  /** Its entries on a drive that is not connected: not looked at. */
  unavailable: number
  /** Its entries that could not be looked at: a network folder, or the disk did not say. */
  unchecked: number
  /** Tracks of the library it has without a grid: not analysed yet. */
  unanalysed: CheckedList<CheckedTrack>
}
