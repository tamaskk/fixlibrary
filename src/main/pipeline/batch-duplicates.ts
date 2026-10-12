// The duplicates among the tracks of one batch: which tracks are copies of one
// recording, which copy of each group stays, and what the "Duplikátumok" tab shows.
// Reads and writes the items of the batch only; no file is touched here.
import { basename, dirname } from 'path'
import { z } from 'zod'
import {
  listAllBatchItems,
  setBatchItemEntry,
  setBatchItemProposal,
  type BatchItem
} from '../db/batches'
import type { AppDatabase } from '../db/connection'
import type { DuplicateGroup, DuplicateMember } from '@shared/duplicates'
import { PREVIEW_WARNINGS, readProposal } from '@shared/preview'
import { toOneLine } from '@shared/text'
import { findDuplicateGroups, suggestKeep, type DuplicateCandidate } from './duplicates'
import { cleanNames, parseFileName } from './naming'
import { identifiersSchema } from './stages/lookup'

/** The entry of an item's `after` that says which group the track is in. */
const DUPLICATE_ENTRY = 'duplicate'

// As long as a file name can be on macOS, and as long as a field of a proposal may be.
const MAX_NAME_LENGTH = 255
const MAX_FOLDER_LENGTH = 1024
// `mp3`, `wav`, `aiff`: a format is a few letters, whatever a snapshot holds.
const MAX_FORMAT_LENGTH = 8
const MAX_SHOWN_TEXT = 300

const markSchema = z.object({
  /** The lowest track id of the group. */
  group: z.number().int().positive(),
  /** True for the one copy of the group that stays where it is. */
  keep: z.boolean(),
  /** The track of that copy: what is set aside is set aside in favour of it. */
  keeper: z.number().int().positive(),
  /** True when the user picked the copy to keep, in the whole group alike. */
  chosen: z.boolean()
})

export type DuplicateMark = z.output<typeof markSchema>

const recordSchema = z.record(z.string(), z.unknown())

/** Which group an item is in, or null for a track that is no copy of another. */
export function readDuplicateMark(after: unknown): DuplicateMark | null {
  const record = recordSchema.safeParse(after)
  if (!record.success) return null
  const mark = markSchema.safeParse(record.data[DUPLICATE_ENTRY])
  return mark.success ? mark.data : null
}

// What the search needs of the track as it was before the batch. Read leniently,
// like the rows of the preview: a field that is missing or odd counts as not known.
const text = z.string().nullable().catch(null)
const size = z.number().int().positive().nullable().catch(null)
const beforeSchema = z.object({
  path: z.string().catch(''),
  format: z.string().catch(''),
  durationMs: size,
  bitrateKbps: size,
  acoustId: text,
  artist: text,
  title: text,
  mix: text
})

interface Described {
  item: BatchItem
  candidate: DuplicateCandidate
  fileName: string
  folder: string
}

/** A track of the batch as the search for duplicates sees it. */
function describe(item: BatchItem): Described {
  const parsed = beforeSchema.safeParse(item.before)
  const before = parsed.success ? parsed.data : beforeSchema.parse({})
  const fields = readProposal(item.after).fields ?? {}
  const named = (field: 'artist' | 'title' | 'mix'): string | null =>
    fields[field] === undefined ? before[field] : fields[field].value
  const known = { artist: named('artist'), title: named('title'), mix: named('mix') }
  // Without a title from a tag or a lookup, the file name is all there is to go by,
  // as it is for the naming: two untagged downloads of one track are copies too.
  const fromName = known.title === null ? parseFileName(basename(before.path)) : null
  // Cleaned the way the naming cleans them, whether or not the batch ran it: a mix
  // that is still in the title must count as the mix. Nothing is kept as typed: the
  // names are compared here, not written.
  const names = cleanNames(
    fromName === null
      ? known
      : { ...known, title: fromName.title, artist: known.artist ?? fromName.artist }
  )
  const found = identifiersSchema.safeParse(
    recordSchema.safeParse(item.after).data?.['identifiers']
  )
  return {
    item,
    fileName: toOneLine(basename(before.path), MAX_NAME_LENGTH),
    folder: before.path === '' ? '' : toOneLine(dirname(before.path), MAX_FOLDER_LENGTH),
    candidate: {
      trackId: item.trackId,
      // What this batch's lookup found, or what an earlier one gave the track.
      acoustId: (found.success ? found.data.acoustId : null) ?? before.acoustId,
      ...names,
      durationMs: before.durationMs,
      format: before.format,
      bitrateKbps: before.bitrateKbps
    }
  }
}

function sameMark(a: DuplicateMark | null, b: DuplicateMark | null): boolean {
  if (a === null || b === null) return a === b
  return a.group === b.group && a.keep === b.keep && a.keeper === b.keeper && a.chosen === b.chosen
}

