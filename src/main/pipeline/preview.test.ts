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
import { listTrackCues } from '../db/cues'
import { batchItems, cues } from '../db/schema'
import { listStyles, replaceStyles } from '../db/styles'
import { getTrackById, insertTracks, updateTrack } from '../db/tracks'
import { logger } from '../services/logger'
import type { PythonBridge } from '../services/python-bridge'
import { AppError } from '@shared/errors'
import type { PreviewRow } from '@shared/preview'
import { DEFAULT_STYLES } from '@shared/settings'
import { buildPreviewRow, commitApprovedValues, createPreview, type Preview } from './preview'
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

type Covers = NonNullable<Parameters<typeof createPreview>[0]['covers']>
type Python = NonNullable<Parameters<typeof createPreview>[0]['python']>

function preview(
  stages: Stage[] = [naming],
  now?: () => number,
  covers?: Partial<Covers>,
  python?: Python
): Preview {
  return createPreview({
    now,
    python,
    covers: covers && {
      thumbnail: async () => null,
      ensure: async () => {},
      importPicture: async () => {
        throw new Error('no picture')
      },
      remove: async () => {},
      ...covers
    },
    db: testDatabase.db,
    stages,
    orchestrator: {
      applyBatch: async (id) => {
        applied.push(id)
        return { ok: true, value: { batchId: id } }
      },
      undoLast: async () => ({ ok: true, value: { batchId: 7, restored: 3, removed: 1, left: 0 } })
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
    for (const trackId of trackIds) commitApprovedValues(testDatabase.db, batchId, trackId)

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
    for (const trackId of trackIds) commitApprovedValues(testDatabase.db, batchId, trackId)

    // Assert
    expect(track(id)).toMatchObject({ title: 'old one', lockedFields: [] })
  })

  it('is not written over by the next automatic run', () => {
    // Arrange
    const [id] = trackIds as [number]
    const rows = preview()
    rows.edit({ batchId, trackId: id, field: 'title', value: 'By Hand' })
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    for (const trackId of trackIds) commitApprovedValues(testDatabase.db, batchId, trackId)
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
      batch: {
        id: batchId,
        type: 'run',
        mode: 'in_place',
        total: 3,
        excluded: 0,
        failed: 0,
        canRefresh: false,
        findsDuplicates: false,
        findsCovers: false,
        organizes: false,
        placesCues: false,
        normalizes: false
      },
      canUndo: true
    })
  })

  it('passes an undo on, and says how many files it put back and removed', async () => {
    // Act
    const undone = await preview().undoLast()

    // Assert
    expect(undone).toEqual({ ok: true, value: { restored: 3, removed: 1, left: 0 } })
  })
})

