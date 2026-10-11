// Locates the external command-line tools and checks that they run.
// ffmpeg, fpcalc and mp3gain come from scripts/fetch-binaries.sh; yt-dlp is a Python
// module in the sidecar environment. Nothing here falls back to a tool on the PATH.
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const TOOL_NAMES = ['yt-dlp', 'ffmpeg', 'fpcalc', 'mp3gain'] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export interface ToolLocations {
  /** `resources/bin` in development, `Resources/bin` in the packaged app. */
  bundledDir: string
  /** The sidecar's interpreter, or null where there is none yet (packaged app, task 41). */
  pythonPath: string | null
}

/** What to execute for a tool. Callers append their own arguments to `args`. */
export interface ToolCommand {
  command: string
  args: string[]
}

export type ToolCheckFailure = 'missing' | 'timeout' | 'failed' | 'unrecognized'

export type ToolCheck =
  | { name: ToolName; ok: true; version: string }
  | { name: ToolName; ok: false; reason: ToolCheckFailure }

// `-I` keeps the interpreter isolated: no PYTHON* variables, no user site-packages,
// and the working directory is not on the module search path.
const YT_DLP_MODULE_ARGS = ['-I', '-m', 'yt_dlp']

const VERSION_CHECKS: Record<ToolName, { args: readonly string[]; pattern: RegExp }> = {
  'yt-dlp': { args: ['--version'], pattern: /^(\d{4}\.\d{2}\.\d{2}[\w.]{0,20})\s*$/ },
  ffmpeg: { args: ['-version'], pattern: /^ffmpeg version ([\w.+-]{1,40})\s/ },
  fpcalc: { args: ['-version'], pattern: /^fpcalc version ([\w.+-]{1,40})\s/ },
  // Prints "<path> version 1.6.2" on stderr.
  mp3gain: { args: ['-v'], pattern: /\sversion ([\w.+-]{1,40})\s*$/ }
}

const DEFAULT_CHECK_TIMEOUT_MS = 30_000
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024

export function resolveToolLocations(app: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}): ToolLocations {
  return app.isPackaged
    ? { bundledDir: join(app.resourcesPath, 'bin'), pythonPath: null }
    : {
        bundledDir: join(app.appPath, 'resources/bin'),
        pythonPath: join(app.appPath, 'python/.venv/bin/python')
      }
}

/** The command a tool is run with, or null when this installation cannot run it. */
export function resolveToolCommand(name: ToolName, locations: ToolLocations): ToolCommand | null {
  if (name === 'yt-dlp') {
    return locations.pythonPath === null
      ? null
      : { command: locations.pythonPath, args: [...YT_DLP_MODULE_ARGS] }
  }
  return { command: join(locations.bundledDir, name), args: [] }
}

function checkTool(
  name: ToolName,
  locations: ToolLocations,
  timeoutMs: number
): Promise<ToolCheck> {
  const tool = resolveToolCommand(name, locations)
  const { args, pattern } = VERSION_CHECKS[name]

  return new Promise((resolve) => {
    if (tool === null || !existsSync(tool.command)) {
      resolve({ name, ok: false, reason: 'missing' })
      return
    }
    execFile(
      tool.command,
      [...tool.args, ...args],
      {
        // The tools need nothing from the app to print a version: no environment
        // (it can hold API keys in development) and a neutral working directory.
        env: {},
        cwd: tmpdir(),
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_VERSION_OUTPUT_BYTES
      },
      (error, stdout, stderr) => {
        if (error) {
          // Too much output also ends in a kill, so the timeout is told apart by its code.
          const timedOut =
            error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          resolve({ name, ok: false, reason: timedOut ? 'timeout' : 'failed' })
          return
        }
        const version = pattern.exec(`${stdout}\n${stderr}`.trim())?.[1]
        resolve(
          version === undefined
            ? { name, ok: false, reason: 'unrecognized' }
            : { name, ok: true, version }
        )
      }
    )
  })
}

/** Runs every tool with its version switch. Never rejects: a failure is part of the result. */
export function checkAll(
  locations: ToolLocations,
  options: { timeoutMs?: number } = {}
): Promise<ToolCheck[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  return Promise.all(TOOL_NAMES.map((name) => checkTool(name, locations, timeoutMs)))
}
