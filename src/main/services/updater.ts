// The semi-automatic updates (T-043). The app asks GitHub for its latest release, and
// downloads the lite DMG of a newer one (and its Python runtime, when that changed,
// unpacked ahead); the user opens the DMG and drags the app across. Nothing is trusted
// that a manifest signed with the owner's Ed25519 key does not name with its SHA-256:
// an app signed ad hoc opens what it downloaded without Gatekeeper. yt-dlp is updated
// apart, weekly and after an extraction failure, as the zipapp of its own release.
import { createHash, createPublicKey, verify } from 'crypto'
import { createWriteStream, existsSync, readFileSync } from 'fs'
import { mkdir, readdir, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import { logger } from './logger'
import { installRuntime } from './python-runtime'
import {
  compareVersions,
  MANIFEST_NAME,
  MANIFEST_SIGNATURE_NAME,
  RELEASE_REPOSITORY,
  releaseManifestSchema,
  updateDownloads,
  type ReleaseFile,
  type ReleaseManifest,
  type UpdateState
} from '@shared/release'

const API = 'https://api.github.com'
const YT_DLP_REPOSITORY = 'yt-dlp/yt-dlp'
// Where a release asset may come from; GitHub sends the download to its object storage.
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
])
const MAX_REDIRECTS = 3
const MAX_SMALL_BYTES = 1024 * 1024
const MAX_YT_DLP_BYTES = 64 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000
export const APP_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const YT_DLP_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
// After an extraction failure: soon, but not for every failed track.
const YT_DLP_RETRY_MS = 6 * 60 * 60 * 1000

const releaseSchema = z.object({
  tag_name: z.string().max(64),
  assets: z
    .array(
      z.object({
        name: z.string().max(200),
        browser_download_url: z.url().max(2000),
        size: z.number().int().nonnegative()
      })
    )
    .max(100)
})
type Release = z.output<typeof releaseSchema>

export interface UpdaterDependencies {
  fetch: typeof fetch
  appVersion: string
  /** The runtime the app runs and where runtimes are unpacked; null in development. */
  runtime: () => { version: number; baseDir: string } | null
  /** `userData/updates`: the downloaded DMGs. */
  updatesDir: string
  /** `userData/bin`: the yt-dlp the updater downloaded. */
  binDir: string
  /** The Ed25519 public key of the releases (PEM), or null when the app has none. */
  publicKey: string | null
  userAgent: string
  /** The version of the yt-dlp the app runs now, or null when it cannot run one. */
  ytDlpVersion: () => Promise<string | null>
  /** When yt-dlp was last looked at, kept across starts. */
  ytDlpCheckedAt: () => number | null
  setYtDlpCheckedAt: (at: number) => void
  onChange: (state: UpdateState) => void
  now?: () => number
}

export interface Updater {
  state: () => UpdateState
  /** The DMG that is downloaded and checked, or null. */
  readyDmg: () => string | null
  checkApp: () => Promise<void>
  /** Looks for a newer yt-dlp; `soon` after an extraction failure. */
  checkYtDlp: (reason: 'scheduled' | 'failure' | 'manual') => Promise<void>
  ytDlpUpdating: () => boolean
  /** Removes the downloads of the version installed and older ones; at startup. */
  cleanUp: () => Promise<void>
}

/** The bytes of a manifest, read only when its Ed25519 signature is the owner's. */
export function verifyManifest(
  bytes: Buffer,
  signature: string,
  publicKey: string
): ReleaseManifest | null {
  try {
    const key = createPublicKey(publicKey)
    if (key.asymmetricKeyType !== 'ed25519') return null
    if (!verify(null, bytes, key, Buffer.from(signature.trim(), 'base64'))) return null
    return releaseManifestSchema.parse(JSON.parse(bytes.toString('utf8')))
  } catch {
    return null
  }
}

/** The SHA-256 a `SHA2-256SUMS` file names for one file, or null. */
export function sumOf(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim())
    if (match?.[2] === name) return match[1] as string
  }
  return null
}

/** A release tag as a version: `v0.0.2` and `0.0.2` alike. */
function versionOf(tag: string): string {
  return tag.replace(/^v/, '')
}

