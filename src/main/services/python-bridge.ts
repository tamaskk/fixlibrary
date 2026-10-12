// The only place that starts or talks to the Python sidecar (docs/ARCHITECTURE.md §05).
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { AppError } from '@shared/errors'
import {
  encodeRpcRequest,
  parseRpcLine,
  RPC_SCHEMAS,
  type RpcMethod,
  type RpcMethods,
  type RpcProgress
} from '@shared/rpc'
import { toOneLine } from '@shared/text'
import { DEFAULT_RPC_TIMEOUT_MS, JOB_CANCEL_TIMEOUT_MS } from '@shared/timeouts'
import { createLineReader } from './line-reader'
import { createLogLimiter } from './log-limiter'
import { logger } from './logger'

const DEFAULT_RESTART_DELAYS_MS = [1000, 2000, 4000]
const DEFAULT_MAX_RESTARTS = 5
const DEFAULT_SHUTDOWN_GRACE_MS = 3000
const DEFAULT_STABLE_UPTIME_MS = 10_000
const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024
const MAX_LOGGED_STDERR_LENGTH = 1000
const MAX_LOGGED_ERROR_LENGTH = 500
// The sidecar shares main.log with the app: a tool's progress display must not be
// able to push the app's own history out of it.
const SIDECAR_OUTPUT_LIMIT = { limit: 200, windowMs: 10_000 }

// The sidecar gets a fixed set of variables, so nothing else in the app's
// environment (lookup API keys in development) can reach it.
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']

export type PythonBridgeState = 'idle' | 'running' | 'restarting' | 'stopping' | 'failed'

export interface PythonBridgeOptions {
  pythonPath: string
  /** Defaults to running the sidecar module. */
  args?: readonly string[]
  cwd?: string
  logDir: string
  /** The ffmpeg the sidecar decodes audio with. Without it, analysis fails per track. */
  ffmpegPath?: string
  onProgress?: (progress: RpcProgress) => void
  /** What the bridge itself has to say: crashes, restarts, rejected lines. */
  log?: (message: string) => void
  /** One line the sidecar wrote to stderr. */
  onSidecarOutput?: (line: string) => void
  now?: () => number
  /** Wait before restart 1, 2, 3…; the last value repeats. */
  restartDelaysMs?: readonly number[]
  /** Restarts in a row before the bridge gives up. */
  maxRestarts?: number
  /** A sidecar that stays up this long ends the row of restarts. */
  stableUptimeMs?: number
  /** Longest protocol line accepted; a longer one counts as a crash. */
  maxLineLength?: number
  /** How long `stop` waits for a clean exit before SIGKILL. */
  shutdownGraceMs?: number
}

export interface CallOptions {
  timeoutMs?: number
  /**
   * For a call that starts a long job in the sidecar: when the signal is aborted, the
   * call is rejected at once and the sidecar is told to stop the job. `id` is the
   * job id that was sent in the params of the call.
   */
  job?: { id: string; signal: AbortSignal }
}

