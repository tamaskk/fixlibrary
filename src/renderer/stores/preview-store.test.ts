import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DuplicateGroup } from '@shared/duplicates'
import type { FixLibraryApi } from '@shared/ipc'
import type { PreviewCell, PreviewRow, PreviewState } from '@shared/preview'
import { useCoverThumbsStore } from './cover-thumbs-store'
import { countRows, shownRows, usePreviewStore } from './preview-store'

const CELL: PreviewCell = {
  before: null,
  after: null,
  changed: false,
  source: null,
  confidence: null
}

function row(trackId: number, overrides: Partial<PreviewRow> = {}): PreviewRow {
  return {
    trackId,
    currentFileName: `${trackId}.mp3`,
    cells: {
      fileName: CELL,
      artist: CELL,
      title: CELL,
      mix: CELL,
      album: CELL,
      label: CELL,
      year: CELL,
      bpm: CELL,
      key: CELL,
      styleId: CELL,
      secondaryStyleId: CELL,
      genre: CELL,
      folder: CELL,
      energy: CELL,
      cover: CELL
    },
    warnings: [],
    excluded: false,
    error: null,
    newStyle: null,
    ...overrides
  }
}

const FAILED = { trackId: 3, stage: 'lookup', code: 'TIMEOUT', message: 'too long' } as const
const ROWS = [
  row(1),
  row(2, { excluded: true, warnings: ['DUPLICATE'] }),
  row(3, { error: FAILED, excluded: true })
]
const WAITING: PreviewState = {
  batch: {
    id: 7,
    type: 'run',
    mode: 'in_place',
    total: 3,
    excluded: 1,
    failed: 1,
    canRefresh: true,
    findsDuplicates: false,
    findsCovers: false,
    organizes: false
  },
  canUndo: false
}

type PreviewApi = FixLibraryApi['preview']

function stubApi(preview: Partial<PreviewApi>): void {
  vi.stubGlobal('window', {
    api: {
      styles: { list: async () => [] },
      preview: {
        state: async () => WAITING,
        rows: async () => ({ ok: true, value: { rows: ROWS, total: ROWS.length } }),
        ...preview
      }
    }
  })
}

beforeEach(() => {
  usePreviewStore.setState(usePreviewStore.getInitialState())
})

describe('shownRows', () => {
  it('shows only the skipped tracks on the errors tab, whatever the filter says', () => {
    // Act
    const shown = shownRows(ROWS, 'errors', 'duplicates')

    // Assert
    expect(shown.map((each) => each.trackId)).toEqual([3])
  })

  it('applies the filter on the changes tab', () => {
    // Act
    const shown = shownRows(ROWS, 'changes', 'duplicates')

    // Assert
    expect(shown.map((each) => each.trackId)).toEqual([2])
  })
})

describe('countRows', () => {
  it('counts a skipped track as failed, not as excluded, and the rest as applied', () => {
    // Act
    const counts = countRows(ROWS)

    // Assert
    expect(counts).toEqual({ applied: 1, excluded: 1, failed: 1 })
  })
})

