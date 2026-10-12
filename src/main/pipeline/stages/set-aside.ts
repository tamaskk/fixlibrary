import { DUPLICATES_FOLDER } from '@shared/duplicates'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { readDuplicateMark } from '../batch-duplicates'
import { DUPLICATES_STAGE } from './duplicates'
import type { Stage } from './stage'

export const SET_ASIDE_STAGE = 'setAside'

/**
 * Moves a copy that its group does not keep into the `_Duplicates` folder at the top
 * of the library, under the name it has. It only moves: the bytes of the file stay
 * what they are, and no file is deleted. The move goes through `context.files`, so
 * the original is backed up or copied first, a name that is taken is never written
 * over, and the batch can be undone. The copy that is kept is left where it is. A
 * copy whose kept copy is not in the library any more is not moved: its track fails.
 */
export function createSetAsideStage(): Stage {
  return {
    name: SET_ASIDE_STAGE,
    phase: 'apply',
    resource: 'io',
    dependsOn: [DUPLICATES_STAGE],
    selectable: false,
    timeoutMs: STAGE_TIMEOUTS_MS.setAside,
    run: async ({ files, proposal }) => {
      if (!files) throw new Error('an apply stage must be given its files')
      // The clean library holds every approved track: the copy that is kept too,
      // and a track that is no duplicate at all.
      const copy = await files.ensureCleanCopy()
      // Said here: the rename that follows finds the copy made, and cannot know
      // that it had to take a number.
      const numbered = { proposal: { warnings: ['NAME_COLLISION' as const] } }
      const mark = readDuplicateMark(proposal)
      if (mark === null || mark.keep) return copy.collided ? numbered : undefined
      // Checked there, on the disk: the copy this one gives way to must be in the
      // library, or the recording would be gone from every list.
      const moved = await files.setAside(DUPLICATES_FOLDER, mark.keeper)
      return copy.collided || moved.collided ? numbered : undefined
    }
  }
}