describe('what the second look at the preview found', () => {
  it('does not lock a style that the track did not get, because the style was deleted', () => {
    // Arrange
    const [id] = trackIds as [number]
    replaceStyles(testDatabase.db, [{ name: 'House', color: '#22c55e', isHouse: true }])
    const [style] = listStyles(testDatabase.db)
    preview().edit({ batchId, trackId: id, field: 'styleId', value: style?.id ?? -1 })
    preview().edit({ batchId, trackId: id, field: 'title', value: 'By Hand' })
    replaceStyles(testDatabase.db, [])
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    for (const trackId of trackIds) commitApprovedValues(testDatabase.db, batchId, trackId)

    // Assert
    expect(track(id)).toMatchObject({ primaryStyleId: null, lockedFields: ['title'] })
  })

  it('acts only on the batch that waits, not on an older one that is still marked so', () => {
    // Arrange
    const [id] = trackIds as [number]
    const newer = createBatch(testDatabase.db, {
      type: 'run',
      mode: 'in_place',
      items: [{ trackId: id, before: { ...track(id) } }]
    })
    setBatchStatus(testDatabase.db, newer, 'preview')

    // Act
    const edited = preview().edit({ batchId, trackId: id, field: 'title', value: 'x' })
    const discarded = preview().discard(batchId)

    // Assert
    expect(edited).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(discarded).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(getBatch(testDatabase.db, newer)?.status).toBe('preview')
  })

  it('refuses a text of any length before it looks at it', () => {
    // Arrange
    const [id] = trackIds as [number]

    // Act
    const edited = preview().edit({ batchId, trackId: id, field: 'title', value: 'x'.repeat(301) })

    // Assert
    expect(edited).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('a warning that an edit has made untrue', () => {
  it('is taken back by the stage that reported it, and the warnings of other stages stay', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, { warnings: ['DUPLICATE', 'LOW_BITRATE'] })
    // Reports a duplicate only for one title.
    const duplicates: Stage = {
      ...naming,
      warnings: ['DUPLICATE'],
      recompute: (_track, values) => (values.title === 'Twice' ? { warnings: ['DUPLICATE'] } : {})
    }
    const edits = preview([duplicates])

    // Act
    const fixed = edits.edit({ batchId, trackId: id, field: 'title', value: 'Once' })
    const again = edits.edit({ batchId, trackId: id, field: 'title', value: 'Twice' })

    // Assert
    expect(fixed.ok && fixed.value.warnings).toEqual(['LOW_BITRATE'])
    expect(again.ok && again.value.warnings).toEqual(['DUPLICATE', 'LOW_BITRATE'])
  })
})

describe('a list of tracks to take out', () => {
  it('is refused by its length, before its entries are looked at', () => {
    // Arrange
    const tooMany = Array.from({ length: 20_001 }, () => 'not even a number')

    // Act
    const result = preview().setExcluded({ batchId, trackIds: tooMany, excluded: true })

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('the tempo and key of a batch', () => {
  const measured = {
    fields: {
      bpm: { value: 124, source: 'analysis', confidence: 0.9 },
      key: { value: '8A', source: 'analysis' }
    }
  }

  it('are shown next to what the track had before', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, measured)

    // Act
    const row = rowOf(id)

    // Assert
    expect(row.cells.bpm).toEqual({
      before: null,
      after: 124,
      changed: true,
      source: 'analysis',
      confidence: 0.9
    })
    expect(row.cells.key).toMatchObject({ before: null, after: '8A', changed: true })
    expect(row.warnings).toEqual([])
  })

  it('flag a tempo that is a weak guess', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, { fields: { bpm: { value: 124, source: 'analysis', confidence: 0.4 } } })

    // Act
    const row = rowOf(id)

    // Assert
    expect(row.warnings).toEqual(['LOW_CONFIDENCE'])
  })

  it("become the track's own when the batch is approved, without being locked", () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, measured)
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(track(id)).toMatchObject({
      bpm: 124,
      camelotKey: '8A',
      musicalKey: 'Am',
      lockedFields: []
    })
  })

  it('are not written for a track that was not approved', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, measured)

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(track(id)).toMatchObject({ bpm: null, camelotKey: null, musicalKey: null })
  })

  it('are not written for a row that was taken out', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, measured)
    preview().setExcluded({ batchId, trackIds: [id], excluded: true })
    testDatabase.db
      .update(batchItems)
      .set({ approved: true })
      .where(eq(batchItems.excluded, false))
      .run()

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(track(id)).toMatchObject({ bpm: null, camelotKey: null })
  })

  it('take a key the user chose by hand, and lock it', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, measured)
    const rows = preview()

    // Act
    const edited = rows.edit({ batchId, trackId: id, field: 'key', value: '11B' })
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(edited.ok && edited.value.cells.key).toMatchObject({ after: '11B', source: 'manual' })
    expect(track(id)).toMatchObject({
      bpm: 124,
      camelotKey: '11B',
      musicalKey: 'A',
      lockedFields: ['key']
    })
  })

  it('leave a key that was set by hand alone in the next run', () => {
    // Arrange
    const [id] = trackIds as [number]
    preview().edit({ batchId, trackId: id, field: 'key', value: '11B' })
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    commitApprovedValues(testDatabase.db, batchId, id)
    setBatchStatus(testDatabase.db, batchId, 'applied')
    const next = createBatch(testDatabase.db, {
      type: 'run',
      mode: 'in_place',
      items: [{ trackId: id, before: { ...track(id) } }]
    })

    // Act
    mergeBatchItemProposal(testDatabase.db, next, id, measured, track(id).lockedFields)
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    commitApprovedValues(testDatabase.db, next, id)

    // Assert
    expect(track(id)).toMatchObject({ bpm: 124, camelotKey: '11B', musicalKey: 'A' })
  })

  it('keep a key that was locked after the stage had proposed another', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, measured)
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    updateTrack(testDatabase.db, id, { camelotKey: '11B', musicalKey: 'A', lockedFields: ['key'] })

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(track(id)).toMatchObject({ bpm: 124, camelotKey: '11B', musicalKey: 'A' })
  })

  it('can be cleared by hand', () => {
    // Arrange
    const [id] = trackIds as [number]
    updateTrack(testDatabase.db, id, { camelotKey: '8A', musicalKey: 'Am' })
    const rows = preview()

    // Act
    rows.edit({ batchId, trackId: id, field: 'key', value: null })
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(track(id)).toMatchObject({ camelotKey: null, musicalKey: null, lockedFields: ['key'] })
  })

  it.each(['13A', '8C', 'Am', '8a', ''])('refuse %j as a key', (value) => {
    // Arrange
    const [id] = trackIds as [number]

    // Act
    const edited = preview().edit({ batchId, trackId: id, field: 'key', value })

    // Assert
    expect(edited).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('cannot have the tempo set from the page', () => {
    // Arrange
    const [id] = trackIds as [number]

    // Act
    const edited = preview().edit({ batchId, trackId: id, field: 'bpm', value: 128 })

    // Assert
    expect(edited).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('show a stored key only when it is one of the 24 codes', () => {
    // Arrange
    const [known, odd] = trackIds as [number, number]
    const item = getBatchItem(testDatabase.db, batchId, known)
    if (!item) throw new Error('no such item')

    // Act
    const shown = buildPreviewRow({ ...item, before: { camelotKey: '8a', bpm: 123.5 } })
    const hidden = buildPreviewRow({ ...item, trackId: odd, before: { camelotKey: 'Am' } })

    // Assert
    expect(shown.cells.key.before).toBe('8A')
    expect(shown.cells.bpm.before).toBe(123.5)
    expect(hidden.cells.key.before).toBeNull()
  })
})

describe('what a lookup found', () => {
  const ACOUSTID = '9ff43b6a-4f16-427c-93c2-92307ca505e0'
  const MBID = '59d61a60-0a62-4004-b0d5-8c55fa62ddbe'
  const found = {
    fields: {
      title: { value: 'Found Title', source: 'musicbrainz', confidence: 0.9 },
      album: { value: 'Found Album', source: 'musicbrainz', confidence: 0.9 },
      label: { value: 'Found Label', source: 'discogs', confidence: 0.9 },
      year: { value: 1997, source: 'musicbrainz', confidence: 0.9 }
    },
    identifiers: { acoustId: ACOUSTID, musicbrainzRecordingId: MBID }
  }

  /** A lookup that answers with the next of `answers`, and notes how it was asked. */
  function lookupStage(answers: (Record<string, unknown> | Error)[]): Stage & { asked: boolean[] } {
    const asked: boolean[] = []
    return {
      name: 'lookup',
      phase: 'compute',
      resource: 'network',
      dependsOn: [],
      selectable: true,
      refreshable: true,
      timeoutMs: 1000,
      warnings: ['LOW_CONFIDENCE'],
      asked,
      run: async (context) => {
        asked.push(context.refresh === true)
        const answer = answers.shift()
        if (answer instanceof Error) throw answer
        return { proposal: answer }
      }
    }
  }

  function withLookupJobs(): void {
    insertJobs(
      testDatabase.db,
      trackIds.map((trackId) => ({ batchId, trackId, stage: 'lookup', phase: 'compute' as const }))
    )
  }

  it('is shown with the album, the label and the year next to what the track had', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, found)

    // Act
    const row = rowOf(id)

    // Assert
    expect(row.cells.album).toMatchObject({ before: null, after: 'Found Album', changed: true })
    expect(row.cells.label).toMatchObject({ after: 'Found Label', source: 'discogs' })
    expect(row.cells.year).toMatchObject({ after: 1997, source: 'musicbrainz' })
  })

  it('leaves its names to the stage that writes the tags, and gives the track its ids', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, found)
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(track(id)).toMatchObject({
      acoustId: ACOUSTID,
      musicbrainzRecordingId: MBID,
      // The row says no more than the file: the names wait for the tags to be written.
      title: 'old one',
      album: null,
      label: null,
      year: null,
      lockedFields: []
    })
  })

  it('gives the track no id that is none', () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, { ...found, identifiers: { acoustId: 'x; drop', musicbrainzRecordingId: MBID } })
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(track(id)).toMatchObject({ acoustId: null, musicbrainzRecordingId: null })
  })

  it('says that a batch which looked tracks up can be asked again, row by row', () => {
    // Arrange
    withLookupJobs()

    // Act
    const state = preview([naming, lookupStage([])]).state()

    // Assert
    expect(state.batch?.canRefresh).toBe(true)
  })

  it('asks again for one row, and shows what was found this time', async () => {
    // Arrange
    const [id, other] = trackIds as [number, number]
    withLookupJobs()
    propose(id, {
      fields: { title: { value: 'old one', source: 'id3' } },
      warnings: ['LOW_CONFIDENCE']
    })
    const lookup = lookupStage([found])
    const rows = preview([naming, lookup])

    // Act
    const refreshed = await rows.refresh({ batchId, trackId: id })

    // Assert
    expect(lookup.asked).toEqual([true])
    expect(refreshed.ok && refreshed.value.cells.title).toMatchObject({
      after: 'Found Title',
      source: 'musicbrainz'
    })
    // The flag of the first answer is gone, and the file name follows the new title.
    expect(refreshed.ok && refreshed.value.warnings).toEqual([])
    expect(refreshed.ok && refreshed.value.cells.fileName.after).toBe(
      'Old Artist - Found Title.mp3'
    )
    expect(rowOf(other).cells.title.changed).toBe(false)
  })

  it('keeps what the user typed when a row is asked about again', async () => {
    // Arrange
    const [id] = trackIds as [number]
    withLookupJobs()
    const rows = preview([naming, lookupStage([found])])
    rows.edit({ batchId, trackId: id, field: 'title', value: 'By Hand' })

    // Act
    const refreshed = await rows.refresh({ batchId, trackId: id })

    // Assert
    expect(refreshed.ok && refreshed.value.cells.title).toMatchObject({
      after: 'By Hand',
      source: 'manual'
    })
    expect(refreshed.ok && refreshed.value.cells.album.after).toBe('Found Album')
  })

  it('leaves the row as it was when the services cannot be asked', async () => {
    // Arrange
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const [id] = trackIds as [number]
    withLookupJobs()
    propose(id, found)
    const before = rowOf(id)
    const rows = preview([naming, lookupStage([new AppError('LOOKUP_FAILED', 'offline')])])

    // Act
    const refreshed = await rows.refresh({ batchId, trackId: id })

    // Assert
    expect(refreshed).toEqual({ ok: false, code: 'LOOKUP_FAILED' })
    expect(rowOf(id)).toEqual(before)
    expect(getBatchItem(testDatabase.db, batchId, id)?.error).toBeNull()
  })

  it('lets nothing else change the batch while a row is asked about', async () => {
    // Arrange
    const [id, other] = trackIds as [number, number]
    withLookupJobs()
    const rows = preview([naming, lookupStage([found, found])])

    // Act
    const refreshing = rows.refresh({ batchId, trackId: id })
    const second = await rows.refresh({ batchId, trackId: other })
    const edited = rows.edit({ batchId, trackId: other, field: 'title', value: 'late' })
    const approved = await rows.approve(batchId)
    await refreshing
    const afterwards = rows.edit({ batchId, trackId: other, field: 'title', value: 'now' })

    // Assert
    expect(second).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(edited).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(approved).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(applied).toEqual([])
    expect(afterwards.ok).toBe(true)
  })

  it.each([
    ['a batch that looked nothing up', false, {}],
    ['a row of another batch', true, { batchId: 999 }],
    ['a track that is not in the batch', true, { trackId: 999 }],
    ['a request with anything else in it', true, { field: 'title' }]
  ])('refuses to ask again for %s', async (_name, ranLookup, change) => {
    // Arrange
    const [id] = trackIds as [number]
    if (ranLookup) withLookupJobs()
    const lookup = lookupStage([found])

    // Act
    const refreshed = await preview([naming, lookup]).refresh({ batchId, trackId: id, ...change })

    // Assert
    expect(refreshed).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(lookup.asked).toEqual([])
  })

  it('refuses to ask again about a track that failed', async () => {
    // Arrange
    const [id] = trackIds as [number]
    withLookupJobs()
    setBatchItemError(testDatabase.db, batchId, {
      trackId: id,
      stage: 'lookup',
      code: 'LOOKUP_FAILED',
      message: 'The online lookup failed'
    })
    const lookup = lookupStage([found])

    // Act
    const refreshed = await preview([naming, lookup]).refresh({ batchId, trackId: id })

    // Assert
    expect(refreshed).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(lookup.asked).toEqual([])
  })
})