describe('the preview store', () => {
  it('loads the batch that waits and all of its rows', async () => {
    // Arrange
    stubApi({})

    // Act
    await usePreviewStore.getState().load()

    // Assert
    expect(usePreviewStore.getState()).toMatchObject({
      loaded: true,
      batch: { id: 7 },
      rows: { status: 'ready', rows: ROWS }
    })
  })

  it('shows a row as taken out only once main has taken it', async () => {
    // Arrange
    let answer: (value: Awaited<ReturnType<PreviewApi['setExcluded']>>) => void = () => {}
    stubApi({ setExcluded: () => new Promise((resolve) => (answer = resolve)) })
    await usePreviewStore.getState().load()
    const excludedOf = (): boolean | undefined => {
      const { rows } = usePreviewStore.getState()
      return rows.status === 'ready' ? rows.rows[0]?.excluded : undefined
    }

    // Act
    const excluding = usePreviewStore.getState().setExcluded([1], true)
    const whileAsking = excludedOf()
    answer({ ok: true, value: WAITING })
    await excluding

    // Assert
    expect(whileAsking).toBe(false)
    expect(excludedOf()).toBe(true)
  })

  it('reads the rows again when an edit was not taken for a reason other than its value', async () => {
    // Arrange
    const rows = vi.fn(async () => ({ ok: true as const, value: { rows: ROWS, total: 3 } }))
    stubApi({ rows, edit: async () => ({ ok: false, code: 'UNEXPECTED' }) })
    await usePreviewStore.getState().load()

    // Act
    const taken = await usePreviewStore.getState().edit(1, 'title', 'x')

    // Assert
    expect(taken).toBe(false)
    expect(usePreviewStore.getState().editNote).toBe('failed')
    expect(rows).toHaveBeenCalledTimes(2)
  })

  it('tells a value the field cannot hold from a batch that does not wait any more', async () => {
    // Arrange
    let waiting = WAITING
    stubApi({
      state: async () => waiting,
      edit: async () => ({ ok: false, code: 'INVALID_INPUT' })
    })
    await usePreviewStore.getState().load()

    // Act
    await usePreviewStore.getState().edit(1, 'energy', 99)
    const whileWaiting = usePreviewStore.getState().editNote
    waiting = { batch: null, canUndo: false }
    await usePreviewStore.getState().edit(1, 'energy', 5)

    // Assert
    expect(whileWaiting).toBe('refused')
    expect(usePreviewStore.getState()).toMatchObject({ editNote: 'failed', batch: null })
  })

  it('forgets the note about an edit when the tab or the filter changes', async () => {
    // Arrange
    stubApi({ edit: async () => ({ ok: false, code: 'RUN_ACTIVE' }) })
    await usePreviewStore.getState().load()
    await usePreviewStore.getState().edit(1, 'title', 'x')
    const afterEdit = usePreviewStore.getState().editNote

    // Act
    usePreviewStore.getState().setTab('errors')

    // Assert
    expect(afterEdit).toBe('busy')
    expect(usePreviewStore.getState().editNote).toBeNull()
  })

  it('sends one request for a row whose exclusion is still on its way', async () => {
    // Arrange
    let answer: (value: Awaited<ReturnType<PreviewApi['setExcluded']>>) => void = () => {}
    const setExcluded = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<PreviewApi['setExcluded']>>>((resolve) => (answer = resolve))
    )
    stubApi({ setExcluded })
    await usePreviewStore.getState().load()

    // Act
    const first = usePreviewStore.getState().setExcluded([1], true)
    const second = usePreviewStore.getState().setExcluded([1], true)
    answer({ ok: true, value: WAITING })
    await Promise.all([first, second])

    // Assert
    expect(setExcluded).toHaveBeenCalledTimes(1)
  })

  it('keeps the batch and says what is needed when it does not fit on the drive', async () => {
    // Arrange
    stubApi({
      approve: async () => ({
        ok: true,
        value: { started: false, neededBytes: 5e9, freeBytes: 1e9 }
      })
    })
    await usePreviewStore.getState().load()

    // Act
    const started = await usePreviewStore.getState().approve()

    // Assert
    expect(started).toBe(false)
    expect(usePreviewStore.getState()).toMatchObject({
      batch: { id: 7 },
      busy: null,
      notice: { kind: 'noSpace', neededBytes: 5e9, freeBytes: 1e9 }
    })
  })

  it('has no batch waiting once an approval has started', async () => {
    // Arrange
    stubApi({ approve: async () => ({ ok: true, value: { started: true } }) })
    await usePreviewStore.getState().load()

    // Act
    const started = await usePreviewStore.getState().approve()

    // Assert
    expect(started).toBe(true)
    expect(usePreviewStore.getState().batch).toBeNull()
  })
})

