// Where macOS mounts network shares on demand, in lower case: the startup disk does
// not tell case apart. Looking at a path there may reach out to a host it names.
const NETWORK_FOLDERS = ['/net/', '/network/']

/** True for a path under a folder where macOS mounts network shares on demand. */
export function isNetworkPath(path: string): boolean {
  const lower = path.toLowerCase()
  return NETWORK_FOLDERS.some((folder) => lower.startsWith(folder))
}
