import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareRuntime, readManifest, runtimePaths } from './python-runtime'
import type { PythonRuntimeState } from '@shared/python-runtime'

let folder: string
let bundleDir: string
let baseDir: string

/** A runtime archive as the build script packs it, with its manifest. */
function packRuntime(version: number, content = 'the interpreter'): void {
  const stage = join(folder, `stage-${version}`)
  mkdirSync(join(stage, 'python-runtime/bin'), { recursive: true })
  writeFileSync(join(stage, 'python-runtime/bin/python3'), content)
  const archive = `python-runtime-${version}.tar.gz`
  execFileSync('/usr/bin/tar', ['-czf', join(bundleDir, archive), '-C', stage, 'python-runtime'])
  const bytes = readFileSync(join(bundleDir, archive))
  writeFileSync(
    join(bundleDir, 'python-runtime.json'),
    JSON.stringify({
      version,
      archive,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: statSync(join(bundleDir, archive)).size
    })
  )
}

function collect(): { states: PythonRuntimeState[]; onState: (state: PythonRuntimeState) => void } {
  const states: PythonRuntimeState[] = []
  return { states, onState: (state) => states.push(state) }
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'fixlib-runtime-'))
  bundleDir = join(folder, 'Resources/python')
  baseDir = join(folder, 'userData/python')
  mkdirSync(bundleDir, { recursive: true })
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

describe('prepareRuntime', () => {
  it('unpacks the runtime of its version once, and reports how far it got', async () => {
    // Arrange
    packRuntime(3)
    const first = collect()
    const second = collect()

    // Act
    const unpacked = await prepareRuntime({ bundleDir, baseDir }, first.onState)
    const again = await prepareRuntime({ bundleDir, baseDir }, second.onState)

    // Assert
    const paths = runtimePaths(baseDir, 3)
    expect(unpacked).toEqual({ ok: true, value: paths })
    expect(readFileSync(paths.python, 'utf8')).toBe('the interpreter')
    expect(first.states.at(0)).toEqual({ status: 'unpacking', fraction: 0 })
    expect(first.states.at(-1)).toEqual({ status: 'ready', fraction: 1 })
    expect(second.states).toEqual([{ status: 'ready', fraction: 1 }])
    expect(again).toEqual(unpacked)
  })

  it('removes the older versions and what an unpacking that stopped left', async () => {
    // Arrange
    packRuntime(1)
    await prepareRuntime({ bundleDir, baseDir }, () => undefined)
    mkdirSync(join(baseDir, '.unpack-2-deadbeef/python-runtime'), { recursive: true })
    mkdirSync(join(baseDir, 'keep-me'))
    packRuntime(2, 'the new interpreter')

    // Act
    await prepareRuntime({ bundleDir, baseDir }, () => undefined)

    // Assert
    expect(existsSync(join(baseDir, '1'))).toBe(false)
    expect(existsSync(join(baseDir, '.unpack-2-deadbeef'))).toBe(false)
    expect(existsSync(join(baseDir, 'keep-me'))).toBe(true)
    expect(readFileSync(runtimePaths(baseDir, 2).python, 'utf8')).toBe('the new interpreter')
  })

  it('unpacks again a version whose folder was not finished', async () => {
    // Arrange
    packRuntime(4)
    mkdirSync(join(baseDir, '4/bin'), { recursive: true })
    writeFileSync(join(baseDir, '4/bin/python3'), 'half')

    // Act
    await prepareRuntime({ bundleDir, baseDir }, () => undefined)

    // Assert
    expect(readFileSync(runtimePaths(baseDir, 4).python, 'utf8')).toBe('the interpreter')
  })

  it('refuses an archive that does not match its SHA-256, and leaves nothing', async () => {
    // Arrange
    packRuntime(5)
    const manifest = readManifest(bundleDir)
    writeFileSync(
      join(bundleDir, 'python-runtime.json'),
      JSON.stringify({ ...manifest, sha256: '0'.repeat(64) })
    )
    const { states, onState } = collect()

    // Act
    const result = await prepareRuntime({ bundleDir, baseDir }, onState)

    // Assert
    expect(result).toEqual({ ok: false, code: 'TOOL_MISSING' })
    expect(states.at(-1)).toEqual({ status: 'failed', fraction: null })
    expect(existsSync(join(baseDir, '5'))).toBe(false)
  })

  it('says the runtime is missing when the app holds no manifest', async () => {
    // Act
    const result = await prepareRuntime({ bundleDir, baseDir }, () => undefined)

    // Assert
    expect(result).toEqual({ ok: false, code: 'TOOL_MISSING' })
  })
})
