// The semi-automatic updates (T-043). The app asks GitHub for its latest release, and
// downloads the lite DMG of a newer one (and its Python runtime, when that changed,
// unpacked ahead); the user opens the DMG and drags the app across. Nothing is trusted
// that a manifest signed with the owner's Ed25519 key does not name with its SHA-256:
// an app signed ad hoc opens what it downloaded without Gatekeeper. yt-dlp is updated
// apart, weekly and after an extraction failure, as the zipapp of its own release.
import { createHash, createPublicKey, verify } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, readdir, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { z } from 'zod'
import { currentYtDlpZipapp, ytDlpZipappName } from './binaries'
import { logger } from './logger'
import { installRuntime, isRuntimeReady } from './python-runtime'
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
// Until the answer's headers arrive.
const HEADERS_TIMEOUT_MS = 30_000
// A download that gets no byte in this time has stalled.
const STALL_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000
// Progress goes to the page four times a second at most.
const PROGRESS_INTERVAL_MS = 250
// The user may ask again after this; GitHub allows 60 questions an hour without a token.
const MIN_CHECK_INTERVAL_MS = 60_000
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
  /** `userData/bin`: the yt-dlp zipapps the updater downloaded. */
  binDir: string
  /** The Ed25519 public key of the releases (PEM), or null when the app has none. */
  publicKey: string | null
  userAgent: string
  /** The version of the yt-dlp the runtime holds, or null when it cannot run one. */
  moduleYtDlpVersion: () => Promise<string | null>
  /** Runs a downloaded zipapp with `--version`: what it says, or null when it fails. */
  probeYtDlp: (zipapp: string) => Promise<string | null>
  /** When yt-dlp was last looked at, kept across starts. */
  ytDlpCheckedAt: () => number | null
  setYtDlpCheckedAt: (at: number) => void
  onChange: (state: UpdateState) => void
  now?: () => number
  /** For tests: the timeouts of the headers and of a stall. */
  timeouts?: { headersMs: number; stallMs: number }
}

