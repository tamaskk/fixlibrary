import { z } from 'zod'
import {
  calibrationView,
  fitEnergyModel,
  newCalibrationSample,
  rateCalibrationTrack,
  type EnergyCalibrationDependencies
} from '../pipeline/energy'
import { calibrationRatingSchema } from '@shared/energy'
import { IPC_CHANNELS } from '@shared/ipc'
import { handleIpc } from './handle'

export function registerEnergyIpc(dependencies: EnergyCalibrationDependencies): void {
  handleIpc(IPC_CHANNELS.energyCalibration, z.tuple([]), () => calibrationView(dependencies))
  handleIpc(IPC_CHANNELS.energyRate, z.tuple([calibrationRatingSchema]), (_event, rating) =>
    rateCalibrationTrack(dependencies, rating)
  )
  handleIpc(IPC_CHANNELS.energyFit, z.tuple([]), () => fitEnergyModel(dependencies))
  handleIpc(IPC_CHANNELS.energyNewSample, z.tuple([]), () => newCalibrationSample(dependencies))
}
