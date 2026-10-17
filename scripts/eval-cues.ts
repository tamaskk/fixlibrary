// Compares the hot cues the app placed on the real test set with the owner's own.
//
//   npm run eval:cues -- [--csv tests/fixtures/real/cues.csv] [--db <path of fixlibrary.db>]
//
// Run it after a run of "Hot cue-k felismerése" on the tracks of tests/fixtures/real/
// was approved. It reads the database only, on Electron's own Node, because the
// database module is built for it. The acceptance criterion of T-029 is 80% or more of
// the cues within one bar of the owner's.
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { evaluateCues, parseCuesCsv, type PlacedTrack } from '../src/shared/cue-eval'
import { HOT_CUE_LETTERS } from '../src/shared/settings'
import { repeatedNames } from '../src/shared/style-eval'

const TARGET = 0.8

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback)
}

const csvPath = option('csv', join('tests', 'fixtures', 'real', 'cues.csv'))
const dbPath = option(
  'db',
  join(homedir(), 'Library', 'Application Support', 'fixlibrary', 'fixlibrary.db')
)

const expected = parseCuesCsv(readFileSync(csvPath, 'utf8'))
const db = new Database(dbPath, { readonly: true, fileMustExist: true })
const tracks = db.prepare('select id, path from tracks').all() as { id: number; path: string }[]
const cueRows = db
  .prepare('select track_id as trackId, slot, position_ms as positionMs from cues')
  .all() as {
  trackId: number
  slot: number
  positionMs: number
}[]
const gridRows = db
  .prepare("select track_id as trackId, result from analyses where type = 'rb_grid'")
  .all() as { trackId: number; result: string }[]
db.close()

/** How long a bar is at a time, by the grid's marker in force then (4/4). */
function barSecondsOf(result: string): (seconds: number) => number {
  const tempos = (JSON.parse(result) as { tempos: { inizio: number; bpm: number }[] }).tempos
  return (seconds) => {
    const marker = [...tempos].reverse().find((tempo) => tempo.inizio <= seconds) ?? tempos[0]
    return (4 * 60) / (marker?.bpm ?? 120)
  }
}

const grids = new Map(gridRows.map((row) => [row.trackId, barSecondsOf(row.result)]))
const placed = new Map<string, PlacedTrack>()
for (const track of tracks) {
  const cues = new Map(
    cueRows.filter((cue) => cue.trackId === track.id).map((cue) => [cue.slot, cue.positionMs])
  )
  placed.set(basename(track.path), { cues, barSeconds: grids.get(track.id) ?? (() => 2) })
}
const repeated = repeatedNames(tracks.map((track) => basename(track.path)))
if (repeated.length > 0)
  console.log(`In more than one folder, compared by one of them: ${repeated.join(', ')}`)

const result = evaluateCues(expected, (name) => placed.get(name) ?? null)
console.log(`Compared: ${result.compared} cues of ${expected.length} in ${csvPath}`)
console.log(`Within one bar: ${result.found} (${(result.rate * 100).toFixed(1)}%, target 80%)`)
for (const miss of result.misses) {
  const letter = HOT_CUE_LETTERS[miss.slot - 1] ?? String(miss.slot)
  const where =
    miss.foundSeconds === null
      ? 'empty'
      : `${miss.foundSeconds.toFixed(2)} s, ${miss.bars?.toFixed(1)} bars off`
  console.log(
    `  ${miss.fileName} ${letter}: expected ${miss.expectedSeconds.toFixed(2)} s, got ${where}`
  )
}
if (result.missing.length > 0) console.log(`Not in the library: ${result.missing.join(', ')}`)
process.exitCode = result.rate >= TARGET ? 0 : 1
