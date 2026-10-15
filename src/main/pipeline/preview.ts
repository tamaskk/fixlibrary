// The batch preview: what the user sees, changes and approves before a batch writes.
// Builds the rows from the items of the batch, takes the edits, and starts the apply
// phase. Nothing here changes a file.
import { basename, extname, isAbsolute, resolve } from 'path'
import { z } from 'zod'
import {
  approveBatchItems,
  cancelPreviewBatches,
  countBatchItems,
  findPreviewBatch,
  getBatchItem,
  countApprovedBatchItems,
  listAllBatchItems,
  listBatchItems,
  mergeBatchItemProposal,
  setBatchItemProposal,
  setBatchItemsExcluded,
  type BatchItem
} from '../db/batches'
import type { AppDatabase } from '../db/connection'
import { listJobStageNames } from '../db/jobs'
import { addStyle, listStyles } from '../db/styles'
import { getTrackById, updateTrack, type Track, type TrackChanges } from '../db/tracks'
import type { CoverStore } from '../services/covers'
import type { PythonBridge } from '../services/python-bridge'
import { describeError } from '../services/error-text'
import { createLogLimiter } from '../services/log-limiter'
import { logger } from '../services/logger'
import { AppError, trackErrorSchema, type Result } from '@shared/errors'
import { COVER_RPC_TIMEOUT_MS } from '@shared/timeouts'
import {
  coverThumbsRequestSchema,
  MANUAL_COVER_EXTENSIONS,
  previewTrackSchema,
  EDITABLE_PREVIEW_FIELDS,
  LOW_CONFIDENCE_BELOW,
  mergeProposal,
  PREVIEW_FIELDS,
  PREVIEW_WARNINGS,
  previewEditSchema,
  previewExcludeSchema,
  previewRefreshSchema,
  previewRowsRequestSchema,
  previewValueSchemas,
  readProposal,
  type ApproveOutcome,
  type CoverThumbs,
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
import { newStylesTaken, styleKey, UNSORTED_STYLE_NAME } from '@shared/settings'
import { toOneLine } from '@shared/text'
import { keepDuplicateSchema, type DuplicateGroup } from '@shared/duplicates'
import { keepDuplicate, listDuplicateGroups } from './batch-duplicates'
import type { BatchFiles } from './batch-files'
import type { Orchestrator } from './orchestrator'
import { runStage } from './run-stage'
import {
  COVER_STAGE,
  coverDetailsOf,
  coverDetailsSchema,
  EMBED_COVER_STAGE,
  type CoverDetails
} from './stages/cover'
import { DUPLICATES_STAGE } from './stages/duplicates'
import { identifiersSchema } from './stages/lookup'
import { styleDetailsOf } from './stages/style'
import { newStyleColor } from './style'
import type { Stage } from './stages/stage'
import { tagsFor, takesTags, WRITE_TAGS_STAGE } from './stages/write-tags'

// Where macOS mounts network shares on demand, in lower case: the startup disk does
// not tell case apart.
const NETWORK_FOLDERS = ['/net/', '/network/']

/** The promise's value, or a rejection once `ms` have passed. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

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
  album: shownText,
  label: shownText,
  year: z.number().nullable().catch(null),
  bpm: z.number().nullable().catch(null),
  camelotKey: z.string().nullable().catch(null),
  primaryStyleId: z.number().nullable().catch(null),
  secondaryStyleId: z.number().nullable().catch(null),
  genre: shownText,
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
    album: track.album,
    label: track.label,
    year: track.year,
    bpm: track.bpm,
    // Shown only as one of the 24 codes; whatever else a row may hold is no key.
    key: track.camelotKey === null ? null : (keyOfCamelot(track.camelotKey)?.camelot ?? null),
    styleId: track.primaryStyleId,
    secondaryStyleId: track.secondaryStyleId,
    genre: track.genre,
    energy: track.energy,
    // The cover a file holds has no name of the app's: a new one is a change.
    cover: null
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
    error: error.success ? error.data : null,
    // Named only while the proposal is still Claude's: a style the user chose is one
    // of the list.
    newStyle:
      proposal.fields?.styleId?.source === 'claude' && proposal.fields.styleId.value === null
        ? (styleDetailsOf(item.after)?.newPrimary ?? null)
        : null
  }
}

// The new styles a batch may create, worked out once: what the rows of an approved
// batch name does not change while its tracks are written one by one.
const takenStyles = new WeakMap<AppDatabase, { batchId: number; keys: string[] }>()

/** The keys of the new styles a batch may create: the first five its approved rows name. */
function newStylesTakenBy(db: AppDatabase, batchId: number): string[] {
  const kept = takenStyles.get(db)
  if (kept?.batchId === batchId) return kept.keys
  const keys = newStylesTaken(newStylesOfBatch(db, batchId)).map(styleKey)
  takenStyles.set(db, { batchId, keys })
  return keys
}

/** The new styles the approved rows of a batch name, in the order of the batch. */
function newStylesOfBatch(db: AppDatabase, batchId: number): string[] {
  return listAllBatchItems(db, batchId).flatMap((item) => {
    if (!item.approved || item.excluded) return []
    const field = readProposal(item.after).fields?.styleId
    const name =
      field?.source === 'claude' && field.value === null
        ? styleDetailsOf(item.after)?.newPrimary
        : null
    return name ? [name] : []
  })
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
    // Which recording the track is, as a lookup found it out: like the tempo and
    // the key, a fact about the audio that needs no file to be written.
    const identifiers = identifiersSchema.safeParse(
      z.record(z.string(), z.unknown()).safeParse(item.after).data?.['identifiers']
    )
    // What the batch wrote into the file's tags is the track's own from then on: the
    // names a lookup found and the naming cleaned. Only then, so that a row never
    // says more than its file.
    const stages = listJobStageNames(tx, batchId)
    const tagged = stages.includes(WRITE_TAGS_STAGE)
    // A cover the batch found is in the file once either stage that writes it ran.
    const covered =
      typeof fields.cover?.value === 'string' && (tagged || stages.includes(EMBED_COVER_STAGE))
    if (
      !tagged &&
      !covered &&
      manual.length === 0 &&
      !fields.bpm &&
      !fields.key &&
      !fields.styleId &&
      !fields.secondaryStyleId &&
      !identifiers.success
    ) {
      return
    }
    const track = getTrackById(tx, trackId, new Set())
    if (!track) return
    const committed = new Set<string>(manual)
    const changes: TrackChanges = {}
    // Only an id that was found: a match by names knows no AcoustID, and must not
    // take away the one an earlier match by fingerprint gave the track.
    if (identifiers.success) {
      const { acoustId, musicbrainzRecordingId } = identifiers.data
      if (acoustId !== null) changes.acoustId = acoustId
      if (musicbrainzRecordingId !== null) {
        changes.musicbrainzRecordingId = musicbrainzRecordingId
      }
    }
    // A field that was locked after the stage proposed for it keeps its value.
    const free = (field: PreviewField): boolean =>
      fields[field]?.source === 'manual' || !track.lockedFields.includes(field)
    if (fields.bpm && free('bpm')) changes.bpm = fields.bpm.value
    if (fields.key && free('key')) {
      const key = fields.key.value === null ? null : keyOfCamelot(fields.key.value)
      changes.camelotKey = key?.camelot ?? null
      changes.musicalKey = key?.musical ?? null
    }
    if (tagged && takesTags(track.path)) {
      // Field by field what went into the tag, and nothing that was left out of it
      // because a tag cannot hold it.
      const written = tagsFor(track, readProposal(item.after))
      if (written.artist !== undefined && fields.artist && free('artist')) {
        changes.artist = fields.artist.value
      }
      if (written.title !== undefined) {
        if (fields.title && free('title')) changes.title = fields.title.value
        if (fields.mix && free('mix')) changes.mix = fields.mix.value
      }
      if (written.album !== undefined && fields.album && free('album')) {
        changes.album = fields.album.value
      }
      if (written.label !== undefined && fields.label && free('label')) {
        changes.label = fields.label.value
      }
      if (written.year !== undefined && fields.year && free('year'))
        changes.year = fields.year.value
    }
    if (covered && takesTags(track.path)) {
      changes.coverStatus = fields.cover?.source === 'placeholder' ? 'placeholder' : 'embedded'
      // A picture the user chose is theirs: no later run looks for another.
      if (fields.cover?.source === 'manual') committed.add('cover')
    }
    if (fields.artist?.source === 'manual') changes.artist = fields.artist.value
    if (fields.title?.source === 'manual') changes.title = fields.title.value
    if (fields.mix?.source === 'manual') changes.mix = fields.mix.value
    if (fields.energy?.source === 'manual') changes.energy = fields.energy.value
    // The styles: what the user chose, or what the classification decided, where the
    // field is not locked. A style the classification named that the list does not
    // have is created now, with a color of its own; one the user chose that was
    // deleted since cannot be the track's, and a value the track did not get is not
    // locked either.
    const known = (id: number | null): boolean =>
      id === null || listStyles(tx).some((style) => style.id === id)
    for (const [field, column] of [
      ['styleId', 'primaryStyleId'],
      ['secondaryStyleId', 'secondaryStyleId']
    ] as const) {
      const proposed = fields[field]
      if (!proposed || !free(field)) continue
      let id = proposed.value
      if (field === 'styleId' && id === null && proposed.source === 'claude') {
        const details = styleDetailsOf(item.after)
        const unsorted = listStyles(tx).find((style) => style.name === UNSORTED_STYLE_NAME)
        // Five new styles a batch at most, the first its rows name; a full list or a
        // name beyond the five leaves the track Unsorted.
        if (details?.newPrimary) {
          const created = newStylesTakenBy(db, batchId).includes(styleKey(details.newPrimary))
            ? addStyle(
                tx,
                details.newPrimary,
                details.newColor ?? newStyleColor(details.newPrimary, listStyles(tx))
              )
            : null
          id = created?.id ?? unsorted?.id ?? null
        }
      }
      // The second style is another style than the first.
      if (field === 'secondaryStyleId' && id !== null && id === changes.primaryStyleId) id = null
      if (known(id)) changes[column] = id
      else committed.delete(field)
    }
    if (committed.size > 0) {
      changes.lockedFields = [...new Set([...track.lockedFields, ...committed])]
    }
    updateTrack(tx, trackId, changes)
  })
}

