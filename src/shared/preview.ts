// The batch preview: what a batch proposes for each track, shown to the user for
// editing and approval before anything is written.
import { z } from 'zod'
import type { TrackError } from './errors'
import { FILE_WARNINGS } from './file-ops'

/** The fields a preview shows. The column sets of the batch types choose from these. */
export const PREVIEW_FIELDS = ['fileName', 'artist', 'title', 'mix', 'styleId', 'energy'] as const
export type PreviewField = (typeof PREVIEW_FIELDS)[number]

/** The fields the user may change in the preview. A file name follows from the others. */
export const EDITABLE_PREVIEW_FIELDS = [
  'artist',
  'title',
  'mix',
  'styleId',
  'energy'
] as const satisfies readonly PreviewField[]
export type EditablePreviewField = (typeof EDITABLE_PREVIEW_FIELDS)[number]

/** Where a proposed value comes from. `manual` is what the user typed in the preview. */
export const FIELD_SOURCES = ['lookup', 'id3', 'analysis', 'claude', 'manual'] as const
export type FieldSource = (typeof FIELD_SOURCES)[number]

export const PREVIEW_WARNINGS = [
  'LOW_CONFIDENCE',
  'DUPLICATE',
  ...FILE_WARNINGS,
  'LOW_BITRATE',
  'CANNOT_NORMALIZE',
  'UNSORTED'
] as const
export type PreviewWarning = (typeof PREVIEW_WARNINGS)[number]

/** A value proposed with less confidence than this is flagged `LOW_CONFIDENCE`. */
export const LOW_CONFIDENCE_BELOW = 0.7

// As long as tag text read by a scan may be.
const MAX_FIELD_TEXT = 300

// One line of text without control characters; an empty text is "no value".
const textValue = z
  .string()
  .max(MAX_FIELD_TEXT)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u)
  .transform((text) => (text.trim() === '' ? null : text.trim()))
  .nullable()

/** What a value of each field may be. Used for proposals of stages and edits of the user alike. */
export const previewValueSchemas = {
  fileName: textValue,
  artist: textValue,
  title: textValue,
  mix: textValue,
  styleId: z.number().int().positive().nullable(),
  energy: z.number().int().min(1).max(10).nullable()
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
    styleId: z.object({ value: previewValueSchemas.styleId, ...provenance }),
    energy: z.object({ value: previewValueSchemas.energy, ...provenance })
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

/** The proposal a stored `after` holds; what cannot be read counts as no proposal. */
export function readProposal(after: unknown): Proposal {
  const parsed = proposalSchema.safeParse(after)
  return parsed.success ? parsed.data : {}
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

export const previewEditSchema = z.discriminatedUnion('field', [
  z.strictObject({ ...editTarget, field: z.literal('artist'), value: z.string().nullable() }),
  z.strictObject({ ...editTarget, field: z.literal('title'), value: z.string().nullable() }),
  z.strictObject({ ...editTarget, field: z.literal('mix'), value: z.string().nullable() }),
  z.strictObject({ ...editTarget, field: z.literal('styleId'), value: z.number().nullable() }),
  z.strictObject({ ...editTarget, field: z.literal('energy'), value: z.number().nullable() })
])
export type PreviewEdit = z.input<typeof previewEditSchema>

export const MAX_EXCLUDE_TRACKS = 20_000

export const previewExcludeSchema = z.strictObject({
  batchId: z.number().int().positive(),
  trackIds: z.array(z.number().int().positive()).min(1).max(MAX_EXCLUDE_TRACKS),
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
}
