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

/** A length of time as a clock: `2:05`, or `1:02:05` from an hour on. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`
}

/** An estimate of the time left in words, rounded so that it does not jump about. */
export function formatRemaining(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'kevesebb mint 1 perc'
  if (minutes < 60) return `kb. ${minutes} perc`
  const hours = Math.floor(minutes / 60)
  const rest = Math.round((minutes % 60) / 5) * 5
  if (rest === 60) return `kb. ${hours + 1} óra`
  return rest === 0 ? `kb. ${hours} óra` : `kb. ${hours} óra ${rest} perc`
}
