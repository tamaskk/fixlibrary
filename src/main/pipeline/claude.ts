// How the app uses Claude: which `claude` command it runs, whether that can be used,
// and how questions are gathered into calls of at most 20 items. The process itself
// is started by `services/claude-cli.ts`; what is asked is a task of
// `services/claude-prompts/`.
import { z } from 'zod'
import type { AppDatabase } from '../db/connection'
import { getSetting, setSetting } from '../db/settings'
import type { ClaudeCli, ClaudeRunOutcome } from '../services/claude-cli'
import type { ClaudeTask } from '../services/claude-prompts/task'
import { logger } from '../services/logger'
import { CLAUDE_BATCH_SIZE, type ClaudeProblem, type ClaudeStatus } from '@shared/claude'
import { AppError, type Result } from '@shared/errors'
import { CLAUDE_LIMIT_RETRY_MS } from '@shared/timeouts'

const SETTING_KEY = 'claude'
// The command the user chose by hand; null means "the one the login shell finds".
const settingSchema = z.object({ path: z.string().min(1).max(1024).nullable() })

// Items that arrive within this time of each other share a call.
const GATHER_MS = 200
const MIN_RECHECK_INTERVAL_MS = 5000

const envelopeSchema = z.object({ items: z.array(z.unknown()).max(CLAUDE_BATCH_SIZE * 2) })

/** What one call came to for the items it held. */
export type BatchOutcome<Answer> =
  | {
      kind: 'answers'
      answers: Map<number, Answer>
      /** The ids Claude answered with something that is not valid, also after a second try. */
      invalid: number[]
      /** The ids Claude did not answer at all. */
      missing: number[]
    }
  | { kind: 'limit'; resetsAt: number | null }
  | { kind: 'unusable'; reason: ClaudeProblem }

export interface ClaudeDependencies {
  db: AppDatabase
  cli: ClaudeCli
  /** Called when a call ran into the usage limit, with the time to try again at. */
  onLimit?: (retryAt: number) => void
  now?: () => number
  gatherMs?: number
}

export interface Claude {
  /** Whether Claude can be used now. The last answer, or a fresh one with `force`. */
  status: (force: boolean) => Promise<ClaudeStatus>
  /** Uses the command at this path from now on; null goes back to the one the shell finds. */
  choosePath: (path: string | null) => Promise<Result<ClaudeStatus>>
  /**
   * Asks about one item. Items of the same task are gathered into calls of at most
   * 20, one call at a time. Rejects with `CLAUDE_FAILED` when Claude gave no valid
   * answer for the item, and with `CLAUDE_LIMIT` when the subscription has no room:
   * that is not a failure of the item, and it can be asked again later.
   */
  ask: <Input, Answer extends { id: number }>(
    task: ClaudeTask<Input, Answer>,
    input: Input,
    signal?: AbortSignal
  ) => Promise<Omit<Answer, 'id'>>
  /** One call for up to 20 items, with one retry for an answer that is not valid. */
  askBatch: <Input, Answer extends { id: number }>(
    task: ClaudeTask<Input, Answer>,
    items: readonly ({ id: number } & Input)[],
    signal?: AbortSignal
  ) => Promise<BatchOutcome<Answer>>
}

interface Waiting {
  input: unknown
  /** True once the item was left out of an answer and lined up again. */
  askedAgain: boolean
  signal: AbortSignal | undefined
  resolve: (answer: unknown) => void
  reject: (error: AppError) => void
}

interface Lane {
  task: ClaudeTask<unknown, { id: number }>
  waiting: Waiting[]
  timer: NodeJS.Timeout | null
}

/** What was wrong with an answer, in the app's own words: safe to send back to Claude. */
function describeIssues(issues: readonly string[]): string {
  return [...new Set(issues)].slice(0, 10).join('; ')
}