export interface Updater {
  state: () => UpdateState
  /** The DMG that is downloaded and checked: hashed again before it is opened, or null. */
  readyDmg: () => Promise<string | null>
  checkApp: (reason?: 'scheduled' | 'manual') => Promise<void>
  /** Looks for a newer yt-dlp: weekly, after an extraction failure, or when asked. */
  checkYtDlp: (reason: 'scheduled' | 'failure' | 'manual') => Promise<void>
  ytDlpUpdating: () => boolean
  /**
   * At startup: removes the downloads of the installed version and older ones, and a
   * downloaded yt-dlp that is not newer than the runtime's own.
   */
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

const SEMVER = /^v?(\d+\.\d+\.\d+)$/
const YT_DLP_VERSION = /^(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/

/** The version of the downloaded yt-dlp that is current, or null. */
export function downloadedYtDlpVersion(binDir: string): string | null {
  const zipapp = currentYtDlpZipapp(binDir)
  return zipapp === null ? null : (/yt-dlp-(.+)\.pyz$/.exec(zipapp)?.[1] ?? null)
}

/** A body read in full, refused once it passes `limit` bytes, also after decompression. */
async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > limit) throw new Error('an answer was too large')
  const chunks: Buffer[] = []
  let read = 0
  if (response.body === null) return Buffer.alloc(0)
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    read += chunk.length
    if (read > limit) throw new Error('an answer was too large')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export function createUpdater(dependencies: UpdaterDependencies): Updater {
  const now = dependencies.now ?? Date.now
  const headersMs = dependencies.timeouts?.headersMs ?? HEADERS_TIMEOUT_MS
  const stallMs = dependencies.timeouts?.stallMs ?? STALL_TIMEOUT_MS
  let state: UpdateState = { status: 'idle', checkedAt: null }
  let ready: { dmg: string; sha256: string } | null = null
  let checkingApp = false
  let checkingYtDlp = false
  let lastAppCheck = -Infinity
  let lastManualYtDlp = -Infinity

  function set(next: UpdateState): void {
    state = next
    dependencies.onChange(next)
  }

  /**
   * One request to an allowed host, following GitHub's redirects by hand. The timeout
   * covers the headers only: the body of a download has its own watch.
   */
  async function request(
    url: string,
    accept: string
  ): Promise<{ response: Response; controller: AbortController }> {
    let address = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const target = new URL(address)
      if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
        throw new Error(`refused to ask ${target.hostname}`)
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), headersMs)
      let response: Response
      try {
        response = await dependencies.fetch(address, {
          redirect: 'manual',
          headers: { Accept: accept, 'User-Agent': dependencies.userAgent },
          signal: controller.signal
        })
      } finally {
        clearTimeout(timer)
      }
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel()
        address = new URL(location, address).href
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`${target.hostname} answered ${response.status}`)
      }
      return { response, controller }
    }
    throw new Error('too many redirects')
  }

  async function small(url: string, accept = 'application/octet-stream'): Promise<Buffer> {
    const { response, controller } = await request(url, accept)
    const timer = setTimeout(() => controller.abort(), headersMs)
    try {
      return await readLimited(response, MAX_SMALL_BYTES)
    } finally {
      clearTimeout(timer)
    }
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
   * Downloads a file next to its place, hashing it on the way and refusing it beyond
   * its size, and renames it into place only when its size and SHA-256 match. A stall
   * of a minute, or an hour in all, ends it.
   */
  async function download(
    url: string,
    path: string,
    expected: { sha256: string; size: number },
    onBytes: (bytes: number) => void
  ): Promise<void> {
    const partial = `${path}.part`
    await rm(partial, { force: true })
    try {
      const { response, controller } = await request(url, 'application/octet-stream')
      if (response.body === null) throw new Error('an empty answer')
      let stall = setTimeout(() => controller.abort(), stallMs)
      const deadline = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
      const hash = createHash('sha256')
      let written = 0
      const check = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          clearTimeout(stall)
          stall = setTimeout(() => controller.abort(), stallMs)
          written += chunk.length
          if (written > expected.size) {
            done(new Error('the download is larger than named'))
            return
          }
          hash.update(chunk)
          onBytes(written)
          done(null, chunk)
        }
      })
      try {
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          check,
          // `wx`: a file planted at its place, or a link, is never written through.
          createWriteStream(partial, { flags: 'wx', mode: 0o600 })
        )
      } finally {
        clearTimeout(stall)
        clearTimeout(deadline)
      }
      if (written !== expected.size || hash.digest('hex') !== expected.sha256) {
        throw new Error('the download does not match its SHA-256')
      }
      await rename(partial, path)
    } finally {
      await rm(partial, { force: true })
    }
  }

  /** Reports the progress four times a second at most. */
  function progressReporter(version: string, total: number): (done: number) => void {
    let reportedAt = -Infinity
    return (done) => {
      if (now() - reportedAt < PROGRESS_INTERVAL_MS && done < total) return
      reportedAt = now()
      set({ status: 'downloading', version, fraction: done / total })
    }
  }

  /** The runtime of the new app, unpacked now so that its first start finds it ready. */
  async function installAhead(
    archive: string,
    manifest: ReleaseManifest,
    file: ReleaseFile,
    runtime: { version: number; baseDir: string }
  ): Promise<void> {
    try {
      await installRuntime(
        archive,
        { version: manifest.runtimeVersion, sha256: file.sha256, size: file.size },
        runtime.baseDir,
        () => undefined
      )
    } finally {
      await rm(archive, { force: true })
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
    // A development build runs no packaged runtime: the archive is of no use to it.
    const files = updateDownloads(manifest, runtime?.version ?? manifest.runtimeVersion)
    if (files === null) throw new Error('the release lacks a file it needs')
    const folder = join(dependencies.updatesDir, version)
    await mkdir(folder, { recursive: true })
    try {
      const total = files.reduce((sum, file) => sum + file.size, 0)
      const report = progressReporter(version, total)
      let before = 0
      let dmg: ReleaseFile | null = null
      for (const file of files) {
        if (file.name.endsWith('.dmg')) {
          await download(assetUrl(release, file.name), join(folder, file.name), file, (bytes) =>
            report(before + bytes)
          )
          dmg = file
        } else if (
          runtime !== null &&
          // A runtime unpacked ahead by an earlier start of this update is kept.
          !isRuntimeReady(runtime.baseDir, manifest.runtimeVersion, file.sha256)
        ) {
          const archive = join(folder, file.name)
          await download(assetUrl(release, file.name), archive, file, (bytes) =>
            report(before + bytes)
          )
          await installAhead(archive, manifest, file, runtime)
        }
        before += file.size
      }
      if (dmg === null) throw new Error('no DMG was downloaded')
      ready = { dmg: join(folder, dmg.name), sha256: dmg.sha256 }
      set({ status: 'ready', version })
    } catch (error) {
      // Nothing of a release that failed stays, not even its DMG.
      await rm(folder, { recursive: true, force: true })
      throw error
    }
  }

  async function hashOf(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    return hash.digest('hex')
  }

  return {
    state: () => state,

    async readyDmg() {
      if (ready === null) return null
      // Hashed again: the file may have been changed since it was downloaded.
      try {
        if ((await hashOf(ready.dmg)) === ready.sha256) return ready.dmg
      } catch {
        // Gone: as changed.
      }
      logger.warn('Update: the downloaded DMG changed after it was checked; it is dropped')
      ready = null
      set({ status: 'failed', checkedAt: now() })
      return null
    },

    async checkApp(reason = 'scheduled') {
      if (checkingApp || state.status === 'ready') return
      if (reason === 'manual' && now() - lastAppCheck < MIN_CHECK_INTERVAL_MS) return
      if (dependencies.publicKey === null) {
        set({ status: 'unverifiable' })
        return
      }
      checkingApp = true
      lastAppCheck = now()
      set({ status: 'checking' })
      try {
        const release = await latest(RELEASE_REPOSITORY)
        const version = SEMVER.exec(release.tag_name)?.[1] ?? null
        if (version === null || compareVersions(version, dependencies.appVersion) <= 0) {
          set({ status: 'upToDate', checkedAt: now() })
          return
        }
        logger.info(`Update: FixLibrary ${version} is out; downloading it`)
        await updateApp(release, version)
        logger.info(`Update: FixLibrary ${version} is downloaded and checked`)
      } catch (error) {
        logger.warn(`Update: the check of the app failed: ${String(error)}`)
        set({ status: 'failed', checkedAt: now() })
      } finally {
        checkingApp = false
      }
    },

    async checkYtDlp(reason) {
      if (checkingYtDlp) return
      const last = dependencies.ytDlpCheckedAt()
      if (reason === 'manual') {
        if (now() - lastManualYtDlp < MIN_CHECK_INTERVAL_MS) return
        lastManualYtDlp = now()
      } else {
        const wait = reason === 'failure' ? YT_DLP_RETRY_MS : YT_DLP_CHECK_INTERVAL_MS
        if (last !== null && now() - last < wait) return
      }
      checkingYtDlp = true
      set(state)
      try {
        const release = await latest(YT_DLP_REPOSITORY)
        // Noted once the release was read: an offline start does not wait a week.
        dependencies.setYtDlpCheckedAt(now())
        const tag = YT_DLP_VERSION.exec(release.tag_name)?.[1]
        if (tag === undefined) throw new Error('the yt-dlp release has no version as its tag')
        const current =
          downloadedYtDlpVersion(dependencies.binDir) ?? (await dependencies.moduleYtDlpVersion())
        if (current !== null && compareVersions(tag, current) <= 0) return
        const sums = (await small(assetUrl(release, 'SHA2-256SUMS'))).toString('utf8')
        const sha256 = sumOf(sums, 'yt-dlp')
        const asset = release.assets.find((each) => each.name === 'yt-dlp')
        if (sha256 === null || asset === undefined || asset.size > MAX_YT_DLP_BYTES) {
          throw new Error('the yt-dlp release names no zipapp')
        }
        await mkdir(dependencies.binDir, { recursive: true })
        // A file of its own per version: a yt-dlp that runs now is never changed under it.
        const zipapp = join(dependencies.binDir, ytDlpZipappName(tag))
        await download(
          asset.browser_download_url,
          zipapp,
          { sha256, size: asset.size },
          () => undefined
        )
        if ((await dependencies.probeYtDlp(zipapp)) === null) {
          await rm(zipapp, { force: true })
          throw new Error('the downloaded yt-dlp does not run')
        }
        // Made current last, in one rename.
        const pointer = join(dependencies.binDir, 'yt-dlp.version')
        await writeFile(`${pointer}.new`, `${tag}\n`)
        await rename(`${pointer}.new`, pointer)
        logger.info(`Update: yt-dlp ${tag} is downloaded, checked and in use`)
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
      const current = downloadedYtDlpVersion(dependencies.binDir)
      const module = await dependencies.moduleYtDlpVersion()
      // An app update may bring a newer yt-dlp than the one downloaded: that one goes.
      const keep = current !== null && (module === null || compareVersions(current, module) > 0)
      for (const name of await readdir(dependencies.binDir).catch(() => [] as string[])) {
        if (!name.startsWith('yt-dlp')) continue
        if (keep && current !== null) {
          if (name === 'yt-dlp.version' || name === ytDlpZipappName(current)) continue
        }
        await rm(join(dependencies.binDir, name), { force: true })
      }
    }
  }
}
