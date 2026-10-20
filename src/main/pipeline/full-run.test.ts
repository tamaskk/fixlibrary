import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BatchStatus } from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { createFullRun, type FullRun, type FullRunDependencies } from './full-run'
import type { FullRunStep } from '@shared/full-run'
import { INITIAL_WIZARD_STATE, type WizardState } from '@shared/rekordbox-wizard'

let testDatabase: TestDatabase

/** Stand-in batches: what each was started with, and a status the test sets. */
interface World {
  started: { batchId: number; stages: string[]; trackIds: number[] }[]
  status: Map<number, BatchStatus>
  discarded: number[]
  model: boolean
  wizard: WizardState
  busy: boolean
}

function setUp(world: World): FullRunDependencies {
  return {
    db: testDatabase.db,
    libraryTrackIds: () => [1, 2, 3],
    startBatch: ({ trackIds, stages }) => {
      if (world.busy) return { ok: false, code: 'RUN_ACTIVE' }
      const batchId = world.started.length + 1
      world.started.push({ batchId, stages, trackIds })
      world.status.set(batchId, 'computing')
      return { ok: true, value: { batchId } }
    },
    batchStatus: (batchId) => world.status.get(batchId),
    discardBatch: (batchId) => {
      world.discarded.push(batchId)
      world.status.set(batchId, 'cancelled')
    },
    batchCounts: () => ({ total: 3, excluded: 1, failed: 0 }),
    computeStages: () => ['bpmKey', 'naming', 'energy'],
    hasEnergyModel: () => world.model,
    wizardState: () => world.wizard,
    restartWizard: async () => {
      world.wizard = { ...world.wizard, step: 'a.writeXml' }
    },
    ready: () => true,
    now: () => 1000
  }
}

function newWorld(overrides: Partial<World> = {}): World {
  return {
    started: [],
    status: new Map(),
    discarded: [],
    model: true,
    wizard: { ...INITIAL_WIZARD_STATE, setupDone: true, step: 'a.writeXml' },
    busy: false,
    ...overrides
  }
}

function lastBatch(world: World): number {
  return world.started.at(-1)?.batchId ?? -1
}

async function stepAfterTick(fullRun: FullRun): Promise<FullRunStep | undefined> {
  await fullRun.tick()
  return fullRun.view()?.step
}

