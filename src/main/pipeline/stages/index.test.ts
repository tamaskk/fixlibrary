import { describe, expect, it } from 'vitest'
import { STAGES, validateStages, withDependencies } from './index'
import type { Stage } from './stage'

function stage(name: string, dependsOn: string[] = [], phase: Stage['phase'] = 'compute'): Stage {
  return { name, phase, resource: 'cpu', dependsOn, timeoutMs: 1000, run: async () => {} }
}

describe('validateStages', () => {
  it('accepts the stages the app ships with', () => {
    // Act
    const validate = (): void => validateStages(STAGES)

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
    expect(selected?.map((entry) => entry.name)).toEqual(['bpmKey', 'energy', 'lookup', 'naming'])
  })

  it('knows no stage of an unknown name', () => {
    // Act
    const selected = withDependencies(stages, ['bpmKey', 'demucs'])

    // Assert
    expect(selected).toBeNull()
  })
})
