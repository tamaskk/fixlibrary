import { execFileSync } from 'child_process'
import { createHash, generateKeyPairSync, sign } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isRuntimeReady } from './python-runtime'
import { createUpdater, sumOf, verifyManifest, type UpdaterDependencies } from './updater'
import type { ReleaseManifest, UpdateState } from '@shared/release'

let folder: string
const keys = generateKeyPairSync('ed25519')
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A runtime archive as the build packs it. */
function runtimeArchive(): Buffer {
  const stage = join(folder, 'stage')
  mkdirSync(join(stage, 'python-runtime/bin'), { recursive: true })
  writeFileSync(join(stage, 'python-runtime/bin/python3'), 'interpreter 2')
  execFileSync('/usr/bin/tar', [
    '-czf',
    join(folder, 'runtime.tar.gz'),
    '-C',
    stage,
    'python-runtime'
  ])
  return readFileSync(join(folder, 'runtime.tar.gz'))
}

interface FakeRelease {
  tag: string
  assets: Record<string, Buffer>
}

/** GitHub as the updater sees it: the API, and assets that redirect to object storage. */
function fakeFetch(releases: Record<string, FakeRelease>, asked: string[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input)
    asked.push(url)
    const api = /^https:\/\/api\.github\.com\/repos\/(.+)\/releases\/latest$/.exec(url)
    if (api) {
      const release = releases[api[1] as string]
      if (!release) return new Response('', { status: 404 })
      return Response.json({
        tag_name: release.tag,
        assets: Object.entries(release.assets).map(([name, bytes]) => ({
          name,
          browser_download_url: `https://github.com/${api[1]}/releases/download/${release.tag}/${name}`,
          size: bytes.length
        }))
      })
    }
    const asset = /^https:\/\/github\.com\/(.+)\/releases\/download\/[^/]+\/(.+)$/.exec(url)
    if (asset) {
      return new Response(null, {
        status: 302,
        headers: { location: `https://objects.githubusercontent.com/${asset[1]}/${asset[2]}` }
      })
    }
    const stored = /^https:\/\/objects\.githubusercontent\.com\/(.+)\/([^/]+)$/.exec(url)
    if (stored) {
      const release = releases[stored[1] as string]
      const bytes = release?.assets[stored[2] as string]
      return bytes ? new Response(new Uint8Array(bytes)) : new Response('', { status: 404 })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
}

/** A signed release of FixLibrary 0.0.2 with runtime 2. */
function release(options: { tamper?: boolean; wrongHash?: boolean } = {}): FakeRelease {
  const lite = Buffer.from('the lite dmg')
  const full = Buffer.from('the full dmg, larger')
  const runtime = runtimeArchive()
  const manifest: ReleaseManifest = {
    appVersion: '0.0.2',
    runtimeVersion: 2,
    files: [
      { name: 'FixLibrary-0.0.2-arm64.dmg', sha256: sha256(full), size: full.length },
      {
        name: 'FixLibrary-0.0.2-arm64-lite.dmg',
        sha256: options.wrongHash ? '0'.repeat(64) : sha256(lite),
        size: lite.length
      },
      { name: 'python-runtime-2.tar.gz', sha256: sha256(runtime), size: runtime.length }
    ]
  }
  const bytes = Buffer.from(JSON.stringify(manifest))
  const signature = sign(null, bytes, keys.privateKey).toString('base64')
  return {
    tag: 'v0.0.2',
    assets: {
      'manifest.json': options.tamper
        ? Buffer.from(JSON.stringify({ ...manifest, runtimeVersion: 3 }))
        : bytes,
      'manifest.json.sig': Buffer.from(signature),
      'FixLibrary-0.0.2-arm64.dmg': full,
      'FixLibrary-0.0.2-arm64-lite.dmg': lite,
      'python-runtime-2.tar.gz': runtime
    }
  }
}

function dependencies(
  overrides: Partial<UpdaterDependencies> = {}
): UpdaterDependencies & { states: UpdateState[] } {
  const states: UpdateState[] = []
  let checkedAt: number | null = null
  return {
    fetch: fakeFetch({}),
    appVersion: '0.0.1',
    runtime: () => ({ version: 1, baseDir: join(folder, 'python') }),
    updatesDir: join(folder, 'updates'),
    binDir: join(folder, 'bin'),
    publicKey: PUBLIC,
    userAgent: 'FixLibrary test',
    moduleYtDlpVersion: async () => '2026.08.19',
    probeYtDlp: async () => '2026.10.10',
    ytDlpCheckedAt: () => checkedAt,
    setYtDlpCheckedAt: (at) => {
      checkedAt = at
    },
    onChange: (state) => states.push(state),
    now: () => 1_000_000_000,
    states,
    ...overrides
  }
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'fixlib-updater-'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

describe('verifyManifest', () => {
  it('reads a manifest signed with the release key, and nothing else', () => {
    // Arrange
    const { assets } = release()
    const manifest = assets['manifest.json'] as Buffer
    const signature = (assets['manifest.json.sig'] as Buffer).toString()
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })

    // Act
    const read = verifyManifest(manifest, signature, PUBLIC)
    const changed = verifyManifest(
      Buffer.from(manifest.toString().replace('0.0.2', '0.0.3')),
      signature,
      PUBLIC
    )
    const otherKey = verifyManifest(manifest, signature, other.toString())

    // Assert
    expect(read?.appVersion).toBe('0.0.2')
    expect(changed).toBeNull()
    expect(otherKey).toBeNull()
  })
})

