// The batch preview: what a batch proposes for each track, shown to the user for
// editing and approval before anything is written.
import { z } from 'zod'
import { COVER_NAMES } from './covers'
import type { TrackError } from './errors'
import { unusableNameReason, UNSAFE_TEXT } from './file-names'
import { FILE_WARNINGS } from './file-ops'
import { CAMELOT_KEYS } from './keys'

/** The fields a preview shows. The column sets of the batch types choose from these. */
export const PREVIEW_FIELDS = [
  'fileName',
  'artist',
  'title',
  'mix',
  'album',
  'label',
  'year',
  'bpm',
  'key',
  'styleId',
  'secondaryStyleId',
  'genre',
  'folder',
  'cues',
  'energy',
  'cover',
  'lufs',
  'truePeak',
  'gain'
] as const
export type PreviewField = (typeof PREVIEW_FIELDS)[number]

/** The fields the user may change in the preview. A file name follows from the others. */
export const EDITABLE_PREVIEW_FIELDS = [
  'artist',
  'title',
  'mix',
  'key',
  'styleId',
  'secondaryStyleId',
  'energy'
] as const satisfies readonly PreviewField[]
export type EditablePreviewField = (typeof EDITABLE_PREVIEW_FIELDS)[number]

/**
 * Where a proposed value comes from. `manual` is what the user typed in the preview;
 * `musicbrainz` and `discogs` are the online services a lookup took it from;
 * `fileName` is what the name of the file said where no tag and no lookup did;
 * `naming` is a file name the app built from the other fields; `conversion` is the
 * name a file gets when it becomes a file of another format; `itunes` and
 * `coverartarchive` are where a cover was found; `placeholder` is a cover the app
 * drew where none was found; `organize` is the style folder a file goes into.
 */
export const FIELD_SOURCES = [
  'lookup',
  'musicbrainz',
  'discogs',
  'itunes',
  'coverartarchive',
  // The thumbnail of a YouTube or SoundCloud download (T-034).
  'thumbnail',
  'placeholder',
  'organize',
  'id3',
  'fileName',
  'naming',
  'conversion',
  'analysis',
  'claude',
  'manual'
] as const
export type FieldSource = (typeof FIELD_SOURCES)[number]

export const PREVIEW_WARNINGS = [
  'LOW_CONFIDENCE',
  'DUPLICATE',
  ...FILE_WARNINGS,
  'LOW_BITRATE',
  'CANNOT_NORMALIZE',
  'UNSORTED',
  'NO_COVER',
  // A slot of the hot cues was emptied because it broke the order of the scheme.
  'CUE_REVIEW',
  // No grid of Rekordbox for the track: its hot cues cannot be placed yet.
  'NO_GRID',
  // The structure gave no cue at all: the cues the track has are kept.
  'NO_CUES'
] as const
export type PreviewWarning = (typeof PREVIEW_WARNINGS)[number]

/** A value proposed with less confidence than this is flagged `LOW_CONFIDENCE`. */
export const LOW_CONFIDENCE_BELOW = 0.7

// As long as tag text read by a scan may be.
const MAX_FIELD_TEXT = 300

// One clean line; an empty text is "no value".
const textValue = z
  .string()
  .max(MAX_FIELD_TEXT)
  .refine((text) => !UNSAFE_TEXT.test(text))
  .transform((text) => (text.trim() === '' ? null : text.trim()))
  .nullable()

// A file name is a name a library file may have, never a path: the rule the rename
// itself applies, so the preview shows no name that would be refused afterwards.
const fileNameValue = z
  .string()
  .refine((name) => unusableNameReason(name, 'file') === null)
  .nullable()