export interface PythonBridge {
  start: () => void
  call: <M extends RpcMethod>(
    method: M,
    params: RpcMethods[M]['params'],
    options?: CallOptions
  ) => Promise<RpcMethods[M]['result']>
  stop: () => Promise<void>
  /** The sidecar's process id, or null while it is not running. */
  pid: () => number | null
  /** `failed` means the bridge gave up restarting; `start` tries again. */
  state: () => PythonBridgeState
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

export function createPythonBridge(options: PythonBridgeOptions): PythonBridge {
  const args = options.args ?? ['-m', 'fixlib_py.server']
  const restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
  const stableUptimeMs = options.stableUptimeMs ?? DEFAULT_STABLE_UPTIME_MS
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH
  const log = options.log ?? ((message: string) => logger.warn(`[python-bridge] ${message}`))
  // The sidecar keeps its own python.log; its lines are also in the main log, in order
  // with what the app was doing at the time.
  const writeSidecarOutput = createLogLimiter(
    options.onSidecarOutput ?? ((line: string) => logger.info(`[python] ${line}`)),
    { ...SIDECAR_OUTPUT_LIMIT, now: options.now }
  )
  // One clean line each: what a tool prints cannot forge or garble log lines.
  const onSidecarOutput = (line: string): void =>
    writeSidecarOutput(toOneLine(line, MAX_LOGGED_STDERR_LENGTH))

  const pending = new Map<number, PendingCall>()
  let state: PythonBridgeState = 'idle'
  let child: ChildProcessWithoutNullStreams | null = null
  let nextId = 1
  let restartsInARow = 0
  let restartTimer: NodeJS.Timeout | null = null
  let stableTimer: NodeJS.Timeout | null = null
  let resolveStopped: (() => void) | null = null
  let stopPromise: Promise<void> | null = null

  function sidecarEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      FIXLIB_LOG_DIR: options.logDir,
      PYTORCH_ENABLE_MPS_FALLBACK: '1',
      PYTHONUNBUFFERED: '1',
      // UTF-8 for the protocol and for file names, whatever locale the app was started in.
      PYTHONUTF8: '1'
    }
    if (options.ffmpegPath !== undefined) env['FIXLIB_FFMPEG'] = options.ffmpegPath
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
    // Whatever the sidecar sends, it must not throw into the main process.
    try {
      routeLine(line)
    } catch (error) {
      log(`could not handle a line from the sidecar: ${String(error)}`)
    }
  }

  function routeLine(line: string): void {
    if (line.length === 0) return
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
        log(
          `sidecar rejected a request (${message.code}): ${toOneLine(message.message, MAX_LOGGED_ERROR_LENGTH)}`
        )
      }
      return
    }
    // A call that already timed out has no entry any more.
    const call = settle(message.id)
    if (!call) return

    if (message.kind === 'error') {
      // What the sidecar says can hold a path or a tool's output: it goes to the log,
      // cut down to one line, and the error itself carries the app's own words.
      log(
        `${call.method} failed (${message.code}): ${toOneLine(message.message, MAX_LOGGED_ERROR_LENGTH)}`
      )
      call.reject(
        new AppError(
          'PYTHON_ERROR',
          `${call.method}: the sidecar reported an error (${message.code})`
        )
      )
      return
    }
    try {
      const result = RPC_SCHEMAS[call.method].result.safeParse(message.result)
      if (result.success) {
        call.resolve(result.data)
        return
      }
    } catch {
      // A pathological value can make validation itself throw; treat it as a wrong shape.
    }
    call.reject(new AppError('PYTHON_ERROR', `${call.method}: the result has the wrong shape`))
  }

  function handleExit(exited: ChildProcessWithoutNullStreams, reason: string): void {
    // 'error' and 'exit' can both fire for one process.
    if (child !== exited) return
    child = null
    if (stableTimer) {
      clearTimeout(stableTimer)
      stableTimer = null
    }

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

    // Only a sidecar that stays up ends a row of restarts. An answered call does
    // not: a sidecar that answers once and dies would otherwise restart forever.
    stableTimer = setTimeout(() => {
      stableTimer = null
      restartsInARow = 0
    }, stableUptimeMs)
    stableTimer.unref()

    started.stdout.on(
      'data',
      createLineReader({
        maxLineLength,
        onLine: handleLine,
        onOverflow: () => {
          log(`sidecar sent a line longer than ${maxLineLength} characters, restarting it`)
          started.kill('SIGKILL')
        }
      })
    )
    started.stderr.on(
      'data',
      createLineReader({
        maxLineLength: MAX_LOGGED_STDERR_LENGTH,
        onLine: onSidecarOutput,
        onOverflow: () => onSidecarOutput('(dropped an overlong line)')
      })
    )
    // A write to a sidecar that just died fails here; the exit handler deals with it.
    started.stdin.on('error', () => {})
    started.on('error', (error) => {
      if (started.pid === undefined) {
        // The process never started, so no 'exit' will follow.
        handleExit(started, error.message)
        return
      }
      // A failed kill or write on a live process: end it, and let 'exit' do the rest.
      log(`sidecar process error: ${error.message}`)
      started.kill('SIGKILL')
    })
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
    callOptions: CallOptions = {}
  ): Promise<RpcMethods[M]['result']> {
    return new Promise((resolve, reject) => {
      if (state !== 'running' && state !== 'restarting') {
        reject(new AppError('PYTHON_CRASHED', `${method}: the sidecar is not running`))
        return
      }
      const { job } = callOptions
      // Checked now and not when the job is stopped: with an id the sidecar would
      // refuse, the stop could never be passed on.
      if (job && !RPC_SCHEMAS['job.cancel'].params.safeParse({ jobId: job.id }).success) {
        reject(new AppError('INVALID_INPUT', `${method}: the job id has the wrong shape`))
        return
      }
      if (job?.signal.aborted) {
        reject(new AppError('UNEXPECTED', `${method}: stopped before it was sent`))
        return
      }
      const validParams = RPC_SCHEMAS[method].params.safeParse(params)
      if (!validParams.success) {
        reject(new AppError('PYTHON_ERROR', `${method}: the params have the wrong shape`))
        return
      }
      const id = nextId++
      const timeoutMs = callOptions.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
      // A call that is over, however it ended, no longer listens for the stop.
      const stopListening = (): void => job?.signal.removeEventListener('abort', onStop)
      const timer = setTimeout(() => {
        if (settle(id)) {
          stopListening()
          reject(new AppError('TIMEOUT', `${method}: no answer within ${timeoutMs} ms`))
        }
      }, timeoutMs)

      function onStop(): void {
        const stopped = settle(id)
        // Answered, timed out or rejected with the sidecar already.
        if (!stopped || !job) return
        reject(new AppError('UNEXPECTED', `${method}: stopped`))
        // A call that never reached the sidecar started no job there, and a sidecar
        // that is being stopped takes its jobs with it.
        if (!stopped.sent || (state !== 'running' && state !== 'restarting')) return
        // The job's own result is no longer waited for, whatever the sidecar answers.
        call('job.cancel', { jobId: job.id }, { timeoutMs: JOB_CANCEL_TIMEOUT_MS }).then(
          ({ cancelled }) => {
            // Not found yet: the sidecar remembers the id and stops the job as it starts.
            if (!cancelled) log(`job.cancel for ${method} found no running job`)
          },
          (error: unknown) => log(`job.cancel for ${method} got no answer: ${String(error)}`)
        )
      }

      pending.set(id, {
        method,
        request: encodeRpcRequest(id, method, validParams.data),
        sent: false,
        resolve: (result) => {
          stopListening()
          resolve(result as RpcMethods[M]['result'])
        },
        reject: (error) => {
          stopListening()
          reject(error)
        },
        timer
      })
      job?.signal.addEventListener('abort', onStop, { once: true })
      sendWaitingCalls()
    })
  }

  function stop(): Promise<void> {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (stopPromise) return stopPromise
    const running = child
    if (!running) {
      state = 'idle'
      rejectCalls(() => true, 'the sidecar was stopped')
      return Promise.resolve()
    }

    stopPromise = new Promise((resolve) => {
      const killTimer = setTimeout(() => running.kill('SIGKILL'), shutdownGraceMs)
      resolveStopped = () => {
        clearTimeout(killTimer)
        stopPromise = null
        resolve()
      }
      // The answer may never arrive; the exit, or the kill timer, ends the wait.
      call('shutdown', {}, { timeoutMs: shutdownGraceMs }).catch(() => {})
      state = 'stopping'
    })
    return stopPromise
  }

  return { start, call, stop, pid: () => child?.pid ?? null, state: () => state }
}
