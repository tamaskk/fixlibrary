import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
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

const TASK = createStyleTask([
  { name: 'House', isHouse: true },
  { name: 'Techno', isHouse: false }
])
const GOOD = { primary: 'House', secondary: null, confidence: 90, isNewStyle: false }

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
    expect(answers.every((answer) => answer.primary === 'House' && answer.confidence === 90)).toBe(
      true
    )
  })

  it('gives every item the answer that was given for its own id', async () => {
    // Arrange
    fake.reply({
      stream: answerStream({
        items: [
          { id: 2, ...{ primary: 'Techno', secondary: null, confidence: 80, isNewStyle: false } },
          { id: 1, ...{ primary: 'House', secondary: null, confidence: 60, isNewStyle: false } }
        ]
      })
    })

    // Act
    const [first, second] = await Promise.all([
      claude.ask(TASK, track(1)),
      claude.ask(TASK, track(2))
    ])

    // Assert
    expect(first).toEqual({ primary: 'House', secondary: null, confidence: 60, isNewStyle: false })
    expect(second).toEqual({
      primary: 'Techno',
      secondary: null,
      confidence: 80,
      isNewStyle: false
    })
  })

  it('keeps the items of two tasks in calls of their own', async () => {
    // Arrange
    const unsorted = { primary: 'Unsorted', secondary: null, confidence: 50, isNewStyle: false }
    fake.reply({ answerEach: unsorted })
    const other = createStyleTask([{ name: 'Trance', isHouse: false }])

    // Act
    const answers = await Promise.all([claude.ask(TASK, track(1)), claude.ask(other, track(2))])

    // Assert
    expect(answers).toEqual([unsorted, unsorted])
    expect(callSizes()).toEqual([1, 1])
    expect(fake.calls()[0]?.input).toContain('House styles: ["House"]')
    expect(fake.calls()[0]?.input).toContain('Other styles: ["Techno"]')
    expect(fake.calls()[1]?.input).toContain('"Trance"')
  })
})

