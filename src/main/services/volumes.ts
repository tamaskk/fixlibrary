import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { logger } from './logger'

const VOLUMES_ROOT = '/Volumes'

function deviceOfPath(path: string): number {
  return statSync(path).dev
}

/**
 * Names of the volumes mounted right now, composed (NFC) like stored track paths.
 *
 * A folder under the root counts only if it is a mount point: an unclean eject can
 * leave an empty folder behind, and a track on it must still show as offline.
 * If the root cannot be read, no volume counts as mounted.
 */
export function listMountedVolumes(
  volumesRoot: string = VOLUMES_ROOT,
  deviceOf: (path: string) => number = deviceOfPath
): Set<string> {
  const mounted = new Set<string>()
  try {
    const rootDevice = deviceOf(volumesRoot)
    for (const entry of readdirSync(volumesRoot, { withFileTypes: true })) {
      // The startup disk appears here as a symlink to `/`.
      const isMounted =
        entry.isSymbolicLink() ||
        (entry.isDirectory() && deviceOf(join(volumesRoot, entry.name)) !== rootDevice)
      if (isMounted) mounted.add(entry.name.normalize('NFC'))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('Could not list the mounted volumes', error)
    }
    return new Set()
  }
  return mounted
}
