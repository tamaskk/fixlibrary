import { describe, expect, it } from 'vitest'
import { createDemoStages } from './demo'
import { createStages, selectableStages, validateStages, withDependencies } from './index'
import type { LookupClients } from '../../services/lookup/chain'
import type { Stage } from './stage'
import type { AppDatabase } from '../../db/connection'

function stage(name: string, dependsOn: string[] = [], phase: Stage['phase'] = 'compute'): Stage {
  return {
    name,
    phase,
    resource: 'cpu',
    dependsOn,
    selectable: phase === 'compute',
    timeoutMs: 1000,
    run: async () => {}
  }
}

describe('validateStages', () => {
  it('accepts the stages the app ships with', () => {
    // Arrange
    const stages = createStages({
      db: {} as AppDatabase,
      python: () => null,
      bpmRange: () => ({ bpmMin: 85, bpmMax: 175 }),
      cache: { get: () => undefined, put: () => {} },
      wanted: () => false,
      clients: {} as LookupClients
    })

    // Act
    const validate = (): void => validateStages(stages)

    // Assert
    expect(validate).not.toThrow()
  })

  it('accepts stages that depend on each other without a circle', () => {
    // Arrange
    const stages = [
      stage('rename', ['naming'], 'apply'),
      stage('naming', ['bpmKey', 'lookup']),
      stage('lookup'),
      stage('bpmKey')
    ]

    // Act
    const validate = (): void => validateStages(stages)

    // Assert
    expect(validate).not.toThrow()
  })

  it('refuses stages that depend on each other in a circle, and names the circle', () => {
    // Arrange
    const stages = [stage('a', ['b']), stage('b', ['c']), stage('c', ['a']), stage('d', ['a'])]

    // Act
    const validate = (): void => validateStages(stages)

    // Assert
    expect(validate).toThrow('a -> b -> c -> a')
  })

  it('refuses a stage that depends on itself', () => {
    // Act
    const validate = (): void => validateStages([stage('a', ['a'])])

    // Assert
    expect(validate).toThrow('a -> a')
  })

  it('refuses a dependency on a stage that does not exist', () => {
    // Act
    const validate = (): void => validateStages([stage('naming', ['lookup'])])

    // Assert
    expect(validate).toThrow('depends on unknown "lookup"')
  })

  it('refuses two stages of the same name', () => {
    // Act
    const validate = (): void => validateStages([stage('a'), stage('a')])

    // Assert
    expect(validate).toThrow('defined twice')
  })

  it('refuses a compute stage that waits for an apply stage', () => {
    // Act
    const validate = (): void =>
      validateStages([stage('rename', [], 'apply'), stage('energy', ['rename'])])

    // Assert
    expect(validate).toThrow('depends on apply stage')
  })
})

describe('withDependencies', () => {
  const stages = [
    stage('rename', ['naming'], 'apply'),
    stage('naming', ['bpmKey', 'lookup']),
    stage('lookup'),
    stage('bpmKey'),
    stage('energy', ['bpmKey'])
  ]

  it('adds what a stage depends on, each stage after the ones it waits for', () => {
    // Act
    const selected = withDependencies(stages, ['rename'])

    // Assert
    expect(selected?.map((entry) => entry.name)).toEqual(['bpmKey', 'lookup', 'naming', 'rename'])
  })

  it('lists a stage once that two selected stages share', () => {
    // Act
    const selected = withDependencies(stages, ['energy', 'naming', 'energy'])

    // Assert
    expect(selected?.map((entry) => entry.name)).toEqual([
      'bpmKey',
      'energy',
      'lookup',
      'naming',
      'rename'
    ])
  })

  it('brings the stage that writes along once everything it depends on is in the run', () => {
    // Act
    const withAll = withDependencies(stages, ['naming'])
    const without = withDependencies(stages, ['energy'])

    // Assert
    expect(withAll?.map((entry) => entry.name)).toContain('rename')
    expect(without?.map((entry) => entry.name)).toEqual(['bpmKey', 'energy'])
  })

  it('knows no stage of an unknown name', () => {
    // Act
    const selected = withDependencies(stages, ['bpmKey', 'demucs'])

    // Assert
    expect(selected).toBeNull()
  })
})

describe('selectableStages', () => {
  it('names the stages the user can ask for, and no other', () => {
    // Arrange
    const stages = [stage('rename', ['naming'], 'apply'), stage('naming'), stage('bpmKey')]

    // Act
    const names = selectableStages(stages)

    // Assert
    expect(names).toEqual(['naming', 'bpmKey'])
  })
})

describe('the demo stages', () => {
  it('can be ordered, and both can be asked for', () => {
    // Arrange
    const stages = createDemoStages()

    // Act
    const validate = (): void => validateStages(stages)

    // Assert
    expect(validate).not.toThrow()
    expect(selectableStages(stages)).toEqual(['demoAnalyze', 'demoLookup'])
  })

  it('propose something for the track and stop waiting when told to', async () => {
    // Arrange
    const [analyze] = createDemoStages(60_000)
    const stop = new AbortController()
    const track = { id: 1 } as Parameters<NonNullable<typeof analyze>['run']>[1]
    const context = { signal: stop.signal, batchId: 1, files: null, proposal: {} }

    // Act
    const quick = await createDemoStages(1)[0]?.run(context, track)
    const stopped = analyze?.run(context, track)
    stop.abort()

    // Assert
    expect(quick).toEqual({
      proposal: { fields: { energy: { value: 2, source: 'analysis' } } }
    })
    await expect(stopped).rejects.toThrow('stopped')
  })

  it('name a file after its artist, title and mix, and again after an edit', async () => {
    // Arrange
    const [, lookup] = createDemoStages(1)
    const track = {
      id: 5,
      path: '/Music/track-005.mp3',
      artist: null,
      title: null,
      mix: null
    } as Parameters<NonNullable<typeof lookup>['run']>[1]
    const context = { signal: new AbortController().signal, batchId: 1, files: null, proposal: {} }

    // Act
    const proposed = await lookup?.run(context, track)
    const again = lookup?.recompute?.(track, {
      fileName: null,
      artist: 'AC/DC',
      title: 'Thunder',
      album: null,
      label: null,
      year: null,
      bpm: null,
      key: null,
      mix: 'Live',
      styleId: null,
      energy: null
    })

    // Assert
    expect(proposed?.proposal?.fields).toMatchObject({
      title: { value: 'track 005', source: 'lookup', confidence: 0.6 },
      fileName: { value: 'Demo Artist - track 005.mp3' }
    })
    expect(again?.fields?.fileName?.value).toBe('AC-DC - Thunder (Live).mp3')
  })
})
