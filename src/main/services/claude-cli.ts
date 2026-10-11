// The one place that starts the `claude` command-line tool: finds it, asks it for its
// version and login state, and runs one headless call. It knows nothing about what
// is asked or about batches; see `pipeline/claude.ts` for those.
//
// How the tool is invoked is a security decision (docs/ARCHITECTURE.md §08): no
// built-in tools, no MCP servers, no settings, skills or memory of the user or of a
// project, an empty working directory, and the subscription login, never an API key.
import { spawn as spawnProcess } from 'child_process'
import { constants } from 'fs'
import { access, mkdir, mkdtemp, realpath, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join } from 'path'
import { z } from 'zod'
import { CLAUDE_CALL_TIMEOUT_MS, CLAUDE_CHECK_TIMEOUT_MS } from '@shared/timeouts'
import { describeError } from './error-text'
import { logger } from './logger'

const COMMAND_NAME = 'claude'
// Where `claude` is usually installed, tried when the login shell does not name it.
const USUAL_FOLDERS = ['.local/bin', '.claude/local']
const USUAL_SYSTEM_FOLDERS = ['/opt/homebrew/bin', '/usr/local/bin']
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
// The only tool a call may have: the one the answer is given through.
const ANSWER_TOOL = 'StructuredOutput'
// A stream that goes beyond these is not an answer to what was asked.
const MAX_LINE_BYTES = 4 * 1024 * 1024
const MAX_STREAM_BYTES = 32 * 1024 * 1024
const MAX_CHECK_OUTPUT_BYTES = 64 * 1024
// After it was told to stop, a process gets this long before it is killed.
const KILL_AFTER_MS = 2000

const versionPattern = /^(\d{1,4}\.\d{1,4}\.\d{1,6})\b/

// Only what the app uses of `claude auth status --json`. The account's email and
// organisation are in there too: they are never read into a variable.
const authStatusSchema = z.object({
  loggedIn: z.boolean(),
  subscriptionType: z
    .string()
    .regex(/^[\w -]{1,40}$/)
    .optional()
})

const streamMessageSchema = z.object({ type: z.string(), subtype: z.string().optional() })
const initSchema = z.object({
  tools: z.array(z.string()),
  mcp_servers: z.array(z.unknown())
})
const rateLimitSchema = z.object({
  rate_limit_info: z.object({ status: z.string(), resetsAt: z.number().optional() })
})
const resultSchema = z.object({
  is_error: z.boolean().optional(),
  api_error_status: z.number().nullable().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional()
})

export interface ClaudeRequest {
  /** What is asked. Goes in through the standard input, never as an argument. */
  prompt: string
  systemPrompt: string
  /** The JSON Schema the answer must fit. */
  jsonSchema: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

export type ClaudeRunOutcome =
  /** `structured` is what Claude answered: untrusted until its task's schema has read it. */
  | { kind: 'answer'; structured: unknown }
  /** The subscription has no room now. `resetsAt` is in ms since the epoch, if told. */
  | { kind: 'limit'; resetsAt: number | null }
  /** The installed `claude` does not know an option the app passes. */
  | { kind: 'outdated' }
  | { kind: 'timeout' }
  | { kind: 'failed' }

export type ClaudeCheck =
  | { ok: true; version: string; subscription: string | null }
  | { ok: false; reason: 'notLoggedIn' | 'outdated' | 'timeout' | 'failed'; version: string | null }

export interface ClaudeCli {
  /** The path of the `claude` command as the user's login shell finds it, or null. */
  locate: () => Promise<string | null>
  /** True for a path that names a `claude` command that can be run. */
  isUsable: (path: string) => Promise<boolean>
  check: (path: string) => Promise<ClaudeCheck>
  run: (path: string, request: ClaudeRequest) => Promise<ClaudeRunOutcome>
}

export interface ClaudeCliOptions {
  /** A folder of the app's own; every call runs in a new, empty folder inside it. */
  workDir: string
  homeDir: string
  userName: string
  /** The shell the command is looked for with. Replaced in tests. */
  shellPath?: string
}

interface ProcessResult {
  /** Null when the process was killed. */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** True when the output went beyond its limit and the process was stopped for it. */
  overflowed: boolean
}

/**
 * Runs a command to its end, with a limit on its time and its output. Never rejects.
 * `onLine` gets every complete line of the standard output as it arrives.
 */
function runProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    env: Record<string, string>
    timeoutMs: number
    maxOutputBytes: number
    input?: string
    signal?: AbortSignal
    onLine?: (line: string) => void
  }
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    // Always an argument array and never a shell: nothing here is interpreted.
    const child = spawnProcess(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let pending = ''
    let received = 0
    let timedOut = false
    let overflowed = false
    let settled = false
    let killer: NodeJS.Timeout | null = null

    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killer ??= setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    const onAbort = (): void => stop()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) stop()

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killer) clearTimeout(killer)
      options.signal?.removeEventListener('abort', onAbort)
      if (pending !== '' && !overflowed) options.onLine?.(pending)
      resolve({ code, stdout, stderr, timedOut, overflowed })
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      received += Buffer.byteLength(chunk)
      if (received > options.maxOutputBytes || overflowed) {
        overflowed = true
        stop()
        return
      }
      if (!options.onLine) {
        stdout += chunk
        return
      }
      pending += chunk
      let end = pending.indexOf('\n')
      while (end !== -1) {
        options.onLine(pending.slice(0, end))
        pending = pending.slice(end + 1)
        end = pending.indexOf('\n')
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
        overflowed = true
        stop()
      }
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_CHECK_OUTPUT_BYTES) stderr += chunk
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
    // A process that does not read its input must not take the app down with it.
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
  })
}