describe('a lookup that is asked again', () => {
  const ACOUSTID = '9ff43b6a-4f16-427c-93c2-92307ca505e0'
  const MBID = '59d61a60-0a62-4004-b0d5-8c55fa62ddbe'
  const OTHER_MBID = 'cd2e7c47-16f5-46c6-a37c-a1eb7bf599ff'
  const first = {
    fields: {
      title: { value: 'First Title', source: 'musicbrainz', confidence: 0.9 },
      album: { value: 'First Album', source: 'musicbrainz', confidence: 0.9 },
      label: { value: 'First Label', source: 'discogs', confidence: 0.9 }
    },
    identifiers: { acoustId: ACOUSTID, musicbrainzRecordingId: MBID }
  }

  function asking(answer: Record<string, unknown>): Stage {
    return {
      name: 'lookup',
      phase: 'compute',
      resource: 'network',
      dependsOn: [],
      selectable: true,
      refreshable: true,
      proposes: ['artist', 'title', 'album', 'label', 'year'],
      timeoutMs: 1000,
      warnings: ['LOW_CONFIDENCE'],
      run: async () => ({ proposal: answer })
    }
  }

  beforeEach(() => {
    insertJobs(
      testDatabase.db,
      trackIds.map((trackId) => ({ batchId, trackId, stage: 'lookup', phase: 'compute' as const }))
    )
  })

  it('and finds nothing this time leaves nothing of the first answer with the row', async () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, first)
    const nothing = {
      fields: { title: { value: 'old one', source: 'id3', confidence: 0 } },
      warnings: ['LOW_CONFIDENCE'],
      identifiers: null
    }

    // Act
    const refreshed = await preview([naming, asking(nothing)]).refresh({ batchId, trackId: id })
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(refreshed.ok && refreshed.value.cells.title).toMatchObject({
      after: 'old one',
      source: 'id3'
    })
    expect(refreshed.ok && refreshed.value.cells.album).toMatchObject({
      after: null,
      changed: false
    })
    expect(refreshed.ok && refreshed.value.cells.label.changed).toBe(false)
    expect(refreshed.ok && refreshed.value.warnings).toEqual(['LOW_CONFIDENCE'])
    expect(track(id)).toMatchObject({ acoustId: null, musicbrainzRecordingId: null })
  })

  it('and finds another recording shows that one alone, also where it names less', async () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, first)
    const second = {
      fields: { title: { value: 'Second Title', source: 'musicbrainz', confidence: 0.8 } },
      identifiers: { acoustId: null, musicbrainzRecordingId: OTHER_MBID }
    }

    // Act
    const refreshed = await preview([naming, asking(second)]).refresh({ batchId, trackId: id })

    // Assert
    expect(refreshed.ok && refreshed.value.cells.title.after).toBe('Second Title')
    expect(refreshed.ok && refreshed.value.cells.album.after).toBeNull()
    expect(refreshed.ok && refreshed.value.cells.label.after).toBeNull()
  })

  it('keeps a title the user typed, and drops the rest of the old answer', async () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, first)
    const rows = preview([
      naming,
      asking({ fields: {}, warnings: ['LOW_CONFIDENCE'], identifiers: null })
    ])
    rows.edit({ batchId, trackId: id, field: 'title', value: 'By Hand' })

    // Act
    const refreshed = await rows.refresh({ batchId, trackId: id })

    // Assert
    expect(refreshed.ok && refreshed.value.cells.title).toMatchObject({
      after: 'By Hand',
      source: 'manual'
    })
    expect(refreshed.ok && refreshed.value.cells.album.after).toBeNull()
  })

  it('by names keeps the AcoustID an earlier match by fingerprint gave the track', () => {
    // Arrange
    const [id] = trackIds as [number]
    updateTrack(testDatabase.db, id, { acoustId: ACOUSTID, musicbrainzRecordingId: MBID })
    propose(id, {
      fields: { title: { value: 'Found', source: 'musicbrainz', confidence: 0.8 } },
      identifiers: { acoustId: null, musicbrainzRecordingId: OTHER_MBID }
    })
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(track(id)).toMatchObject({ acoustId: ACOUSTID, musicbrainzRecordingId: OTHER_MBID })
  })
})