describe('the duplicates of a batch', () => {
  const FINDS: PreviewState = {
    batch: { ...(WAITING.batch as NonNullable<PreviewState['batch']>), findsDuplicates: true },
    canUndo: false
  }
  const member = (trackId: number, keep: boolean): DuplicateGroup['members'][number] => ({
    trackId,
    fileName: `track-${trackId}.mp3`,
    folder: '/Music/Inbox',
    format: 'mp3',
    bitrateKbps: 320,
    durationMs: 300_000,
    keep,
    suggested: trackId === 1,
    excluded: false
  })
  const group = (kept: number): DuplicateGroup => ({
    id: 1,
    artist: 'Bicep',
    title: 'Glue',
    mix: null,
    members: [member(1, kept === 1), member(2, kept === 2)]
  })

  it('are read with the rows, for a batch that looked for them', async () => {
    // Arrange
    stubApi({
      state: async () => FINDS,
      duplicates: async () => ({ ok: true, value: [group(1)] })
    })

    // Act
    await usePreviewStore.getState().load()

    // Assert
    expect(usePreviewStore.getState().duplicates).toEqual({ status: 'ready', groups: [group(1)] })
  })

  it('are not asked for when the batch did not look for them', async () => {
    // Arrange
    const duplicates = vi.fn(async () => ({ ok: true as const, value: [] }))
    stubApi({ duplicates })

    // Act
    await usePreviewStore.getState().load()

    // Assert
    expect(duplicates).not.toHaveBeenCalled()
    expect(usePreviewStore.getState().duplicates).toEqual({ status: 'idle' })
    expect(shownRows(ROWS, 'duplicates', 'all')).toEqual([])
  })

  it('show an error of their own, and the rows all the same, when they cannot be read', async () => {
    // Arrange
    stubApi({
      state: async () => FINDS,
      duplicates: async () => ({ ok: false, code: 'UNEXPECTED' })
    })

    // Act
    await usePreviewStore.getState().load()

    // Assert
    expect(usePreviewStore.getState().duplicates).toEqual({ status: 'error' })
    expect(usePreviewStore.getState().rows.status).toBe('ready')
  })

  it('show the copy that is kept only once main has taken the choice', async () => {
    // Arrange
    let answer: (result: Awaited<ReturnType<PreviewApi['keepDuplicate']>>) => void = () => {}
    const keepDuplicate = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<PreviewApi['keepDuplicate']>>>(
          (resolve) => (answer = resolve)
        )
    )
    stubApi({
      state: async () => FINDS,
      duplicates: async () => ({ ok: true, value: [group(1)] }),
      keepDuplicate
    })
    await usePreviewStore.getState().load()

    // Act
    const keeping = usePreviewStore.getState().keepDuplicate(2)
    // A second choice while the first is on its way is not sent.
    await usePreviewStore.getState().keepDuplicate(1)
    const meanwhile = usePreviewStore.getState().duplicates
    answer({ ok: true, value: [group(2)] })
    await keeping

    // Assert
    expect(keepDuplicate).toHaveBeenCalledTimes(1)
    expect(keepDuplicate).toHaveBeenCalledWith({ batchId: 7, trackId: 2 })
    expect(meanwhile).toEqual({ status: 'ready', groups: [group(1)] })
    expect(usePreviewStore.getState().duplicates).toEqual({ status: 'ready', groups: [group(2)] })
  })

  it('say so when a choice comes while the batch is being approved', async () => {
    // Arrange
    stubApi({
      state: async () => FINDS,
      duplicates: async () => ({ ok: true, value: [group(1)] }),
      keepDuplicate: async () => ({ ok: false, code: 'RUN_ACTIVE' })
    })
    await usePreviewStore.getState().load()

    // Act
    await usePreviewStore.getState().keepDuplicate(2)

    // Assert
    expect(usePreviewStore.getState().editNote).toBe('busy')
    expect(usePreviewStore.getState().duplicates).toEqual({ status: 'ready', groups: [group(1)] })
  })

  it('are read again after a name was changed, and the rows say who is a copy now', async () => {
    // Arrange: row 2 is flagged as a copy; after the edit rows 1 and 3 are the copies.
    let groups = [group(1)]
    const rows = vi.fn(async () => ({
      ok: true as const,
      value: { rows: ROWS, total: ROWS.length }
    }))
    stubApi({
      state: async () => FINDS,
      rows,
      duplicates: async () => ({ ok: true, value: groups }),
      edit: async () => ({ ok: true, value: row(1) })
    })
    await usePreviewStore.getState().load()
    groups = [{ ...group(1), members: [member(1, true), member(3, false)] }]

    // Act
    await usePreviewStore.getState().edit(1, 'energy', 7)
    const afterEnergy = usePreviewStore.getState().duplicates
    await usePreviewStore.getState().edit(1, 'title', 'Another')

    // Assert: an energy makes no track a copy of another, a title may.
    expect(afterEnergy).toEqual({ status: 'ready', groups: [group(1)] })
    expect(usePreviewStore.getState().duplicates).toEqual({ status: 'ready', groups })
    const shown = usePreviewStore.getState().rows
    expect(shown.status === 'ready' && shown.rows.map((each) => each.warnings)).toEqual([
      ['DUPLICATE'],
      [],
      ['DUPLICATE']
    ])
    // The rows themselves are not all read again.
    expect(rows).toHaveBeenCalledTimes(1)
  })

  it('keep the rows that are shown when they cannot be read again after an edit', async () => {
    // Arrange
    let fails = false
    stubApi({
      state: async () => FINDS,
      duplicates: async () =>
        fails ? { ok: false, code: 'UNEXPECTED' } : { ok: true, value: [group(1)] },
      edit: async () => ({ ok: true, value: row(1) })
    })
    await usePreviewStore.getState().load()
    fails = true

    // Act
    const taken = await usePreviewStore.getState().edit(1, 'title', 'Another')

    // Assert
    expect(taken).toBe(true)
    expect(usePreviewStore.getState().rows.status).toBe('ready')
    expect(usePreviewStore.getState().duplicates).toEqual({ status: 'error' })
  })

  it('are read again when an approval is refused because they were out of date', async () => {
    // Arrange
    let groups = [group(1)]
    stubApi({
      state: async () => FINDS,
      duplicates: async () => ({ ok: true, value: groups }),
      approve: async () => ({ ok: false, code: 'PREVIEW_CHANGED' })
    })
    await usePreviewStore.getState().load()
    groups = [group(2)]

    // Act
    const started = await usePreviewStore.getState().approve()

    // Assert: nothing was started, the reason is said, and the page shows what main holds.
    expect(started).toBe(false)
    expect(usePreviewStore.getState().notice).toEqual({ kind: 'failed', code: 'PREVIEW_CHANGED' })
    expect(usePreviewStore.getState().duplicates).toEqual({ status: 'ready', groups: [group(2)] })
    expect(usePreviewStore.getState().batch?.id).toBe(7)
  })

  it('say of a copy that it was taken out as soon as its row says so', async () => {
    // Arrange
    stubApi({
      state: async () => FINDS,
      duplicates: async () => ({ ok: true, value: [group(1)] }),
      setExcluded: async () => ({ ok: true, value: FINDS })
    })
    await usePreviewStore.getState().load()

    // Act
    await usePreviewStore.getState().setExcluded([1], true)

    // Assert
    const { duplicates } = usePreviewStore.getState()
    expect(duplicates.status === 'ready' && duplicates.groups[0]?.members).toMatchObject([
      { trackId: 1, excluded: true },
      { trackId: 2, excluded: false }
    ])
  })
})

