// Test helper: stands in for the file rules where a test is about scheduling and its
// stages touch no file.
import type { BatchFiles } from './batch-files'

export function stubBatchFiles(overrides: Partial<BatchFiles> = {}): BatchFiles {
  return {
    forTrack: () => ({
      workingPath: async () => {
        throw new Error('this test has no files')
      },
      ensureCleanCopy: async () => {
        throw new Error('this test has no files')
      },
      wouldMove: async () => {
        throw new Error('this test has no files')
      },
      move: async () => {
        throw new Error('this test has no files')
      },
      convertTo: async () => {
        throw new Error('this test has no files')
      },
      setAside: async () => {
        throw new Error('this test has no files')
      },
      organize: async () => {
        throw new Error('this test has no files')
      },
      replaceContent: async () => {
        throw new Error('this test has no files')
      }
    }),
    checkSpace: async () => ({ enough: true, neededBytes: 0, freeBytes: 0 }),
    restoredOriginals: async () => new Set<string>(),
    lastUndoable: () => null,
    undoLast: async () => ({ ok: false, code: 'NOTHING_TO_UNDO' }),
    pruneOlderBackups: async () => {},
    removeTempFiles: async () => 0,
    reconcileInterrupted: async () => 0,
    busy: () => false,
    undoing: () => false,
    settled: async () => {},
    ...overrides
  }
}
