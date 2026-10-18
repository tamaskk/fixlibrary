import { randomUUID } from 'crypto'
import type { AppDatabase } from '../../db/connection'
import { listAllBatchItems, setBatchItemEntry, setBatchItemProposal } from '../../db/batches'
import { listStyles } from '../../db/styles'
import { getTrackById, type Track } from '../../db/tracks'
import type { PythonBridge } from '../../services/python-bridge'
import { isSetAsidePath } from '@shared/duplicates'
import { folderNameOf } from '@shared/file-names'
import { AppError } from '@shared/errors'
import { APP_FOLDER_NAMES, UNSORTED_STYLE_NAME } from '@shared/settings'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { CONVERT_FILE_STAGE } from './convert'
import { EMBED_COVER_STAGE, REDRAW_PLACEHOLDER_STAGE } from './cover-stages'
import { NORMALIZE_FILE_STAGE } from './normalize'
import { RENAME_STAGE } from './rename'
import { SET_ASIDE_STAGE } from './set-aside'
import type { Stage } from './stage'
import { readProposal, type Proposal, type ProposedFields } from '@shared/preview'
import { readDuplicateMark } from '../batch-duplicates'
import { createsStyle, newStyleOf, createdNames } from '../new-styles'
import { STYLE_STAGE } from './style'
import {
  organizeDetailsOf,
  organizeDetailsSchema,
  styleFolderOf,
  styleTagsFor,
  type OrganizeDetails
} from './style-tags'
import { takesTags, WRITE_TAGS_STAGE } from './write-tags'
import { listJobStageNames } from '../../db/jobs'

export const ORGANIZE_STAGE = 'organize'
export const ORGANIZE_FILE_STAGE = 'organizeFile'

/** The entry the organize stage keeps next to its proposal, by that name. */
const ORGANIZE_ENTRY = 'organize'

export interface OrganizeStageDependencies {
  db: AppDatabase
  python: () => Pick<PythonBridge, 'call'> | null
}

/** The styles of the list as the batch keeps them: the ones whose names it can use. */
function stylesOfList(db: AppDatabase): OrganizeDetails['styles'] {
  return listStyles(db).flatMap((style) => {
    const parsed = organizeDetailsSchema.shape.styles.element.safeParse(style)
    return parsed.success ? [{ id: parsed.data.id, name: parsed.data.name }] : []
  })
}

/** What the preview shows of a track the batch organizes: its style folder and its genre. */
function organizeFields(
  track: Track,
  proposal: Proposal & Record<string, unknown>,
  details: OrganizeDetails
): ProposedFields {
  const fields: ProposedFields = {
    folder: { value: styleFolderOf(track, proposal, details), source: 'organize' }
  }
  // Only what goes into the tag: a WAV takes none.
  const genre = takesTags(track.path) ? styleTagsFor(track, proposal, details).genre : undefined
  if (genre !== undefined) fields.genre = { value: genre, source: 'organize' }
  return fields
}

/** The fields of a row without what the organize stage proposed for it. */
function withoutOrganize(fields: ProposedFields | undefined): ProposedFields {
  return Object.fromEntries(
    Object.entries(fields ?? {}).filter(([, field]) => field?.source !== 'organize')
  ) as ProposedFields
}

/**
 * Looks at the rows of a batch together: which new styles the batch creates (the
 * first five its rows name, as the list has room), and so which folder and genre each
 * row shows. A copy that is to be set aside goes to `_Duplicates`, not into a style
 * folder. Done after the compute phase, after an edit that may change either, and
 * before the batch is applied. Returns true when anything changed.
 */
export function regroupStyleFolders(db: AppDatabase, batchId: number): boolean {
  return db.transaction((tx) => {
    let changed = false
    const creates = createsStyle(tx, batchId)
    for (const item of listAllBatchItems(tx, batchId)) {
      const details = organizeDetailsOf(item.after)
      const track = details && getTrackById(tx, item.trackId, new Set())
      if (!details || !track) continue
      const newStyle = newStyleOf(item.after)
      const next: OrganizeDetails = {
        ...details,
        createsNew: newStyle !== null && creates(newStyle)
      }
      if (next.createsNew !== details.createsNew) {
        setBatchItemEntry(tx, batchId, item.trackId, ORGANIZE_ENTRY, next)
        changed = true
      }
      const proposal = readProposal(item.after)
      const record = { ...(item.after as Record<string, unknown>), [ORGANIZE_ENTRY]: next }
      const setAside = readDuplicateMark(item.after)?.keep === false
      const fields = {
        ...withoutOrganize(proposal.fields),
        ...(setAside ? {} : organizeFields(track, { ...record, ...proposal }, next))
      }
      const same = (['folder', 'genre'] as const).every(
        (field) =>
          fields[field]?.value === proposal.fields?.[field]?.value &&
          fields[field]?.source === proposal.fields?.[field]?.source
      )
      if (same) continue
      setBatchItemProposal(tx, batchId, item.trackId, { ...proposal, fields })
      changed = true
    }
    return changed
  })
}

