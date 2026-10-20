// The Python runtime of the packaged app (T-041): the interpreter with Essentia, Demucs
// and fixlib_py, built by scripts/build-python.sh. It ships as an archive inside the
// app and is unpacked once per runtime version into userData/python/<version>, so an
// app update that keeps the version keeps the runtime. A download of a new version
// from the GitHub release comes with T-043.
import { spawn } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { createReadStream, existsSync, readFileSync } from 'fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import { logger } from './logger'
import type { Result } from '@shared/errors'
import type { PythonRuntimeState } from '@shared/python-runtime'

const MANIFEST_NAME = 'python-runtime.json'
// Written last: a folder without it was not unpacked to its end.
const READY_NAME = '.ready'
const UNPACK_PREFIX = '.unpack-'
// The system's own tar: the archive is the app's, checked by its SHA-256 first.
const TAR = '/usr/bin/tar'

const manifestSchema = z.object({
  version: z.number().int().positive(),
  archive: z.string().regex(/^python-runtime-\d+\.tar\.gz$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive()
})
export type RuntimeManifest = z.output<typeof manifestSchema>

export interface RuntimeFolders {
  /** Where the app keeps the archive and its manifest (`Resources/python`). */
  bundleDir: string
  /** Where versions are unpacked (`userData/python`). */
  baseDir: string
}

/** The paths of an unpacked runtime the sidecar is started from. */
export interface RuntimePaths {
  dir: string
  python: string
  modelsDir: string
  torchHome: string
}

export function readManifest(bundleDir: string): RuntimeManifest | null {
  try {
    return manifestSchema.parse(JSON.parse(readFileSync(join(bundleDir, MANIFEST_NAME), 'utf8')))
  } catch {
    return null
  }
}

export function runtimePaths(baseDir: string, version: number): RuntimePaths {
  const dir = join(baseDir, String(version))
  return {
    dir,
    python: join(dir, 'bin/python3'),
    modelsDir: join(dir, 'models'),
    torchHome: join(dir, 'torch-home')
  }
}

function isReady(paths: RuntimePaths): boolean {
  return existsSync(join(paths.dir, READY_NAME)) && existsSync(paths.python)
}

/** Reads a file through, hashing it, and says how far it got. */
async function sha256Of(path: string, onBytes: (bytes: number) => void): Promise<string> {
  const hash = createHash('sha256')
  let read = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
    read += (chunk as Buffer).length
    onBytes(read)
  }
  return hash.digest('hex')
}

/** Unpacks the archive into a folder, feeding tar from a stream so the bytes read can be counted. */
function unpack(archive: string, into: string, onBytes: (bytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // bsdtar refuses absolute paths and `..` in an archive unless told otherwise.
    const tar = spawn(TAR, ['-xzf', '-', '-C', into], {
      env: {},
      stdio: ['pipe', 'ignore', 'pipe']
    })
    const errors: string[] = []
    tar.stderr.on('data', (data: Buffer) => {
      if (errors.length < 20) errors.push(data.toString('utf8').slice(0, 500))
    })
    let read = 0
    const input = createReadStream(archive)
    input.on('data', (chunk) => {
      read += (chunk as Buffer).length
      onBytes(read)
    })
    input.on('error', (error) => {
      tar.kill()
      reject(error)
    })
    input.pipe(tar.stdin)
    tar.on('error', reject)
    tar.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar ended with ${code}: ${errors.join(' ').trim()}`))
    })
  })
}

/** Removes every version but `keep`, and what an unpacking that stopped left behind. */
async function removeOthers(baseDir: string, keep: number): Promise<void> {
  for (const name of await readdir(baseDir).catch(() => [] as string[])) {
    if (name === String(keep)) continue
    if (!/^\d+$/.test(name) && !name.startsWith(UNPACK_PREFIX)) continue
    await rm(join(baseDir, name), { recursive: true, force: true }).catch((error: unknown) =>
      logger.warn(`An old Python runtime could not be removed: ${String(error)}`)
    )
  }
}

/**
 * Makes sure the runtime of the app's version is unpacked: checks the archive against
 * its manifest, unpacks it into a folder of its own and renames that into place, then
 * removes the other versions. Says how far it is through `onState`.
 */
export async function prepareRuntime(
  folders: RuntimeFolders,
  onState: (state: PythonRuntimeState) => void
): Promise<Result<RuntimePaths>> {
  const manifest = readManifest(folders.bundleDir)
  if (manifest === null) {
    logger.error('The app holds no Python runtime archive, or its manifest is unreadable')
    onState({ status: 'failed', fraction: null })
    return { ok: false, code: 'TOOL_MISSING' }
  }
  const paths = runtimePaths(folders.baseDir, manifest.version)
  if (isReady(paths)) {
    await removeOthers(folders.baseDir, manifest.version)
    onState({ status: 'ready', fraction: 1 })
    return { ok: true, value: paths }
  }

  const archive = join(folders.bundleDir, manifest.archive)
  const work = join(
    folders.baseDir,
    `${UNPACK_PREFIX}${manifest.version}-${randomBytes(4).toString('hex')}`
  )
  try {
    if ((await stat(archive)).size !== manifest.size)
      throw new Error('the archive has another size')
    // A tenth of the way is the check, the rest the unpacking.
    onState({ status: 'unpacking', fraction: 0 })
    const hash = await sha256Of(archive, (bytes) =>
      onState({ status: 'unpacking', fraction: (0.1 * bytes) / manifest.size })
    )
    if (hash !== manifest.sha256) throw new Error('the archive does not match its SHA-256')
    await mkdir(work, { recursive: true })
    await unpack(archive, work, (bytes) =>
      onState({ status: 'unpacking', fraction: 0.1 + (0.9 * bytes) / manifest.size })
    )
    const unpacked = join(work, 'python-runtime')
    if (!existsSync(join(unpacked, 'bin/python3')))
      throw new Error('the archive holds no interpreter')
    await writeFile(join(unpacked, READY_NAME), `${manifest.sha256}\n`)
    // A folder of this version that was not finished goes first.
    await rm(paths.dir, { recursive: true, force: true })
    await rename(unpacked, paths.dir)
    logger.info(`Python runtime ${manifest.version} unpacked`)
  } catch (error) {
    logger.error(`The Python runtime could not be unpacked: ${String(error)}`)
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
    onState({ status: 'failed', fraction: null })
    return { ok: false, code: 'TOOL_MISSING' }
  }
  await rm(work, { recursive: true, force: true }).catch(() => undefined)
  await removeOthers(folders.baseDir, manifest.version)
  onState({ status: 'ready', fraction: 1 })
  return { ok: true, value: paths }
}