/** What a value of each field may be. Used for proposals of stages and edits of the user alike. */
export const previewValueSchemas = {
  fileName: fileNameValue,
  artist: textValue,
  title: textValue,
  mix: textValue,
  album: textValue,
  label: textValue,
  year: z.number().int().min(1000).max(9999).nullable(),
  /** Whole beats per minute, as the track's row and its file name hold the tempo. */
  bpm: z.number().int().min(20).max(400).nullable(),
  /** The Camelot code; the musical name follows from it (`shared/keys.ts`). */
  key: z.enum(CAMELOT_KEYS).nullable(),
  styleId: z.number().int().positive().nullable(),
  secondaryStyleId: z.number().int().positive().nullable(),
  /** The genre the file's tag holds; proposed only as the style a batch sorts the file by. */
  genre: textValue,
  /** The folder the file is in, by its name: a style folder once the library is organized. */
  folder: textValue,
  /** The hot cues by their letters, a dash for an empty slot: `A B – D E F G –`. */
  cues: z
    .string()
    .regex(/^[A-H–]( [A-H–]){7}$/u)
    .nullable(),
  energy: z.number().int().min(1).max(10).nullable(),
  /** The name of a cover the app made, to be embedded; a track's own cover has none. */
  cover: z.string().regex(COVER_NAMES.cover).nullable(),
  /** The integrated loudness in LUFS: as measured, and as the normalization will make it. */
  lufs: z.number().min(-70).max(10).nullable(),
  /** The true peak in dBTP, as measured and after the normalization. */
  truePeak: z.number().min(-200).max(40).nullable(),
  /** The gain the normalization applies, in dB. */
  gain: z.number().min(-40).max(40).nullable()
} as const satisfies Record<PreviewField, z.ZodType>

export type PreviewValue = string | number | null

// Where a proposed value comes from, and how sure its source is.
const provenance = {
  source: z.enum(FIELD_SOURCES),
  /** 0 to 1. Missing for a value that is not a guess, such as one read from a tag. */
  confidence: z.number().min(0).max(1).optional()
}

const proposedFieldsSchema = z
  .object({
    fileName: z.object({ value: previewValueSchemas.fileName, ...provenance }),
    artist: z.object({ value: previewValueSchemas.artist, ...provenance }),
    title: z.object({ value: previewValueSchemas.title, ...provenance }),
    mix: z.object({ value: previewValueSchemas.mix, ...provenance }),
    album: z.object({ value: previewValueSchemas.album, ...provenance }),
    label: z.object({ value: previewValueSchemas.label, ...provenance }),
    year: z.object({ value: previewValueSchemas.year, ...provenance }),
    bpm: z.object({ value: previewValueSchemas.bpm, ...provenance }),
    key: z.object({ value: previewValueSchemas.key, ...provenance }),
    styleId: z.object({ value: previewValueSchemas.styleId, ...provenance }),
    secondaryStyleId: z.object({ value: previewValueSchemas.secondaryStyleId, ...provenance }),
    genre: z.object({ value: previewValueSchemas.genre, ...provenance }),
    folder: z.object({ value: previewValueSchemas.folder, ...provenance }),
    cues: z.object({ value: previewValueSchemas.cues, ...provenance }),
    energy: z.object({ value: previewValueSchemas.energy, ...provenance }),
    cover: z.object({ value: previewValueSchemas.cover, ...provenance }),
    lufs: z.object({ value: previewValueSchemas.lufs, ...provenance }),
    truePeak: z.object({ value: previewValueSchemas.truePeak, ...provenance }),
    gain: z.object({ value: previewValueSchemas.gain, ...provenance })
  })
  .partial()

export type ProposedFields = z.output<typeof proposedFieldsSchema>
export type ProposedField = NonNullable<ProposedFields[PreviewField]>

/**
 * What the stages of a batch propose for one track: the `after` of a batch item.
 * Keys this schema does not name are dropped when it is read.
 */
export const proposalSchema = z.object({
  fields: proposedFieldsSchema.optional(),
  warnings: z.array(z.enum(PREVIEW_WARNINGS)).max(PREVIEW_WARNINGS.length).optional()
})

export type Proposal = z.output<typeof proposalSchema>

const fieldSchemas = proposedFieldsSchema.shape

/**
 * The proposal a stored `after` or the result of a stage holds. Read part by part: a
 * field or a warning that is not valid is left out, and the others stay. What is no
 * object at all counts as no proposal.
 */
