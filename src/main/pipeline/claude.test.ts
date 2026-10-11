import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { createClaudeCli } from '../services/claude-cli'
import {
  answerStream,
  createFakeClaude,
  limitStream,
  type FakeClaude
} from '../services/claude-cli.test-util'
import { createStyleTask, type StyleInput } from '../services/claude-prompts/style'
import { logger } from '../services/logger'
import { AppError } from '@shared/errors'
import { createClaude, type Claude } from './claude'

const TASK = createStyleTask(['House', 'Techno'])
const GOOD = { style: 'House', confidence: 0.9 }

let testDatabase: TestDatabase
let folder: string
let fake: FakeClaude
let limits: number[]
let claude: Claude

function track(number: number): StyleInput {
  return { artist: `Artist ${number}`, title: `Title ${number}`, label: null, year: 2020, bpm: 124 }
}

/** How many items each call held, by the ids in its question. */
function callSizes(): number[] {
  return fake
    .calls()
    .map(
      (call) =>
        [...(call.input.split('Your previous answer')[0] ?? '').matchAll(/"id":\d+/g)].length
    )
}

function settle<T>(promises: Promise<T>[]): Promise<(T | string)[]> {
  return Promise.all(
    promises.map((promise) =>
      promise.catch((error: unknown) => (error instanceof AppError ? error.code : 'OTHER'))
    )
  )
}

beforeEach(async () => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-claude-run-')))
  mkdirSync(join(folder, 'home'))
  fake = createFakeClaude(folder)
  limits = []
  claude = createClaude({
    db: testDatabase.db,
    cli: createClaudeCli({
      workDir: join(folder, 'work'),
      homeDir: join(folder, 'home'),
      userName: 'dj',
      // A shell that finds nothing: the command is the one chosen by hand below.
      shellPath: '/usr/bin/true'
    }),
    onLimit: (retryAt) => limits.push(retryAt),
    now: () => 1_000_000,
    gatherMs: 20
  })
  await claude.choosePath(fake.path)
})

