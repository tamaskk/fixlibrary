import { randomUUID } from 'crypto'
import { basename } from 'path'
import type { Track } from '../../db/tracks'
import { logger } from '../../services/logger'
import type { PythonBridge } from '../../services/python-bridge'
import { isSetAsidePath } from '@shared/duplicates'
import { AppError } from '@shared/errors'
import { extensionOf } from '@shared/file-names'
import { keyOfCamelot } from '@shared/keys'
import type { PreviewField, PreviewValue, Proposal } from '@shared/preview'
import { tagFieldsSchema, type TagFields } from '@shared/rpc'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { CONVERT_FILE_STAGE } from './convert'
import { REDRAW_PLACEHOLDER_STAGE } from './cover-stages'
import { NAMING_STAGE } from './naming'
import { SET_ASIDE_STAGE } from './set-aside'
import type { Stage } from './stage'

export const WRITE_TAGS_STAGE = 'writeTags'

/** The formats tags are written into. A WAV becomes an AIFF first, or keeps its tags. */
const TAGGED_EXTENSIONS: readonly string[] = ['.mp3', '.aif', '.aiff']

/**
 * True for a file this stage writes tags into, by its name and its place. A copy
 * that was set aside waits for the user to delete it: tags in it, and the backup
 * they would cost, are of no use to anyone.
 */
export function takesTags(path: string): boolean {
  return TAGGED_EXTENSIONS.includes(extensionOf(basename(path))) && !isSetAsidePath(path)
}

export interface WriteTagsStageDependencies {
  /** Null while this installation has no sidecar to ask. */
  python: () => Pick<PythonBridge, 'call'> | null
}

/** One line of text as a tag holds it, or undefined when nothing is left of it. */
function line(value: PreviewValue | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/gu, ' ').trim()
  return text === '' ? undefined : text
}

/**
 * A tag has no field for the mix: it stands in the title, in brackets. Unless the
 * title says it already, as one the user typed may.
 */
function titleWithMix(title: string | undefined, mix: string | undefined): string | undefined {
  if (title === undefined || mix === undefined) return title
  return title.toLowerCase().endsWith(`(${mix.toLowerCase()})`) ? title : `${title} (${mix})`
}

/**
 * The tags a track is to have: what the batch proposes for it, with what the user
 * changed in the preview, and the track's own value where the batch proposes none,
 * or where the field is locked and the proposal is not the user's own.
 * A value that is not known is not written, and never takes a tag away.
 */
export function tagsFor(track: Track, proposal: Proposal): TagFields {
  const proposed = proposal.fields ?? {}
  const valueOf = (field: PreviewField, own: PreviewValue): PreviewValue => {
    const value = proposed[field]
    // A locked field is the user's word; so is an edit made in this preview.
    if (value === undefined) return own
    return track.lockedFields.includes(field) && value.source !== 'manual' ? own : value.value
  }
  const title = line(valueOf('title', track.title))
  const mix = line(valueOf('mix', track.mix))
  const camelot = valueOf('key', track.camelotKey)
  const bpm = valueOf('bpm', track.bpm)
  const year = valueOf('year', track.year)
  const wanted = {
    artist: line(valueOf('artist', track.artist)),
    title: titleWithMix(title, mix),
    album: line(valueOf('album', track.album)),
    label: line(valueOf('label', track.label)),
    year: typeof year === 'number' ? year : undefined,
    bpm: typeof bpm === 'number' ? Math.round(bpm) : undefined,
    key: typeof camelot === 'string' ? keyOfCamelot(camelot)?.musical : undefined,
    // The cover the batch found goes in with the tags: one write, one backup.
    cover: typeof proposed.cover?.value === 'string' ? proposed.cover.value : undefined
  }
  const fields: TagFields = {}
  for (const [name, value] of Object.entries(wanted)) {
    // Field by field: one value a tag cannot hold must not keep the others out.
    const checked = tagFieldsSchema.safeParse({ [name]: value })
    if (value !== undefined && checked.success) Object.assign(fields, checked.data)
  }
  return fields
}

/**
 * Writes the names, the year, the tempo and the key of a track into its file as
 * ID3v2.3 tags: Rekordbox reads a track from its tags, not from its file name. The
 * sidecar writes a copy with the new tags into the temp file it is given and reads
 * it back; `context.files.replaceContent` puts it in place, after the original was
 * backed up or copied. A file that says all of it already is not touched and costs
 * no backup. A WAV is left alone: its tags come with its conversion to AIFF. So is
 * a copy that was set aside as a duplicate.
 */
export function createWriteTagsStage(dependencies: WriteTagsStageDependencies): Stage {
  return {
    name: WRITE_TAGS_STAGE,
    phase: 'apply',
    resource: 'io',
    dependsOn: [NAMING_STAGE],
    // Each of them gives the file another path or other bytes, and their steps
    // must not be mixed. A WAV is an AIFF by the time its tags are written.
    // A placeholder drawn again for the names of the preview is the one written.
    after: [CONVERT_FILE_STAGE, SET_ASIDE_STAGE, REDRAW_PLACEHOLDER_STAGE],
    selectable: false,
    timeoutMs: STAGE_TIMEOUTS_MS.writeTags,
    run: async ({ files, proposal }, track) => {
      if (!files) throw new Error('an apply stage must be given its files')
      // The clean library holds every approved track, also one that gets no tags.
      // Said here when the copy had to take a number: a later stage finds it made.
      const copy = await files.ensureCleanCopy()
      const numbered = copy.collided
        ? { proposal: { warnings: ['NAME_COLLISION' as const] } }
        : undefined
      if (!takesTags(track.path)) {
        logger.info(`Track ${track.id}: tags are not written into its file`)
        return numbered
      }
      const fields = tagsFor(track, proposal)
      if (Object.keys(fields).length === 0) return numbered
      const python = dependencies.python()
      if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
      // Asked of the file as the track has it now, before the file is asked for: a
      // backup is made only for a file that will change. In the clean library the
      // original and its copy say the same.
      const { changed } = await python.call(
        'tags.would_change',
        { path: track.path, fields },
        { timeoutMs: STAGE_TIMEOUTS_MS.tags }
      )
      if (!changed) return numbered
      const source = await files.workingPath()
      await files.replaceContent(async (tempPath, signal) => {
        // A new id for every attempt: the sidecar refuses one that is still in use.
        const jobId = randomUUID()
        await python.call(
          'tags.write',
          { src: source, dst: tempPath, fields, jobId },
          // With the signal: a quit or a cancel must not wait out the whole call.
          { timeoutMs: STAGE_TIMEOUTS_MS.tags, job: { id: jobId, signal } }
        )
      })
      return numbered
    }
  }
}
