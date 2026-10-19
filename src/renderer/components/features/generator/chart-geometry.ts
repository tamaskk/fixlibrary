// The drawing space shared by the curve editor and the chart of the list.
export const CHART_WIDTH = 300
export const CHART_HEIGHT = 120
export const PAD = 12

/** Where a point of the curve is drawn. */
export function xOf(t: number): number {
  return PAD + t * (CHART_WIDTH - 2 * PAD)
}

export function yOf(energy: number): number {
  return CHART_HEIGHT - PAD - ((energy - 1) / 9) * (CHART_HEIGHT - 2 * PAD)
}
