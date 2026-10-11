import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBatch,
  getBatch,
  getBatchItem,
  mergeBatchItemProposal,
  setBatchItemError,
  setBatchStatus
} from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { insertJobs } from '../db/jobs'
import { batchItems } from '../db/schema'
import { listStyles, replaceStyles } from '../db/styles'
import { getTrackById, insertTracks } from '../db/tracks'
import { logger } from '../services/logger'
import type { PreviewRow } from '@shared/preview'
import { buildPreviewRow, commitManualEdits, createPreview, type Preview } from './preview'
import type { Stage } from './stages/stage'

const NO_VOLUMES: ReadonlySet<string> = new Set()

let testDatabase: TestDatabase
let trackIds: number[]
let batchId: number
let applied: number[]
let space: { enough: boolean; neededBytes: number; freeBytes: number }
let undoable: number | null

/** Names the file after the title, like the stage that will do it for real. */
const naming: Stage = {
  name: 'naming',
  phase: 'compute',
  resource: 'cpu',
  dependsOn: [],
  selectable: true,
  timeoutMs: 1000,
  run: async () => {},
  recompute: (_track, values) => ({
    fields: {
      fileName: { value: `${values.artist ?? '?'} - ${values.title ?? '?'}.mp3`, source: 'lookup' }
    }
  })
}

function preview(stages: Stage[] = [naming]): Preview {
  return createPreview({
    db: testDatabase.db,
    stages,
    orchestrator: {
      applyBatch: async (id) => {
        applied.push(id)
        return { ok: true, value: { batchId: id } }
      },
      undoLast: async () => ({ ok: true, value: { batchId: 7, restored: 3, removed: 1 } })
    },
    batchFiles: { checkSpace: async () => space, lastUndoable: () => undoable },
    listMountedVolumes: () => NO_VOLUMES
  })
}

function propose(trackId: number, proposal: Record<string, unknown>): void {
  mergeBatchItemProposal(testDatabase.db, batchId, trackId, proposal, [])
}

function rowOf(trackId: number): PreviewRow {
  const item = getBatchItem(testDatabase.db, batchId, trackId)
  if (!item) throw new Error('no such item')
  return buildPreviewRow(item)
}

function track(id: number): NonNullable<ReturnType<typeof getTrackById>> {
  const found = getTrackById(testDatabase.db, id, NO_VOLUMES)
  if (!found) throw new Error('no such track')
  return found
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  trackIds = insertTracks(
    testDatabase.db,
    ['one', 'two', 'three'].map((name) => ({
      path: `/Music/${name}.mp3`,
      originalPath: `/Music/${name}.mp3`,
      format: 'mp3' as const,
      artist: 'Old Artist',
      title: `old ${name}`
    }))
  )
  batchId = createBatch(testDatabase.db, {
    type: 'run',
    mode: 'in_place',
    items: trackIds.map((trackId) => ({ trackId, before: { ...track(trackId) } }))
  })
  insertJobs(
    testDatabase.db,
    trackIds.map((trackId) => ({ batchId, trackId, stage: 'naming', phase: 'compute' as const }))
  )
  setBatchStatus(testDatabase.db, batchId, 'preview')
  applied = []
  space = { enough: true, neededBytes: 0, freeBytes: 0 }
  undoable = null
})

afterEach(() => {
  testDatabase.cleanup()
  vi.restoreAllMocks()
})