/**
 * Finds the duplicates among the tracks of a batch and writes into each item which
 * group it is in and whether it is the copy to keep. Every copy gets the `DUPLICATE`
 * warning. A track a stage failed for is in no group: it is not written anyway.
 *
 * Done again after the names of a row changed. A copy the user picked to keep stays
 * the one to keep as long as its group has no second such copy; otherwise the app
 * proposes again. Returns true when anything changed.
 */
export function groupBatchDuplicates(db: AppDatabase, batchId: number): boolean {
  return db.transaction((tx) => {
    let changed = false
    const items = listAllBatchItems(tx, batchId)
    const described = new Map<number, Described>()
    for (const item of items) {
      if (item.error === null) described.set(item.trackId, describe(item))
    }
    const before = new Map(items.map((item) => [item.trackId, readDuplicateMark(item.after)]))

    const marks = new Map<number, DuplicateMark>()
    const candidates = [...described.values()].map((each) => each.candidate)
    for (const trackIds of findDuplicateGroups(candidates)) {
      const group = trackIds.reduce((least, id) => Math.min(least, id))
      const picked = trackIds.filter((id) => before.get(id)?.chosen && before.get(id)?.keep)
      const chosen = picked.length === 1
      const members = trackIds.flatMap((id) => described.get(id)?.candidate ?? [])
      const keeper = (chosen ? picked[0] : suggestKeep(members)) ?? group
      for (const id of trackIds) marks.set(id, { group, keep: id === keeper, keeper, chosen })
    }

    for (const item of items) {
      const mark = marks.get(item.trackId) ?? null
      const proposal = readProposal(item.after)
      const flagged = proposal.warnings?.includes('DUPLICATE') ?? false
      if (!sameMark(before.get(item.trackId) ?? null, mark)) {
        setBatchItemEntry(tx, batchId, item.trackId, DUPLICATE_ENTRY, mark ?? undefined)
        changed = true
      }
      if (flagged === (mark !== null)) continue
      changed = true
      setBatchItemProposal(tx, batchId, item.trackId, {
        fields: proposal.fields,
        warnings: PREVIEW_WARNINGS.filter((warning) =>
          warning === 'DUPLICATE' ? mark !== null : proposal.warnings?.includes(warning)
        )
      })
    }
    return changed
  })
}

/** The groups of a batch, in the order of their first tracks. */
export function listDuplicateGroups(db: AppDatabase, batchId: number): DuplicateGroup[] {
  const groups = new Map<number, { described: Described; mark: DuplicateMark }[]>()
  for (const item of listAllBatchItems(db, batchId)) {
    const mark = readDuplicateMark(item.after)
    if (mark === null) continue
    const entry = { described: describe(item), mark }
    const group = groups.get(mark.group)
    if (group) group.push(entry)
    else groups.set(mark.group, [entry])
  }
  const shown = (value: string | null): string | null =>
    value === null ? null : toOneLine(value, MAX_SHOWN_TEXT)
  return [...groups]
    .sort(([a], [b]) => a - b)
    .map(([id, entries]) => {
      const suggested = suggestKeep(entries.map(({ described }) => described.candidate))
      // Named by the copy that stays: that is the one the library goes on with.
      const named = (entries.find(({ mark }) => mark.keep) ?? entries[0])?.described.candidate
      const members: DuplicateMember[] = entries.map(({ described, mark }) => ({
        trackId: described.item.trackId,
        fileName: described.fileName,
        folder: described.folder,
        format: toOneLine(described.candidate.format, MAX_FORMAT_LENGTH),
        bitrateKbps: described.candidate.bitrateKbps,
        durationMs: described.candidate.durationMs,
        keep: mark.keep,
        suggested: described.item.trackId === suggested,
        excluded: described.item.excluded
      }))
      return {
        id,
        artist: shown(named?.artist ?? null),
        title: shown(named?.title ?? null),
        mix: shown(named?.mix ?? null),
        members
      }
    })
}

/**
 * Makes one copy the one its group keeps, in place of the copy that was. Returns
 * false when the track is in no group of the batch.
 */
export function keepDuplicate(db: AppDatabase, batchId: number, trackId: number): boolean {
  return db.transaction((tx) => {
    const items = listAllBatchItems(tx, batchId)
    const own = items.find((item) => item.trackId === trackId)
    const group = own === undefined ? null : readDuplicateMark(own.after)?.group
    if (group === null || group === undefined) return false
    for (const item of items) {
      const mark = readDuplicateMark(item.after)
      if (mark?.group !== group) continue
      const next: DuplicateMark = {
        group,
        keep: item.trackId === trackId,
        keeper: trackId,
        chosen: true
      }
      if (!sameMark(mark, next)) {
        setBatchItemEntry(tx, batchId, item.trackId, DUPLICATE_ENTRY, next)
      }
    }
    return true
  })
}
