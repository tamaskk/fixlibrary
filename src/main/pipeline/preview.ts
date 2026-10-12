// The batch preview: what the user sees, changes and approves before a batch writes.
// Builds the rows from the items of the batch, takes the edits, and starts the apply
// phase. Nothing here changes a file.
import { basename } from 'path'
import { z } from 'zod'
import {
  approveBatchItems,
  cancelPreviewBatches,
  countBatchItems,
  findPreviewBatch,
  getBatchItem,
  countApprovedBatchItems,
  listBatchItems,
  setBatchItemProposal,
  setBatchItemsExcluded,
  type BatchItem
} from '../db/batches'
import type { AppDatabase } from '../db/connection'
import { listJobStageNames } from '../db/jobs'
import { listStyles } from '../db/styles'
import { getTrackById, updateTrack, type Track, type TrackChanges } from '../db/tracks'
import { describeError } from '../services/error-text'
import { createLogLimiter } from '../services/log-limiter'
import { logger } from '../services/logger'
import { trackErrorSchema, type Result } from '@shared/errors'
import {
  EDITABLE_PREVIEW_FIELDS,
  LOW_CONFIDENCE_BELOW,
  mergeProposal,
  PREVIEW_FIELDS,
  PREVIEW_WARNINGS,
  previewEditSchema,
  previewExcludeSchema,
  previewRowsRequestSchema,
  previewValueSchemas,
  readProposal,
  type ApproveOutcome,
  type PreviewCell,
  type PreviewField,
  type PreviewPage,
  type PreviewRow,
  type PreviewState,
  type PreviewValue,
  type Proposal,
  type UndoOutcome
} from '@shared/preview'
import { keyOfCamelot } from '@shared/keys'
import { toOneLine } from '@shared/text'
import type { BatchFiles } from './batch-files'
import type { Orchestrator } from './orchestrator'
import type { Stage } from './stages/stage'

// As long as a file name can be on macOS.
const MAX_NAME_LENGTH = 255
// As long as a field of a proposal may be.
const MAX_SHOWN_TEXT = 300

// What a row needs of the track as it was before the batch. Read leniently: a field
// that is missing or odd shows as empty and never keeps the row from being shown.
// For display only, like the file name: one line, and no longer than a field may be.
const shownText = z
  .string()
  .transform((text) => toOneLine(text, MAX_SHOWN_TEXT))
  .nullable()
  .catch(null)

const beforeSchema = z.object({
  path: z.string().catch(''),
  artist: shownText,
  title: shownText,
  mix: shownText,
  bpm: z.number().nullable().catch(null),
  camelotKey: z.string().nullable().catch(null),
  primaryStyleId: z.number().nullable().catch(null),
  energy: z.number().nullable().catch(null)
})

function valuesBefore(before: unknown): Record<PreviewField, PreviewValue> {
  const parsed = beforeSchema.safeParse(before)
  const track = parsed.success ? parsed.data : beforeSchema.parse({})
  return {
    // For display only: a file name may hold a line break or characters that turn
    // the reading direction around, and would then read as something else.
    fileName: track.path === '' ? null : toOneLine(basename(track.path), MAX_NAME_LENGTH),
    artist: track.artist,
    title: track.title,
    mix: track.mix,
    bpm: track.bpm,
    // Shown only as one of the 24 codes; whatever else a row may hold is no key.
    key: track.camelotKey === null ? null : (keyOfCamelot(track.camelotKey)?.camelot ?? null),
    styleId: track.primaryStyleId,
    energy: track.energy
  }
}

/** The fields of a row as the preview shows them: the proposed value, or the old one. */
function valuesAfter(before: unknown, proposal: Proposal): Record<PreviewField, PreviewValue> {
  const values = valuesBefore(before)
  for (const field of PREVIEW_FIELDS) {
    const proposed = proposal.fields?.[field]
    if (proposed !== undefined) values[field] = proposed.value
  }
  return values
}

/** One row of the preview from one item of the batch. */
export function buildPreviewRow(item: BatchItem): PreviewRow {
  const before = valuesBefore(item.before)
  const proposal = readProposal(item.after)
  let lowConfidence = false
  const cells = {} as Record<PreviewField, PreviewCell>
  for (const field of PREVIEW_FIELDS) {
    const proposed = proposal.fields?.[field]
    const after = proposed === undefined ? before[field] : proposed.value
    const confidence = proposed?.confidence ?? null
    const changed = after !== before[field]
    // Only a guess that would change something is worth a second look.
    if (changed && confidence !== null && confidence < LOW_CONFIDENCE_BELOW) lowConfidence = true
    cells[field] = {
      before: before[field],
      after,
      changed,
      source: proposed?.source ?? null,
      confidence
    }
  }
  const error = trackErrorSchema.safeParse(item.error)
  return {
    trackId: item.trackId,
    currentFileName: String(before.fileName ?? ''),
    cells,
    warnings: PREVIEW_WARNINGS.filter(
      (warning) =>
        proposal.warnings?.includes(warning) || (warning === 'LOW_CONFIDENCE' && lowConfidence)
    ),
    excluded: item.excluded,
    error: error.success ? error.data : null
  }
}

