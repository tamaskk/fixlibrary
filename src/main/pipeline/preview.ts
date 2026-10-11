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
  getBatch,
  getBatchItem,
  listApprovedBatchItems,
  listBatchItems,
  setBatchItemProposal,
  setBatchItemsExcluded,
  type BatchItem
} from '../db/batches'
import type { AppDatabase } from '../db/connection'
import { listJobStageNames } from '../db/jobs'
import { listStyles } from '../db/styles'
import { getTrackById, updateTrack, type Track, type TrackChanges } from '../db/tracks'
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
import { toOneLine } from '@shared/text'
import type { BatchFiles } from './batch-files'
import type { Orchestrator } from './orchestrator'
import type { Stage } from './stages/stage'

// As long as a file name can be on macOS.
const MAX_NAME_LENGTH = 255

// What a row needs of the track as it was before the batch. Read leniently: a field
// that is missing or odd shows as empty and never keeps the row from being shown.
const beforeSchema = z.object({
  path: z.string().catch(''),
  artist: z.string().nullable().catch(null),
  title: z.string().nullable().catch(null),
  mix: z.string().nullable().catch(null),
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
 * Before the apply phase of a batch starts: what the user typed in its preview
 * becomes the track's own, and those fields are locked, so that no later automatic
 * run proposes anything else for them. Only for the tracks that are applied.
 */
export function commitManualEdits(db: AppDatabase, batchId: number): void {
  const styleIds = new Set(listStyles(db).map((style) => style.id))
  db.transaction((tx) => {
    for (const item of listApprovedBatchItems(tx, batchId)) {
      const fields = readProposal(item.after).fields ?? {}
      const manual = EDITABLE_PREVIEW_FIELDS.filter((field) => fields[field]?.source === 'manual')
      if (manual.length === 0) continue
      const track = getTrackById(tx, item.trackId, new Set())
      if (!track) continue
      const changes: TrackChanges = {
        lockedFields: [...new Set([...track.lockedFields, ...manual])]
      }
      if (fields.artist?.source === 'manual') changes.artist = fields.artist.value
      if (fields.title?.source === 'manual') changes.title = fields.title.value
      if (fields.mix?.source === 'manual') changes.mix = fields.mix.value
      if (fields.energy?.source === 'manual') changes.energy = fields.energy.value
      if (fields.styleId?.source === 'manual') {
        const styleId = fields.styleId.value
        // A style that was deleted since the edit cannot be the track's.
        if (styleId === null || styleIds.has(styleId)) changes.primaryStyleId = styleId
      }
      updateTrack(tx, item.trackId, changes)
    }
  })
}

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
    const batch = getBatch(db, batchId)
    if (!batch || batch.status !== 'preview') return { ok: false, code: 'INVALID_INPUT' }
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
        // What the user typed stays, as in a run: a stage never writes over it.
        if (next) proposal = mergeProposal(proposal, readProposal(next), track.lockedFields)
      } catch (error) {
        // The edit itself is kept; only what follows from it is not brought up to date.
        logger.error(`Stage ${stage.name} could not propose again for track ${track.id}`, error)
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
      const batch = getBatch(db, batchId)
      if (!batch || batch.status !== 'preview') return { ok: false, code: 'INVALID_INPUT' }
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
        if (listApprovedBatchItems(db, batchId).length === 0) {
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