export function readProposal(after: unknown): Proposal {
  const record = z.record(z.string(), z.unknown()).safeParse(after)
  if (!record.success) return {}
  const proposal: Proposal = {}
  const stored = z.record(z.string(), z.unknown()).safeParse(record.data['fields'])
  if (stored.success) {
    const fields: ProposedFields = {}
    for (const field of PREVIEW_FIELDS) {
      const parsed = fieldSchemas[field].safeParse(stored.data[field])
      if (parsed.success && parsed.data !== undefined) {
        Object.assign(fields, { [field]: parsed.data })
      }
    }
    if (Object.keys(fields).length > 0) proposal.fields = fields
  }
  const warnings = z.array(z.unknown()).safeParse(record.data['warnings'])
  if (warnings.success) {
    const known = PREVIEW_WARNINGS.filter((warning) => warnings.data.includes(warning))
    if (known.length > 0) proposal.warnings = known
  }
  return proposal
}

/**
 * Adds what a stage proposes to what the item holds already. A field the user has
 * set by hand, in this preview or in an earlier one (`lockedFields`), keeps its
 * value: no stage writes over it.
 */
export function mergeProposal(
  current: Proposal,
  proposed: Proposal,
  lockedFields: readonly string[]
): Proposal {
  const fields: ProposedFields = { ...current.fields }
  for (const field of PREVIEW_FIELDS) {
    const next = proposed.fields?.[field]
    if (next === undefined) continue
    if (lockedFields.includes(field) || fields[field]?.source === 'manual') continue
    Object.assign(fields, { [field]: next })
  }
  const warnings = PREVIEW_WARNINGS.filter(
    (warning) => current.warnings?.includes(warning) || proposed.warnings?.includes(warning)
  )
  return { fields, warnings }
}

export interface PreviewCell {
  before: PreviewValue
  after: PreviewValue
  changed: boolean
  /** Where the new value comes from; null when nothing is proposed for the field. */
  source: FieldSource | null
  confidence: number | null
}

export interface PreviewRow {
  trackId: number
  /** The name of the file as it is now: what the row is known by. */
  currentFileName: string
  cells: Record<PreviewField, PreviewCell>
  warnings: PreviewWarning[]
  /** Taken out by the user: nothing of this row is written. */
  excluded: boolean
  /** Why the track was skipped; such a row is never written and cannot be edited. */
  error: TrackError | null
  /**
   * A style the classification proposes that the list does not have yet: created when
   * the batch is approved. Null when the proposed style is one of the list.
   */
  newStyle: string | null
  /** What the normalization plans for the track, or null when the batch plans none. */
  normalization: PreviewNormalization | null
}

/** How a row is normalized: the method, and for a track that is skipped, the gains. */
export interface PreviewNormalization {
  /** mp3gain in steps, an MP3 encoded again, or the samples of an AIFF or WAV. */
  kind: 'mp3gain' | 'reencode' | 'pcm'
  /** `apply`: the gain is applied; `none`: at its target already; `skip`: it would clip. */
  action: 'apply' | 'none' | 'skip'
  /** For a track that is skipped: the gain it needed, and the most it could have had. */
  neededGainDb: number | null
  possibleGainDb: number | null
}

export const PREVIEW_FILTERS = ['all', 'warnings', 'lowConfidence', 'duplicates', 'errors'] as const
export type PreviewFilter = (typeof PREVIEW_FILTERS)[number]

/** Whether a row belongs to what a filter shows. */
export function matchesPreviewFilter(row: PreviewRow, filter: PreviewFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'warnings':
      return row.warnings.length > 0
    case 'lowConfidence':
      return row.warnings.includes('LOW_CONFIDENCE')
    case 'duplicates':
      return row.warnings.includes('DUPLICATE')
    case 'errors':
      return row.error !== null
  }
}

export const PREVIEW_PAGE_SIZE = 500

export const previewRowsRequestSchema = z.strictObject({
  batchId: z.number().int().positive(),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(PREVIEW_PAGE_SIZE)
})
export type PreviewRowsRequest = z.input<typeof previewRowsRequestSchema>

export interface PreviewPage {
  rows: PreviewRow[]
  /** All rows of the batch, not only the ones in this page. */
  total: number
}

const editTarget = {
  batchId: z.number().int().positive(),
  trackId: z.number().int().positive()
}

// Bounded before anything looks at it; what a field may hold is checked after.
const editText = z.string().max(MAX_FIELD_TEXT).nullable()