/**
 * Once a track of a batch is written: what the batch holds for the track's row alone
 * becomes the track's own. That is the tempo and the key, which are measured from the
 * audio and need no file to be written, and what the user typed in the preview. The
 * typed fields are locked, so that no later automatic run or rescan puts anything
 * else in their place. Only for a track that was approved. Doing it again changes nothing.
 */
export function commitApprovedValues(db: AppDatabase, batchId: number, trackId: number): void {
  db.transaction((tx) => {
    const item = getBatchItem(tx, batchId, trackId)
    if (!item || !item.approved) return
    const fields = readProposal(item.after).fields ?? {}
    const manual = EDITABLE_PREVIEW_FIELDS.filter((field) => fields[field]?.source === 'manual')
    if (manual.length === 0 && !fields.bpm && !fields.key) return
    const track = getTrackById(tx, trackId, new Set())
    if (!track) return
    const committed = new Set<string>(manual)
    const changes: TrackChanges = {}
    // A field that was locked after the stage proposed for it keeps its value.
    const free = (field: PreviewField): boolean =>
      fields[field]?.source === 'manual' || !track.lockedFields.includes(field)
    if (fields.bpm && free('bpm')) changes.bpm = fields.bpm.value
    if (fields.key && free('key')) {
      const key = fields.key.value === null ? null : keyOfCamelot(fields.key.value)
      changes.camelotKey = key?.camelot ?? null
      changes.musicalKey = key?.musical ?? null
    }
    if (fields.artist?.source === 'manual') changes.artist = fields.artist.value
    if (fields.title?.source === 'manual') changes.title = fields.title.value
    if (fields.mix?.source === 'manual') changes.mix = fields.mix.value
    if (fields.energy?.source === 'manual') changes.energy = fields.energy.value
    if (fields.styleId?.source === 'manual') {
      const styleId = fields.styleId.value
      const known = styleId === null || listStyles(tx).some((style) => style.id === styleId)
      // A style that was deleted since the edit cannot be the track's, and a value
      // the track did not get is not locked either.
      if (known) changes.primaryStyleId = styleId
      else committed.delete('styleId')
    }
    if (committed.size > 0) {
      changes.lockedFields = [...new Set([...track.lockedFields, ...committed])]
    }
    updateTrack(tx, trackId, changes)
  })
}

// A stage that throws on every edit must not fill the log.
const logRecompute = createLogLimiter((line) => logger.error(line), {
  limit: 20,
  windowMs: 10_000
})

export interface PreviewDependencies {
  db: AppDatabase
  /** Every stage the app has; the ones a batch ran are asked to propose again after an edit. */
  stages: readonly Stage[]
  orchestrator: Pick<Orchestrator, 'applyBatch' | 'undoLast'>
  batchFiles: Pick<BatchFiles, 'checkSpace' | 'lastUndoable'>
  listMountedVolumes: () => ReadonlySet<string>
}

export interface Preview {
  state: () => PreviewState
  /** One page of the rows of the batch that waits for approval. */
  rows: (request: unknown) => Result<PreviewPage>
  /** Sets one field of one row by hand, and returns the row as it is afterwards. */
  edit: (request: unknown) => Result<PreviewRow>
  /** Takes rows out of the batch, or back in. */
  setExcluded: (request: unknown) => Result<PreviewState>
  /**
   * Starts the apply phase for the rows the user left in. Answers with the room that
   * is needed and free when the backups or copies would not fit.
   */
  approve: (batchId: number) => Promise<Result<ApproveOutcome>>
  /** Gives the batch up: nothing it proposed is written. */
  discard: (batchId: number) => Result<PreviewState>
  undoLast: () => Promise<Result<UndoOutcome>>
}

