// What must end before the app may close its database.

/** The part of the file rules that says whether work on a file is going on. */
export interface FileWork {
  busy: () => boolean
  /** True while an undo is under way. */
  undoing: () => boolean
  settled: () => Promise<void>
}

/**
 * Waits until no stage is in the middle of a file any more, for at most `timeoutMs`.
 * Resolves to false when the time ran out first.
 *
 * An undo is waited for without a limit. It puts many files back and writes all of
 * that down in one step at its end: cut short, the files would be back where they
 * were and the database would not know. `onUndo` is told when that wait begins.
 *
 * A stage that was told to stop still finishes the step it is in: a rename that has
 * happened is written down in the database right after. If the database were closed
 * in between, the file would have its new name and its track the old one.
 */
export async function waitForFileWork(
  files: FileWork,
  timeoutMs: number,
  onUndo: () => void = () => {}
): Promise<boolean> {
  if (!files.busy()) return true
  if (files.undoing()) onUndo()
  // Only the undo is waited for without a limit; what else is still going on when
  // it has ended gets the time below.
  while (files.undoing()) await files.settled()
  if (!files.busy()) return true
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([files.settled().then(() => true as const), timedOut])
  } finally {
    clearTimeout(timer)
  }
}