export const previewEditSchema = z.discriminatedUnion('field', [
  z.strictObject({ ...editTarget, field: z.literal('artist'), value: editText }),
  z.strictObject({ ...editTarget, field: z.literal('title'), value: editText }),
  z.strictObject({ ...editTarget, field: z.literal('mix'), value: editText }),
  z.strictObject({ ...editTarget, field: z.literal('key'), value: z.string().max(3).nullable() }),
  z.strictObject({ ...editTarget, field: z.literal('styleId'), value: z.number().nullable() }),
  z.strictObject({
    ...editTarget,
    field: z.literal('secondaryStyleId'),
    value: z.number().nullable()
  }),
  z.strictObject({ ...editTarget, field: z.literal('energy'), value: z.number().nullable() })
])
export type PreviewEdit = z.input<typeof previewEditSchema>

export const previewRefreshSchema = z.strictObject(editTarget)
export type PreviewRefresh = z.input<typeof previewRefreshSchema>

export const MAX_EXCLUDE_TRACKS = 20_000

export const previewExcludeSchema = z.strictObject({
  batchId: z.number().int().positive(),
  // The length first: a list of millions is refused before its entries are looked at.
  trackIds: z
    .array(z.unknown())
    .min(1)
    .max(MAX_EXCLUDE_TRACKS)
    .pipe(z.array(z.number().int().positive())),
  excluded: z.boolean()
})
export type PreviewExclude = z.input<typeof previewExcludeSchema>

/** The batch that waits for approval, in numbers. */
export interface PreviewBatch {
  id: number
  /** What kind of batch it is; the preview picks its columns by this. */
  type: string
  mode: 'in_place' | 'clean_library'
  total: number
  excluded: number
  failed: number
  /** True when the batch ran a step whose result can be asked for again, row by row. */
  canRefresh: boolean
  /** True when the batch looked for duplicates: the "Duplikátumok" tab is shown. */
  findsDuplicates: boolean
  /** True when the batch looked for covers: the "Borító" column is shown. */
  findsCovers: boolean
  /** True when the batch sorts files into style folders: the "Mappa" column is shown. */
  organizes: boolean
  /** True when the batch places hot cues: the "Cue-k" column is shown. */
  placesCues: boolean
  /** True when the batch normalizes the loudness: its columns are shown. */
  normalizes: boolean
  /** True for a batch of new tracks from the Inbox (T-035): the target folder is always shown. */
  inbox: boolean
}

/** How many rows one `preview:coverThumbs` call may ask about: about two screens. */
export const MAX_COVER_THUMB_TRACKS = 100

export const coverThumbsRequestSchema = z.object({
  batchId: z.number().int().positive(),
  trackIds: z.array(z.number().int().positive()).min(1).max(MAX_COVER_THUMB_TRACKS)
})
export type CoverThumbsRequest = z.input<typeof coverThumbsRequestSchema>

/** A row of the batch that waits for approval, named by ids only. */
export const previewTrackSchema = z.object({
  batchId: z.number().int().positive(),
  trackId: z.number().int().positive()
})
export type PreviewTrack = z.input<typeof previewTrackSchema>

/** The kinds of picture the user can give a track as its cover. */
export const MANUAL_COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const
export const MANUAL_COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/** True for a file that may be a picture of a kind a cover can be made of, by its type or name. */
export function isManualCoverFile(name: string, type: string): boolean {
  if (type !== '') return MANUAL_COVER_TYPES.some((allowed) => allowed === type)
  const lower = name.toLowerCase()
  return MANUAL_COVER_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** The covers of one row, as small JPEGs in `data:` addresses. */
export interface CoverThumbs {
  trackId: number
  /** True when the file holds a cover now, whether or not it can be shown. */
  hadBefore: boolean
  /** The cover the file holds now, when it has one that can be shown. */
  before: string | null
  /** Its size in pixels, when it could be read. */
  beforeSize: { width: number; height: number } | null
  /** The cover the batch found for it. */
  after: string | null
}

export interface PreviewState {
  /** The batch that waits for approval, or null. */
  batch: PreviewBatch | null
  /** True when a batch that changed files can be undone now. */
  canUndo: boolean
}

/** How an approval went: the apply phase started, or the batch does not fit on the drive. */
export type ApproveOutcome =
  { started: true } | { started: false; neededBytes: number; freeBytes: number }

export interface UndoOutcome {
  restored: number
  removed: number
  /** Files that stayed because they were not what the batch had left there. */
  left: number
}