describe('sumOf', () => {
  it('finds the hash of one file in a SHA2-256SUMS', () => {
    // Act
    const found = sumOf(`${'a'.repeat(64)}  yt-dlp.exe\n${'b'.repeat(64)}  yt-dlp\n`, 'yt-dlp')

    // Assert
    expect(found).toBe('b'.repeat(64))
  })
})

describe('the app update', () => {
  it('trusts no release without a key', async () => {
    // Arrange
    const deps = dependencies({ publicKey: null })

    // Act
    await createUpdater(deps).checkApp()

    // Assert
    expect(deps.states.at(-1)).toEqual({ status: 'unverifiable' })
  })

  it('says it is up to date when the latest release is not newer', async () => {
    // Arrange
    const deps = dependencies({
      appVersion: '0.0.2',
      fetch: fakeFetch({ 'tamaskk/fixlibrary': release() })
    })

    // Act
    await createUpdater(deps).checkApp()

    // Assert
    expect(deps.states.at(-1)).toMatchObject({ status: 'upToDate' })
  })

  it('downloads the lite DMG and unpacks the new runtime ahead', async () => {
    // Arrange
    const asked: string[] = []
    const published = release()
    const deps = dependencies({ fetch: fakeFetch({ 'tamaskk/fixlibrary': published }, asked) })
    const updater = createUpdater(deps)

    // Act
    await updater.checkApp()

    // Assert
    expect(deps.states.at(-1)).toEqual({ status: 'ready', version: '0.0.2' })
    expect(readFileSync((await updater.readyDmg()) ?? '', 'utf8')).toBe('the lite dmg')
    const runtime = published.assets['python-runtime-2.tar.gz'] as Buffer
    expect(isRuntimeReady(join(folder, 'python'), 2, sha256(runtime))).toBe(true)
    expect(asked.some((url) => url.endsWith('FixLibrary-0.0.2-arm64.dmg'))).toBe(false)
    expect(readdirSync(join(folder, 'updates/0.0.2'))).toEqual(['FixLibrary-0.0.2-arm64-lite.dmg'])
  })

  it('downloads only the lite DMG when the runtime stays the same', async () => {
    // Arrange
    const asked: string[] = []
    const deps = dependencies({
      runtime: () => ({ version: 2, baseDir: join(folder, 'python') }),
      fetch: fakeFetch({ 'tamaskk/fixlibrary': release() }, asked)
    })

    // Act
    await createUpdater(deps).checkApp()

    // Assert
    expect(asked.some((url) => url.endsWith('python-runtime-2.tar.gz'))).toBe(false)
    expect(deps.states.at(-1)).toEqual({ status: 'ready', version: '0.0.2' })
  })

  it.each([
    ['a manifest changed after it was signed', { tamper: true }],
    ['a download that does not match its hash', { wrongHash: true }]
  ])('drops %s and keeps nothing of it', async (_name, options) => {
    // Arrange
    const deps = dependencies({ fetch: fakeFetch({ 'tamaskk/fixlibrary': release(options) }) })
    const updater = createUpdater(deps)

    // Act
    await updater.checkApp()

    // Assert
    expect(deps.states.at(-1)).toMatchObject({ status: 'failed' })
    expect(await updater.readyDmg()).toBeNull()
    const kept = existsSync(join(folder, 'updates/0.0.2'))
      ? readdirSync(join(folder, 'updates/0.0.2')).filter((name) => name.endsWith('.dmg'))
      : []
    expect(kept).toEqual([])
  })

  it('downloads only the lite DMG in development, where no packaged runtime runs', async () => {
    // Arrange
    const asked: string[] = []
    const deps = dependencies({
      runtime: () => null,
      fetch: fakeFetch({ 'tamaskk/fixlibrary': release() }, asked)
    })

    // Act
    await createUpdater(deps).checkApp()

    // Assert
    expect(deps.states.at(-1)).toEqual({ status: 'ready', version: '0.0.2' })
    expect(asked.some((url) => url.endsWith('python-runtime-2.tar.gz'))).toBe(false)
  })

  it('lets a slow download run past the timeout of the headers, and ends a stalled one', async () => {
    // Arrange: the lite DMG comes in two halves, the second after a pause.
    const published = release()
    const slow = (pauseMs: number): typeof fetch => {
      const plain = fakeFetch({ 'tamaskk/fixlibrary': published })
      return (async (input: string | URL, init?: RequestInit) => {
        const answer = await plain(input, init)
        if (!String(input).endsWith('-lite.dmg') || answer.status !== 200) return answer
        const bytes = new Uint8Array(await answer.arrayBuffer())
        const signal = init?.signal
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(bytes.slice(0, 4))
              await new Promise((resolve) => setTimeout(resolve, pauseMs))
              if (signal?.aborted) {
                controller.error(new Error('aborted'))
                return
              }
              controller.enqueue(bytes.slice(4))
              controller.close()
            }
          })
        )
      }) as typeof fetch
    }
    const timeouts = { headersMs: 20, stallMs: 150 }
    const fine = dependencies({ fetch: slow(60), timeouts, runtime: () => null })
    const stalled = dependencies({ fetch: slow(400), timeouts, runtime: () => null })

    // Act
    await createUpdater(fine).checkApp()
    await createUpdater(stalled).checkApp()

    // Assert
    expect(fine.states.at(-1)).toEqual({ status: 'ready', version: '0.0.2' })
    expect(stalled.states.at(-1)).toMatchObject({ status: 'failed' })
  })

  it('looks again when asked only after a minute', async () => {
    // Arrange
    const asked: string[] = []
    const deps = dependencies({
      appVersion: '0.0.2',
      fetch: fakeFetch({ 'tamaskk/fixlibrary': release() }, asked)
    })
    const updater = createUpdater(deps)

    // Act
    await updater.checkApp('manual')
    await updater.checkApp('manual')

    // Assert
    expect(asked.filter((url) => url.includes('api.github.com'))).toHaveLength(1)
  })

  it('asks no host but GitHub', async () => {
    // Arrange
    const deps = dependencies({
      fetch: (async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/x' }
        })) as typeof fetch
    })

    // Act
    await createUpdater(deps).checkApp()

    // Assert
    expect(deps.states.at(-1)).toMatchObject({ status: 'failed' })
  })

  it('removes the downloads of the installed version and older, not of a newer one', async () => {
    // Arrange
    for (const version of ['0.0.1', '0.0.0', '0.0.2'])
      mkdirSync(join(folder, 'updates', version), { recursive: true })
    mkdirSync(join(folder, 'updates/other'))

    // Act
    await createUpdater(dependencies()).cleanUp()

    // Assert
    expect(readdirSync(join(folder, 'updates')).sort()).toEqual(['0.0.2', 'other'])
  })
})