// The least time between two refreshes of a row, counted from when the first began.
const MIN_REFRESH_INTERVAL_MS = 2000

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
  /** Where the thumbnails of covers are read from; without it, no row shows a cover. */
  covers?: Pick<CoverStore, 'thumbnail' | 'ensure' | 'importPicture' | 'remove'>
  /** The sidecar that makes a cover of a picture the user chose; null while there is none. */
  python?: () => Pick<PythonBridge, 'call'> | null
  now?: () => number
}

export interface Preview {
  state: () => PreviewState
  /** One page of the rows of the batch that waits for approval. */
  rows: (request: unknown) => Result<PreviewPage>
  /** Sets one field of one row by hand, and returns the row as it is afterwards. */
  edit: (request: unknown) => Result<PreviewRow>
  /**
   * Asks again what the batch's steps that keep answers of online services found for
   * one track, and returns the row as it is afterwards. What the user set by hand stays.
   */
  refresh: (request: unknown) => Promise<Result<PreviewRow>>
  /** The groups of duplicates in the batch that waits for approval. */
  duplicates: (batchId: number) => Result<DuplicateGroup[]>
  /**
   * Makes one copy the one its group keeps, and returns the groups as they are
   * afterwards. The copy that was kept before is then one that is set aside.
   */
  keepDuplicate: (request: unknown) => Result<DuplicateGroup[]>
  /** The old and the new cover of some rows of the batch that waits for approval. */
  coverThumbs: (request: unknown) => Promise<Result<CoverThumbs[]>>
  /**
   * Makes a picture the user chose, named by the path the main process got for it
   * (a dialog of its own, or the file dropped on the page), the cover a row proposes.
   */
  setCover: (request: unknown, path: string) => Promise<Result<PreviewRow>>
  /** True when a picture could become the cover of the row now: asked before a dialog opens. */
  canSetCover: (request: unknown) => boolean
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
  const now = dependencies.now ?? Date.now
  // True while an approval is on its way: the batch must not change under it.
  let approving = false
  // True while a row is asked about again: one at a time, and nothing else changes
  // the batch until its answer is in.
  let refreshing = false
  // A refresh goes around what was kept, so a page must not ask in a loop: the
  // services would be held at their limits with the owner's keys.
  let lastRefreshAt = -Infinity

