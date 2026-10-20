// The releases the updater reads (T-043). A release carries the full and the lite DMG,
// the Python runtime archive, and `manifest.json` naming each file with its SHA-256,
// signed with the owner's Ed25519 key in `manifest.json.sig`.
import { z } from 'zod'

export const RELEASE_REPOSITORY = 'tamaskk/fixlibrary'
export const MANIFEST_NAME = 'manifest.json'
export const MANIFEST_SIGNATURE_NAME = 'manifest.json.sig'

const semver = z.string().regex(/^\d+\.\d+\.\d+$/)
const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/)

export const releaseManifestSchema = z.strictObject({
  appVersion: semver,
  runtimeVersion: z.number().int().positive(),
  /** The full DMG, the lite DMG and the runtime archive, each once. */
  files: z
    .array(
      z.strictObject({
        name: fileName,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().positive()
      })
    )
    .min(1)
    .max(10)
})
export type ReleaseManifest = z.output<typeof releaseManifestSchema>
export type ReleaseFile = ReleaseManifest['files'][number]

/**
 * Negative, zero or positive as `a` is older, the same as or newer than `b`, part by
 * numeric part: x.y.z, and yt-dlp's dates with a fourth part for a point release.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] =>
    version
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** The names the release gives its files (scripts/build-dmg.sh, scripts/build-python.sh). */
export function releaseFileNames(
  manifest: Pick<ReleaseManifest, 'appVersion' | 'runtimeVersion'>
): {
  full: string
  lite: string
  runtime: string
} {
  return {
    full: `FixLibrary-${manifest.appVersion}-arm64.dmg`,
    lite: `FixLibrary-${manifest.appVersion}-arm64-lite.dmg`,
    runtime: `python-runtime-${manifest.runtimeVersion}.tar.gz`
  }
}

/**
 * What an update downloads: always the lite DMG, and the runtime archive when the
 * release's runtime is not the one installed. The archive is unpacked ahead, so the
 * new app finds its runtime ready at its first start.
 */
export function updateDownloads(
  manifest: ReleaseManifest,
  installedRuntimeVersion: number | null
): ReleaseFile[] | null {
  const names = releaseFileNames(manifest)
  const byName = new Map(manifest.files.map((file) => [file.name, file]))
  const lite = byName.get(names.lite)
  if (lite === undefined) return null
  if (installedRuntimeVersion === manifest.runtimeVersion) return [lite]
  const runtime = byName.get(names.runtime)
  return runtime === undefined ? null : [lite, runtime]
}

/** What the page shows of the updates. */
export type UpdateState =
  | { status: 'idle'; checkedAt: number | null }
  | { status: 'checking' }
  | { status: 'upToDate'; checkedAt: number }
  | { status: 'downloading'; version: string; fraction: number }
  | { status: 'ready'; version: string }
  /** The app has no release key: it cannot trust any release (`npm run release:key -- keygen`). */
  | { status: 'unverifiable' }
  | { status: 'failed'; checkedAt: number }

export interface VersionsView {
  app: string
  /** The runtime this app runs; null in development, where the virtual environment is used. */
  runtime: number | null
  update: UpdateState
  /** yt-dlp downloaded by the updater, if any: it runs before the runtime's own. */
  ytDlp: { version: string | null; updating: boolean }
}
