import { createBpmKeyStage, type BpmKeyStageDependencies } from './bpm-key'
import {
  createCoverStage,
  createEmbedCoverStage,
  createRedrawPlaceholderStage,
  type CoverStageDependencies
} from './cover'
import {
  createConvertFileStage,
  createConvertStage,
  type ConvertStageDependencies
} from './convert'
import { createCuesStage, type CuesStageDependencies } from './cues'
import { createEnergyStage, type EnergyStageDependencies } from './energy'
import { createDuplicatesStage, type DuplicatesStageDependencies } from './duplicates'
import { createFingerprintStage, type FingerprintStageDependencies } from './fingerprint'
import { createLookupStage, type LookupStageDependencies } from './lookup'
import { createLoudnessStage } from './loudness'
import { createNamingStage } from './naming'
import {
  createNormalizeFileStage,
  createNormalizeStage,
  type NormalizeStageDependencies
} from './normalize'
import { createOrganizeFileStage, createOrganizeStage } from './organize'
import { createRenameStage } from './rename'
import { createSetAsideStage } from './set-aside'
import { createStemsStage, type StemsStageDependencies } from './stems'
import { createStyleStage, type StyleStageDependencies } from './style'
import type { Stage } from './stage'
import { createWriteTagsStage } from './write-tags'

export type StageDependencies = BpmKeyStageDependencies &
  EnergyStageDependencies &
  ConvertStageDependencies &
  CoverStageDependencies &
  CuesStageDependencies &
  DuplicatesStageDependencies &
  FingerprintStageDependencies &
  LookupStageDependencies &
  NormalizeStageDependencies &
  StemsStageDependencies &
  StyleStageDependencies

/** Every stage the app has, in the order the function chooser lists them. */
export function createStages(dependencies: StageDependencies): Stage[] {
  return [
    createFingerprintStage(dependencies),
    createLookupStage(dependencies),
    createBpmKeyStage(dependencies),
    createStemsStage(dependencies),
    createEnergyStage(dependencies),
    createCuesStage(dependencies),
    createStyleStage(dependencies),
    createCoverStage(dependencies),
    createLoudnessStage(dependencies),
    createNormalizeStage(dependencies),
    createNamingStage(),
    createDuplicatesStage(dependencies),
    // After the duplicates: a copy that is set aside goes into no style folder.
    createOrganizeStage(dependencies),
    createConvertStage(),
    createConvertFileStage(dependencies),
    createRedrawPlaceholderStage(dependencies),
    createWriteTagsStage(dependencies),
    createEmbedCoverStage(dependencies),
    createNormalizeFileStage(dependencies),
    createRenameStage(),
    createOrganizeFileStage(dependencies),
    createSetAsideStage()
  ]
}

/**
 * Checks that the stages can be ordered at all. Run once at startup: a mistake here
 * is a bug in the app, so it throws instead of returning an error for the user.
 */
export function validateStages(stages: readonly Stage[]): void {
  const byName = new Map<string, Stage>()
  for (const stage of stages) {
    if (byName.has(stage.name)) throw new Error(`Stage "${stage.name}" is defined twice`)
    byName.set(stage.name, stage)
  }
  for (const stage of stages) {
    for (const name of stage.after ?? []) {
      const earlier = byName.get(name)
      // Only the order inside a phase is a stage's to ask for. A stage that is not
      // there is nothing to wait for.
      if (earlier && earlier.phase !== stage.phase) {
        throw new Error(`Stage "${stage.name}" comes after "${name}" of another phase`)
      }
    }
    for (const name of stage.dependsOn) {
      const dependency = byName.get(name)
      if (!dependency) throw new Error(`Stage "${stage.name}" depends on unknown "${name}"`)
      // Apply runs after the user approved what compute proposed, never before it.
      if (stage.phase === 'compute' && dependency.phase === 'apply') {
        throw new Error(`Compute stage "${stage.name}" depends on apply stage "${name}"`)
      }
    }
  }

  // Depth-first: a stage met again while it is still being followed closes a cycle.
  const finished = new Set<string>()
  const following: string[] = []
  const follow = (stage: Stage): void => {
    if (finished.has(stage.name)) return
    if (following.includes(stage.name)) {
      const cycle = [...following.slice(following.indexOf(stage.name)), stage.name]
      throw new Error(`Stages depend on each other in a circle: ${cycle.join(' -> ')}`)
    }
    following.push(stage.name)
    for (const name of [...stage.dependsOn, ...(stage.after ?? [])]) {
      const earlier = byName.get(name)
      if (earlier) follow(earlier)
    }
    following.pop()
    finished.add(stage.name)
  }
  for (const stage of stages) follow(stage)
}

/**
 * The named stages and everything they depend on, each after the stages it depends
 * on. Returns null when a name is not a stage. `stages` must have passed `validateStages`.
 */
export function withDependencies(
  stages: readonly Stage[],
  names: readonly string[]
): Stage[] | null {
  const byName = new Map(stages.map((stage) => [stage.name, stage]))
  const ordered: Stage[] = []
  const added = new Set<string>()
  const add = (name: string): boolean => {
    const stage = byName.get(name)
    if (!stage) return false
    if (added.has(name)) return true
    added.add(name)
    for (const dependency of stage.dependsOn) add(dependency)
    ordered.push(stage)
    return true
  }
  if (!names.every(add)) return null
  // The stages that write what the chosen ones propose come along by themselves: the
  // user asks for a function, not for the step that writes its result. Such a stage
  // cannot be asked for, and joins once everything it depends on is in the run.
  for (let grown = true; grown;) {
    grown = false
    for (const stage of stages) {
      const writes = stage.phase === 'apply' && !stage.selectable && stage.dependsOn.length > 0
      if (!writes || added.has(stage.name)) continue
      if (!stage.dependsOn.every((name) => added.has(name))) continue
      added.add(stage.name)
      ordered.push(stage)
      grown = true
    }
  }
  return ordered
}

/** The names of the stages the user can ask for, in the order they are defined. */
export function selectableStages(stages: readonly Stage[]): string[] {
  return stages.filter((stage) => stage.selectable).map((stage) => stage.name)
}