  /** The stages of a batch whose result can be asked for again. */
  function refreshableStages(batchId: number): Stage[] {
    const ran = new Set(listJobStageNames(db, batchId))
    return stages.filter(
      (stage) => stage.refreshable === true && stage.phase === 'compute' && ran.has(stage.name)
    )
  }

  /** The row a chosen picture can become the cover of: of the batch that waits and writes covers. */
  function coverRow(
    request: unknown
  ): Result<{ batchId: number; trackId: number; item: BatchItem; track: Track }> {
    const parsed = previewTrackSchema.safeParse(request)
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
    const { batchId, trackId } = parsed.data
    const batch = waitingBatch(batchId)
    if (!batch.ok) return batch
    // Only a batch that writes covers can write this one.
    if (!listJobStageNames(db, batchId).includes(COVER_STAGE)) {
      return { ok: false, code: 'INVALID_INPUT' }
    }
    const item = getBatchItem(db, batchId, trackId)
    const track = getTrackById(db, trackId, listMountedVolumes())
    if (!item || !track || item.error !== null || !takesTags(track.path)) {
      return { ok: false, code: 'INVALID_INPUT' }
    }
    return { ok: true, value: { batchId, trackId, item, track } }
  }

  /** The batch with this id, if it is the one that waits for approval and may change. */
  function waitingBatch(batchId: number): Result<{ id: number }> {
    if (approving || refreshing) return { ok: false, code: 'RUN_ACTIVE' }
    // The one batch that waits, not merely one that is marked as waiting.
    const batch = findPreviewBatch(db)
    if (!batch || batch.id !== batchId) return { ok: false, code: 'INVALID_INPUT' }
    return { ok: true, value: batch }
  }

