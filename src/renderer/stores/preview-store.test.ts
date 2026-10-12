import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FixLibraryApi } from '@shared/ipc'
import type { PreviewCell, PreviewRow, PreviewState } from '@shared/preview'
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
      energy: CELL
    },
    warnings: [],
    excluded: false,
    error: null,
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
    canRefresh: true
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
