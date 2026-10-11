// The only place that starts or talks to the Python sidecar (docs/ARCHITECTURE.md §05).
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import { AppError } from '@shared/errors'
import {
  encodeRpcRequest,
  parseRpcLine,
  RPC_SCHEMAS,
  type RpcMethod,
  type RpcMethods,
  type RpcProgress
} from '@shared/rpc'

// T-007 moves the per-stage timeouts to src/shared/timeouts.ts.
const DEFAULT_CALL_TIMEOUT_MS = 30_000
const DEFAULT_RESTART_DELAYS_MS = [1000, 2000, 4000]
const DEFAULT_MAX_RESTARTS = 5
const DEFAULT_SHUTDOWN_GRACE_MS = 3000

// The sidecar gets a fixed set of variables, so nothing else in the app's
// environment (lookup API keys in development) can reach it.
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']

export interface PythonBridgeOptions {
  pythonPath: string
  /** Defaults to running the sidecar module. */
  args?: readonly string[]
  cwd?: string
  logDir: string
  onProgress?: (progress: RpcProgress) => void
  log?: (message: string) => void
  /** Wait before restart 1, 2, 3…; the last value repeats. */
  restartDelaysMs?: readonly number[]
  /** Restarts in a row without one answered call before the bridge gives up. */
  maxRestarts?: number
  /** How long `stop` waits for a clean exit before SIGKILL. */
  shutdownGraceMs?: number
}

export interface PythonBridge {
  start: () => void
  call: <M extends RpcMethod>(
    method: M,
    params: RpcMethods[M]['params'],
    options?: { timeoutMs?: number }
  ) => Promise<RpcMethods[M]['result']>
  stop: () => Promise<void>
  /** The sidecar's process id, or null while it is not running. */
  pid: () => number | null
}

interface PendingCall {
  method: RpcMethod
  request: string
  // False while the call waits for a sidecar to be running.
  sent: boolean
  resolve: (result: unknown) => void
  reject: (error: AppError) => void
  timer: NodeJS.Timeout
}

type BridgeState = 'idle' | 'running' | 'restarting' | 'stopping' | 'failed'

