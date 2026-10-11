import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPythonBridge, type PythonBridge, type PythonBridgeOptions } from './python-bridge'

const PYTHON_DIR = resolve('python')
const PYTHON_PATH = join(PYTHON_DIR, '.venv/bin/python')

let logDir: string
let bridge: PythonBridge | null

function startBridge(overrides: Partial<PythonBridgeOptions> = {}): PythonBridge {
  bridge = createPythonBridge({
    pythonPath: PYTHON_PATH,
    cwd: PYTHON_DIR,
    logDir,
    log: () => {},
    ...overrides
  })
  bridge.start()
  return bridge
}

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'fixlibrary-bridge-'))
  bridge = null
})

afterEach(async () => {
  await bridge?.stop()
  rmSync(logDir, { recursive: true, force: true })
})

// Needs the development Python environment (python/SPIKE.md); CI has none.
describe.skipIf(!existsSync(PYTHON_PATH))('python bridge with the real sidecar', () => {
  it('answers ping with the fixlib_py version within one second', async () => {
    // Arrange
    const startedAt = performance.now()
    const sidecar = startBridge()

    // Act
    const result = await sidecar.call('ping', {})

    // Assert
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(performance.now() - startedAt).toBeLessThan(1000)
  })

  it('answers 100 parallel echo calls, each with its own value', async () => {
    // Arrange
    const sidecar = startBridge()
    const values = Array.from({ length: 100 }, (_, index) => ({ index, title: `Szám ${index}` }))

    // Act
    const results = await Promise.all(values.map((value) => sidecar.call('echo', { value })))

    // Assert
    expect(results.map((result) => result.value)).toEqual(values)
  })

  it('rejects pending calls with PYTHON_CRASHED after kill -9 and answers again within 5 s', async () => {
    // Arrange
    const sidecar = startBridge()
    await sidecar.call('ping', {})
    const killedPid = sidecar.pid()
    if (killedPid === null) throw new Error('the sidecar is not running')

    // Act
    const pendingCall = sidecar.call('echo', { value: 'lost' })
    process.kill(killedPid, 'SIGKILL')
    const killedAt = performance.now()
    const pendingError: unknown = await pendingCall.catch((error: unknown) => error)
    const result = await sidecar.call('ping', {})

    // Assert
    expect(pendingError).toMatchObject({ code: 'PYTHON_CRASHED' })
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(performance.now() - killedAt).toBeLessThan(5000)
    expect(sidecar.pid()).not.toBe(killedPid)
  })

  it('ignores output that reaches stdout before the sidecar claims it', async () => {
    // Arrange
    const noisyStart =
      'print("stray print", flush=True); from fixlib_py import server; server.main()'
    const sidecar = startBridge({ args: ['-c', noisyStart] })

    // Act
    const result = await sidecar.call('echo', { value: 'still works' })

    // Assert
    expect(result).toEqual({ value: 'still works' })
  })

  it('stops the sidecar on request and rejects later calls', async () => {
    // Arrange
    const sidecar = startBridge()
    await sidecar.call('ping', {})

    // Act
    await sidecar.stop()
    const error: unknown = await sidecar.call('ping', {}).catch((caught: unknown) => caught)

    // Assert
    expect(sidecar.pid()).toBeNull()
    expect(error).toMatchObject({ code: 'PYTHON_CRASHED' })
  })
})

describe('python bridge with a stand-in process', () => {
  it('rejects a call with TIMEOUT when no answer arrives', async () => {
    // Arrange
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      shutdownGraceMs: 50
    })

    // Act
    const error: unknown = await sidecar
      .call('ping', {}, { timeoutMs: 50 })
      .catch((caught: unknown) => caught)

    // Assert
    expect(error).toMatchObject({ code: 'TIMEOUT' })
  })

  it('rejects a result with the wrong shape', async () => {
    // Arrange
    const wrongAnswer =
      'process.stdin.once("data", () => console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }))); setInterval(() => {}, 1000)'
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', wrongAnswer],
      shutdownGraceMs: 50
    })

    // Act
    const error: unknown = await sidecar.call('ping', {}).catch((caught: unknown) => caught)

    // Assert
    expect(error).toMatchObject({ code: 'PYTHON_ERROR' })
  })

  it('gives up after five restarts in a row and rejects with PYTHON_CRASHED', async () => {
    // Arrange
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', 'process.exit(1)'],
      restartDelaysMs: [1]
    })

    // Act
    const error: unknown = await sidecar.call('ping', {}).catch((caught: unknown) => caught)
    const laterError: unknown = await sidecar.call('ping', {}).catch((caught: unknown) => caught)

    // Assert
    expect(error).toMatchObject({ code: 'PYTHON_CRASHED' })
    expect(laterError).toMatchObject({ code: 'PYTHON_CRASHED' })
    expect(sidecar.pid()).toBeNull()
  })

  it('rejects with PYTHON_CRASHED when the interpreter does not exist', async () => {
    // Arrange
    const sidecar = startBridge({
      pythonPath: join(logDir, 'missing-python'),
      restartDelaysMs: [1]
    })

    // Act
    const error: unknown = await sidecar.call('ping', {}).catch((caught: unknown) => caught)

    // Assert
    expect(error).toMatchObject({ code: 'PYTHON_CRASHED' })
  })
})