export function createClaude(dependencies: ClaudeDependencies): Claude {
  const { db, cli } = dependencies
  const now = dependencies.now ?? Date.now
  const gatherMs = dependencies.gatherMs ?? GATHER_MS

  let located: Promise<string | null> | null = null
  let lastStatus: { status: ClaudeStatus; at: number } | null = null
  let checking: Promise<ClaudeStatus> | null = null

  function chosenPath(): string | null {
    try {
      return getSetting(db, SETTING_KEY, settingSchema)?.path ?? null
    } catch {
      // A stored value that cannot be read counts as "nothing chosen".
      return null
    }
  }

  /** The command to run: the one chosen by hand, or the one the login shell finds. */
  async function commandPath(fresh: boolean): Promise<string | null> {
    const chosen = chosenPath()
    if (chosen !== null) return chosen
    if (fresh) located = null
    located ??= cli.locate().catch(() => null)
    return located
  }

  async function checkNow(fresh: boolean): Promise<ClaudeStatus> {
    const chosenByHand = chosenPath() !== null
    const path = await commandPath(fresh)
    if (path === null) return { ok: false, reason: 'missing', version: null, chosenByHand }
    const check = await cli.check(path)
    // A path that was chosen by hand and is no command any more is a missing one too.
    if (!check.ok && check.reason === 'failed' && !(await cli.isUsable(path))) {
      return { ok: false, reason: 'missing', version: null, chosenByHand }
    }
    return { ...check, chosenByHand }
  }

  function status(force: boolean): Promise<ClaudeStatus> {
    if (checking) return checking
    // Checking starts processes: even a forced check is not repeated back to back.
    if (lastStatus && (!force || now() - lastStatus.at < MIN_RECHECK_INTERVAL_MS)) {
      return Promise.resolve(lastStatus.status)
    }
    checking = checkNow(force)
      .then((result) => {
        lastStatus = { status: result, at: now() }
        return result
      })
      .finally(() => {
        checking = null
      })
    return checking
  }

  function noteProblem(reason: ClaudeProblem): void {
    // What a call ran into is news about the command: the next status asks again.
    if (lastStatus) lastStatus = { status: lastStatus.status, at: 0 }
    logger.warn(`Claude cannot be used: ${reason}`)
  }

  async function askBatch<Input, Answer extends { id: number }>(
    task: ClaudeTask<Input, Answer>,
    items: readonly ({ id: number } & Input)[],
    signal?: AbortSignal
  ): Promise<BatchOutcome<Answer>> {
    if (items.length === 0 || items.length > CLAUDE_BATCH_SIZE) {
      throw new Error('A call to Claude holds 1 to 20 items')
    }
    const path = await commandPath(false)
    if (path === null) return { kind: 'unusable', reason: 'missing' }

    const asked = new Set(items.map((item) => item.id))
    const answers = new Map<number, Answer>()
    let invalid = new Set<number>()
    let issues: string[] = []
    const question = task.prompt(items)

    // The first try, and one more with what was wrong with the answer.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt =
        attempt === 0
          ? question
          : `${question}\n\nYour previous answer was not valid: ${describeIssues(issues)}. Answer again for every id.`
      const outcome: ClaudeRunOutcome = await cli.run(path, {
        prompt,
        systemPrompt: task.systemPrompt,
        jsonSchema: task.jsonSchema,
        signal
      })
      if (outcome.kind === 'limit') return outcome
      if (outcome.kind === 'outdated' || outcome.kind === 'timeout') {
        noteProblem(outcome.kind)
        return { kind: 'unusable', reason: outcome.kind }
      }
      if (outcome.kind === 'failed') {
        // Why it failed is for the status to find out: not logged in, most likely.
        noteProblem('failed')
        return { kind: 'unusable', reason: 'failed' }
      }

      invalid = new Set()
      issues = []
      answers.clear()
      const envelope = envelopeSchema.safeParse(outcome.structured)
      if (!envelope.success) {
        issues.push('the answer must be an object with an "items" array')
        invalid = new Set(asked)
        continue
      }
      for (const entry of envelope.data.items) {
        const answer = task.answerSchema.safeParse(entry)
        const id = z.object({ id: z.number().int() }).safeParse(entry).data?.id
        if (!answer.success) {
          // Named by what the schema says, never by what Claude wrote.
          const where = answer.error.issues[0]?.path.join('.') ?? ''
          issues.push(`an item has an invalid "${where}"`)
          if (id !== undefined && asked.has(id)) invalid.add(id)
          continue
        }
        if (!asked.has(answer.data.id)) {
          issues.push('an item has an id that was not asked for')
          continue
        }
        if (answers.has(answer.data.id)) {
          issues.push('an id is answered twice')
          continue
        }
        answers.set(answer.data.id, answer.data)
      }
      for (const id of answers.keys()) invalid.delete(id)
      if (issues.length === 0) break
    }

    return {
      kind: 'answers',
      answers,
      invalid: [...invalid],
      missing: [...asked].filter((id) => !answers.has(id) && !invalid.has(id))
    }
  }

  // One lane of waiting items per task; one call at a time across all of them.
  const lanes = new Map<string, Lane>()
  let calling: Promise<void> = Promise.resolve()

  function flush(lane: Lane): void {
    if (lane.timer) clearTimeout(lane.timer)
    lane.timer = null
    // A question nobody waits for any more is not asked.
    lane.waiting = lane.waiting.filter((item) => {
      if (!item.signal?.aborted) return true
      item.reject(new AppError('CLAUDE_FAILED', 'the question was withdrawn'))
      return false
    })
    const batch = lane.waiting.splice(0, CLAUDE_BATCH_SIZE)
    if (batch.length === 0) return
    calling = calling.then(() => callFor(lane, batch)).catch(() => {})
    // What is left over waits for company again, unless it is a full call already.
    if (lane.waiting.length >= CLAUDE_BATCH_SIZE) flush(lane)
    else if (lane.waiting.length > 0) lane.timer = setTimeout(() => flush(lane), gatherMs)
  }

  async function callFor(lane: Lane, batch: Waiting[]): Promise<void> {
    // The ids are the places in this call: Claude never sees a track id.
    const items = batch.map((item, index) => ({ ...(item.input as object), id: index + 1 }))
    let outcome: BatchOutcome<{ id: number }>
    try {
      outcome = await askBatch(lane.task, items)
    } catch (error) {
      logger.error('A call to Claude could not be made', error)
      outcome = { kind: 'unusable', reason: 'failed' }
    }

    if (outcome.kind === 'limit') {
      const retryAt = now() + CLAUDE_LIMIT_RETRY_MS
      logger.warn('The Claude usage limit is reached; trying again in 15 minutes')
      dependencies.onLimit?.(retryAt)
      // Everything that waits is handed back: it is asked again once there is room.
      const all = [...batch, ...lane.waiting.splice(0)]
      for (const item of all)
        item.reject(new AppError('CLAUDE_LIMIT', 'the usage limit is reached'))
      return
    }
    if (outcome.kind === 'unusable') {
      for (const item of batch) {
        item.reject(new AppError('CLAUDE_FAILED', `Claude cannot be used: ${outcome.reason}`))
      }
      return
    }

    const again: Waiting[] = []
    batch.forEach((item, index) => {
      const id = index + 1
      const answer = outcome.answers.get(id)
      if (answer !== undefined) {
        // The id was the item's place in the call; it means nothing to the asker.
        const rest: Record<string, unknown> = { ...answer }
        delete rest['id']
        item.resolve(rest)
      } else if (outcome.missing.includes(id) && !item.askedAgain) {
        // Left out of the answer: asked once more, with the next call.
        item.askedAgain = true
        again.push(item)
      } else {
        item.reject(new AppError('CLAUDE_FAILED', 'Claude gave no valid answer for the item'))
      }
    })
    if (again.length > 0) {
      lane.waiting.unshift(...again)
      flush(lane)
    }
  }

  return {
    status,

    async choosePath(path) {
      if (path !== null && !(await cli.isUsable(path))) return { ok: false, code: 'INVALID_INPUT' }
      setSetting(db, SETTING_KEY, { path })
      located = null
      lastStatus = null
      return { ok: true, value: await status(true) }
    },

    askBatch,

    ask(task, input, signal) {
      return new Promise((resolve, reject) => {
        const lane = lanes.get(task.key) ?? {
          task: task as unknown as ClaudeTask<unknown, { id: number }>,
          waiting: [],
          timer: null
        }
        lanes.set(task.key, lane)
        lane.waiting.push({
          input,
          askedAgain: false,
          signal,
          resolve: resolve as (answer: unknown) => void,
          reject
        })
        if (lane.waiting.length >= CLAUDE_BATCH_SIZE) flush(lane)
        else lane.timer ??= setTimeout(() => flush(lane), gatherMs)
      })
    }
  }
}