export function createUpdater(dependencies: UpdaterDependencies): Updater {
  const now = dependencies.now ?? Date.now
  let state: UpdateState = { status: 'idle', checkedAt: null }
  let readyDmg: string | null = null
  let checkingApp = false
  let checkingYtDlp = false

  function set(next: UpdateState): void {
    state = next
    dependencies.onChange(next)
  }

  /** One request to an allowed host, following GitHub's redirects by hand. */
  async function request(url: string, accept: string): Promise<Response> {
    let address = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!ALLOWED_HOSTS.has(new URL(address).hostname) || !address.startsWith('https://')) {
        throw new Error(`refused to ask ${new URL(address).hostname}`)
      }
      const response = await dependencies.fetch(address, {
        redirect: 'manual',
        headers: { Accept: accept, 'User-Agent': dependencies.userAgent },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location !== null) {
        address = new URL(location, address).href
        continue
      }
      if (!response.ok) throw new Error(`${new URL(address).hostname} answered ${response.status}`)
      return response
    }
    throw new Error('too many redirects')
  }

  async function small(url: string, accept = 'application/octet-stream'): Promise<Buffer> {
    const response = await request(url, accept)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_SMALL_BYTES) throw new Error('an answer was too large')
    return bytes
  }

  async function latest(repository: string): Promise<Release> {
    const bytes = await small(
      `${API}/repos/${repository}/releases/latest`,
      'application/vnd.github+json'
    )
    return releaseSchema.parse(JSON.parse(bytes.toString('utf8')))
  }

  function assetUrl(release: Release, name: string): string {
    const asset = release.assets.find((each) => each.name === name)
    if (asset === undefined) throw new Error(`the release has no ${name}`)
    return asset.browser_download_url
  }

  /**
   * Downloads a file next to its place, hashing it on the way, and renames it into
   * place only when its size and SHA-256 are the expected ones.
   */
  async function download(
    url: string,
    path: string,
    expected: { sha256: string; size: number },
    onBytes: (bytes: number) => void
  ): Promise<void> {
    const partial = `${path}.part`
    try {
      const response = await request(url, 'application/octet-stream')
      if (response.body === null) throw new Error('an empty answer')
      const hash = createHash('sha256')
      const output = createWriteStream(partial, { flags: 'w', mode: 0o600 })
      let written = 0
      const deadline = now() + DOWNLOAD_TIMEOUT_MS
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          written += chunk.length
          if (written > expected.size) throw new Error('the download is larger than named')
          if (now() > deadline) throw new Error('the download took too long')
          hash.update(chunk)
          if (!output.write(chunk))
            await new Promise<void>((resolve) => output.once('drain', () => resolve()))
          onBytes(written)
        }
        await new Promise<void>((resolve, reject) =>
          output.end((error?: Error) => (error ? reject(error) : resolve()))
        )
      } catch (error) {
        output.destroy()
        throw error
      }
      if (written !== expected.size || hash.digest('hex') !== expected.sha256) {
        throw new Error('the download does not match its SHA-256')
      }
      await rename(partial, path)
    } finally {
      await rm(partial, { force: true })
    }
  }

  async function updateApp(release: Release, version: string): Promise<void> {
    const publicKey = dependencies.publicKey as string
    const bytes = await small(assetUrl(release, MANIFEST_NAME))
    const signature = (await small(assetUrl(release, MANIFEST_SIGNATURE_NAME))).toString('utf8')
    const manifest = verifyManifest(bytes, signature, publicKey)
    if (manifest === null) throw new Error('the release manifest is not signed by the release key')
    if (manifest.appVersion !== version) throw new Error('the manifest names another version')
    const runtime = dependencies.runtime()
    const files = updateDownloads(manifest, runtime?.version ?? null)
    if (files === null) throw new Error('the release lacks a file it needs')
    const folder = join(dependencies.updatesDir, version)
    await mkdir(folder, { recursive: true })
    const total = files.reduce((sum, file) => sum + file.size, 0)
    let before = 0
    let dmg: string | null = null
    for (const file of files) {
      const path = join(folder, file.name)
      await download(assetUrl(release, file.name), path, file, (bytes) =>
        set({ status: 'downloading', version, fraction: (before + bytes) / total })
      )
      before += file.size
      if (file.name.endsWith('.dmg')) dmg = path
      else await installAhead(path, manifest, file, runtime)
    }
    if (dmg === null) throw new Error('no DMG was downloaded')
    readyDmg = dmg
    set({ status: 'ready', version })
  }

  /** The runtime of the new app, unpacked now so that its first start finds it ready. */
  async function installAhead(
    archive: string,
    manifest: ReleaseManifest,
    file: ReleaseFile,
    runtime: { version: number; baseDir: string } | null
  ): Promise<void> {
    if (runtime === null) return
    await installRuntime(
      archive,
      { version: manifest.runtimeVersion, sha256: file.sha256, size: file.size },
      runtime.baseDir,
      () => undefined
    )
    await rm(archive, { force: true })
  }

  return {
    state: () => state,
    readyDmg: () => readyDmg,

    async checkApp() {
      if (checkingApp || state.status === 'ready') return
      if (dependencies.publicKey === null) {
        set({ status: 'unverifiable' })
        return
      }
      checkingApp = true
      set({ status: 'checking' })
      try {
        const release = await latest(RELEASE_REPOSITORY)
        const version = versionOf(release.tag_name)
        if (compareVersions(version, dependencies.appVersion) <= 0) {
          set({ status: 'upToDate', checkedAt: now() })
          return
        }
        logger.info(`Update: FixLibrary ${version} is out; downloading it`)
        await updateApp(release, version)
        logger.info(`Update: FixLibrary ${version} is downloaded and checked`)
      } catch (error) {
        // A release that cannot be checked is dropped whole: nothing of it stays.
        logger.warn(`Update: the check of the app failed: ${String(error)}`)
        set({ status: 'failed', checkedAt: now() })
      } finally {
        checkingApp = false
      }
    },

    async checkYtDlp(reason) {
      if (checkingYtDlp) return
      const last = dependencies.ytDlpCheckedAt()
      const wait = reason === 'failure' ? YT_DLP_RETRY_MS : YT_DLP_CHECK_INTERVAL_MS
      if (reason !== 'manual' && last !== null && now() - last < wait) return
      checkingYtDlp = true
      set(state)
      try {
        dependencies.setYtDlpCheckedAt(now())
        const release = await latest(YT_DLP_REPOSITORY)
        const current = await dependencies.ytDlpVersion()
        if (current !== null && compareVersions(release.tag_name, current) <= 0) return
        const sums = (await small(assetUrl(release, 'SHA2-256SUMS'))).toString('utf8')
        const sha256 = sumOf(sums, 'yt-dlp')
        const asset = release.assets.find((each) => each.name === 'yt-dlp')
        if (sha256 === null || asset === undefined || asset.size > MAX_YT_DLP_BYTES) {
          throw new Error('the yt-dlp release names no zipapp')
        }
        await mkdir(dependencies.binDir, { recursive: true })
        await download(
          asset.browser_download_url,
          join(dependencies.binDir, 'yt-dlp'),
          { sha256, size: asset.size },
          () => undefined
        )
        await writeFile(join(dependencies.binDir, 'yt-dlp.version'), `${release.tag_name}\n`)
        logger.info(`Update: yt-dlp ${release.tag_name} is downloaded and checked`)
      } catch (error) {
        logger.warn(`Update: the check of yt-dlp failed: ${String(error)}`)
      } finally {
        checkingYtDlp = false
        set(state)
      }
    },

    ytDlpUpdating: () => checkingYtDlp,

    async cleanUp() {
      for (const name of await readdir(dependencies.updatesDir).catch(() => [] as string[])) {
        // Only what the updater wrote, by the version folders it makes, and only of a
        // version that is installed now or older.
        if (!/^\d+\.\d+\.\d+$/.test(name)) continue
        if (compareVersions(name, dependencies.appVersion) > 0) continue
        await rm(join(dependencies.updatesDir, name), { recursive: true, force: true })
      }
    }
  }
}

/** The version of the yt-dlp the updater downloaded, or null. */
export function downloadedYtDlpVersion(binDir: string): string | null {
  try {
    if (!existsSync(join(binDir, 'yt-dlp'))) return null
    const version = readFileSync(join(binDir, 'yt-dlp.version'), 'utf8').trim()
    return /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(version) ? version : null
  } catch {
    return null
  }
}
