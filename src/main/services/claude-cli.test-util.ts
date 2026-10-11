// Test helper: a stand-in for the `claude` command. It is a real executable in a temp
// folder, so the service starts it exactly as it would start the real one, and it
// answers with streams written beforehand.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/** What the stand-in does for one call, in the order the calls arrive. */
export type FakeClaudeReply =
  /** Prints these stream messages, one per line, and exits with `exitCode` (0 by default). */
  | { stream: readonly unknown[]; exitCode?: number }
  /** Prints to stderr and exits with 1, like the real tool for an option it does not know. */
  | { unknownOption: string }
  /** Never answers. */
  | { hang: true }
  /**
   * Answers every id of the question with `answer`, except the ids in `leaveOut`
   * (not answered) and in `spoil` (answered with `spoilWith` in the place of `answer`).
   */
  | {
      answerEach: Record<string, unknown>
      leaveOut?: readonly number[]
      spoil?: readonly number[]
      spoilWith?: Record<string, unknown>
    }

export interface FakeClaudeCall {
  args: string[]
  input: string
  cwd: string
  /** The names of the files in the working directory when the call started. */
  cwdEntries: string[]
  env: Record<string, string>
}

export interface FakeClaude {
  /** The path of the stand-in; its file name is `claude`. */
  path: string
  /** Sets what the next calls answer; the last reply repeats once they run out. */
  reply: (...replies: FakeClaudeReply[]) => void
  /** What `claude auth status` says: logged in or not. */
  setLoggedIn: (loggedIn: boolean) => void
  /** Every `-p` call so far. */
  calls: () => FakeClaudeCall[]
}

const INIT = { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] }

/** The stream of a call that answered with `structured`. */
export function answerStream(structured: unknown): unknown[] {
  return [
    INIT,
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1_791_755_400 } },
    { type: 'result', subtype: 'success', is_error: false, structured_output: structured }
  ]
}

/** The stream of a call that ran into the usage limit of the subscription. */
export function limitStream(resetsAt = 1_791_755_400): unknown[] {
  return [
    INIT,
    { type: 'system', subtype: 'api_retry', error: 'rate_limit', attempt: 1 },
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } },
    { type: 'result', subtype: 'error', is_error: true, api_error_status: 429, result: 'limit' }
  ]
}

const SCRIPT = `
const fs = require('fs')
const path = require('path')
const dir = __dirname
const args = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
if (args[0] === '--version') {
  process.stdout.write('2.1.296 (Claude Code)\\n')
  process.exit(0)
}
if (args[0] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: state.loggedIn, email: 'dj@example.com', subscriptionType: 'max' }))
  process.exit(state.loggedIn ? 0 : 1)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => {
  const calls = path.join(dir, 'calls.jsonl')
  const done = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\\n').filter(Boolean).length : 0
  fs.appendFileSync(calls, JSON.stringify({ args, input, cwd: process.cwd(), cwdEntries: fs.readdirSync('.'), env: process.env }) + '\\n')
  const reply = state.replies[Math.min(done, state.replies.length - 1)]
  if (!reply) process.exit(3)
  if (reply.unknownOption) {
    process.stderr.write("error: unknown option '" + reply.unknownOption + "'\\n")
    process.exit(1)
  }
  if (reply.hang) return setInterval(() => {}, 1000)
  if (reply.answerEach) {
    // The ids of the question, without those a retry quotes after it.
    const question = input.split('Your previous answer')[0]
    const ids = [...question.matchAll(/"id":(\\d+)/g)].map((match) => Number(match[1]))
    const items = ids
      .filter((id) => !(reply.leaveOut || []).includes(id))
      .map((id) => ({ id, ...((reply.spoil || []).includes(id) ? reply.spoilWith : reply.answerEach) }))
    reply.stream = [
      { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] },
      { type: 'result', subtype: 'success', is_error: false, structured_output: { items } }
    ]
  }
  for (const message of reply.stream) process.stdout.write(JSON.stringify(message) + '\\n')
  process.exit(reply.exitCode || 0)
})
`

/** Writes the stand-in into `folder/bin/claude`. The folder must be a temp folder of the test. */
export function createFakeClaude(folder: string): FakeClaude {
  const bin = join(folder, 'bin')
  mkdirSync(bin, { recursive: true })
  const path = join(bin, 'claude')
  const statePath = join(bin, 'state.json')
  const callsPath = join(bin, 'calls.jsonl')
  const state: { loggedIn: boolean; replies: FakeClaudeReply[] } = { loggedIn: true, replies: [] }
  const save = (): void => writeFileSync(statePath, JSON.stringify(state))
  save()
  // Started with the Node that runs the tests, by its full path: the service gives a
  // process no PATH that would find one.
  writeFileSync(path, `#!${process.execPath}\n${SCRIPT}`)
  chmodSync(path, 0o755)

  return {
    path,
    reply(...replies) {
      state.replies = replies
      save()
    },
    setLoggedIn(loggedIn) {
      state.loggedIn = loggedIn
      save()
    },
    calls: () =>
      existsSync(callsPath)
        ? readFileSync(callsPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as FakeClaudeCall)
        : []
  }
}