afterEach(() => {
  testDatabase.cleanup()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('the status of Claude', () => {
  it('is fine for a command that runs and is logged in', async () => {
    // Act
    const status = await claude.status(true)

    // Assert
    expect(status).toEqual({
      ok: true,
      version: '2.1.296',
      subscription: 'max',
      chosenByHand: true
    })
  })

  it('says that nobody is logged in', async () => {
    // Arrange
    fake.setLoggedIn(false)
    const fresh = createClaude({
      db: testDatabase.db,
      cli: createClaudeCli({
        workDir: join(folder, 'work'),
        homeDir: join(folder, 'home'),
        userName: 'dj'
      })
    })

    // Act
    const status = await fresh.status(true)

    // Assert
    expect(status).toEqual({
      ok: false,
      reason: 'notLoggedIn',
      version: '2.1.296',
      chosenByHand: true
    })
  })

  it('says that the command is missing when neither the user nor the shell names one', async () => {
    // Act
    const cleared = await claude.choosePath(null)

    // Assert
    expect(cleared).toEqual({
      ok: true,
      value: { ok: false, reason: 'missing', version: null, chosenByHand: false }
    })
  })

  it('takes no path by hand that is not a claude command', async () => {
    // Act
    const chosen = await claude.choosePath('/bin/ls')

    // Assert
    expect(chosen).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect((await claude.status(false)).ok).toBe(true)
  })
})

describe('asking about many items', () => {
  it('makes exactly three calls for 45 tracks (20, 20, 5), and answers all 45', async () => {
    // Arrange
    fake.reply({ answerEach: GOOD })

    // Act
    const answers = await Promise.all(
      Array.from({ length: 45 }, (_, index) => claude.ask(TASK, track(index + 1)))
    )

    // Assert
    expect(callSizes()).toEqual([20, 20, 5])
    expect(answers).toHaveLength(45)
    expect(answers.every((answer) => answer.style === 'House' && answer.confidence === 0.9)).toBe(
      true
    )
  })

  it('gives every item the answer that was given for its own id', async () => {
    // Arrange
    fake.reply({
      stream: answerStream({
        items: [
          { id: 2, style: 'Techno', confidence: 0.8 },
          { id: 1, style: 'House', confidence: 0.6 }
        ]
      })
    })

    // Act
    const [first, second] = await Promise.all([
      claude.ask(TASK, track(1)),
      claude.ask(TASK, track(2))
    ])

    // Assert
    expect(first).toEqual({ style: 'House', confidence: 0.6 })
    expect(second).toEqual({ style: 'Techno', confidence: 0.8 })
  })

  it('keeps the items of two tasks in calls of their own', async () => {
    // Arrange
    const unsorted = { style: 'Unsorted', confidence: 0.5 }
    fake.reply({ answerEach: unsorted })
    const other = createStyleTask(['Trance'])

    // Act
    const answers = await Promise.all([claude.ask(TASK, track(1)), claude.ask(other, track(2))])

    // Assert
    expect(answers).toEqual([unsorted, unsorted])
    expect(callSizes()).toEqual([1, 1])
    expect(fake.calls()[0]?.input).toContain('"House","Techno"')
    expect(fake.calls()[1]?.input).toContain('"Trance"')
  })
})

describe('an answer that is not valid', () => {
  it('is asked for once more, with what was wrong, and then counts', async () => {
    // Arrange
    fake.reply(
      { answerEach: GOOD, spoil: [1], spoilWith: { style: 'Polka', confidence: 0.9 } },
      { answerEach: GOOD }
    )

    // Act
    const answers = await Promise.all([claude.ask(TASK, track(1)), claude.ask(TASK, track(2))])

    // Assert
    expect(answers).toEqual([GOOD, GOOD])
    expect(fake.calls()).toHaveLength(2)
    expect(fake.calls()[1]?.input).toContain('Your previous answer was not valid')
    expect(fake.calls()[1]?.input).toContain('an item has an invalid "style"')
    // What Claude wrote is not quoted back.
    expect(fake.calls()[1]?.input).not.toContain('Polka')
  })

  it('fails the track with CLAUDE_FAILED after the second try, and keeps the valid ones', async () => {
    // Arrange
    fake.reply({ answerEach: GOOD, spoil: [1], spoilWith: { style: 'Polka', confidence: 2 } })

    // Act
    const answers = await settle([claude.ask(TASK, track(1)), claude.ask(TASK, track(2))])

    // Assert
    expect(answers).toEqual(['CLAUDE_FAILED', GOOD])
    expect(fake.calls()).toHaveLength(2)
  })

  it('fails every track of a call whose answer is not even a list of items', async () => {
    // Arrange
    fake.reply({ stream: answerStream({ wrong: true }) })

    // Act
    const answers = await settle([claude.ask(TASK, track(1)), claude.ask(TASK, track(2))])

    // Assert
    expect(answers).toEqual(['CLAUDE_FAILED', 'CLAUDE_FAILED'])
    expect(fake.calls()).toHaveLength(2)
  })
})

describe('an id that is missing from the answer', () => {
  it('is asked again once, in a call of its own', async () => {
    // Arrange
    fake.reply({ answerEach: GOOD, leaveOut: [2] }, { answerEach: GOOD })

    // Act
    const answers = await Promise.all([1, 2, 3].map((number) => claude.ask(TASK, track(number))))

    // Assert
    expect(answers).toEqual([GOOD, GOOD, GOOD])
    expect(callSizes()).toEqual([3, 1])
    expect(fake.calls()[1]?.input).toContain('Title 2')
  })

  it('fails with CLAUDE_FAILED when it is missing the second time too', async () => {
    // Arrange: the item is the second of the first call and the first of the second.
    fake.reply({ answerEach: GOOD, leaveOut: [2] }, { answerEach: GOOD, leaveOut: [1] })

    // Act
    const answers = await settle([1, 2].map((number) => claude.ask(TASK, track(number))))

    // Assert
    expect(answers).toEqual([GOOD, 'CLAUDE_FAILED'])
    expect(fake.calls()).toHaveLength(2)
  })
})

describe('the usage limit', () => {
  it('hands every waiting item back with CLAUDE_LIMIT, and says when to try again', async () => {
    // Arrange
    fake.reply({ stream: limitStream() })

    // Act
    const answers = await settle(
      Array.from({ length: 25 }, (_, index) => claude.ask(TASK, track(index + 1)))
    )

    // Assert
    expect(new Set(answers)).toEqual(new Set(['CLAUDE_LIMIT']))
    // Fifteen minutes after the call.
    expect(limits[0]).toBe(1_000_000 + 15 * 60 * 1000)
  })
})

describe('a command that cannot be used', () => {
  it('fails the tracks with CLAUDE_FAILED when it does not know an option', async () => {
    // Arrange
    fake.reply({ unknownOption: '--json-schema' })

    // Act
    const answers = await settle([claude.ask(TASK, track(1))])
    const batch = await claude.askBatch(TASK, [{ id: 1, ...track(1) }])

    // Assert
    expect(answers).toEqual(['CLAUDE_FAILED'])
    expect(batch).toEqual({ kind: 'unusable', reason: 'outdated' })
  })

  it('does not ask a question that was withdrawn before its call', async () => {
    // Arrange
    fake.reply({ answerEach: GOOD })
    const withdrawn = new AbortController()

    // Act
    const asking = settle([
      claude.ask(TASK, track(1), withdrawn.signal),
      claude.ask(TASK, track(2))
    ])
    withdrawn.abort()
    const answers = await asking

    // Assert
    expect(answers).toEqual(['CLAUDE_FAILED', GOOD])
    expect(callSizes()).toEqual([1])
  })
})
