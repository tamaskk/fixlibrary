// The folder of the app where the stem envelopes of tracks are kept (T-028): one
// `<track id>.npz` per track, written by the sidecar, which is told the folder when it
// starts (`FIXLIB_STEMS_DIR`). Only the user may read it.
import { chmod, lstat, mkdir, readdir, rm } from 'fs/promises'
import { join } from 'path'

export interface StemsStore {
  folder: string
  /**
   * Makes the folder, only the user's; refuses a link in its place. The first time,
   * also removes what a stopped sidecar left (its temp files) and the envelopes of
   * tracks that are no more, by their exact names, plain files only.
   */
  ensure: (trackIds: () => ReadonlySet<number>) => Promise<void>
  /** True when the envelopes of the track are there, as a plain file. */
  has: (trackId: number) => Promise<boolean>
}

// What the sidecar writes: `<id>.npz`, and its temp files `.<id>.npz.<pid>.<thread>.fixlib-tmp`.
const ENVELOPES = /^([1-9][0-9]{0,15})\.npz$/u
const TEMP_FILE = /^\.[1-9][0-9]{0,15}\.npz\.[0-9]+\.[0-9]+\.fixlib-tmp$/u

export function createStemsStore(folder: string): StemsStore {
  let tidied = false

  async function tidy(trackIds: ReadonlySet<number>): Promise<void> {
    for (const name of await readdir(folder)) {
      const envelopes = ENVELOPES.exec(name)
      const stale = TEMP_FILE.test(name) || (envelopes && !trackIds.has(Number(envelopes[1])))
      if (!stale) continue
      const path = join(folder, name)
      const found = await lstat(path).catch(() => null)
      if (found?.isFile()) await rm(path, { force: true })
    }
  }

  return {
    folder,
    async ensure(trackIds) {
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const stats = await lstat(folder)
      if (!stats.isDirectory()) throw new Error('the stems folder is not a folder')
      if ((stats.mode & 0o077) !== 0) await chmod(folder, 0o700)
      if (tidied) return
      // Once: a run of thousands of tracks does not read the folder again for each.
      tidied = true
      await tidy(trackIds())
    },
    async has(trackId) {
      const found = await lstat(join(folder, `${trackId}.npz`)).catch(() => null)
      return found?.isFile() ?? false
    }
  }
}

/** True when the htdemucs model of scripts/fetch-demucs-weights.sh is in the models folder. */
export async function stemModelInstalled(modelsDir: string): Promise<boolean> {
  const found = await lstat(join(modelsDir, 'htdemucs', 'state.pt')).catch(() => null)
  return found?.isFile() ?? false
}
