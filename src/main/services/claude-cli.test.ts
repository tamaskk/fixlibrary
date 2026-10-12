import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClaudeCli, type ClaudeCli } from './claude-cli'
import {
  answerStream,
  createFakeClaude,
  limitStream,
  type FakeClaude
} from './claude-cli.test-util'
import { logger } from './logger'

const SCHEMA = { type: 'object', properties: { items: { type: 'array' } } }
const REQUEST = { prompt: 'classify these', systemPrompt: 'You classify.', jsonSchema: SCHEMA }

let folder: string
let workDir: string
let fake: FakeClaude
let cli: ClaudeCli

/** A shell that "finds" whatever the test tells it to, in the place of a login shell. */
function shellThatPrints(...lines: string[]): string {
  const path = join(folder, 'fake-shell')
  writeFileSync(path, `#!/bin/sh\n${lines.map((line) => `echo '${line}'`).join('\n')}\n`)
  chmodSync(path, 0o755)
  return path
}

function cliWith(shellPath?: string): ClaudeCli {
  return createClaudeCli({ workDir, homeDir: join(folder, 'home'), userName: 'dj', shellPath })
}

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-claude-')))
  workDir = join(folder, 'claude-workdir')
  mkdirSync(join(folder, 'home'))
  fake = createFakeClaude(folder)
  cli = cliWith()
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('finding the command', () => {
  it('takes the path the login shell names, whatever else a profile prints', async () => {
    // Arrange
    const shell = shellThatPrints('Welcome back', fake.path)

    // Act
    const found = await cliWith(shell).locate()

    // Assert
    expect(found).toBe(fake.path)
  })

  it('falls back to where the command is usually installed', async () => {
    // Arrange
    const usual = join(folder, 'home', '.local', 'bin')
    mkdirSync(usual, { recursive: true })
    symlinkSync(fake.path, join(usual, 'claude'))
    const shell = shellThatPrints('claude not found')

    // Act
    const found = await cliWith(shell).locate()

    // Assert
    expect(found).toBe(join(usual, 'claude'))
  })

  it.each([
    ['an alias', 'alias claude=/usr/local/bin/other'],
    ['a file that is not there', '/nowhere/claude'],
    ['a command of another name', '/bin/ls']
  ])('does not take %s for the command', async (_what, printed) => {
    // Arrange
    const shell = shellThatPrints(printed)

    // Act
    const found = await cliWith(shell).locate()

    // Assert
    expect(found).toBeNull()
  })

  it('knows a file that cannot be run from the command', async () => {
    // Arrange
    const plain = join(folder, 'plain', 'claude')
    mkdirSync(join(folder, 'plain'))
    writeFileSync(plain, 'not a program')

    // Act
    const usable = [
      await cli.isUsable(fake.path),
      await cli.isUsable(plain),
      await cli.isUsable('claude')
    ]

    // Assert
    expect(usable).toEqual([true, false, false])
  })
})

describe('checking the command', () => {
  it('tells the version and the kind of subscription, and nothing of the account', async () => {
    // Act
    const check = await cli.check(fake.path)

    // Assert
    expect(check).toEqual({ ok: true, version: '2.1.296', subscription: 'max' })
    expect(JSON.stringify(check)).not.toContain('example.com')
  })

  it('says so when nobody is logged in, with the version it found', async () => {
    // Arrange
    fake.setLoggedIn(false)

    // Act
    const check = await cli.check(fake.path)

    // Assert
    expect(check).toEqual({ ok: false, reason: 'notLoggedIn', version: '2.1.296' })
  })

  it('fails for a path that is no command', async () => {
    // Act
    const check = await cli.check(join(folder, 'nowhere', 'claude'))

    // Assert
    expect(check).toEqual({ ok: false, reason: 'failed', version: null })
  })
})