/**
 * Proposes the style folder a track goes into: `<root>/<primary style>/`, Unsorted
 * for a track without one, and the primary style as its genre. The style the
 * classification of the same run decided, else the track's own. The names of the
 * styles are kept with the proposal, so the folder follows when the user changes the
 * style in the preview. A copy that was set aside stays where it is.
 */
export function createOrganizeStage(dependencies: OrganizeStageDependencies): Stage {
  return {
    name: ORGANIZE_STAGE,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [],
    // The style of the same run decides the folder.
    after: [STYLE_STAGE],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.organize,
    run: async ({ proposal }, track) => {
      if (isSetAsidePath(track.path)) return
      // Whether the batch creates a new style is known once every row is computed:
      // the regrouping after the phase decides it.
      const details: OrganizeDetails = { styles: stylesOfList(dependencies.db), createsNew: false }
      return {
        proposal: {
          fields: organizeFields(track, proposal, details),
          [ORGANIZE_ENTRY]: details
        }
      }
    },
    recompute: (track, _values, after) => {
      const details = organizeDetailsOf(after)
      if (!details || isSetAsidePath(track.path)) return
      if (readDuplicateMark(after)?.keep === false) return
      return { fields: organizeFields(track, after as Proposal & Record<string, unknown>, details) }
    },
    regroup: (batchId) => regroupStyleFolders(dependencies.db, batchId)
  }
}

/**
 * Moves the file of a track into its style folder, after every other step that
 * changes the file, and writes the primary style into its genre tag and the energy
 * and the secondary style into its comment, unless the tags were written by the
 * batch already. The old folders it leaves with nothing in them but Finder's data go;
 * the style folders and the app's own folders stay. A copy that was set aside is not
 * moved; a WAV is moved without tags.
 */
export function createOrganizeFileStage(dependencies: OrganizeStageDependencies): Stage {
  return {
    name: ORGANIZE_FILE_STAGE,
    phase: 'apply',
    resource: 'io',
    dependsOn: [ORGANIZE_STAGE],
    after: [
      CONVERT_FILE_STAGE,
      SET_ASIDE_STAGE,
      REDRAW_PLACEHOLDER_STAGE,
      WRITE_TAGS_STAGE,
      EMBED_COVER_STAGE,
      NORMALIZE_FILE_STAGE,
      RENAME_STAGE
    ],
    selectable: false,
    timeoutMs: STAGE_TIMEOUTS_MS.organizeFile,
    run: async ({ files, proposal, batchId }, track) => {
      if (!files) throw new Error('an apply stage must be given its files')
      if (isSetAsidePath(track.path)) return
      const stored = organizeDetailsOf(proposal)
      if (!stored) return
      // Worked out again from the styles, never taken as written: the new style the
      // row names is used only if the batch does create it.
      const newStyle = newStyleOf(proposal)
      const details: OrganizeDetails = {
        ...stored,
        createsNew:
          stored.createsNew && newStyle !== null && createsStyle(dependencies.db, batchId)(newStyle)
      }
      const folder = styleFolderOf(track, proposal, details)
      const copy = await files.ensureCleanCopy()
      const warnings = copy.collided ? (['NAME_COLLISION'] as const) : []

      // The tags first, in the folder the file is in: the tags of the batch carried
      // them already when they were written.
      const tagged = listJobStageNames(dependencies.db, batchId).includes(WRITE_TAGS_STAGE)
      // The file the copy of a clean library made, or the track's own.
      const current = getTrackById(dependencies.db, track.id, new Set()) ?? track
      const fields = styleTagsFor(current, proposal, details)
      if (!tagged && takesTags(current.path) && Object.keys(fields).length > 0) {
        const python = dependencies.python()
        if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
        const { changed } = await python.call(
          'tags.would_change',
          { path: current.path, fields },
          { timeoutMs: STAGE_TIMEOUTS_MS.tags }
        )
        if (changed) {
          const source = await files.workingPath()
          await files.replaceContent(async (tempPath, signal) => {
            const jobId = randomUUID()
            await python.call(
              'tags.write',
              { src: source, dst: tempPath, fields, jobId },
              { timeoutMs: STAGE_TIMEOUTS_MS.tags, job: { id: jobId, signal } }
            )
          })
        }
      }

      // The folders that stay, whether or not they are empty: every style folder,
      // also one the classification of this batch creates, and the app's own.
      // By the names the folders have: a style's folder is its name made safe.
      const kept = [
        ...details.styles.map((style) => style.name),
        ...listStyles(dependencies.db).map((style) => style.name),
        ...createdNames(dependencies.db, batchId),
        UNSORTED_STYLE_NAME
      ]
        .map((name) => folderNameOf(name) ?? name)
        .concat(APP_FOLDER_NAMES)
      const moved = await files.organize(folder, kept)
      const collided = moved.collided ? (['NAME_COLLISION'] as const) : []
      const all = [...warnings, ...collided]
      return all.length > 0 ? { proposal: { warnings: [...new Set(all)] } } : undefined
    }
  }
}