describe('the yt-dlp update', () => {
  function ytDlpRelease(zipapp: Buffer, sum: string): FakeRelease {
    return {
      tag: '2026.10.10',
      assets: {
        'yt-dlp': zipapp,
        'SHA2-256SUMS': Buffer.from(`${sum}  yt-dlp\n${'c'.repeat(64)}  yt-dlp_macos\n`)
      }
    }
  }

  it('downloads a newer zipapp when its hash matches, and notes its version', async () => {
    // Arrange
    const zipapp = Buffer.from('a yt-dlp zipapp')
    const deps = dependencies({
      fetch: fakeFetch({ 'yt-dlp/yt-dlp': ytDlpRelease(zipapp, sha256(zipapp)) })
    })

    // Act
    await createUpdater(deps).checkYtDlp('manual')

    // Assert
    expect(readFileSync(join(folder, 'bin/yt-dlp-2026.10.10.pyz'), 'utf8')).toBe('a yt-dlp zipapp')
    expect(readFileSync(join(folder, 'bin/yt-dlp.version'), 'utf8').trim()).toBe('2026.10.10')
  })

  it('keeps nothing of a zipapp that does not match its hash', async () => {
    // Arrange
    const deps = dependencies({
      fetch: fakeFetch({ 'yt-dlp/yt-dlp': ytDlpRelease(Buffer.from('changed'), 'd'.repeat(64)) })
    })

    // Act
    await createUpdater(deps).checkYtDlp('manual')

    // Assert
    expect(existsSync(join(folder, 'bin/yt-dlp-2026.10.10.pyz'))).toBe(false)
  })

  it('drops a zipapp that does not run, and keeps the one in use', async () => {
    // Arrange
    const zipapp = Buffer.from('a broken zipapp')
    const deps = dependencies({
      fetch: fakeFetch({ 'yt-dlp/yt-dlp': ytDlpRelease(zipapp, sha256(zipapp)) }),
      probeYtDlp: async () => null
    })

    // Act
    await createUpdater(deps).checkYtDlp('manual')

    // Assert
    expect(existsSync(join(folder, 'bin/yt-dlp-2026.10.10.pyz'))).toBe(false)
    expect(existsSync(join(folder, 'bin/yt-dlp.version'))).toBe(false)
  })

  it('takes a point release of the same day', async () => {
    // Arrange
    const zipapp = Buffer.from('a point release')
    const release = { ...ytDlpRelease(zipapp, sha256(zipapp)), tag: '2026.10.10.1' }
    const deps = dependencies({
      moduleYtDlpVersion: async () => '2026.10.10',
      fetch: fakeFetch({ 'yt-dlp/yt-dlp': release })
    })

    // Act
    await createUpdater(deps).checkYtDlp('manual')

    // Assert
    expect(readFileSync(join(folder, 'bin/yt-dlp.version'), 'utf8').trim()).toBe('2026.10.10.1')
  })

  it('looks again at the next start after an offline one', async () => {
    // Arrange
    let noted: number | null = null
    const deps = dependencies({
      fetch: (async () => {
        throw new Error('offline')
      }) as typeof fetch,
      setYtDlpCheckedAt: (at) => {
        noted = at
      }
    })

    // Act
    await createUpdater(deps).checkYtDlp('scheduled')

    // Assert
    expect(noted).toBeNull()
  })

  it('removes a downloaded yt-dlp that is not newer than the runtime one', async () => {
    // Arrange
    mkdirSync(join(folder, 'bin'))
    writeFileSync(join(folder, 'bin/yt-dlp-2026.08.01.pyz'), 'old')
    writeFileSync(join(folder, 'bin/yt-dlp.version'), '2026.08.01\n')

    // Act
    await createUpdater(dependencies()).cleanUp()

    // Assert
    expect(readdirSync(join(folder, 'bin'))).toEqual([])
  })

  it('asks weekly, and after a failure not more than once in six hours', async () => {
    // Arrange
    const asked: string[] = []
    let at = 1_000_000_000
    const same = { ...ytDlpRelease(Buffer.from('x'), 'e'.repeat(64)), tag: '2026.08.19' }
    const deps = dependencies({ fetch: fakeFetch({ 'yt-dlp/yt-dlp': same }, asked), now: () => at })
    const updater = createUpdater(deps)

    // Act
    await updater.checkYtDlp('scheduled')
    at += 60 * 60 * 1000
    await updater.checkYtDlp('failure')
    await updater.checkYtDlp('scheduled')
    at += 6 * 60 * 60 * 1000
    await updater.checkYtDlp('failure')

    // Assert
    expect(asked.filter((url) => url.includes('yt-dlp/yt-dlp'))).toHaveLength(2)
  })
})