export function createPreview(dependencies: PreviewDependencies): Preview {
  const { db, stages, orchestrator, batchFiles, listMountedVolumes } = dependencies
  // True while an approval is on its way: the batch must not change under it.
  let approving = false

  /** The batch with this id, if it is the one that waits for approval and may change. */
  function waitingBatch(batchId: number): Result<{ id: number }> {
    if (approving) return { ok: false, code: 'RUN_ACTIVE' }
    // The one batch that waits, not merely one that is marked as waiting.
    const batch = findPreviewBatch(db)
    if (!batch || batch.id !== batchId) return { ok: false, code: 'INVALID_INPUT' }
    return { ok: true, value: batch }
  }

  function state(): PreviewState {
    const batch = findPreviewBatch(db)
    return {
      batch: batch
        ? { id: batch.id, type: batch.type, mode: batch.mode, ...countBatchItems(db, batch.id) }
        : null,
      canUndo: batchFiles.lastUndoable() !== null
    }
  }

  /** What the stages of the batch propose now that the user changed a field. */
  function recomputed(batchId: number, track: Track, before: unknown, edited: Proposal): Proposal {
    const ran = new Set(listJobStageNames(db, batchId))
    let proposal = edited
    for (const stage of stages) {
      if (!stage.recompute || stage.phase !== 'compute' || !ran.has(stage.name)) continue
      try {
        const next = stage.recompute(track, valuesAfter(before, proposal))
        if (!next) continue
        // The warnings a stage reports are its own to take back: a name that was
        // taken, or a duplicate, may be neither after the edit.
        const owned = stage.warnings ?? []
        const kept = { ...proposal, warnings: proposal.warnings?.filter((w) => !owned.includes(w)) }
        // What the user typed stays, as in a run: a stage never writes over it.
        proposal = mergeProposal(kept, readProposal(next), track.lockedFields)
      } catch (error) {
        // The edit itself is kept; only what follows from it is not brought up to date.
        logRecompute(
          `Stage ${stage.name} could not propose again for track ${track.id}: ${describeError(error)}`
        )
      }
    }
    return proposal
  }

  return {
    state,

    rows(request) {
      const parsed = previewRowsRequestSchema.safeParse(request)
      if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
      const { batchId, offset, limit } = parsed.data
      const batch = findPreviewBatch(db)
      if (!batch || batch.id !== batchId) return { ok: false, code: 'INVALID_INPUT' }
      return {
        ok: true,
        value: {
          rows: listBatchItems(db, batchId, { offset, limit }).map(buildPreviewRow),
          total: countBatchItems(db, batchId).total
        }
      }
    },

    edit(request) {
      const parsed = previewEditSchema.safeParse(request)
      if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
      const { batchId, trackId, field } = parsed.data
      const value = previewValueSchemas[field].safeParse(parsed.data.value)
      if (!value.success) return { ok: false, code: 'INVALID_INPUT' }
      const batch = waitingBatch(batchId)
      if (!batch.ok) return batch

      const item = getBatchItem(db, batchId, trackId)
      const track = getTrackById(db, trackId, listMountedVolumes())
      // A track that a stage failed for is not written, so there is nothing to edit.
      if (!item || !track || item.error !== null) return { ok: false, code: 'INVALID_INPUT' }
      if (field === 'styleId' && value.data !== null) {
        const known = listStyles(db).some((style) => style.id === value.data)
        if (!known) return { ok: false, code: 'INVALID_INPUT' }
      }

      const current = readProposal(item.after)
      const edited: Proposal = {
        ...current,
        fields: { ...current.fields, [field]: { value: value.data, source: 'manual' } }
      }
      setBatchItemProposal(db, batchId, trackId, recomputed(batchId, track, item.before, edited))
      const stored = getBatchItem(db, batchId, trackId)
      if (!stored) return { ok: false, code: 'INVALID_INPUT' }
      return { ok: true, value: buildPreviewRow(stored) }
    },

    setExcluded(request) {
      const parsed = previewExcludeSchema.safeParse(request)
      if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
      const batch = waitingBatch(parsed.data.batchId)
      if (!batch.ok) return batch
      setBatchItemsExcluded(db, batch.value.id, parsed.data.trackIds, parsed.data.excluded)
      return { ok: true, value: state() }
    },

    async approve(batchId) {
      const batch = waitingBatch(batchId)
      if (!batch.ok) return batch
      approving = true
      try {
        approveBatchItems(db, batchId)
        // An approval of nothing would end as a batch that is "applied" and did nothing.
        if (countApprovedBatchItems(db, batchId) === 0) {
          return { ok: false, code: 'INVALID_INPUT' }
        }
        // Asked here as well as by the orchestrator: the page shows the numbers.
        const space = await batchFiles.checkSpace(batchId)
        if (!space.enough) {
          const { neededBytes, freeBytes } = space
          return { ok: true, value: { started: false, neededBytes, freeBytes } }
        }
        const applying = await orchestrator.applyBatch(batchId)
        if (!applying.ok) return applying
        return { ok: true, value: { started: true } }
      } finally {
        approving = false
      }
    },

    discard(batchId) {
      const batch = waitingBatch(batchId)
      if (!batch.ok) return batch
      // Only one batch waits at a time, so this is the one.
      cancelPreviewBatches(db)
      logger.info(`Batch ${batchId} was given up in its preview`)
      return { ok: true, value: state() }
    },

    async undoLast() {
      if (approving) return { ok: false, code: 'RUN_ACTIVE' }
      const undone = await orchestrator.undoLast()
      if (!undone.ok) return undone
      const { restored, removed } = undone.value
      return { ok: true, value: { restored, removed } }
    }
  }
}
