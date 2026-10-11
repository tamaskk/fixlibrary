import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Result } from '@shared/errors'
import type { FixLibraryApi } from '@shared/ipc'
import type { LibraryPage, LibraryTrack, RunRequest, RunTargets } from '@shared/library'

type LibraryApi = FixLibraryApi['library']

function track(id: number, overrides: Partial<LibraryTrack> = {}): LibraryTrack {
  return {
    id,
    fileName: `${id}.mp3`,
    folder: '/Music',
    format: 'mp3',
    durationMs: 200_000,
    artist: null,
    title: `Track ${id}`,
    bpm: null,
    camelotKey: null,
    energy: null,
    styleId: null,
    coverStatus: 'missing',
    stageStatus: { scan: 'done' },
    offline: false,
    fileMissing: false,
    ...overrides
  }
}

/** The library as the main process would serve it; a test may change it between pages. */
let library: LibraryTrack[]
let listCalls: number
let runRequests: RunRequest[]
let beforePage: (offset: number) => void

const api = {
  styles: { list: async () => [] },
  library: {
    status: async () => ({ rootChosen: true, trackCount: library.length, scanning: false }),
    list: async ({ limit, offset }): Promise<Result<LibraryPage>> => {
      listCalls += 1
      beforePage(offset)
      return {
        ok: true,
        value: { tracks: library.slice(offset, offset + limit), total: library.length }
      }
    },
    run: async (request): Promise<Result<RunTargets>> => {
      runRequests.push(request)
      const trackIds = request.scope === 'selection' ? request.trackIds : library.map((t) => t.id)
      return { ok: true, value: { trackIds, skipped: 0 } }
    },
    scan: async () => ({ ok: false, code: 'UNEXPECTED' }),
    followScan: async () => null,
    onScanProgress: () => () => {}
  } satisfies LibraryApi
}

// The store is a module with state: every test gets a fresh one.
async function freshStore(): Promise<typeof import('./library-store').useLibraryStore> {
  vi.resetModules()
  vi.stubGlobal('window', { api })
  return (await import('./library-store')).useLibraryStore
}

const CLICK = { range: false, toggle: false }
const SHIFT = { range: true, toggle: false }

beforeEach(() => {
  library = Array.from({ length: 1200 }, (_, index) => track(index + 1))
  listCalls = 0
  runRequests = []
  beforePage = () => {}
})

describe('loadTracks', () => {
  it('loads a library larger than one page, page by page', async () => {
    // Arrange
    const store = await freshStore()

    // Act
    await store.getState().loadTracks()

    // Assert
    const { list } = store.getState()
    expect(listCalls).toBe(3)
    expect(list.status === 'ready' && list.tracks.map((row) => row.id)).toEqual(
      library.map((row) => row.id)
    )
  })

  it('shows a track once when a scan shifts the rows between two pages', async () => {
    // Arrange
    const store = await freshStore()
    beforePage = (offset) => {
      // A track added at the front after the first page: the second page starts with
      // the last track of the first.
      if (offset === 500) library = [track(5000), ...library]
    }

    // Act
    await store.getState().loadTracks()

    // Assert
    const { list } = store.getState()
    const ids = list.status === 'ready' ? list.tracks.map((row) => row.id) : []
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps only the answer to the latest of two overlapping requests', async () => {
    // Arrange
    const store = await freshStore()
    const first = store.getState().loadTracks()
    library = [track(1), track(2)]

    // Act
    await Promise.all([first, store.getState().loadTracks()])

    // Assert
    const { list } = store.getState()
    expect(list.status === 'ready' && list.tracks).toHaveLength(2)
  })

  it('drops tracks that are gone from the selection when the rows are loaded again', async () => {
    // Arrange
    const store = await freshStore()
    await store.getState().loadTracks()
    store.getState().select(2, CLICK, [1, 2, 3, 4])
    store.getState().select(4, SHIFT, [1, 2, 3, 4])
    library = library.filter((row) => row.id !== 3)

    // Act
    await store.getState().loadTracks()

    // Assert
    expect([...store.getState().selection.ids]).toEqual([2, 4])
  })

  it('reports that the rows could not be loaded', async () => {
    // Arrange
    const store = await freshStore()
    beforePage = () => {
      throw new Error('IPC failed')
    }

    // Act
    await store.getState().loadTracks()

    // Assert
    expect(store.getState().list).toEqual({ status: 'error' })
  })
})

describe('selection and view', () => {
  it('takes a selected track out of the selection when a search hides it', async () => {
    // Arrange
    library = [
      track(1, { title: 'Tűz' }),
      track(2, { title: 'Water' }),
      track(3, { title: 'Tűzhely' })
    ]
    const store = await freshStore()
    await store.getState().loadTracks()
    store.getState().selectAllShown([1, 2, 3])

    // Act
    store.getState().setView({ search: 'tuz' })

    // Assert
    expect([...store.getState().selection.ids]).toEqual([1, 3])
  })

  it('keeps the selection when only the sorting changes', async () => {
    // Arrange
    library = [track(1), track(2), track(3)]
    const store = await freshStore()
    await store.getState().loadTracks()
    store.getState().selectAllShown([1, 2, 3])

    // Act
    store.getState().toggleSort('title')

    // Assert
    expect(store.getState().selection.ids.size).toBe(3)
  })
})

describe('run', () => {
  it('sends exactly the selected ids, and never a track that a filter has hidden', async () => {
    // Arrange
    library = [
      track(1, { title: 'Tűz' }),
      track(2, { title: 'Water' }),
      track(3, { title: 'Tűzhely' })
    ]
    const store = await freshStore()
    await store.getState().loadTracks()
    store.getState().selectAllShown([1, 2, 3])
    store.getState().setView({ search: 'tuz' })

    // Act
    await store.getState().run('selection')

    // Assert
    expect(runRequests).toEqual([{ scope: 'selection', trackIds: [1, 3] }])
    expect(store.getState().lastRun).toEqual({
      ok: true,
      targets: { trackIds: [1, 3], skipped: 0 }
    })
  })

  it('sends no ids for a run on the whole library', async () => {
    // Arrange
    const store = await freshStore()
    await store.getState().loadTracks()
    store.getState().select(5, CLICK, [5])

    // Act
    await store.getState().run('library')

    // Assert
    expect(runRequests).toEqual([{ scope: 'library' }])
  })

  it('does not ask for a run on an empty selection', async () => {
    // Arrange
    const store = await freshStore()
    await store.getState().loadTracks()

    // Act
    await store.getState().run('selection')

    // Assert
    expect(runRequests).toEqual([])
  })

  it('forgets the answer to a run when the selection changes', async () => {
    // Arrange
    const store = await freshStore()
    await store.getState().loadTracks()
    store.getState().select(5, CLICK, [5, 6])
    await store.getState().run('selection')

    // Act
    store.getState().select(6, CLICK, [5, 6])

    // Assert
    expect(store.getState().lastRun).toBeNull()
  })
})
