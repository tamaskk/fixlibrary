import { basename, extname } from 'path'
import type { Track } from '../../db/tracks'
import type { PreviewField, PreviewValue, Proposal, ProposedFields } from '@shared/preview'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { cleanNames, formatFileName, parseFileName, type NameParts } from '../naming'
import { extensionOf } from '@shared/file-names'
import { BPM_KEY_STAGE } from './bpm-key'
import { CONVERT_STAGE, convertedName, wantsConversion } from './convert'
import { LOOKUP_STAGE } from './lookup'
import { ENERGY_STAGE } from './energy-value'
import type { Stage } from './stage'

export const NAMING_STAGE = 'naming'

const NAME_FIELDS = ['artist', 'title', 'mix'] as const
type NameField = (typeof NAME_FIELDS)[number]

function text(value: PreviewValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function whole(value: PreviewValue | undefined): number | null {
  return typeof value === 'number' ? value : null
}

/** The file name for the names and the analysis a row shows. */
function fileNameFor(
  extension: string,
  values: Partial<Record<PreviewField, PreviewValue>>
): string | null {
  return formatFileName({
    artist: text(values.artist),
    title: text(values.title),
    mix: text(values.mix),
    camelot: text(values.key),
    bpm: whole(values.bpm),
    energy: whole(values.energy),
    extension
  })
}

/**
 * The extension the file of a track will have when its batch is written: a file that
 * is about to be converted gets the name of what it will be.
 */
function extensionFor(track: Track, after: unknown): string {
  return wantsConversion(after)
    ? extensionOf(convertedName(basename(track.path)))
    : extname(track.path)
}

function propose(track: Track, proposal: Proposal): Proposal {
  const proposed = proposal.fields ?? {}
  // What the user set by hand, in this preview or an earlier one, is taken as it is.
  const fixed = (field: NameField): boolean =>
    proposed[field]?.source === 'manual' || track.lockedFields.includes(field)
  const known: NameParts = {
    artist: fixed('artist') ? track.artist : text(proposed.artist?.value ?? track.artist),
    title: fixed('title') ? track.title : text(proposed.title?.value ?? track.title),
    mix: fixed('mix') ? track.mix : text(proposed.mix?.value ?? track.mix)
  }
  for (const field of NAME_FIELDS) {
    if (proposed[field]?.source === 'manual') known[field] = text(proposed[field].value)
  }

  // Without a title from a tag or a lookup, the file name is all there is to go by.
  const fromFileName = known.title === null && !fixed('title')
  const parsed = fromFileName ? parseFileName(basename(track.path)) : null
  // An artist the user took away stays away: the file name is then all title.
  const wholeStem =
    parsed && [parsed.artist, parsed.title].filter((part) => part !== null).join(' - ')
  const named: NameParts = !parsed
    ? known
    : fixed('artist') && known.artist === null
      ? { ...known, title: wholeStem || null }
      : {
          ...known,
          title: parsed.title,
          // An artist the user set stays; one that is only missing is read from the name.
          artist: fixed('artist') ? known.artist : (known.artist ?? parsed.artist)
        }
  // What the user set is neither changed nor taken apart.
  const cleaned = cleanNames(named, { keep: NAME_FIELDS.filter(fixed) })

  const fields: ProposedFields = {}
  const names: NameParts = { ...known }
  for (const field of NAME_FIELDS) {
    if (fixed(field)) continue
    // A name that was all junk is no reason to take the name away.
    const value = cleaned[field] ?? (field === 'mix' ? null : named[field])
    names[field] = value
    if (value === known[field]) continue
    const origin =
      proposed[field] ??
      // A mix or a guest that was taken out of the title comes from where the title did.
      (field !== 'title' ? proposed.title : undefined)
    const parsedHere = parsed !== null && (field === 'title' || known.artist === null)
    fields[field] = {
      value,
      source: parsedHere ? 'fileName' : (origin?.source ?? 'id3'),
      ...(origin?.confidence === undefined ? {} : { confidence: origin.confidence })
    }
  }

  const fileName = fileNameFor(extensionFor(track, proposal), {
    ...names,
    key: proposed.key ? proposed.key.value : track.camelotKey,
    bpm: proposed.bpm ? proposed.bpm.value : track.bpm,
    energy: proposed.energy ? proposed.energy.value : track.energy
  })
  if (fileName !== null) fields.fileName = { value: fileName, source: 'naming' }
  return { fields }
}

/**
 * Cleans the names of a track and proposes its file name:
 * `Artist feat. X - Title (Mix) [8A Am - 124 - E7].mp3`. It works on what the lookup
 * and the analysis proposed, and falls back on the tags and then on the file name.
 * It reads nothing and changes nothing; the rename stage writes the name.
 */
export function createNamingStage(): Stage {
  return {
    name: NAMING_STAGE,
    phase: 'compute',
    resource: 'cpu',
    // The name holds the key and the tempo, and the names a lookup found.
    dependsOn: [LOOKUP_STAGE, BPM_KEY_STAGE],
    // The name ends as the file will: a conversion in the batch says so first.
    after: [CONVERT_STAGE],
    // The file name carries the energy the batch proposes, when it proposes one.
    follows: [ENERGY_STAGE],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.naming,
    run: async ({ proposal }, track) => ({ proposal: propose(track, proposal) }),
    // After an edit the name follows the row as it is now. What the user typed is
    // not cleaned again: only what a file system refuses is replaced.
    recompute: (track, values, after) => {
      // With nothing left to name the file by, the name that was proposed goes too:
      // it was built from names the row no longer shows. The file then keeps its own.
      const fileName = fileNameFor(extensionFor(track, after), values)
      return { fields: { fileName: { value: fileName, source: 'naming' } } }
    }
  }
}
