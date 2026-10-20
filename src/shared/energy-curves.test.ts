import { describe, expect, it } from 'vitest'
import { customCurveSchema, customEnergyAt, energyAt } from './energy-curves'

describe('energyAt', () => {
  it.each([
    ['warmUp', 0, 3],
    ['warmUp', 1, 6],
    ['peakTime', 0.3, 8],
    ['closing', 0, 8],
    ['closing', 1, 3],
    ['sunset', 0, 4],
    ['sunset', 0.125, 5.875],
    ['sunset', 1, 7]
  ] as const)('%s at %f is %f', (profile, t, expected) => {
    // Act
    const energy = energyAt(profile, t, null)

    // Assert
    expect(energy).toBeCloseTo(expected)
  })
})

describe('a drawn curve', () => {
  const points = [
    { t: 0, energy: 2 },
    { t: 0.25, energy: 6 },
    { t: 0.5, energy: 4 },
    { t: 0.75, energy: 4 },
    { t: 1, energy: 9 }
  ]

  it('is linear between its points', () => {
    // Act
    const between = customEnergyAt(points, 0.125)

    // Assert
    expect(between).toBeCloseTo(4)
  })

  it('takes 5 to 10 points in their order', () => {
    // Act
    const tooFew = customCurveSchema.safeParse(points.slice(0, 4))
    const unordered = customCurveSchema.safeParse([...points].reverse())

    // Assert
    expect(customCurveSchema.safeParse(points).success).toBe(true)
    expect(tooFew.success).toBe(false)
    expect(unordered.success).toBe(false)
  })
})
