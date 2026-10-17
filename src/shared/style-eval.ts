// How well the style classification matches the owner's own: the measure of the
// acceptance criterion of T-021, used by scripts/eval-styles.ts.
import { styleKey } from './settings'

export interface StyleMismatch {
  fileName: string
  expected: string
  actual: string | null
}

export interface StyleEvaluation {
  /** Files of the list that the library has. */
  compared: number
  matched: number
  /** 0 to 1; 0 when nothing could be compared. */
  rate: number
  mismatches: StyleMismatch[]
  /** Files of the list that the library does not have. */
  missing: string[]
}

/** The file names the library has more than once, in different folders: compared as one. */
export function repeatedNames(fileNames: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const name of fileNames) {
    if (seen.has(name)) repeated.add(name)
    seen.add(name)
  }
  return [...repeated]
}

/**
 * The rows of `styles.csv`: `file name,primary style`, a first line that names the
 * columns allowed, quotes allowed.
 */
export function parseStylesCsv(text: string): Map<string, string> {
  const rows = new Map<string, string>()
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    const cells = splitCsvLine(line)
    if (cells.length < 2) continue
    const [fileName, style] = cells.map((cell) => cell.trim()) as [string, string]
    // A header names its columns, and no audio file is named without an extension.
    if (rows.size === 0 && !/\.[A-Za-z0-9]{2,5}$/u.test(fileName)) continue
    rows.set(fileName, style)
  }
  return rows
}

/** The cells of one line of a CSV file, quotes allowed. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === ',' || char === ';') {
      cells.push(cell)
      cell = ''
    } else cell += char
  }
  cells.push(cell)
  return cells
}

/**
 * Compares the owner's styles with the library's, by file name. Style names are
 * compared as the app compares them: case, spaces and hyphens aside.
 */
export function evaluateStyles(
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string | null>
): StyleEvaluation {
  const mismatches: StyleMismatch[] = []
  const missing: string[] = []
  let compared = 0
  for (const [fileName, style] of expected) {
    if (!actual.has(fileName)) {
      missing.push(fileName)
      continue
    }
    compared += 1
    const found = actual.get(fileName) ?? null
    if (found === null || styleKey(found) !== styleKey(style)) {
      mismatches.push({ fileName, expected: style, actual: found })
    }
  }
  const matched = compared - mismatches.length
  return { compared, matched, rate: compared === 0 ? 0 : matched / compared, mismatches, missing }
}
