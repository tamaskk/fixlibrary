// Compares the primary styles the app gave the real test set with the owner's own.
//
//   npm run eval:styles -- [--csv tests/fixtures/real/styles.csv] [--db <path of fixlibrary.db>]
//
// Run it after a run of "Stílus besorolás" on the tracks of tests/fixtures/real/ was
// approved. It reads the database only. It runs on Electron's own Node, because the
// database module is built for it. The acceptance criterion of T-021 is 85% or more.
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { evaluateStyles, parseStylesCsv, repeatedNames } from '../src/shared/style-eval'

const TARGET = 0.85

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback)
}

const csvPath = option('csv', join('tests', 'fixtures', 'real', 'styles.csv'))
const dbPath = option(
  'db',
  join(homedir(), 'Library', 'Application Support', 'fixlibrary', 'fixlibrary.db')
)

const expected = parseStylesCsv(readFileSync(csvPath, 'utf8'))
const db = new Database(dbPath, { readonly: true, fileMustExist: true })
const rows = db
  .prepare(
    'select tracks.path as path, styles.name as style from tracks left join styles on styles.id = tracks.primary_style_id'
  )
  .all() as { path: string; style: string | null }[]
db.close()

const actual = new Map(rows.map((row) => [basename(row.path), row.style]))
const repeated = repeatedNames(rows.map((row) => basename(row.path)))
if (repeated.length > 0) {
  console.log(`In more than one folder, compared by one of them: ${repeated.join(', ')}`)
}
const result = evaluateStyles(expected, actual)

console.log(`Compared: ${result.compared} of ${expected.size} files in ${csvPath}`)
console.log(`Matched:  ${result.matched} (${(result.rate * 100).toFixed(1)}%, target 85%)`)
for (const mismatch of result.mismatches) {
  console.log(
    `  ${mismatch.fileName}: expected ${mismatch.expected}, got ${mismatch.actual ?? '—'}`
  )
}
if (result.missing.length > 0) {
  console.log(`Not in the library: ${result.missing.join(', ')}`)
}
process.exitCode = result.rate >= TARGET ? 0 : 1
