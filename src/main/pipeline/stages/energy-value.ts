import type { AppDatabase } from '../../db/connection'
import { currentEnergyModel } from '../energy'
import { energyByModel } from '@shared/energy'
import { AppError } from '@shared/errors'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { ENERGY_FEATURES_STAGE, keptEnergyFeatures } from './energy'
import type { Stage } from './stage'
import { STYLE_STAGE } from './style'
import { fieldOf } from './style-tags'

export const ENERGY_STAGE = 'energy'

/**
 * Proposes the 1–10 energy of a track by the calibrated model, on the scale of the
 * style the batch gives it (T-024). Without a model it proposes nothing: the page
 * "Energy" asks for the calibration. A locked energy is left as it is.
 */
export function createEnergyValueStage(dependencies: { db: AppDatabase }): Stage {
  const { db } = dependencies
  return {
    name: ENERGY_STAGE,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [ENERGY_FEATURES_STAGE],
    // The scale is the style's: the one the batch proposes, when it classifies too.
    follows: [STYLE_STAGE],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.energy,
    run: async ({ proposal }, track) => {
      const kept = currentEnergyModel(db)
      if (!kept || track.lockedFields.includes('energy')) return
      const features = keptEnergyFeatures(db, track)
      if (!features) throw new AppError('UNEXPECTED', 'the energy features are not measured')
      const styleId = fieldOf(track, proposal, 'styleId', track.primaryStyleId).value
      const energy = energyByModel(kept, features, typeof styleId === 'number' ? styleId : null)
      if (energy === null) return
      return { proposal: { fields: { energy: { value: energy, source: 'analysis' } } } }
    }
  }
}