describe('a row of the preview', () => {
  it('shows every field before and after, with what changed and where it comes from', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, {
      fields: {
        title: { value: 'New One', source: 'lookup', confidence: 0.92 },
        fileName: { value: 'Old Artist - New One.mp3', source: 'lookup' },
        artist: { value: 'Old Artist', source: 'id3' }
      }
    })

    // Act
    const row = rowOf(id)

    // Assert
    expect(row).toMatchObject({ trackId: id, currentFileName: 'one.mp3', excluded: false })
    expect(row.cells.title).toEqual({
      before: 'old one',
      after: 'New One',
      changed: true,
      source: 'lookup',
      confidence: 0.92
    })
    expect(row.cells.fileName).toMatchObject({
      before: 'one.mp3',
      after: 'Old Artist - New One.mp3',
      changed: true
    })
    expect(row.cells.artist).toMatchObject({ changed: false, source: 'id3' })
    expect(row.cells.energy).toEqual({
      before: null,
      after: null,
      changed: false,
      source: null,
      confidence: null
    })
  })

  it('warns about a change that was proposed with less than 70% confidence', () => {
    // Arrange
    const [low, edge, same] = trackIds as [number, number, number]
    propose(low, { fields: { title: { value: 'Guess', source: 'lookup', confidence: 0.69 } } })
    propose(edge, { fields: { title: { value: 'Guess', source: 'lookup', confidence: 0.7 } } })
    // A guess that changes nothing needs no second look.
    propose(same, { fields: { title: { value: 'old three', source: 'lookup', confidence: 0.2 } } })

    // Act
    const warnings = [low, edge, same].map((id) => rowOf(id).warnings)

    // Assert
    expect(warnings).toEqual([['LOW_CONFIDENCE'], [], []])
  })

  it('carries the warnings of the stages, each once, in a fixed order', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, { warnings: ['UNSORTED', 'DUPLICATE'] })
    propose(id, { warnings: ['DUPLICATE', 'NAME_COLLISION', 'LOW_BITRATE', 'CANNOT_NORMALIZE'] })

    // Act
    const row = rowOf(id)

    // Assert
    expect(row.warnings).toEqual([
      'DUPLICATE',
      'NAME_COLLISION',
      'LOW_BITRATE',
      'CANNOT_NORMALIZE',
      'UNSORTED'
    ])
  })

  it('says why a track was skipped', () => {
    // Arrange
    const [id] = trackIds as [number]
    const error = { trackId: id, stage: 'naming', code: 'TIMEOUT', message: 'too long' } as const
    setBatchItemError(testDatabase.db, batchId, error)

    // Act
    const row = rowOf(id)

    // Assert
    expect(row.error).toEqual(error)
  })

  it('is still shown when what is stored for it cannot be read', () => {
    // Arrange
    const [id] = trackIds as [number]
    testDatabase.db
      .update(batchItems)
      .set({ before: 'not a track', after: { fields: 'not fields' } })
      .where(eq(batchItems.trackId, id))
      .run()

    // Act
    const row = rowOf(id)

    // Assert
    expect(row).toMatchObject({ trackId: id, currentFileName: '', warnings: [] })
    expect(row.cells.title.after).toBeNull()
  })
})