  function state(): PreviewState {
    const batch = findPreviewBatch(db)
    return {
      batch: batch
        ? {
            id: batch.id,
            type: batch.type,
            mode: batch.mode,
            ...countBatchItems(db, batch.id),
            canRefresh: refreshableStages(batch.id).length > 0,
            findsDuplicates: listJobStageNames(db, batch.id).includes(DUPLICATES_STAGE),
            findsCovers: listJobStageNames(db, batch.id).includes(COVER_STAGE)
          }
        : null,
      canUndo: batchFiles.lastUndoable() !== null
    }
  }

  /** What the stages of the batch propose now that the user changed a field. */
  function recomputed(
    batchId: number,
    track: Track,
    item: { before: unknown; after: unknown },
    edited: Proposal
  ): Proposal {
    const { before, after } = item
    const ran = new Set(listJobStageNames(db, batchId))
    let proposal = edited
    for (const stage of stages) {
      if (!stage.recompute || stage.phase !== 'compute' || !ran.has(stage.name)) continue
      try {
        const next = stage.recompute(track, valuesAfter(before, proposal), after)
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

  /**
   * Lets the stages that look at the tracks of the batch together look again: a
   * name that changed may have made a copy of a track, or made it one no more.
   */
  function regroup(batchId: number): void {
    const ran = new Set(listJobStageNames(db, batchId))
    for (const stage of stages) {
      if (!stage.regroup || !ran.has(stage.name)) continue
      try {
        stage.regroup(batchId)
      } catch (error) {
        // The change itself is kept; the groups stay as they were before it.
        logRecompute(
          `Stage ${stage.name} could not look at batch ${batchId} again: ${describeError(error)}`
        )
      }
    }
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
      if ((field === 'styleId' || field === 'secondaryStyleId') && value.data !== null) {
        const known = listStyles(db).some((style) => style.id === value.data)
        if (!known) return { ok: false, code: 'INVALID_INPUT' }
      }
      // A second style is another style than the first.
      if (field === 'secondaryStyleId' && value.data !== null) {
        const primary = readProposal(item.after).fields?.styleId?.value ?? track.primaryStyleId
        if (value.data === primary) return { ok: false, code: 'INVALID_INPUT' }
      }

      const current = readProposal(item.after)
      const edited: Proposal = {
        ...current,
        fields: { ...current.fields, [field]: { value: value.data, source: 'manual' } }
      }
      // A first style that the second one is takes the second one's place: the second
      // is then none.
      if (field === 'styleId' && value.data !== null) {
        const second = current.fields?.secondaryStyleId
        const secondId = second === undefined ? track.secondaryStyleId : second.value
        if (secondId === value.data && edited.fields) {
          edited.fields.secondaryStyleId = { value: null, source: 'manual' }
        }
      }
      setBatchItemProposal(db, batchId, trackId, recomputed(batchId, track, item, edited))
      // Only a name can make a track a copy of another; the batch may hold thousands.
      if (field === 'artist' || field === 'title' || field === 'mix') regroup(batchId)
      const stored = getBatchItem(db, batchId, trackId)
      if (!stored) return { ok: false, code: 'INVALID_INPUT' }
      return { ok: true, value: buildPreviewRow(stored) }
    },

    async refresh(request) {
      const parsed = previewRefreshSchema.safeParse(request)
      if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
      const { batchId, trackId } = parsed.data
      const batch = waitingBatch(batchId)
      if (!batch.ok) return batch
      if (now() - lastRefreshAt < MIN_REFRESH_INTERVAL_MS) return { ok: false, code: 'RUN_ACTIVE' }
      const item = getBatchItem(db, batchId, trackId)
      const track = getTrackById(db, trackId, listMountedVolumes())
      const again = refreshableStages(batchId)
      // A track that a stage failed for is not written, so there is nothing to ask about.
      if (!item || !track || item.error !== null || again.length === 0) {
        return { ok: false, code: 'INVALID_INPUT' }
      }
      if (track.offline || track.fileMissing) return { ok: false, code: 'LIBRARY_UNAVAILABLE' }

      refreshing = true
      lastRefreshAt = now()
      let regrouped = false
      try {
        for (const stage of again) {
          const current = getBatchItem(db, batchId, trackId)
          if (!current) return { ok: false, code: 'INVALID_INPUT' }
          const proposal = readProposal(current.after)
          const outcome = await runStage(
            { trackId, stage: stage.name, timeoutMs: stage.timeoutMs },
            (signal) => stage.run({ signal, batchId, files: null, proposal, refresh: true }, track)
          )
          // The row stays as it was: a refresh that failed is no failure of the track.
          if (!outcome.ok) return { ok: false, code: outcome.error.code }
          if (!outcome.value?.proposal) continue
          // The warnings a stage reports are its own to take back, as after an edit,
          // and so is what it proposed before: the new answer replaces the old one
          // whole, also where it names less. What the user typed is not the stage's.
          const owned = stage.warnings ?? []
          const fields = { ...proposal.fields }
          for (const field of stage.proposes ?? []) {
            if (fields[field]?.source !== 'manual') delete fields[field]
          }
          setBatchItemProposal(db, batchId, trackId, {
            fields,
            warnings: proposal.warnings?.filter((warning) => !owned.includes(warning))
          })
          mergeBatchItemProposal(db, batchId, trackId, outcome.value.proposal, track.lockedFields)
        }
        // A new artist or title gives a new file name, like an edit by hand.
        const stored = getBatchItem(db, batchId, trackId)
        if (!stored) return { ok: false, code: 'INVALID_INPUT' }
        setBatchItemProposal(
          db,
          batchId,
          trackId,
          recomputed(batchId, track, stored, readProposal(stored.after))
        )
        regroup(batchId)
        regrouped = true
        const shown = getBatchItem(db, batchId, trackId)
        if (!shown) return { ok: false, code: 'INVALID_INPUT' }
        return { ok: true, value: buildPreviewRow(shown) }
      } finally {
        // Also when a later step failed: what an earlier one stored is in the rows.
        if (!regrouped) regroup(batchId)
        refreshing = false
      }
    },

    duplicates(batchId) {
      const batch = findPreviewBatch(db)
      if (!batch || batch.id !== batchId) return { ok: false, code: 'INVALID_INPUT' }
      return { ok: true, value: listDuplicateGroups(db, batchId) }
    },

    async coverThumbs(request) {
      const parsed = coverThumbsRequestSchema.safeParse(request)
      if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
      const { batchId, trackIds } = parsed.data
      const batch = findPreviewBatch(db)
      if (!batch || batch.id !== batchId) return { ok: false, code: 'INVALID_INPUT' }
      const covers = dependencies.covers
      const thumbs: CoverThumbs[] = []
      for (const trackId of new Set(trackIds)) {
        const item = getBatchItem(db, batchId, trackId)
        if (!item) continue
        // What the cover stage kept for the row; a row it found nothing for has none.
        const details = coverDetailsSchema.safeParse(
          z.record(z.string(), z.unknown()).safeParse(item.after).data?.['cover']
        )
        if (!details.success || !covers) continue
        const { before } = details.data
        thumbs.push({
          trackId,
          hadBefore: before !== null,
          before: before?.thumb ? await covers.thumbnail(before.thumb) : null,
          beforeSize:
            before && before.width !== null && before.height !== null
              ? { width: before.width, height: before.height }
              : null,
          after: await covers.thumbnail(details.data.thumb)
        })
      }
      return { ok: true, value: thumbs }
    },

    canSetCover(request) {
      return coverRow(request).ok
    },

    async setCover(request, path) {
      const row = coverRow(request)
      if (!row.ok) return row
      const { batchId, trackId, item, track } = row.value
      // Judged as the path resolves: `//net`, `..` and another spelling of the folder
      // are the same place. A share mounted under /Volumes is a drive the user mounted.
      const resolved = isAbsolute(path) ? resolve(path) : ''
      const extension = extname(resolved).toLowerCase()
      const remote = NETWORK_FOLDERS.some((folder) => resolved.toLowerCase().startsWith(folder))
      if (!MANUAL_COVER_EXTENSIONS.some((allowed) => allowed === extension) || remote) {
        return { ok: false, code: 'COVER_UNUSABLE' }
      }
      const covers = dependencies.covers
      const python = dependencies.python?.() ?? null
      if (!covers || !python) return { ok: false, code: 'PYTHON_CRASHED' }

      refreshing = true
      try {
        await covers.ensure()
        let download: string
        try {
          // A drive that does not answer must not hold the preview: the read is given
          // up, and finishes into nothing.
          download = await withTimeout(covers.importPicture(resolved), COVER_RPC_TIMEOUT_MS)
        } catch {
          // What went wrong names a path of the user's: it is not passed on.
          logger.warn(`Track ${trackId}: the chosen picture could not be read`)
          return { ok: false, code: 'COVER_UNUSABLE' }
        }
        let made: { cover: string; thumb: string }
        try {
          made = await python.call(
            'cover.prepare',
            { source: download, manual: true },
            { timeoutMs: COVER_RPC_TIMEOUT_MS }
          )
        } catch (error) {
          if (error instanceof AppError && error.code === 'PYTHON_ERROR') {
            return { ok: false, code: 'COVER_UNUSABLE' }
          }
          throw error
        } finally {
          // A download left behind is only a file of the covers folder.
          await covers.remove(download, 'download').catch(() => {
            logger.warn(`Track ${trackId}: a download could not be removed from the covers folder`)
          })
        }
        // What the file holds now, as the cover stage saw it; asked again otherwise,
        // and shown as nothing when it cannot be told.
        const before =
          coverDetailsOf(item.after)?.before ??
          (await python
            .call('cover.inspect', { path: track.path }, { timeoutMs: COVER_RPC_TIMEOUT_MS })
            .then((held) => held.cover)
            .catch(() => null))
        const current = readProposal(item.after)
        const details: CoverDetails = { thumb: made.thumb, before }
        // The field and what is kept next to it, together or not at all.
        db.transaction((tx) => {
          setBatchItemProposal(tx, batchId, trackId, {
            fields: { ...current.fields, cover: { value: made.cover, source: 'manual' } },
            warnings: (current.warnings ?? []).filter((warning) => warning !== 'NO_COVER')
          })
          mergeBatchItemProposal(tx, batchId, trackId, { cover: details }, [])
        })
      } finally {
        refreshing = false
      }
      const stored = getBatchItem(db, batchId, trackId)
      if (!stored) return { ok: false, code: 'INVALID_INPUT' }
      return { ok: true, value: buildPreviewRow(stored) }
    },

    keepDuplicate(request) {
      const parsed = keepDuplicateSchema.safeParse(request)
      if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
      const { batchId, trackId } = parsed.data
      const batch = waitingBatch(batchId)
      if (!batch.ok) return batch
      if (!keepDuplicate(db, batchId, trackId)) return { ok: false, code: 'INVALID_INPUT' }
      return { ok: true, value: listDuplicateGroups(db, batchId) }
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
      if (approving || refreshing) return { ok: false, code: 'RUN_ACTIVE' }
      const undone = await orchestrator.undoLast()
      if (!undone.ok) return undone
      const { restored, removed, left } = undone.value
      return { ok: true, value: { restored, removed, left } }
    }
  }
}