describe('a cover the user gives a row', () => {
  const COVER = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd.jpg'
  const WITH_COVER = row(1, {
    cells: { ...row(1).cells, cover: { ...CELL, after: COVER, changed: true, source: 'manual' } }
  })

  beforeEach(() => {
    useCoverThumbsStore.setState(useCoverThumbsStore.getInitialState())
  })

  it('replaces the row, says so, and has the thumbnails of the row asked for again', async () => {
    // Arrange
    stubApi({
      chooseCover: async () => true,
      setChosenCover: async () => ({ ok: true, value: WITH_COVER })
    })
    await usePreviewStore.getState().load()
    useCoverThumbsStore.setState({ batchId: 7, rows: { 1: { status: 'failed' } } })

    // Act
    await usePreviewStore.getState().chooseCover(1)

    // Assert
    const { rows, editNote, settingCover } = usePreviewStore.getState()
    expect(rows.status === 'ready' && rows.rows[0]?.cells.cover.after).toBe(COVER)
    expect({ editNote, settingCover }).toEqual({ editNote: 'coverSet', settingCover: null })
    expect(useCoverThumbsStore.getState().rows[1]).toBeUndefined()
  })

  it('says nothing, and makes nothing, when no picture was chosen', async () => {
    // Arrange
    const setChosenCover = vi.fn()
    stubApi({ chooseCover: async () => false, setChosenCover })
    await usePreviewStore.getState().load()

    // Act
    await usePreviewStore.getState().chooseCover(1)

    // Assert
    expect(usePreviewStore.getState().editNote).toBeNull()
    expect(setChosenCover).not.toHaveBeenCalled()
  })

  it('says a picture is being made a cover only once one was chosen', async () => {
    // Arrange
    let whilePicking: number | null = -1
    let whileMaking: number | null = -1
    stubApi({
      chooseCover: async () => {
        whilePicking = usePreviewStore.getState().settingCover
        return true
      },
      setChosenCover: async () => {
        whileMaking = usePreviewStore.getState().settingCover
        return { ok: true, value: WITH_COVER }
      }
    })
    await usePreviewStore.getState().load()

    // Act
    await usePreviewStore.getState().chooseCover(1)

    // Assert
    expect({ whilePicking, whileMaking }).toEqual({ whilePicking: null, whileMaking: 1 })
  })

  it('keeps the thumbnails of a row given the same picture again', async () => {
    // Arrange
    stubApi({ dropCover: async () => ({ ok: true, value: WITH_COVER }) })
    await usePreviewStore.getState().load()
    const png = new File(['x'], 'a.png', { type: 'image/png' })
    await usePreviewStore.getState().dropCover(1, png)
    const ready = {
      status: 'ready' as const,
      trackId: 1,
      hadBefore: false,
      before: null,
      beforeSize: null,
      after: 'data:image/jpeg;base64,AA'
    }
    useCoverThumbsStore.setState({ batchId: 7, rows: { 1: ready } })

    // Act
    await usePreviewStore.getState().dropCover(1, png)

    // Assert
    expect(useCoverThumbsStore.getState().rows[1]).toEqual(ready)
  })

  it('says another picture is still being made a cover, and takes no second one', async () => {
    // Arrange
    let answer: (value: { ok: true; value: PreviewRow }) => void = () => {}
    const dropCover = vi.fn(
      () => new Promise<{ ok: true; value: PreviewRow }>((resolve) => (answer = resolve))
    )
    stubApi({ dropCover })
    await usePreviewStore.getState().load()
    const png = new File(['x'], 'a.png', { type: 'image/png' })
    const first = usePreviewStore.getState().dropCover(1, png)

    // Act
    await usePreviewStore.getState().dropCover(2, png)
    const note = usePreviewStore.getState().editNote
    answer({ ok: true, value: WITH_COVER })
    await first

    // Assert
    expect(note).toBe('coverBusy')
    expect(dropCover).toHaveBeenCalledOnce()
  })

  it('says a picture cannot be a cover, and keeps the row', async () => {
    // Arrange
    stubApi({ dropCover: async () => ({ ok: false, code: 'COVER_UNUSABLE' }) })
    await usePreviewStore.getState().load()

    // Act
    await usePreviewStore.getState().dropCover(1, new File(['x'], 'a.png', { type: 'image/png' }))

    // Assert
    expect(usePreviewStore.getState().editNote).toBe('coverRefused')
  })

  it('does not blame the picture for a failure that is not its own', async () => {
    // Arrange
    stubApi({
      chooseCover: async () => true,
      setChosenCover: async () => ({ ok: false, code: 'PYTHON_CRASHED' })
    })
    await usePreviewStore.getState().load()

    // Act
    await usePreviewStore.getState().chooseCover(1)

    // Assert
    expect(usePreviewStore.getState().editNote).toBe('failed')
  })

  it('takes a dropped WebP that says nothing of its type, by its name', async () => {
    // Arrange
    const dropCover = vi.fn(async () => ({ ok: true as const, value: WITH_COVER }))
    stubApi({ dropCover })
    await usePreviewStore.getState().load()

    // Act
    await usePreviewStore.getState().dropCover(1, new File(['x'], 'cover.WEBP', { type: '' }))

    // Assert
    expect(dropCover).toHaveBeenCalledOnce()
  })

  it('does not hand over a dropped file that is no picture of a kind it takes', async () => {
    // Arrange
    const dropCover = vi.fn()
    stubApi({ dropCover })
    await usePreviewStore.getState().load()

    // Act
    await usePreviewStore.getState().dropCover(1, new File(['x'], 'a.gif', { type: 'image/gif' }))

    // Assert
    expect(dropCover).not.toHaveBeenCalled()
    expect(usePreviewStore.getState().editNote).toBe('coverRefused')
  })
})
