import { basename, dirname, join } from 'path'
import { AppError } from '@shared/errors'
import { extensionOf } from '@shared/file-names'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { isBuiltFileName } from '../naming'
import { NAMING_STAGE } from './naming'
import { CONVERT_FILE_STAGE } from './convert'
import { EMBED_COVER_STAGE } from './cover-stages'
import { SET_ASIDE_STAGE } from './set-aside'
import type { Stage } from './stage'
import { WRITE_TAGS_STAGE } from './write-tags'

export const RENAME_STAGE = 'rename'

/**
 * Gives the file of a track the name the batch holds for it, in the folder it is in.
 * It only renames: the bytes of the file stay what they are. The change goes through
 * `context.files`, so the original is backed up or copied first, a name that is
 * taken is never written over, and the batch can be undone.
 */
export function createRenameStage(): Stage {
  return {
    name: RENAME_STAGE,
    phase: 'apply',
    resource: 'io',
    dependsOn: [NAMING_STAGE],
    // All of them move the file, and their steps must not be mixed. A WAV becomes
    // an AIFF first, so that the name it gets ends as the file does. Set aside first: a
    // copy that is not kept then gets its name in `_Duplicates`, and does not take
    // the name in the folder that the copy that is kept is about to get.
    after: [CONVERT_FILE_STAGE, SET_ASIDE_STAGE, WRITE_TAGS_STAGE, EMBED_COVER_STAGE],
    selectable: false,
    timeoutMs: STAGE_TIMEOUTS_MS.rename,
    run: async ({ files, proposal }, track) => {
      if (!files) throw new Error('an apply stage must be given its files')
      // First of all: the clean library holds every approved track, also one that
      // keeps its name, and one whose proposed name is refused below.
      const copy = await files.ensureCleanCopy()
      // Said when the file stays under the name the copy got: the user should know
      // that the name it has is not the one it was meant to have.
      const kept = copy.collided
        ? { proposal: { warnings: ['NAME_COLLISION' as const] } }
        : undefined
      const fileName = proposal.fields?.fileName?.value
      // Nothing was proposed for this track: its file keeps its name.
      if (typeof fileName !== 'string') return kept
      // The name a conversion showed is the name it gave: the file has it already,
      // and it was never built by the naming, so its rule is not asked of it.
      if (proposal.fields?.fileName?.source === 'conversion') return kept
      // Checked again here, whatever the preview showed: this is what reaches the
      // disk. Only a name as the naming builds one is written.
      if (!isBuiltFileName(fileName)) {
        throw new AppError('INVALID_INPUT', 'the proposed name cannot be given to a file')
      }
      // A new name never makes a file another kind of file.
      if (extensionOf(fileName) !== extensionOf(basename(track.path))) {
        throw new AppError('INVALID_INPUT', 'the proposed name has another extension')
      }
      // Decided before the file is asked for: asking makes the backup or the copy,
      // and a track that needs nothing must not cost one, nor make its batch count
      // as one that wrote, which would take away the undo of the batch before it.
      if (!(await files.wouldMove(fileName))) return kept
      const working = await files.workingPath()
      // A new name never makes a file another kind of file.
      if (extensionOf(fileName) !== extensionOf(basename(working))) {
        throw new AppError('INVALID_INPUT', 'the proposed name has another extension')
      }
      if (basename(working) === fileName) return kept
      const moved = await files.move(join(dirname(working), fileName))
      return moved.collided ? { proposal: { warnings: ['NAME_COLLISION'] } } : undefined
    }
  }
}
