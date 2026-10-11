// At least one decimal, and as many as the value has (up to two), so that showing
// a number never rounds it to something else.
const decimal = new Intl.NumberFormat('hu-HU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 2
})

/** A number in the hu-HU form with a true minus sign, such as `−11,0`. */
export function formatDecimal(value: number): string {
  return decimal.format(value).replace('-', '−')
}

/** Reads what a user types for a decimal: comma or point, hyphen or minus sign. */
export function parseDecimal(text: string): number | null {
  const normalized = text.trim().replace('−', '-').replace(',', '.')
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null
  return Number(normalized)
}

const count = new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 })

/** A whole number in the hu-HU form, such as `12 984`. */
export function formatCount(value: number): string {
  return count.format(value)
}
