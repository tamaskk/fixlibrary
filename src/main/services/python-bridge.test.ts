import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPythonBridge, type PythonBridge, type PythonBridgeOptions } from './python-bridge'

const PYTHON_DIR = resolve('python')
const PYTHON_PATH = join(PYTHON_DIR, '.venv/bin/python')

// Stand-in "sidecars" run by Node. Each start appends one byte to the file in argv[1].
const COUNT_START = 'require("fs").appendFileSync(process.argv[1], "x")'
const COUNT_START_THEN_EXIT = `${COUNT_START}; process.exit(1)`

let logDir: string
let bridge: PythonBridge | null

function startsFile(): string {
  return join(logDir, 'starts')
}

function countStarts(): number {
  return existsSync(startsFile()) ? readFileSync(startsFile()).length : 0
}

function startBridge(overrides: Partial<PythonBridgeOptions> = {}): PythonBridge {
  bridge = createPythonBridge({
    pythonPath: PYTHON_PATH,
    cwd: PYTHON_DIR,
    logDir,
    log: () => {},
    onSidecarOutput: () => {},
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

  it('keeps what the sidecar says about an error out of the error, and logs it as one line', async () => {
    // Arrange
    const logged: string[] = []
    const failWithDetail =
      'process.stdin.once("data", (line) => console.log(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(line).id, error: { code: -32603, message: "FileNotFoundError: /Volumes/DJ SSD/Private/track.mp3\\nffmpeg -i x" } }))); setInterval(() => {}, 1000)'
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', failWithDetail],
      shutdownGraceMs: 50,
      log: (message) => logged.push(message)
    })

    // Act
    const error = (await sidecar.call('ping', {}).catch((caught: unknown) => caught)) as Error

    // Assert
    expect(error).toMatchObject({ code: 'PYTHON_ERROR' })
    expect(error.message).toBe('ping: the sidecar reported an error (-32603)')
    expect(logged).toContain(
      'ping failed (-32603): FileNotFoundError: /Volumes/DJ SSD/Private/track.mp3 ffmpeg -i x'
    )
  })

  it('writes at most 200 lines of sidecar output in ten seconds, then says how many it held back', async () => {
    // Arrange
    const output: string[] = []
    let clock = 0
    const chatty =
      'for (let i = 0; i < 500; i += 1) console.error("progress " + i); process.stdin.once("data", (line) => { console.error("after the pause"); console.log(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(line).id, result: { version: "0.0.0" } })) }); setInterval(() => {}, 1000)'
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', chatty],
      shutdownGraceMs: 50,
      onSidecarOutput: (line) => output.push(line),
      now: () => clock
    })
    await vi.waitFor(() => expect(output).toHaveLength(200))

    // Act
    clock = 10_000
    await sidecar.call('ping', {})
    await vi.waitFor(() => expect(output.at(-1)).toBe('after the pause'))

    // Assert
    expect(output.slice(0, 2)).toEqual(['progress 0', 'progress 1'])
    expect(output.slice(-2)).toEqual(['(300 lines suppressed)', 'after the pause'])
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

  it('starts the sidecar six times, then gives up and rejects calls at once', async () => {
    // Arrange
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', COUNT_START_THEN_EXIT, startsFile()],
      restartDelaysMs: [1]
    })

    // Act
    await vi.waitFor(() => expect(sidecar.state()).toBe('failed'))
    const error: unknown = await sidecar.call('ping', {}).catch((caught: unknown) => caught)

    // Assert
    expect(countStarts()).toBe(6)
    expect(error).toMatchObject({ code: 'PYTHON_CRASHED' })
    expect(sidecar.pid()).toBeNull()
  })

  it('keeps restarting a sidecar that stays up between its crashes', async () => {
    // Arrange
    const liveBrieflyThenExit = `${COUNT_START}; setTimeout(() => process.exit(1), 60)`
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', liveBrieflyThenExit, startsFile()],
      restartDelaysMs: [1],
      maxRestarts: 2,
      stableUptimeMs: 20
    })

    // Act
    await vi.waitFor(() => expect(countStarts()).toBeGreaterThanOrEqual(5))

    // Assert
    expect(sidecar.state()).not.toBe('failed')
  })

  it('gives up on a sidecar that answers a call and then dies every time', async () => {
    // Arrange
    const answerOnceThenExit = `${COUNT_START}; process.stdin.once("data", (line) => { console.log(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(line).id, result: { version: "0.0.0" } })); setTimeout(() => process.exit(1), 5) })`
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', answerOnceThenExit, startsFile()],
      restartDelaysMs: [1],
      maxRestarts: 2
    })

    // Act
    while (sidecar.state() !== 'failed') {
      await sidecar.call('ping', {}).catch(() => {})
    }

    // Assert
    expect(countStarts()).toBe(3)
  })

  it('restarts a sidecar that sends a line longer than the limit', async () => {
    // Arrange
    const endlessLine = `${COUNT_START}; process.stdin.once("data", () => process.stdout.write("x".repeat(5000)))`
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', endlessLine, startsFile()],
      restartDelaysMs: [1],
      maxLineLength: 1000
    })

    // Act
    const error: unknown = await sidecar.call('ping', {}).catch((caught: unknown) => caught)
    await vi.waitFor(() => expect(countStarts()).toBeGreaterThanOrEqual(2))

    // Assert
    expect(error).toMatchObject({ code: 'PYTHON_CRASHED' })
  })

  it('survives a progress listener that throws', async () => {
    // Arrange
    const progressThenAnswer =
      'process.stdin.once("data", (line) => { console.log(JSON.stringify({ jsonrpc: "2.0", method: "progress", params: { jobId: "j", percent: 50 } })); console.log(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(line).id, result: { version: "0.0.0" } })) }); setInterval(() => {}, 1000)'
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', progressThenAnswer],
      shutdownGraceMs: 50,
      onProgress: () => {
        throw new Error('listener failed')
      }
    })

    // Act
    const result = await sidecar.call('ping', {})

    // Assert
    expect(result).toEqual({ version: '0.0.0' })
  })

  it('rejects params with the wrong shape without sending them', async () => {
    // Arrange
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      shutdownGraceMs: 50
    })
    const badParams = { value: () => 'not JSON' } as unknown as { value: string }

    // Act
    const error: unknown = await sidecar.call('echo', badParams).catch((caught: unknown) => caught)

    // Assert
    expect(error).toMatchObject({ code: 'PYTHON_ERROR' })
  })

  it('resolves two overlapping stop calls', async () => {
    // Arrange
    const sidecar = startBridge({
      pythonPath: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      shutdownGraceMs: 50
    })

    // Act
    await Promise.all([sidecar.stop(), sidecar.stop()])

    // Assert
    expect(sidecar.state()).toBe('idle')
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
