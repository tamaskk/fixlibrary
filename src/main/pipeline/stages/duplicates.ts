import type { AppDatabase } from '../../db/connection'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { groupBatchDuplicates } from '../batch-duplicates'
import { LOOKUP_STAGE } from './lookup'
import type { Stage } from './stage'

export const DUPLICATES_STAGE = 'duplicates'

export interface DuplicatesStageDependencies {
  db: AppDatabase
}

/**
 * Finds the copies of one recording among the tracks of the batch, and proposes
 * which copy of each group to keep. A copy is known by comparing it with the other
 * tracks, so there is nothing to do for a track alone: the work is done once for
 * the whole batch, when every track has its names and its AcoustID, and again
 * whenever the user changes a name in the preview. It reads no file and changes
 * none; the set-aside stage moves the copies that are not kept.
 */
export function createDuplicatesStage({ db }: DuplicatesStageDependencies): Stage {
  return {
    name: DUPLICATES_STAGE,
    phase: 'compute',
    resource: 'cpu',
    // The AcoustID of a track, and the names a lookup found for it.
    dependsOn: [LOOKUP_STAGE],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.duplicates,
    run: async () => undefined,
    regroup: (batchId) => groupBatchDuplicates(db, batchId),
    warnings: ['DUPLICATE']
  }
}