describe('a page that asks for refreshes in a loop', () => {
  it('is answered at most once in two seconds, and the services are not asked in between', async () => {
    // Arrange
    const [id] = trackIds as [number]
    insertJobs(testDatabase.db, [{ batchId, trackId: id, stage: 'lookup', phase: 'compute' }])
    let asked = 0
    const lookup: Stage = {
      ...naming,
      name: 'lookup',
      refreshable: true,
      recompute: undefined,
      run: async () => {
        asked += 1
        return {
          proposal: { fields: { title: { value: `Answer ${asked}`, source: 'musicbrainz' } } }
        }
      }
    }
    let time = 10_000
    const rows = preview([lookup], () => time)

    // Act
    const first = await rows.refresh({ batchId, trackId: id })
    time += 1999
    const tooSoon = await rows.refresh({ batchId, trackId: id })
    time += 1
    const later = await rows.refresh({ batchId, trackId: id })

    // Assert
    expect(first.ok).toBe(true)
    expect(tooSoon).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(later.ok && later.value.cells.title.after).toBe('Answer 2')
    expect(asked).toBe(2)
  })
})

describe('the covers of the rows', () => {
  const STEM = '0123456789abcdef0123456789abcdef01234567'
  const OLD = 'fedcba9876543210fedcba9876543210fedcba98'
  const covers = {
    thumbnail: async (name: string): Promise<string | null> => `data:image/jpeg;base64,${name}`
  }

  it('gives the old and the new cover of the rows that found one', async () => {
    // Arrange
    const [first, second, third] = trackIds as [number, number, number]
    propose(first, {
      fields: { cover: { value: `${STEM}.jpg`, source: 'itunes' } },
      cover: { thumb: `${STEM}.thumb.jpg`, before: null }
    })
    propose(second, {
      fields: { cover: { value: `${STEM}.jpg`, source: 'discogs' } },
      cover: {
        thumb: `${STEM}.thumb.jpg`,
        before: { width: 200, height: 200, thumb: `${OLD}.thumb.jpg` }
      }
    })
    propose(third, { warnings: ['NO_COVER'], cover: null })

    // Act
    const thumbs = await preview([naming], undefined, covers).coverThumbs({
      batchId,
      trackIds: [first, second, third, 9999]
    })

    // Assert
    expect(thumbs).toEqual({
      ok: true,
      value: [
        {
          trackId: first,
          hadBefore: false,
          before: null,
          beforeSize: null,
          after: `data:image/jpeg;base64,${STEM}.thumb.jpg`
        },
        {
          trackId: second,
          hadBefore: true,
          before: `data:image/jpeg;base64,${OLD}.thumb.jpg`,
          beforeSize: { width: 200, height: 200 },
          after: `data:image/jpeg;base64,${STEM}.thumb.jpg`
        }
      ]
    })
    expect(rowOf(first).cells.cover).toMatchObject({
      before: null,
      changed: true,
      source: 'itunes'
    })
  })

  it.each([
    [{ batchId: 999, trackIds: [1] }],
    [{ batchId: 1, trackIds: [] }],
    [{ batchId: 1, trackIds: Array.from({ length: 101 }, (_, index) => index + 1) }],
    [{ batchId: 1, trackIds: ['../x'] }]
  ])('refuses a request that is not one for rows of the batch that waits', async (request) => {
    // Act
    const thumbs = await preview([naming], undefined, covers).coverThumbs(
      request.batchId === 1 ? { ...request, batchId } : request
    )

    // Assert
    expect(thumbs).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('says a batch looked for covers once it ran the cover stage', () => {
    // Arrange
    const [id] = trackIds as [number]
    insertJobs(testDatabase.db, [{ batchId, trackId: id, stage: 'cover', phase: 'compute' }])

    // Act
    const state = preview().state()

    // Assert
    expect(state.batch?.findsCovers).toBe(true)
  })
})

describe('a cover the user chooses', () => {
  const STEM = '0123456789abcdef0123456789abcdef01234567'
  const CHOSEN = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd'
  let removed: string[]
  let prepared: unknown[]

  const covers: Partial<Covers> = {
    importPicture: async () => `${CHOSEN}.download`,
    remove: async (name) => void removed.push(name)
  }

  function sidecar(refuse = false): Python {
    return () => ({
      call: (async (method: string, params: unknown) => {
        if (method === 'cover.inspect') return { cover: null }
        prepared.push(params)
        if (refuse) throw new AppError('PYTHON_ERROR', 'cover.prepare: refused')
        return { cover: `${CHOSEN}.jpg`, thumb: `${CHOSEN}.thumb.jpg`, width: 800, height: 800 }
      }) as PythonBridge['call']
    })
  }

  beforeEach(() => {
    removed = []
    prepared = []
    insertJobs(
      testDatabase.db,
      trackIds.map((trackId) => ({ batchId, trackId, stage: 'cover', phase: 'compute' as const }))
    )
  })

  it('becomes the cover the row proposes, by hand, in the place of a placeholder and its warning', async () => {
    // Arrange
    const [id] = trackIds as [number]
    propose(id, {
      fields: { cover: { value: `${STEM}.jpg`, source: 'placeholder' } },
      warnings: ['NO_COVER'],
      cover: {
        thumb: `${STEM}.thumb.jpg`,
        before: null,
        placeholder: { artist: 'A', title: 'T', color: '#111111' }
      }
    })

    // Act
    const result = await preview([naming], undefined, covers, sidecar()).setCover(
      { batchId, trackId: id },
      '/Users/me/Pictures/cover.WEBP'
    )

    // Assert
    expect(result.ok && result.value.cells.cover).toMatchObject({
      after: `${CHOSEN}.jpg`,
      source: 'manual',
      changed: true
    })
    expect(result.ok && result.value.warnings).toEqual([])
    expect(prepared).toEqual([{ source: `${CHOSEN}.download`, manual: true }])
    expect(removed).toEqual([`${CHOSEN}.download`])
    const stored = getBatchItem(testDatabase.db, batchId, id)?.after as Record<string, unknown>
    expect(stored['cover']).toEqual({ thumb: `${CHOSEN}.thumb.jpg`, before: null })
  })

  it.each([
    ['/Users/me/Pictures/cover.gif'],
    ['/Users/me/Pictures/cover'],
    ['/Users/me/Music/track.mp3'],
    ['/net/server/share/cover.png'],
    ['/Network/Servers/x/cover.jpg'],
    ['//net/server/cover.png'],
    ['/NET/server/cover.png'],
    ['/Users/../net/server/cover.png'],
    ['relative/cover.png']
  ])('takes no file that is not a JPG, PNG or WebP on this Mac: %s', async (path) => {
    // Arrange
    const [id] = trackIds as [number]

    // Act
    const result = await preview([naming], undefined, covers, sidecar()).setCover(
      { batchId, trackId: id },
      path
    )

    // Assert
    expect(result).toEqual({ ok: false, code: 'COVER_UNUSABLE' })
    expect(prepared).toEqual([])
  })

  it('says a picture the sidecar makes no cover of cannot be used, and keeps the row', async () => {
    // Arrange
    const [id] = trackIds as [number]
    const before = rowOf(id)

    // Act
    const result = await preview([naming], undefined, covers, sidecar(true)).setCover(
      { batchId, trackId: id },
      '/Users/me/Pictures/tiny.png'
    )

    // Assert
    expect(result).toEqual({ ok: false, code: 'COVER_UNUSABLE' })
    expect(rowOf(id)).toEqual(before)
    expect(removed).toEqual([`${CHOSEN}.download`])
  })

  it('takes nothing for a batch that does not write covers, or a track not in it', async () => {
    // Arrange
    const [id] = trackIds as [number]
    const withoutCovers = createBatch(testDatabase.db, {
      type: 'run',
      mode: 'in_place',
      items: [{ trackId: id, before: { ...track(id) } }]
    })

    // Act
    const other = await preview([naming], undefined, covers, sidecar()).setCover(
      { batchId: withoutCovers, trackId: id },
      '/Users/me/Pictures/cover.png'
    )
    const missing = await preview([naming], undefined, covers, sidecar()).setCover(
      { batchId, trackId: 9999 },
      '/Users/me/Pictures/cover.png'
    )

    // Assert
    expect([other, missing]).toEqual([
      { ok: false, code: 'INVALID_INPUT' },
      { ok: false, code: 'INVALID_INPUT' }
    ])
  })
})

describe('the styles of a batch', () => {
  function seed(): Record<string, number> {
    const stored = replaceStyles(testDatabase.db, DEFAULT_STYLES)
    return Object.fromEntries(stored.map((style) => [style.name, style.id]))
  }

  it("become the track's own when the batch is approved, without being locked", () => {
    // Arrange
    const ids = seed()
    const [id] = trackIds as [number]
    propose(id, {
      fields: {
        styleId: { value: ids['Tech House'], source: 'claude', confidence: 0.9 },
        secondaryStyleId: { value: ids['Afro House'], source: 'claude', confidence: 0.9 }
      },
      style: { newPrimary: null, sources: ['id3'] }
    })
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(track(id)).toMatchObject({
      primaryStyleId: ids['Tech House'],
      secondaryStyleId: ids['Afro House'],
      lockedFields: []
    })
  })

  it('create a new style only when the batch is approved, before Unsorted, with a color of its own', () => {
    // Arrange
    seed()
    const [id] = trackIds as [number]
    propose(id, {
      fields: { styleId: { value: null, source: 'claude', confidence: 0.9 } },
      style: { newPrimary: 'Hip Hop', sources: ['discogs'] }
    })
    const shown = rowOf(id)
    const before = listStyles(testDatabase.db).map((style) => style.name)
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(shown.newStyle).toBe('Hip Hop')
    expect(before).not.toContain('Hip Hop')
    const styles = listStyles(testDatabase.db)
    expect(styles.map((style) => style.name).slice(-2)).toEqual(['Hip Hop', 'Unsorted'])
    const added = styles.find((style) => style.name === 'Hip Hop')
    expect(added).toMatchObject({ isHouse: false, color: '#22d3ee' })
    expect(track(id).primaryStyleId).toBe(added?.id)
  })

  it('take a style the user chose in the place of a new one, and lock it', () => {
    // Arrange
    const ids = seed()
    const [id] = trackIds as [number]
    propose(id, {
      fields: { styleId: { value: null, source: 'claude', confidence: 0.9 } },
      style: { newPrimary: 'Hip Hop', sources: ['discogs'] }
    })
    void preview().edit({ batchId, trackId: id, field: 'styleId', value: ids['Tech House'] })
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(rowOf(id).newStyle).toBeNull()
    expect(listStyles(testDatabase.db).map((style) => style.name)).not.toContain('Hip Hop')
    expect(track(id)).toMatchObject({
      primaryStyleId: ids['Tech House'],
      lockedFields: ['styleId']
    })
  })

  it('leave a style the user locked as it is', () => {
    // Arrange
    const ids = seed()
    const [id] = trackIds as [number]
    updateTrack(testDatabase.db, id, {
      primaryStyleId: ids['Afro House'],
      lockedFields: ['styleId']
    })
    propose(id, {
      fields: { styleId: { value: ids['Tech House'], source: 'claude', confidence: 0.9 } }
    })
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(track(id).primaryStyleId).toBe(ids['Afro House'])
  })

  it('take a new style whose name the list has already, case and hyphens aside', () => {
    // Arrange
    const ids = seed()
    const [id] = trackIds as [number]
    propose(id, {
      fields: { styleId: { value: null, source: 'claude', confidence: 0.9 } },
      style: { newPrimary: 'tech-house', sources: ['discogs'] }
    })
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(listStyles(testDatabase.db)).toHaveLength(DEFAULT_STYLES.length)
    expect(track(id).primaryStyleId).toBe(ids['Tech House'])
  })

  it('leave the track Unsorted when the list holds as many styles as it may', () => {
    // Arrange
    const extra = Array.from({ length: 44 }, (_, index) => ({
      name: `Style ${index + 1}`,
      color: '#123456',
      isHouse: false
    }))
    const stored = replaceStyles(testDatabase.db, [
      ...DEFAULT_STYLES.slice(0, -1),
      ...extra,
      DEFAULT_STYLES[DEFAULT_STYLES.length - 1] as (typeof DEFAULT_STYLES)[number]
    ])
    const [id] = trackIds as [number]
    propose(id, {
      fields: { styleId: { value: null, source: 'claude', confidence: 0.9 } },
      style: { newPrimary: 'Hip Hop', sources: ['discogs'] }
    })
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    commitApprovedValues(testDatabase.db, batchId, id)

    // Assert
    expect(stored).toHaveLength(50)
    expect(listStyles(testDatabase.db)).toHaveLength(50)
    expect(track(id).primaryStyleId).toBe(stored.find((style) => style.name === 'Unsorted')?.id)
  })

  it('take the second style away when the first is set to it', async () => {
    // Arrange
    const ids = seed()
    const [id] = trackIds as [number]
    propose(id, {
      fields: {
        styleId: { value: ids['Tech House'], source: 'claude', confidence: 0.9 },
        secondaryStyleId: { value: ids['Afro House'], source: 'claude', confidence: 0.9 }
      }
    })

    // Act
    const edited = await preview().edit({
      batchId,
      trackId: id,
      field: 'styleId',
      value: ids['Afro House']
    })

    // Assert
    expect(edited.ok && edited.value.cells.styleId.after).toBe(ids['Afro House'])
    expect(edited.ok && edited.value.cells.secondaryStyleId.after).toBeNull()
  })

  it('accept an edit of the secondary style only to a style that exists and is not the first', async () => {
    // Arrange
    const ids = seed()
    const [id] = trackIds as [number]

    // Act
    const known = await preview().edit({
      batchId,
      trackId: id,
      field: 'secondaryStyleId',
      value: ids['Organic House']
    })
    const unknown = await preview().edit({
      batchId,
      trackId: id,
      field: 'secondaryStyleId',
      value: 9999
    })
    await preview().edit({ batchId, trackId: id, field: 'styleId', value: ids['Tech House'] })
    const same = await preview().edit({
      batchId,
      trackId: id,
      field: 'secondaryStyleId',
      value: ids['Tech House']
    })

    // Assert
    expect(known.ok && known.value.cells.secondaryStyleId.after).toBe(ids['Organic House'])
    expect(unknown).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(same).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('the hot cues a batch placed', () => {
  it('show the slots before and after, and become the track cues in the colors of the Settings', () => {
    // Arrange
    const [placed] = trackIds as [number]
    testDatabase.db
      .insert(cues)
      .values({ trackId: placed, slot: 8, positionMs: 1000, name: 'Old', color: '#000000' })
      .run()
    propose(placed, {
      fields: { cues: { value: 'A – – D – – – –', source: 'analysis' } },
      cues: {
        slots: [
          { slot: 1, positionMs: 469 },
          { slot: 4, positionMs: 45_469 }
        ],
        before: '– – – – – – – H'
      }
    })
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    const row = rowOf(placed)
    commitApprovedValues(testDatabase.db, batchId, placed)

    // Assert
    expect(row.cells.cues).toMatchObject({
      before: '– – – – – – – H',
      after: 'A – – D – – – –',
      changed: true
    })
    expect(listTrackCues(testDatabase.db, placed)).toMatchObject([
      { slot: 1, positionMs: 469, name: 'Start', color: '#22c55e' },
      { slot: 4, positionMs: 45_469, name: 'Drop 1', color: '#ef4444' }
    ])
  })

  it('keep a slot the user placed by hand, and leave all of them while the cues are locked', () => {
    // Arrange
    const [byHand, locked] = trackIds as [number, number]
    for (const trackId of [byHand, locked]) {
      testDatabase.db
        .insert(cues)
        .values({ trackId, slot: 4, positionMs: 50_000, name: 'Mine', color: '#000000' })
        .run()
      propose(trackId, {
        cues: {
          slots: [
            { slot: 1, positionMs: 469 },
            { slot: 4, positionMs: 45_469 }
          ],
          before: null
        }
      })
    }
    updateTrack(testDatabase.db, byHand, { lockedFields: ['cue:4'] })
    updateTrack(testDatabase.db, locked, { lockedFields: ['cues'] })
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    for (const trackId of [byHand, locked]) commitApprovedValues(testDatabase.db, batchId, trackId)

    // Assert
    expect(listTrackCues(testDatabase.db, byHand)).toMatchObject([
      { slot: 1, positionMs: 469 },
      { slot: 4, positionMs: 50_000, name: 'Mine' }
    ])
    expect(listTrackCues(testDatabase.db, locked)).toMatchObject([{ slot: 4, positionMs: 50_000 }])
  })
})
