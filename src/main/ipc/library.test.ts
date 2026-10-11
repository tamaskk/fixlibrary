import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { batches } from '../db/schema'
import { insertTracks } from '../db/tracks'
import { stubBatchFiles } from '../pipeline/batch-files.test-util'
import { createOrchestrator, type Orchestrator } from '../pipeline/orchestrator'
import type { LibraryScanner } from '../pipeline/scanner'
import type { Stage } from '../pipeline/stages/stage'
import { logger } from '../services/logger'
import { IPC_CHANNELS } from '@shared/ipc'

type Listener = (event: unknown, ...args: unknown[]) => Promise<unknown>

const listeners = new Map<string, Listener>()

// Stands in for Electron: keeps the registered listeners so a test can call them as IPC would.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (channel: string, listener: Listener) => listeners.set(channel, listener) }
}))

const { setRendererEntry } = await import('./handle')
const { registerLibraryIpc } = await import('./library')

const APP_PAGE = '/Applications/FixLibrary.app/Contents/Resources/app.asar/out/renderer/index.html'

let testDatabase: TestDatabase
let orchestrator: Orchestrator
let trackIds: number[]

function stage(name: string, changes: Partial<Stage> = {}): Stage {
  return {
    name,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [],
    selectable: true,
    timeoutMs: 60_000,
    run: () => new Promise((resolve) => setTimeout(resolve, 100)),
    ...changes
  }
}

/** Calls `library:run` as the app's own page would. */
function run(request: unknown): Promise<unknown> {
  const mainFrame = { url: `file://${APP_PAGE}` }
  const listener = listeners.get(IPC_CHANNELS.libraryRun)
  if (!listener) throw new Error('library:run is not registered')
  return listener({ senderFrame: mainFrame, sender: { mainFrame } }, request)
}

function batchCount(): number {
  return testDatabase.db.select().from(batches).all().length
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  listeners.clear()
  testDatabase = createTestDatabase()
  trackIds = insertTracks(
    testDatabase.db,
    ['a', 'b', 'c'].map((name) => ({
      path: `/Music/${name}.mp3`,
      originalPath: `/Music/${name}.mp3`,
      format: 'mp3' as const
    }))
  )
  const stages = [
    stage('bpmKey'),
    stage('internal', { selectable: false }),
    stage('writeTags', { phase: 'apply', resource: 'io', selectable: false })
  ]
  orchestrator = createOrchestrator({
    db: testDatabase.db,
    stages,
    limits: () => ({ cpu: 2, gpu: 1, network: 4, claude: 1, io: 2 }),
    listMountedVolumes: () => new Set(),
    mode: () => 'clean_library',
    batchFiles: stubBatchFiles()
  })
  setRendererEntry({ filePath: APP_PAGE })
  registerLibraryIpc({
    db: testDatabase.db,
    scanner: {} as LibraryScanner,
    orchestrator,
    functions: ['bpmKey'],
    listMountedVolumes: () => new Set()
  })
})

afterEach(() => {
  orchestrator.shutdown()
  vi.useRealTimers()
  vi.restoreAllMocks()
  testDatabase.cleanup()
})

describe('library:run', () => {
  it('starts a run on the selected tracks and says which batch it is', async () => {
    // Act
    const result = await run({
      scope: 'selection',
      trackIds: [trackIds[2], trackIds[0], 999_999],
      stages: ['bpmKey']
    })

    // Assert
    expect(result).toEqual({
      ok: true,
      value: { batchId: expect.any(Number), trackIds: [trackIds[2], trackIds[0]], skipped: 1 }
    })
    expect(orchestrator.progress()).toMatchObject({ counts: { total: 2 } })
  })

  it.each([
    ['a stage that is not offered to the user', ['internal']],
    ['an apply stage', ['writeTags']],
    ['an offered function together with one that is not', ['bpmKey', 'writeTags']],
    ['a name that is no stage', ['__proto__']]
  ])('refuses %s, and creates no batch', async (_name, stages) => {
    // Act
    const result = await run({ scope: 'library', stages })

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(batchCount()).toBe(0)
  })

  it('refuses a run when none of the tracks can be processed', async () => {
    // Act
    const result = await run({ scope: 'selection', trackIds: [999_999], stages: ['bpmKey'] })

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(batchCount()).toBe(0)
  })

  it('refuses a second run while one is active', async () => {
    // Arrange: a paused run stays active for as long as the test needs.
    await run({ scope: 'library', stages: ['bpmKey'] })
    orchestrator.pause()
    await vi.advanceTimersByTimeAsync(10_000)

    // Act
    const second = await run({ scope: 'library', stages: ['bpmKey'] })

    // Assert
    expect(second).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(batchCount()).toBe(1)
  })

  it('starts at most one run in two seconds, however fast a page starts and cancels', async () => {
    // Act
    const results: unknown[] = []
    for (let turn = 0; turn < 50; turn += 1) {
      results.push(await run({ scope: 'library', stages: ['bpmKey'] }))
      orchestrator.cancel()
      await vi.advanceTimersByTimeAsync(100)
    }

    // Assert: 50 turns in five seconds. A batch that was cancelled unwritten is
    // deleted by the next start, so only the last one is left.
    expect(batchCount()).toBe(1)
    expect(results.filter((result) => (result as { ok: boolean }).ok)).toHaveLength(3)
  })
})
