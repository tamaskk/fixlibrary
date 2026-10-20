// The energy curves of the playlist generator (T-039): the energy a set should have at
// each point of its time, t from 0 (start) to 1 (end), on the 1–10 scale.
import { z } from 'zod'

export const ENERGY_PROFILES = ['warmUp', 'peakTime', 'sunset', 'closing', 'custom'] as const
export type EnergyProfile = (typeof ENERGY_PROFILES)[number]

export const MIN_CURVE_POINTS = 5
export const MAX_CURVE_POINTS = 10

/** A point of a drawn curve. */
export const curvePointSchema = z.strictObject({
  t: z.number().min(0).max(1),
  energy: z.number().min(1).max(10)
})
export type CurvePoint = z.output<typeof curvePointSchema>

/** 5 to 10 points of a drawn curve, ordered by time. */
export const customCurveSchema = z
  .array(curvePointSchema)
  .min(MIN_CURVE_POINTS)
  .max(MAX_CURVE_POINTS)
  .refine((points) =>
    points.every((point, index) => index === 0 || points[index - 1]!.t <= point.t)
  )

/** A curve to start drawing from: flat at 5, its points spread evenly. */
export const DEFAULT_CUSTOM_CURVE: CurvePoint[] = Array.from({ length: 5 }, (_, index) => ({
  t: index / 4,
  energy: 5
}))

function clampEnergy(energy: number): number {
  return Math.min(10, Math.max(1, energy))
}

/** The energy of a drawn curve at t: linear between its points, flat beyond its ends. */
export function customEnergyAt(points: readonly CurvePoint[], t: number): number {
  const first = points[0]
  const last = points[points.length - 1]
  if (first === undefined || last === undefined) return 5
  if (t <= first.t) return first.energy
  if (t >= last.t) return last.energy
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index] as CurvePoint
    const left = points[index - 1] as CurvePoint
    if (t <= right.t) {
      const span = right.t - left.t
      return span === 0
        ? right.energy
        : left.energy + ((t - left.t) / span) * (right.energy - left.energy)
    }
  }
  return last.energy
}

/** The energy the curve asks for at t (0 to 1). */
export function energyAt(
  profile: EnergyProfile,
  t: number,
  custom: readonly CurvePoint[] | null
): number {
  const x = Math.min(1, Math.max(0, t))
  switch (profile) {
    case 'warmUp':
      return 3 + 3 * x
    case 'peakTime':
      return 8
    case 'sunset':
      // A baseline rising from 4 to 7, with two whole waves of ±1.5 on it.
      return clampEnergy(4 + 3 * x + 1.5 * Math.sin(2 * Math.PI * 2 * x))
    case 'closing':
      return 8 - 5 * x
    case 'custom':
      return customEnergyAt(custom ?? DEFAULT_CUSTOM_CURVE, x)
  }
}