export function createClaudeCli(options: ClaudeCliOptions): ClaudeCli {
  const shellPath = options.shellPath ?? '/bin/zsh'

  /**
   * What a `claude` process gets of the environment: enough to find the user's
   * login, and nothing else. No `ANTHROPIC_API_KEY`, so the subscription login is
   * what it runs on, and none of the keys the app holds in development.
   */
  function environmentFor(commandPath: string | null): Record<string, string> {
    const ownFolder = commandPath === null ? [] : [dirname(commandPath)]
    return {
      HOME: options.homeDir,
      USER: options.userName,
      LOGNAME: options.userName,
      SHELL: shellPath,
      PATH: [...ownFolder, SYSTEM_PATH].join(':'),
      LANG: 'en_US.UTF-8',
      TMPDIR: tmpdir()
    }
  }

  async function isUsable(path: string): Promise<boolean> {
    // The name is checked as given: the command is often a link to a versioned file.
    if (!isAbsolute(path) || basename(path) !== COMMAND_NAME) return false
    try {
      const resolved = await realpath(path)
      if (!(await stat(resolved)).isFile()) return false
      await access(resolved, constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  async function firstUsable(candidates: readonly string[]): Promise<string | null> {
    for (const candidate of candidates) {
      if (await isUsable(candidate)) return candidate
    }
    return null
  }

  /** A call runs where nothing is: no `CLAUDE.md`, no settings, no files to read. */
  async function inEmptyFolder<T>(work: (folder: string) => Promise<T>): Promise<T> {
    await mkdir(options.workDir, { recursive: true })
    const folder = await mkdtemp(join(options.workDir, 'call-'))
    try {
      return await work(folder)
    } finally {
      // The app's own folder, made a moment ago; whatever the tool left there goes.
      await rm(folder, { recursive: true, force: true }).catch((error: unknown) => {
        logger.warn(`A Claude working folder could not be removed: ${describeError(error)}`)
      })
    }
  }

  function isUnknownOption(result: ProcessResult): boolean {
    return result.code !== 0 && /unknown option|unknown command/i.test(result.stderr)
  }

  return {
    isUsable,

    async locate() {
      // A Mac app started from the Finder does not get the PATH of the user's shell;
      // a login shell does. The command is fixed text, and what it prints is only
      // ever checked as a path, never run as it is.
      const found = await inEmptyFolder((cwd) =>
        runProcess(shellPath, ['-lc', `command -v ${COMMAND_NAME}`], {
          cwd,
          env: { ...environmentFor(null), TERM: 'dumb' },
          timeoutMs: CLAUDE_CHECK_TIMEOUT_MS,
          maxOutputBytes: MAX_CHECK_OUTPUT_BYTES
        })
      )
      // A profile may print lines of its own before the answer.
      const named = found.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => isAbsolute(line))
        .reverse()
      return firstUsable([
        ...named,
        ...USUAL_FOLDERS.map((folder) => join(options.homeDir, folder, COMMAND_NAME)),
        ...USUAL_SYSTEM_FOLDERS.map((folder) => join(folder, COMMAND_NAME))
      ])
    },

    async check(path) {
      if (!(await isUsable(path))) return { ok: false, reason: 'failed', version: null }
      const ask = (args: readonly string[]): Promise<ProcessResult> =>
        inEmptyFolder((cwd) =>
          runProcess(path, args, {
            cwd,
            env: environmentFor(path),
            timeoutMs: CLAUDE_CHECK_TIMEOUT_MS,
            maxOutputBytes: MAX_CHECK_OUTPUT_BYTES
          })
        )

      const versionRun = await ask(['--version'])
      if (versionRun.timedOut) return { ok: false, reason: 'timeout', version: null }
      const version = versionPattern.exec(versionRun.stdout.trim())?.[1] ?? null
      if (versionRun.code !== 0 || version === null) {
        return { ok: false, reason: 'failed', version: null }
      }

      const auth = await ask(['auth', 'status'])
      if (auth.timedOut) return { ok: false, reason: 'timeout', version }
      if (isUnknownOption(auth)) return { ok: false, reason: 'outdated', version }
      let status: z.output<typeof authStatusSchema> | null = null
      try {
        const parsed = authStatusSchema.safeParse(JSON.parse(auth.stdout))
        status = parsed.success ? parsed.data : null
      } catch {
        status = null
      }
      // The exit code is the answer; the output only adds the kind of subscription.
      if (auth.code !== 0 || status?.loggedIn === false) {
        return { ok: false, reason: 'notLoggedIn', version }
      }
      return { ok: true, version, subscription: status?.subscriptionType ?? null }
    },

    async run(path, request) {
      // What the stream has said so far.
      const seen: {
        answer: { structured: unknown } | null
        limit: { resetsAt: number | null } | null
        unexpected: string | null
      } = { answer: null, limit: null, unexpected: null }

      const onLine = (line: string): void => {
        if (line.trim() === '') return
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          // Not a line of the stream; what counts is the result at its end.
          return
        }
        const kind = streamMessageSchema.safeParse(message)
        if (!kind.success) return
        const { type, subtype } = kind.data

        if (type === 'system' && subtype === 'init') {
          const init = initSchema.safeParse(message)
          // The call was told to have no tools and no MCP servers. If it has some
          // after all, its answer is not one the app asked for.
          const clean =
            init.success &&
            init.data.mcp_servers.length === 0 &&
            init.data.tools.every((tool) => tool === ANSWER_TOOL)
          if (!clean) seen.unexpected = 'the call started with tools or MCP servers'
          return
        }
        if (type === 'rate_limit_event') {
          const event = rateLimitSchema.safeParse(message)
          if (event.success && !event.data.rate_limit_info.status.startsWith('allowed')) {
            const { resetsAt } = event.data.rate_limit_info
            seen.limit = { resetsAt: resetsAt === undefined ? null : resetsAt * 1000 }
          }
          return
        }
        if (type === 'system' && subtype === 'api_retry') {
          if (/rate_limit/i.test(line)) seen.limit ??= { resetsAt: null }
          return
        }
        if (type === 'result') {
          const result = resultSchema.safeParse(message)
          if (!result.success) return
          const failed = result.data.is_error === true
          if (
            failed &&
            (result.data.api_error_status === 429 || /limit/i.test(result.data.result ?? ''))
          ) {
            seen.limit ??= { resetsAt: null }
          }
          if (!failed && result.data.structured_output !== undefined) {
            seen.answer = { structured: result.data.structured_output }
          }
        }
      }

      const result = await inEmptyFolder((cwd) =>
        runProcess(
          path,
          [
            '-p',
            '--output-format',
            'stream-json',
            '--verbose',
            '--json-schema',
            JSON.stringify(request.jsonSchema),
            // No built-in tools.
            '--tools',
            '',
            // No MCP servers: only the ones of `--mcp-config`, and there is none.
            '--strict-mcp-config',
            '--no-session-persistence',
            // No settings of the user or of a project: no hooks, no permissions of theirs.
            '--setting-sources',
            '',
            // No skills.
            '--disable-slash-commands',
            // The app's own instructions in the place of the default ones.
            '--system-prompt',
            request.systemPrompt
          ],
          {
            cwd,
            env: environmentFor(path),
            timeoutMs: request.timeoutMs ?? CLAUDE_CALL_TIMEOUT_MS,
            maxOutputBytes: MAX_STREAM_BYTES,
            input: request.prompt,
            signal: request.signal,
            onLine
          }
        )
      )

      if (seen.unexpected !== null) {
        logger.error(`A Claude call was thrown away: ${seen.unexpected}`)
        return { kind: 'failed' }
      }
      if (isUnknownOption(result)) return { kind: 'outdated' }
      // Before the timeout: a call that waits out a limit runs into its time too.
      if (seen.limit !== null) return { kind: 'limit', resetsAt: seen.limit.resetsAt }
      if (result.timedOut) return { kind: 'timeout' }
      if (seen.answer !== null && !result.overflowed) {
        return { kind: 'answer', structured: seen.answer.structured }
      }
      // What the tool printed stays out of the log: it may quote what it was asked.
      logger.warn(`A Claude call gave no answer (exit code ${String(result.code)})`)
      return { kind: 'failed' }
    }
  }
}