beforeEach(() => {
  testDatabase = createTestDatabase()
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('the full run', () => {
  it('goes through every step with a model, the stems beside phase A', async () => {
    // Arrange
    const world = newWorld()
    const fullRun = createFullRun(setUp(world))
    fullRun.start({ trackIds: null })

    // Act and assert, step by step
    expect(await stepAfterTick(fullRun)).toBe('compute')
    expect(world.started[0]?.stages).toEqual(['bpmKey', 'naming', 'energy'])
    expect(world.started[0]?.trackIds).toEqual([1, 2, 3])
    const main = lastBatch(world)

    world.status.set(main, 'preview')
    expect(await stepAfterTick(fullRun)).toBe('preview')

    world.status.set(main, 'applying')
    expect(await stepAfterTick(fullRun)).toBe('apply')

    world.status.set(main, 'applied')
    expect(await stepAfterTick(fullRun)).toBe('rekordboxA')
    expect(world.started[1]?.stages).toEqual(['stems'])
    expect(fullRun.view()?.stemsRunning).toBe(true)

    world.wizard = { ...world.wizard, step: 'b.writeXml' }
    expect(await stepAfterTick(fullRun)).toBe('cues')
    // The cues wait for the stems.
    expect(world.started).toHaveLength(2)

    world.status.set(2, 'preview')
    await fullRun.tick()
    expect(world.discarded).toEqual([2])
    expect(world.started[2]?.stages).toEqual(['cues'])

    world.status.set(3, 'applied')
    expect(await stepAfterTick(fullRun)).toBe('rekordboxB')

    world.wizard = { ...world.wizard, step: 'doneB' }
    expect(await stepAfterTick(fullRun)).toBe('done')
    expect(fullRun.view()?.summary).toEqual({ processed: 2, skipped: 1, failed: 0 })
    expect(fullRun.active()).toBe(false)
  })

  it('measures and waits for the calibration first when there is no model', async () => {
    // Arrange
    const world = newWorld({ model: false })
    const fullRun = createFullRun(setUp(world))
    fullRun.start({ trackIds: [2, 3] })

    // Act
    await fullRun.tick()
    world.status.set(1, 'preview')
    const atCalibration = await stepAfterTick(fullRun)
    const stillThere = await stepAfterTick(fullRun)
    world.model = true
    const afterwards = await stepAfterTick(fullRun)

    // Assert
    expect(world.started[0]).toMatchObject({ stages: ['energyFeatures'], trackIds: [2, 3] })
    expect(world.discarded).toEqual([1])
    expect([atCalibration, stillThere, afterwards]).toEqual([
      'calibration',
      'calibration',
      'compute'
    ])
    expect(fullRun.view()?.calibrates).toBe(true)
  })

  it('waits while another batch is in the way', async () => {
    // Arrange
    const world = newWorld({ busy: true })
    const fullRun = createFullRun(setUp(world))
    fullRun.start({ trackIds: null })

    // Act
    await fullRun.tick()
    const waiting = world.started.length
    world.busy = false
    await fullRun.tick()

    // Assert
    expect(waiting).toBe(0)
    expect(world.started).toHaveLength(1)
  })

  it('ends as failed when its batch cannot start at all, and goes on without stems', async () => {
    // Arrange
    const world = newWorld()
    const dependencies = setUp(world)
    const refusing = createFullRun({
      ...dependencies,
      startBatch: () => ({ ok: false, code: 'INVALID_INPUT' })
    })
    refusing.start({ trackIds: null })
    const withoutStems = newWorld()
    const plain = setUp(withoutStems)
    const noStems = createFullRun({
      ...plain,
      db: dependencies.db,
      startBatch: (request) =>
        request.stages.includes('stems')
          ? { ok: false, code: 'INVALID_INPUT' }
          : plain.startBatch(request)
    })

    // Act
    await refusing.tick()
    const refused = refusing.view()
    refusing.stop()
    noStems.start({ trackIds: null })
    await noStems.tick()
    withoutStems.status.set(1, 'applied')
    await noStems.tick()
    withoutStems.wizard = { ...withoutStems.wizard, step: 'b.writeXml' }
    await noStems.tick()

    // Assert
    expect(refused).toMatchObject({ step: 'compute', stop: 'failed' })
    expect(noStems.view()?.step).toBe('cues')
    expect(withoutStems.started.at(-1)?.stages).toEqual(['cues'])
  })

  it('stops when its batch is given up in the preview', async () => {
    // Arrange
    const world = newWorld()
    const fullRun = createFullRun(setUp(world))
    fullRun.start({ trackIds: null })
    await fullRun.tick()
    world.status.set(1, 'preview')
    await fullRun.tick()

    // Act
    world.status.set(1, 'cancelled')
    await fullRun.tick()

    // Assert
    expect(fullRun.view()).toMatchObject({ step: 'preview', stop: 'cancelled' })
    expect(fullRun.active()).toBe(false)
  })

  it('takes a batch approved between two looks', async () => {
    // Arrange
    const world = newWorld()
    const fullRun = createFullRun(setUp(world))
    fullRun.start({ trackIds: null })
    await fullRun.tick()

    // Act
    world.status.set(1, 'applied')
    const step = await stepAfterTick(fullRun)

    // Assert
    expect(step).toBe('rekordboxA')
  })

  it('goes through phase A again when the wizard was done in an earlier run', async () => {
    // Arrange
    const world = newWorld({ wizard: { ...INITIAL_WIZARD_STATE, setupDone: true, step: 'doneB' } })
    const fullRun = createFullRun(setUp(world))
    fullRun.start({ trackIds: null })
    await fullRun.tick()
    world.status.set(1, 'applied')

    // Act
    const step = await stepAfterTick(fullRun)

    // Assert
    expect(step).toBe('rekordboxA')
    expect(world.wizard.step).toBe('a.writeXml')
  })

  it.each([
    ['compute', 0],
    ['preview', 1],
    ['rekordboxA', 3],
    ['cues', 4]
  ] as const)('goes on from %s after a restart', async (expected, steps) => {
    // Arrange: the same world, a second run machine as after a restart.
    const world = newWorld()
    const first = createFullRun(setUp(world))
    first.start({ trackIds: null })
    await first.tick()
    const moves: (() => void)[] = [
      () => world.status.set(1, 'preview'),
      () => world.status.set(1, 'applying'),
      () => world.status.set(1, 'applied'),
      () => {
        world.wizard = { ...world.wizard, step: 'b.writeXml' }
      }
    ]
    for (const move of moves.slice(0, steps)) {
      move()
      await first.tick()
    }

    // Act
    const second = createFullRun(setUp(world))
    await second.tick()

    // Assert
    expect(second.view()?.step).toBe(expected)
    expect(second.active()).toBe(true)
  })

  it('refuses a second start while one goes on, and can be stopped', () => {
    // Arrange
    const fullRun = createFullRun(setUp(newWorld()))
    fullRun.start({ trackIds: null })

    // Act
    const again = fullRun.start({ trackIds: [1] })
    fullRun.stop()

    // Assert
    expect(again).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(fullRun.view()?.stop).toBe('stopped')
    expect(fullRun.start({ trackIds: [1] }).ok).toBe(true)
  })
})