describe('the rows of a batch', () => {
  it('come in pages, in the order of the batch, with the size of the whole', () => {
    // Act
    const first = preview().rows({ batchId, offset: 0, limit: 2 })
    const second = preview().rows({ batchId, offset: 2, limit: 2 })

    // Assert
    expect(first.ok && first.value.rows.map((row) => row.trackId)).toEqual(trackIds.slice(0, 2))
    expect(second.ok && second.value.rows.map((row) => row.trackId)).toEqual(trackIds.slice(2))
    expect(first.ok && first.value.total).toBe(3)
  })

  it.each([
    [
      'a batch that does not wait for approval',
      () => setBatchStatus(testDatabase.db, 1, 'applied')
    ],
    ['a request that is not one', () => {}]
  ])('are not given for %s', (_what, arrange) => {
    // Arrange
    arrange()
    const request = _what.startsWith('a request')
      ? { batchId: 'x' }
      : { batchId, offset: 0, limit: 5 }

    // Act
    const rows = preview().rows(request)

    // Assert
    expect(rows).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('editing a field', () => {
  it('stores the value as set by hand, and brings the file name up to date at once', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, {
      fields: {
        title: { value: 'Wrong', source: 'lookup', confidence: 0.5 },
        fileName: { value: 'Old Artist - Wrong.mp3', source: 'lookup' }
      }
    })

    // Act
    const edited = preview().edit({ batchId, trackId: id, field: 'title', value: ' Right ' })

    // Assert
    expect(edited.ok && edited.value.cells.title).toMatchObject({
      after: 'Right',
      source: 'manual',
      confidence: null
    })
    expect(edited.ok && edited.value.cells.fileName.after).toBe('Old Artist - Right.mp3')
    // What the user set is no guess any more.
    expect(edited.ok && edited.value.warnings).toEqual([])
    expect(rowOf(id).cells.fileName.after).toBe('Old Artist - Right.mp3')
  })

  it('keeps what else a stage stored for the track', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, { bpm: 124, warnings: ['DUPLICATE'] })

    // Act
    preview().edit({ batchId, trackId: id, field: 'energy', value: 7 })

    // Assert
    expect(getBatchItem(testDatabase.db, batchId, id)?.after).toMatchObject({
      bpm: 124,
      warnings: ['DUPLICATE'],
      fields: { energy: { value: 7, source: 'manual' } }
    })
  })

  it('does not let a stage that proposes again write over another manual field', () => {
    // Arrange
    const [id] = trackIds as [number]
    const overeager: Stage = {
      ...naming,
      recompute: () => ({ fields: { artist: { value: 'Stage Artist', source: 'lookup' } } })
    }
    const edits = preview([overeager])
    edits.edit({ batchId, trackId: id, field: 'artist', value: 'My Artist' })

    // Act
    const edited = edits.edit({ batchId, trackId: id, field: 'title', value: 'My Title' })

    // Assert
    expect(edited.ok && edited.value.cells.artist.after).toBe('My Artist')
  })

  it('keeps the edit when a stage fails to propose again', () => {
    // Arrange
    const [id] = trackIds as [number]
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const broken: Stage = {
      ...naming,
      recompute: () => {
        throw new Error('broken')
      }
    }

    // Act
    const edited = preview([broken]).edit({ batchId, trackId: id, field: 'title', value: 'Kept' })

    // Assert
    expect(edited.ok && edited.value.cells.title.after).toBe('Kept')
  })

  it('accepts a style of the settings and no other', () => {
    // Arrange
    const [id] = trackIds as [number]
    replaceStyles(testDatabase.db, [{ name: 'House', color: '#22c55e', isHouse: true }])
    const [style] = listStyles(testDatabase.db)
    const edits = preview()

    // Act
    const known = edits.edit({ batchId, trackId: id, field: 'styleId', value: style?.id ?? -1 })
    const unknown = edits.edit({ batchId, trackId: id, field: 'styleId', value: 9999 })

    // Assert
    expect(known.ok && known.value.cells.styleId.after).toBe(style?.id)
    expect(unknown).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it.each([
    ['an energy of 11', { field: 'energy', value: 11 }],
    ['a title of two lines', { field: 'title', value: 'a\nb' }],
    ['the file name', { field: 'fileName', value: 'x.mp3' }],
    ['a field that does not exist', { field: 'path', value: '/etc/passwd' }]
  ])('refuses %s, and stores nothing', (_what, change) => {
    // Arrange
    const [id] = trackIds as [number]

    // Act
    const edited = preview().edit({ batchId, trackId: id, ...change })

    // Assert
    expect(edited).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(getBatchItem(testDatabase.db, batchId, id)?.after).toEqual({})
  })

  it('is refused for a track that a stage failed for', () => {
    // Arrange
    const [id] = trackIds as [number]
    setBatchItemError(testDatabase.db, batchId, {
      trackId: id,
      stage: 'naming',
      code: 'TIMEOUT',
      message: 'too long'
    })

    // Act
    const edited = preview().edit({ batchId, trackId: id, field: 'title', value: 'x' })

    // Assert
    expect(edited).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('is refused once the batch does not wait for approval any more', () => {
    // Arrange
    const [id] = trackIds as [number]
    setBatchStatus(testDatabase.db, batchId, 'applying')

    // Act
    const edited = preview().edit({ batchId, trackId: id, field: 'title', value: 'x' })

    // Assert
    expect(edited).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('taking rows out', () => {
  it('counts them, and brings them back in', () => {
    // Arrange
    const [first, second] = trackIds as [number, number]
    const rows = preview()

    // Act
    const out = rows.setExcluded({ batchId, trackIds: [first, second], excluded: true })
    const back = rows.setExcluded({ batchId, trackIds: [first], excluded: false })

    // Assert
    expect(out.ok && out.value.batch).toMatchObject({ total: 3, excluded: 2, failed: 0 })
    expect(back.ok && back.value.batch).toMatchObject({ excluded: 1 })
    expect(rowOf(second).excluded).toBe(true)
  })
})

describe('approving', () => {
  it('starts the apply phase for exactly the rows that were left in and did not fail', async () => {
    // Arrange
    const [kept, excluded, failed] = trackIds as [number, number, number]
    const rows = preview()
    rows.setExcluded({ batchId, trackIds: [excluded], excluded: true })
    setBatchItemError(testDatabase.db, batchId, {
      trackId: failed,
      stage: 'naming',
      code: 'TIMEOUT',
      message: 'too long'
    })

    // Act
    const outcome = await rows.approve(batchId)

    // Assert
    expect(outcome).toEqual({ ok: true, value: { started: true } })
    expect(applied).toEqual([batchId])
    const approved = testDatabase.db.select().from(batchItems).all()
    expect(approved.filter((item) => item.approved).map((item) => item.trackId)).toEqual([kept])
  })

  it('does not start when the copies would not fit, and says what is needed and what is free', async () => {
    // Arrange
    space = { enough: false, neededBytes: 5_000_000_000, freeBytes: 1_000_000_000 }

    // Act
    const outcome = await preview().approve(batchId)

    // Assert
    expect(outcome).toEqual({
      ok: true,
      value: { started: false, neededBytes: 5_000_000_000, freeBytes: 1_000_000_000 }
    })
    expect(applied).toEqual([])
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('preview')
  })

  it('is refused when every row was taken out', async () => {
    // Arrange
    const rows = preview()
    rows.setExcluded({ batchId, trackIds, excluded: true })

    // Act
    const outcome = await rows.approve(batchId)

    // Assert
    expect(outcome).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(applied).toEqual([])
  })

  it('lets nothing change the batch while it is on its way', async () => {
    // Arrange
    const [id] = trackIds as [number]
    const rows = preview()

    // Act
    const approving = rows.approve(batchId)
    const edited = rows.edit({ batchId, trackId: id, field: 'title', value: 'late' })
    const discarded = rows.discard(batchId)
    await approving

    // Assert
    expect(edited).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(discarded).toEqual({ ok: false, code: 'RUN_ACTIVE' })
  })
})

describe('what the user set by hand', () => {
  it("becomes the track's own and is locked when the batch is applied", () => {
    // Arrange
    const [edited, untouched] = trackIds as [number, number]
    const rows = preview()
    rows.edit({ batchId, trackId: edited, field: 'title', value: 'By Hand' })
    rows.edit({ batchId, trackId: edited, field: 'energy', value: 8 })
    propose(untouched, { fields: { title: { value: 'By Stage', source: 'lookup' } } })
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    commitManualEdits(testDatabase.db, batchId)

    // Assert
    expect(track(edited)).toMatchObject({
      title: 'By Hand',
      energy: 8,
      artist: 'Old Artist',
      lockedFields: ['title', 'energy']
    })
    // What a stage proposed is written by its own apply stage, not here.
    expect(track(untouched)).toMatchObject({ title: 'old two', lockedFields: [] })
  })

  it('is not written or locked for a row that was taken out', () => {
    // Arrange
    const [id] = trackIds as [number]
    const rows = preview()
    rows.edit({ batchId, trackId: id, field: 'title', value: 'By Hand' })
    rows.setExcluded({ batchId, trackIds: [id], excluded: true })
    testDatabase.db
      .update(batchItems)
      .set({ approved: true })
      .where(eq(batchItems.excluded, false))
      .run()

    // Act
    commitManualEdits(testDatabase.db, batchId)

    // Assert
    expect(track(id)).toMatchObject({ title: 'old one', lockedFields: [] })
  })

  it('is not written over by the next automatic run', () => {
    // Arrange
    const [id] = trackIds as [number]
    const rows = preview()
    rows.edit({ batchId, trackId: id, field: 'title', value: 'By Hand' })
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    commitManualEdits(testDatabase.db, batchId)
    setBatchStatus(testDatabase.db, batchId, 'applied')
    const next = createBatch(testDatabase.db, {
      type: 'run',
      mode: 'in_place',
      items: [{ trackId: id, before: { ...track(id) } }]
    })

    // Act: what the orchestrator does with the proposal of a stage.
    mergeBatchItemProposal(
      testDatabase.db,
      next,
      id,
      {
        fields: {
          title: { value: 'By Lookup', source: 'lookup' },
          artist: { value: 'New Artist', source: 'lookup' }
        }
      },
      track(id).lockedFields
    )

    // Assert
    const item = getBatchItem(testDatabase.db, next, id)
    const row = item ? buildPreviewRow(item) : null
    expect(row?.cells.title).toMatchObject({ before: 'By Hand', after: 'By Hand', changed: false })
    expect(row?.cells.artist.after).toBe('New Artist')
  })
})

describe('giving a batch up', () => {
  it('ends it as cancelled, and nothing waits any more', () => {
    // Act
    const state = preview().discard(batchId)

    // Assert
    expect(state).toEqual({ ok: true, value: { batch: null, canUndo: false } })
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('cancelled')
  })
})

describe('the state of the preview', () => {
  it('names the batch that waits, in numbers, and says whether a batch can be undone', () => {
    // Arrange
    undoable = 4

    // Act
    const state = preview().state()

    // Assert
    expect(state).toEqual({
      batch: { id: batchId, type: 'run', mode: 'in_place', total: 3, excluded: 0, failed: 0 },
      canUndo: true
    })
  })

  it('passes an undo on, and says how many files it put back and removed', async () => {
    // Act
    const undone = await preview().undoLast()

    // Assert
    expect(undone).toEqual({ ok: true, value: { restored: 3, removed: 1 } })
  })
})