describe('one call', () => {
  it('returns what Claude answered in the structured output of the result', async () => {
    // Arrange
    fake.reply({ stream: answerStream({ items: [{ id: 1, style: 'House' }] }) })

    // Act
    const outcome = await cli.run(fake.path, REQUEST)

    // Assert
    expect(outcome).toEqual({ kind: 'answer', structured: { items: [{ id: 1, style: 'House' }] } })
  })

  it('passes exactly the options that keep tools, MCP servers, settings and skills out', async () => {
    // Arrange
    fake.reply({ stream: answerStream({}) })

    // Act
    await cli.run(fake.path, REQUEST)

    // Assert
    expect(fake.calls()[0]?.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(SCHEMA),
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--system-prompt',
      'You classify.'
    ])
    expect(fake.calls()[0]?.args).not.toContain('--bare')
    expect(fake.calls()[0]?.input).toBe('classify these')
  })

  it('runs in a new, empty folder of the app, and leaves none behind', async () => {
    // Arrange
    fake.reply({ stream: answerStream({}) })

    // Act
    await cli.run(fake.path, REQUEST)
    await cli.run(fake.path, REQUEST)

    // Assert
    const [first, second] = fake.calls()
    expect(first?.cwd.startsWith(workDir)).toBe(true)
    expect(first?.cwd).not.toBe(second?.cwd)
    expect(first?.cwdEntries).toEqual([])
    expect(readdirSync(workDir)).toEqual([])
  })

  it("hands the process no API key and nothing else of the app's environment", async () => {
    // Arrange
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-should-not-leak')
    vi.stubEnv('DISCOGS_TOKEN', 'also-not')
    fake.reply({ stream: answerStream({}) })

    // Act
    await cli.run(fake.path, REQUEST)

    // Assert
    const env = fake.calls()[0]?.env ?? {}
    expect(
      Object.keys(env)
        .filter((name) => !name.startsWith('__'))
        .sort()
    ).toEqual(['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER'])
    expect(env['HOME']).toBe(join(folder, 'home'))
  })

  it('reports the usage limit, with the time it is said to end', async () => {
    // Arrange
    fake.reply({ stream: limitStream(1_800_000_000) })

    // Act
    const outcome = await cli.run(fake.path, REQUEST)

    // Assert
    expect(outcome).toEqual({ kind: 'limit', resetsAt: 1_800_000_000_000 })
  })

  it('knows an option the installed command does not know', async () => {
    // Arrange
    fake.reply({ unknownOption: '--json-schema' })

    // Act
    const outcome = await cli.run(fake.path, REQUEST)

    // Assert
    expect(outcome).toEqual({ kind: 'outdated' })
  })

  it('throws away the answer of a call that started with a tool or an MCP server', async () => {
    // Arrange
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const withTool = answerStream({ items: [] })
    withTool[0] = {
      type: 'system',
      subtype: 'init',
      tools: ['StructuredOutput', 'Bash'],
      mcp_servers: []
    }
    const withServer = answerStream({ items: [] })
    withServer[0] = { type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'x' }] }
    fake.reply({ stream: withTool }, { stream: withServer })

    // Act
    const outcomes = [await cli.run(fake.path, REQUEST), await cli.run(fake.path, REQUEST)]

    // Assert
    expect(outcomes).toEqual([{ kind: 'failed' }, { kind: 'failed' }])
  })

  it.each([
    [
      'a stream without a result',
      [{ type: 'system', subtype: 'init', tools: [], mcp_servers: [] }]
    ],
    ['a result that is an error', [{ type: 'result', is_error: true, result: 'boom' }]],
    ['a result without structured output', [{ type: 'result', is_error: false, result: 'text' }]],
    ['lines that are not JSON', ['not json at all']]
  ])('fails for %s', async (_what, stream) => {
    // Arrange
    fake.reply({ stream })

    // Act
    const outcome = await cli.run(fake.path, REQUEST)

    // Assert
    expect(outcome).toEqual({ kind: 'failed' })
  })

  it('gives up after its time, and stops the process', async () => {
    // Arrange
    fake.reply({ hang: true })

    // Act
    const outcome = await cli.run(fake.path, { ...REQUEST, timeoutMs: 300 })

    // Assert
    expect(outcome).toEqual({ kind: 'timeout' })
  })

  it('stops when it is told to', async () => {
    // Arrange
    fake.reply({ hang: true })
    const stop = new AbortController()

    // Act
    const running = cli.run(fake.path, { ...REQUEST, signal: stop.signal })
    setTimeout(() => stop.abort(), 200)
    const outcome = await running

    // Assert
    expect(outcome).toEqual({ kind: 'failed' })
  })
})

