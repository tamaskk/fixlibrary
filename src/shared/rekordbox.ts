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
