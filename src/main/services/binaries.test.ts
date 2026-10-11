import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkAll,
  resolveToolCommand,
  resolveToolLocations,
  type ToolCheck,
  type ToolLocations
} from './binaries'

const REAL_LOCATIONS = resolveToolLocations({
  isPackaged: false,
  appPath: resolve('.'),
  resourcesPath: ''
})

let folder: string
let locations: ToolLocations

/** Writes a shell script that stands in for a tool. */
function writeTool(path: string, script: string): void {
  writeFileSync(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
}

function writeWorkingTools(): void {
  // Answers only the exact way the app starts yt-dlp: isolated, as a module.
  writeTool(
    join(folder, 'python'),
    '[ "$*" = "-I -m yt_dlp --version" ] && echo 2026.08.19 || exit 9'
  )
  writeTool(join(locations.bundledDir, 'ffmpeg'), 'echo "ffmpeg version 9.0.2 Copyright (c) 2026"')
  writeTool(join(locations.bundledDir, 'fpcalc'), 'echo "fpcalc version 1.6.1 (FFmpeg Lavc62)"')
  writeTool(join(locations.bundledDir, 'mp3gain'), 'echo "$0 version 1.6.2" >&2')
}

function summarize(checks: ToolCheck[]): [string, string][] {
  return checks.map((check) => [check.name, check.ok ? check.version : check.reason])
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'fixlibrary-tools-'))
  locations = { bundledDir: join(folder, 'bin'), pythonPath: join(folder, 'python') }
  mkdirSync(locations.bundledDir)
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

describe('resolveToolLocations', () => {
  const paths = { appPath: '/repo', resourcesPath: '/App/Resources' }

  it('uses the project folders in development', () => {
    // Act
    const resolved = resolveToolLocations({ ...paths, isPackaged: false })

    // Assert
    expect(resolved).toEqual({
      bundledDir: '/repo/resources/bin',
      pythonPath: '/repo/python/.venv/bin/python'
    })
  })

  it('uses the app resources when packaged, where no interpreter exists yet', () => {
    // Act
    const resolved = resolveToolLocations({ ...paths, isPackaged: true })

    // Assert
    expect(resolved).toEqual({ bundledDir: '/App/Resources/bin', pythonPath: null })
  })
})

describe('resolveToolCommand', () => {
  it('runs a bundled tool directly from the bundled folder', () => {
    // Act
    const ffmpeg = resolveToolCommand('ffmpeg', locations)

    // Assert
    expect(ffmpeg).toEqual({ command: join(locations.bundledDir, 'ffmpeg'), args: [] })
  })

  it('runs yt-dlp as an isolated module of the sidecar interpreter', () => {
    // Act
    const ytDlp = resolveToolCommand('yt-dlp', locations)

    // Assert
    expect(ytDlp).toEqual({ command: join(folder, 'python'), args: ['-I', '-m', 'yt_dlp'] })
  })

  it('has no command for yt-dlp without an interpreter', () => {
    // Act
    const ytDlp = resolveToolCommand('yt-dlp', { ...locations, pythonPath: null })

    // Assert
    expect(ytDlp).toBeNull()
  })
})

describe('checkAll', () => {
  it('returns the version of every tool', async () => {
    // Arrange
    writeWorkingTools()

    // Act
    const checks = await checkAll(locations)

    // Assert
    expect(summarize(checks)).toEqual([
      ['yt-dlp', '2026.08.19'],
      ['ffmpeg', '9.0.2'],
      ['fpcalc', '1.6.1'],
      ['mp3gain', '1.6.2']
    ])
  })

  it('reports each kind of failure without failing the other tools', async () => {
    // Arrange
    // `exec` so that the kill on timeout ends the sleep itself, not only its shell.
    writeTool(join(folder, 'python'), 'exec sleep 30')
    writeTool(join(locations.bundledDir, 'ffmpeg'), 'exit 3')
    writeTool(join(locations.bundledDir, 'fpcalc'), 'echo "something else entirely"')

    // Act
    // Long enough for macOS to scan the freshly written scripts on their first run.
    const checks = await checkAll(locations, { timeoutMs: 2000 })

    // Assert
    expect(summarize(checks)).toEqual([
      ['yt-dlp', 'timeout'],
      ['ffmpeg', 'failed'],
      ['fpcalc', 'unrecognized'],
      ['mp3gain', 'missing']
    ])
  })

  it('reports yt-dlp as missing where there is no interpreter', async () => {
    // Arrange
    writeWorkingTools()

    // Act
    const checks = await checkAll({ ...locations, pythonPath: null })

    // Assert
    expect(summarize(checks)[0]).toEqual(['yt-dlp', 'missing'])
    expect(checks.slice(1).every((check) => check.ok)).toBe(true)
  })

  it('reports a file that is not executable as failed', async () => {
    // Arrange
    writeWorkingTools()
    chmodSync(join(locations.bundledDir, 'fpcalc'), 0o644)

    // Act
    const checks = await checkAll(locations)

    // Assert
    expect(summarize(checks)[2]).toEqual(['fpcalc', 'failed'])
  })

  it('reports a tool that floods its output as failed, not as a timeout', async () => {
    // Arrange
    writeWorkingTools()
    writeTool(join(locations.bundledDir, 'ffmpeg'), 'exec yes "ffmpeg version 9.0.2 padding"')

    // Act
    const checks = await checkAll(locations)

    // Assert
    expect(summarize(checks)[1]).toEqual(['ffmpeg', 'failed'])
  })

  it('does not accept an overlong or oddly shaped version string', async () => {
    // Arrange
    writeWorkingTools()
    writeTool(
      join(locations.bundledDir, 'ffmpeg'),
      `echo "ffmpeg version ${'9'.repeat(200)} Copyright"`
    )
    writeTool(
      join(locations.bundledDir, 'fpcalc'),
      'echo "fpcalc version <script>alert(1)</script> x"'
    )

    // Act
    const checks = await checkAll(locations)

    // Assert
    expect(summarize(checks).slice(1, 3)).toEqual([
      ['ffmpeg', 'unrecognized'],
      ['fpcalc', 'unrecognized']
    ])
  })

  it('does not pass the environment of the app on to a tool', async () => {
    // Arrange
    writeWorkingTools()
    writeTool(
      join(locations.bundledDir, 'ffmpeg'),
      'echo "ffmpeg version ${FIXLIB_TEST_SECRET:-clean} x"'
    )
    process.env.FIXLIB_TEST_SECRET = 'leaked'

    // Act
    const checks = await checkAll(locations).finally(() => delete process.env.FIXLIB_TEST_SECRET)

    // Assert
    expect(summarize(checks)[1]).toEqual(['ffmpeg', 'clean'])
  })
})

// Needs ./scripts/fetch-binaries.sh and the Python environment (python/SPIKE.md); CI has neither.
const hasRealTools =
  existsSync(join(REAL_LOCATIONS.bundledDir, '.recipe-sha256')) &&
  REAL_LOCATIONS.pythonPath !== null &&
  existsSync(REAL_LOCATIONS.pythonPath)

describe.skipIf(!hasRealTools)('checkAll with the real tools', () => {
  it('gets a version from all four', async () => {
    // Act
    const checks = await checkAll(REAL_LOCATIONS)

    // Assert
    expect(checks.map((check) => [check.name, check.ok])).toEqual([
      ['yt-dlp', true],
      ['ffmpeg', true],
      ['fpcalc', true],
      ['mp3gain', true]
    ])
    expect(summarize(checks).every(([, version]) => /^\d/.test(version))).toBe(true)
  })
})