describe('an answer that is not valid', () => {
  it('is asked for once more, with what was wrong, and then counts', async () => {
    // Arrange
    fake.reply(
      { answerEach: GOOD, spoil: [1], spoilWith: { primary: 'Polka'.repeat(10) } },
      { answerEach: GOOD }
    )

    // Act
    const answers = await Promise.all([claude.ask(TASK, track(1)), claude.ask(TASK, track(2))])

    // Assert
    expect(answers).toEqual([GOOD, GOOD])
    expect(fake.calls()).toHaveLength(2)
    expect(fake.calls()[1]?.input).toContain('Your previous answer was not valid')
    expect(fake.calls()[1]?.input).toContain('the item with id 1 has an invalid "primary"')
    // What Claude wrote is not quoted back.
    expect(fake.calls()[1]?.input).not.toContain('PolkaPolka')
  })

  it('fails the track with CLAUDE_FAILED after the second try, and keeps the valid ones', async () => {
    // Arrange
    fake.reply({
      answerEach: GOOD,
      spoil: [1],
      spoilWith: { primary: 'Polka/Folk', confidence: 200 }
    })

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

describe('what the review of the batcher found', () => {
  it('keeps the valid answers of the first try when the second one mends the rest', async () => {
    // Arrange: the second try answers only the id that was wrong.
    fake.reply(
      { answerEach: GOOD, spoil: [2], spoilWith: { primary: 'Polka'.repeat(10) } },
      { answerEach: GOOD, leaveOut: [1, 3] }
    )

    // Act
    const answers = await settle([1, 2, 3].map((number) => claude.ask(TASK, track(number))))

    // Assert
    expect(answers).toEqual([GOOD, GOOD, GOOD])
    expect(fake.calls()).toHaveLength(2)
  })

  it('does not ask again because of an entry for an id nobody asked about', async () => {
    // Arrange
    fake.reply({
      stream: answerStream({
        items: [
          { id: 1, ...GOOD },
          { id: 1, ...GOOD },
          { id: 99, ...GOOD },
          { id: 7, ...GOOD, primary: 'Polka'.repeat(10) }
        ]
      })
    })

    // Act
    const answers = await settle([claude.ask(TASK, track(1))])

    // Assert
    expect(answers).toEqual([GOOD])
    expect(fake.calls()).toHaveLength(1)
  })

  it('makes no further call once the limit was reached, also for what was lined up before', async () => {
    // Arrange
    fake.reply({ stream: limitStream() })

    // Act: 45 at once are three calls in line; only the first is made.
    const answers = await settle(
      Array.from({ length: 45 }, (_, index) => claude.ask(TASK, track(index + 1)))
    )

    // Assert
    expect(new Set(answers)).toEqual(new Set(['CLAUDE_LIMIT']))
    expect(fake.calls()).toHaveLength(1)
    expect(limits).toHaveLength(1)
  })

  it('makes a call that is asked for directly take its turn with the gathered ones', async () => {
    // Arrange
    fake.reply({ answerEach: GOOD })

    // Act: the gathered item still waits for company when the direct call is asked for.
    const asked = claude.ask(TASK, track(1))
    const batch = claude.askBatch(TASK, [{ id: 1, ...track(2) }])
    await Promise.all([asked, batch])

    // Assert: two calls, one after the other, each in a folder that was empty.
    expect(fake.calls().map((call) => call.input.includes('Title 2'))).toEqual([true, false])
    expect(fake.calls().every((call) => call.cwdEntries.length === 0)).toBe(true)
  })

  it('stops the running call and hands everything back when the app quits', async () => {
    // Arrange
    fake.reply({ hang: true })
    const asking = settle(
      Array.from({ length: 25 }, (_, index) => claude.ask(TASK, track(index + 1)))
    )
    await vi.waitFor(() => expect(fake.calls()).toHaveLength(1))
    const started = Date.now()

    // Act
    claude.stop()
    const answers = await asking

    // Assert
    expect(Date.now() - started).toBeLessThan(5000)
    expect(answers.every((answer) => typeof answer === 'string')).toBe(true)
  })

  it('stops a call that nobody waits for any more', async () => {
    // Arrange
    fake.reply({ hang: true })
    const withdrawn = new AbortController()
    const asking = settle([claude.ask(TASK, track(1), withdrawn.signal)])
    await vi.waitFor(() => expect(fake.calls()).toHaveLength(1))
    const started = Date.now()

    // Act
    withdrawn.abort()
    const answers = await asking

    // Assert
    expect(answers).toEqual(['CLAUDE_FAILED'])
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('asks for the status again after a call found the command unusable', async () => {
    // Arrange
    await claude.status(true)
    fake.setLoggedIn(false)
    fake.reply({ stream: [{ type: 'result', is_error: true, result: 'not logged in' }] })
    await settle([claude.ask(TASK, track(1))])

    // Act: not forced, as the Settings page asks when it opens.
    const status = await claude.status(false)

    // Assert
    expect(status).toMatchObject({ ok: false, reason: 'notLoggedIn' })
  })

  it('takes a program for the command by what it says, whatever its file is called', async () => {
    // Arrange: the dialog may hand back what the link points to.
    const versioned = join(folder, 'versions', '2.1.296')
    mkdirSync(join(folder, 'versions'))
    copyFileSync(fake.path, versioned)
    copyFileSync(join(folder, 'bin', 'state.json'), join(folder, 'versions', 'state.json'))
    chmodSync(versioned, 0o755)

    // Act
    const chosen = await claude.choosePath(versioned)

    // Assert
    expect(chosen).toMatchObject({ ok: true, value: { ok: true, version: '2.1.296' } })
  })

  it('writes an @ in a tag as an escape, so that the tool attaches no file for it', () => {
    // Act
    const prompt = TASK.prompt([{ id: 1, ...track(1), title: 'Intro @/etc/passwd mix' }])

    // Assert
    expect(prompt).not.toContain('@')
    expect(prompt).toContain('Intro \\u0040/etc/passwd mix')
  })
})