export function createPythonBridge(options: PythonBridgeOptions): PythonBridge {
  const args = options.args ?? ['-m', 'fixlib_py.server']
  const restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
  const log = options.log ?? ((message: string) => console.error(`[python-bridge] ${message}`))

  const pending = new Map<number, PendingCall>()
  let state: BridgeState = 'idle'
  let child: ChildProcessWithoutNullStreams | null = null
  let nextId = 1
  let restartsInARow = 0
  let restartTimer: NodeJS.Timeout | null = null
  let resolveStopped: (() => void) | null = null

  function sidecarEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      FIXLIB_LOG_DIR: options.logDir,
      PYTORCH_ENABLE_MPS_FALLBACK: '1',
      PYTHONUNBUFFERED: '1'
    }
    for (const name of INHERITED_ENV) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
    return env
  }

  function settle(id: number): PendingCall | undefined {
    const call = pending.get(id)
    if (!call) return undefined
    clearTimeout(call.timer)
    pending.delete(id)
    return call
  }

  function rejectCalls(shouldReject: (call: PendingCall) => boolean, message: string): void {
    for (const [id, call] of pending) {
      if (!shouldReject(call)) continue
      settle(id)
      call.reject(new AppError('PYTHON_CRASHED', `${call.method}: ${message}`))
    }
  }

  function sendWaitingCalls(): void {
    if (!child) return
    for (const call of pending.values()) {
      if (call.sent) continue
      child.stdin.write(call.request)
      call.sent = true
    }
  }

  function handleLine(line: string): void {
    const message = parseRpcLine(line)
    if (!message) {
      // Never trust the stream: a stray line is logged and dropped.
      log(`ignored a line that is not a valid RPC message (${line.length} characters)`)
      return
    }
    if (message.kind === 'progress') {
      options.onProgress?.(message.progress)
      return
    }
    if (message.id === null) {
      if (message.kind === 'error') {
        log(`sidecar rejected a request: ${message.message} (${message.code})`)
      }
      return
    }
    // A call that already timed out has no entry any more.
    const call = settle(message.id)
    if (!call) return
    restartsInARow = 0

    if (message.kind === 'error') {
      call.reject(
        new AppError('PYTHON_ERROR', `${call.method}: ${message.message} (${message.code})`)
      )
      return
    }
    const result = RPC_SCHEMAS[call.method].result.safeParse(message.result)
    if (result.success) {
      call.resolve(result.data)
    } else {
      call.reject(new AppError('PYTHON_ERROR', `${call.method}: the result has the wrong shape`))
    }
  }

  function handleExit(exited: ChildProcessWithoutNullStreams, reason: string): void {
    // 'error' and 'exit' can both fire for one process.
    if (child !== exited) return
    child = null

    if (state === 'stopping') {
      state = 'idle'
      rejectCalls(() => true, 'the sidecar was stopped')
      resolveStopped?.()
      resolveStopped = null
      return
    }

    log(`sidecar exited unexpectedly (${reason})`)
    rejectCalls((call) => call.sent, 'the sidecar crashed')

    if (restartsInARow >= maxRestarts) {
      state = 'failed'
      log(`giving up after ${maxRestarts} restarts in a row`)
      rejectCalls(() => true, 'the sidecar keeps crashing')
      return
    }
    const delayMs = restartDelaysMs[Math.min(restartsInARow, restartDelaysMs.length - 1)] ?? 0
    restartsInARow += 1
    state = 'restarting'
    restartTimer = setTimeout(() => {
      restartTimer = null
      spawnSidecar()
    }, delayMs)
  }

  function spawnSidecar(): void {
    const started = spawn(options.pythonPath, [...args], {
      cwd: options.cwd,
      env: sidecarEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child = started
    state = 'running'

    createInterface({ input: started.stdout }).on('line', handleLine)
    createInterface({ input: started.stderr }).on('line', (line) => log(`sidecar: ${line}`))
    // A write to a sidecar that just died fails here; the exit handler deals with it.
    started.stdin.on('error', () => {})
    started.on('error', (error) => handleExit(started, error.message))
    started.on('exit', (code, signal) => handleExit(started, signal ?? `code ${code}`))

    sendWaitingCalls()
  }

  function start(): void {
    if (state === 'running' || state === 'restarting' || state === 'stopping') return
    restartsInARow = 0
    spawnSidecar()
  }

  function call<M extends RpcMethod>(
    method: M,
    params: RpcMethods[M]['params'],
    callOptions: { timeoutMs?: number } = {}
  ): Promise<RpcMethods[M]['result']> {
    return new Promise((resolve, reject) => {
      if (state !== 'running' && state !== 'restarting') {
        reject(new AppError('PYTHON_CRASHED', `${method}: the sidecar is not running`))
        return
      }
      const id = nextId++
      const timeoutMs = callOptions.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
      const timer = setTimeout(() => {
        if (settle(id)) {
          reject(new AppError('TIMEOUT', `${method}: no answer within ${timeoutMs} ms`))
        }
      }, timeoutMs)

      pending.set(id, {
        method,
        request: encodeRpcRequest(id, method, RPC_SCHEMAS[method].params.parse(params)),
        sent: false,
        resolve: resolve as (result: unknown) => void,
        reject,
        timer
      })
      sendWaitingCalls()
    })
  }

  function stop(): Promise<void> {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    const running = child
    if (!running) {
      state = 'idle'
      rejectCalls(() => true, 'the sidecar was stopped')
      return Promise.resolve()
    }
    if (state === 'stopping') {
      return new Promise((resolve) => running.once('exit', () => resolve()))
    }

    return new Promise((resolve) => {
      const killTimer = setTimeout(() => running.kill('SIGKILL'), shutdownGraceMs)
      resolveStopped = () => {
        clearTimeout(killTimer)
        resolve()
      }
      // The answer may never arrive; the exit, or the kill timer, ends the wait.
      call('shutdown', {}, { timeoutMs: shutdownGraceMs }).catch(() => {})
      state = 'stopping'
    })
  }

  return { start, call, stop, pid: () => child?.pid ?? null }
}