describe('what the audit of the service found', () => {
  it('takes no answer from a stream that never said it has no tools', async () => {
    // Arrange
    fake.reply({
      stream: [{ type: 'result', is_error: false, structured_output: { items: [] } }]
    })

    // Act
    const outcome = await cli.run(fake.path, REQUEST)

    // Assert
    expect(outcome).toEqual({ kind: 'failed' })
  })

  it('takes the answer of a call that was held up by the limit and answered after all', async () => {
    // Arrange
    const stream = answerStream({ items: [{ id: 1 }] })
    stream.splice(1, 0, { type: 'system', subtype: 'api_retry', error: 'rate_limit', attempt: 1 })
    fake.reply({ stream })

    // Act
    const outcome = await cli.run(fake.path, REQUEST)

    // Assert
    expect(outcome).toEqual({ kind: 'answer', structured: { items: [{ id: 1 }] } })
  })

  it('does not take an error that only mentions a limit for the usage limit', async () => {
    // Arrange
    fake.reply({
      stream: [
        { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
        { type: 'result', is_error: true, result: 'The output token limit was exceeded' }
      ]
    })

    // Act
    const outcome = await cli.run(fake.path, REQUEST)

    // Assert
    expect(outcome).toEqual({ kind: 'failed' })
  })

  it('does not run a path that is no program any more', async () => {
    // Arrange
    fake.reply({ stream: answerStream({}) })
    chmodSync(fake.path, 0o644)

    // Act
    const outcome = await cli.run(fake.path, REQUEST)

    // Assert
    expect(outcome).toEqual({ kind: 'failed' })
    expect(fake.calls()).toEqual([])
  })

  it('does not wait for a background process of the shell profile', async () => {
    // Arrange: the profile leaves something running that keeps the output open.
    const shell = join(folder, 'slow-shell')
    writeFileSync(shell, `#!/bin/sh\nsleep 20 &\necho '${fake.path}'\n`)
    chmodSync(shell, 0o755)
    const started = Date.now()

    // Act
    const found = await cliWith(shell).locate()

    // Assert
    expect(found).toBe(fake.path)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('removes the call folders that a run that was killed left behind, and nothing else', async () => {
    // Arrange
    mkdirSync(join(workDir, 'call-left'), { recursive: true })
    writeFileSync(join(workDir, 'call-left', 'x'), 'x')
    mkdirSync(join(workDir, 'other'))

    // Act
    await cli.cleanUp()

    // Assert
    expect(readdirSync(workDir)).toEqual(['other'])
  })

  it('refuses a working folder that is a link to somewhere else', async () => {
    // Arrange
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const elsewhere = join(folder, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, workDir)
    fake.reply({ stream: answerStream({}) })

    // Act
    const running = cli.run(fake.path, REQUEST)

    // Assert
    await expect(running).rejects.toThrow('not a folder')
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('puts the folder of the command last on the PATH', async () => {
    // Arrange
    fake.reply({ stream: answerStream({}) })

    // Act
    await cli.run(fake.path, REQUEST)

    // Assert
    expect(fake.calls()[0]?.env['PATH']).toBe(
      `/usr/bin:/bin:/usr/sbin:/sbin:${join(folder, 'bin')}`
    )
  })
})
