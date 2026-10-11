import { readFileSync } from 'fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { settings } from '../db/schema'
import { getSetting } from '../db/settings'
import type { SecretCipher } from '../services/keychain'
import { z } from 'zod'
import { createSecretStore, pickSecretEnv, type SecretStore } from './secrets'

const KEY = 'acoustid-key-1234567890'

// Stands in for the Keychain: reversible, and the output shares no substring with the input.
const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 0x5a)),
  decrypt: (data) => Buffer.from(data.map((byte) => byte ^ 0x5a)).toString()
}

let testDatabase: TestDatabase

function store(
  overrides: {
    cipher?: SecretCipher
    devEnv?: Record<string, string>
    fetch?: typeof fetch
    now?: () => number
  } = {}
): SecretStore {
  return createSecretStore({
    db: testDatabase.db,
    cipher: overrides.cipher ?? fakeCipher,
    devEnv: overrides.devEnv ?? {},
    now: overrides.now,
    keyCheck: {
      userAgent: 'FixLibrary/test',
      fetch:
        overrides.fetch ??
        (() => {
          throw new Error('no network in unit tests')
        })
    }
  })
}

beforeEach(() => {
  testDatabase = createTestDatabase()
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('secret store', () => {
  it('reports every key as missing on a fresh database', () => {
    // Act
    const status = store().status()

    // Assert
    expect(status).toEqual({ acoustid: 'missing', discogsKey: 'missing', discogsSecret: 'missing' })
  })

  it('keeps a saved key after a restart', () => {
    // Arrange
    store().save({ name: 'acoustid', value: KEY })

    // Act
    testDatabase.reopen()
    const afterRestart = store()

    // Assert
    expect(afterRestart.status().acoustid).toBe('stored')
    expect(afterRestart.read('acoustid')).toBe(KEY)
  })

  it('never writes the key as plain text into the database files', () => {
    // Arrange
    store().save({ name: 'acoustid', value: KEY })
    testDatabase.reopen()

    // Act
    const files = ['', '-wal'].map((suffix) => {
      try {
        return readFileSync(testDatabase.filePath + suffix).toString('latin1')
      } catch {
        return ''
      }
    })

    // Assert
    expect(files.join('').length).toBeGreaterThan(0)
    expect(files.some((content) => content.includes(KEY))).toBe(false)
    expect(files.some((content) => content.includes(Buffer.from(KEY).toString('base64')))).toBe(
      false
    )
  })

  it('stores nothing, not even plain text, when encryption is unavailable', () => {
    // Arrange
    const unavailable = { ...fakeCipher, isAvailable: () => false }

    // Act
    const result = store({ cipher: unavailable }).save({ name: 'acoustid', value: KEY })

    // Assert
    expect(result).toEqual({ ok: false, code: 'SECRET_STORAGE_UNAVAILABLE' })
    expect(getSetting(testDatabase.db, 'secret.acoustid', z.unknown())).toBeUndefined()
  })

  it.each([
    ['an unknown secret name', { name: 'github', value: KEY }],
    ['an empty value', { name: 'acoustid', value: '   ' }],
    ['a value with a space', { name: 'acoustid', value: 'two words' }]
  ])('refuses %s', (_name, input) => {
    // Act
    const result = store().save(input)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('uses the development env file only while nothing is stored', () => {
    // Arrange
    const devEnv = { ACOUSTID_API_KEY: 'from-env-file', DISCOGS_CONSUMER_KEY: 'discogs-env' }
    const secrets = store({ devEnv })

    // Act
    const before = { status: secrets.status(), value: secrets.read('acoustid') }
    secrets.save({ name: 'acoustid', value: KEY })
    const after = { status: secrets.status(), value: secrets.read('acoustid') }

    // Assert
    expect(before.status).toEqual({ acoustid: 'env', discogsKey: 'env', discogsSecret: 'missing' })
    expect(before.value).toBe('from-env-file')
    expect(after.status.acoustid).toBe('stored')
    expect(after.value).toBe(KEY)
  })

  it('ignores env values when it is given none, as in the packaged app', () => {
    // Act
    const secrets = store({ devEnv: {} })

    // Assert
    expect(secrets.status().acoustid).toBe('missing')
    expect(secrets.read('acoustid')).toBeUndefined()
  })

  it('reports a stored key that cannot be decrypted, and does not fall back to the env file', () => {
    // Arrange
    store().save({ name: 'acoustid', value: KEY })
    const otherBuild: SecretCipher = {
      ...fakeCipher,
      decrypt: () => {
        throw new Error('Error while decrypting the ciphertext')
      }
    }

    // Act
    const secrets = store({ cipher: otherBuild, devEnv: { ACOUSTID_API_KEY: 'from-env-file' } })

    // Assert
    expect(secrets.status().acoustid).toBe('unreadable')
    expect(secrets.read('acoustid')).toBeUndefined()
  })

  it('removes a key on request', () => {
    // Arrange
    const secrets = store()
    secrets.save({ name: 'acoustid', value: KEY })

    // Act
    const status = secrets.clear('acoustid')

    // Assert
    expect(status.acoustid).toBe('missing')
    expect(secrets.read('acoustid')).toBeUndefined()
  })
})

describe('values that cannot be trusted', () => {
  it('reports a key that decrypts to noise as unreadable', () => {
    // Arrange
    store().save({ name: 'acoustid', value: KEY })
    const wrongKey: SecretCipher = { ...fakeCipher, decrypt: () => 'not a key \u0000\u0001' }

    // Act
    const secrets = store({ cipher: wrongKey })

    // Assert
    expect(secrets.status().acoustid).toBe('unreadable')
    expect(secrets.read('acoustid')).toBeUndefined()
  })

  it('reports a stored row that is not a ciphertext as unreadable, and can clear it', () => {
    // Arrange
    testDatabase.db
      .insert(settings)
      .values({ key: 'secret.acoustid', value: { broken: true }, updatedAt: new Date() })
      .run()
    const secrets = store()

    // Act
    const before = secrets.status().acoustid
    const after = secrets.clear('acoustid').acoustid

    // Assert
    expect(before).toBe('unreadable')
    expect(after).toBe('missing')
  })

  it('does not accept a ciphertext that was moved to the row of another key', () => {
    // Arrange
    store().save({ name: 'discogsSecret', value: 'the-discogs-secret' })
    const [moved] = testDatabase.db.select().from(settings).all()
    testDatabase.db
      .insert(settings)
      .values({ key: 'secret.acoustid', value: moved?.value, updatedAt: new Date() })
      .run()

    // Act
    const secrets = store()

    // Assert
    expect(secrets.status().acoustid).toBe('unreadable')
    expect(secrets.read('acoustid')).toBeUndefined()
    expect(secrets.read('discogsSecret')).toBe('the-discogs-secret')
  })

  it('stores nothing when the Keychain fails while encrypting', () => {
    // Arrange
    const failing: SecretCipher = {
      ...fakeCipher,
      encrypt: () => {
        throw new Error('Error while encrypting the text')
      }
    }

    // Act
    const result = store({ cipher: failing }).save({ name: 'acoustid', value: KEY })

    // Assert
    expect(result).toEqual({ ok: false, code: 'SECRET_STORAGE_UNAVAILABLE' })
    expect(store().status().acoustid).toBe('missing')
  })

  it('ignores an env value that cannot be a key', () => {
    // Act
    const secrets = store({ devEnv: { ACOUSTID_API_KEY: 'two words' } })

    // Assert
    expect(secrets.status().acoustid).toBe('missing')
  })

  it('keeps only the API keys of an env file', () => {
    // Arrange
    const env = { ACOUSTID_API_KEY: 'a', GITHUB_PAT: 'b', DISCOGS_CONSUMER_SECRET: 'c' }

    // Act
    const kept = pickSecretEnv(env)

    // Assert
    expect(kept).toEqual({ ACOUSTID_API_KEY: 'a', DISCOGS_CONSUMER_SECRET: 'c' })
  })
})

describe('testing a key', () => {
  it('asks the service once for overlapping and repeated tests, until five seconds pass', async () => {
    // Arrange
    let requests = 0
    let clock = 0
    const counting = (async () => {
      requests += 1
      return new Response('{"status":"ok","results":[]}', { status: 200 })
    }) as typeof fetch
    const secrets = store({ fetch: counting, now: () => clock })
    secrets.save({ name: 'acoustid', value: KEY })

    // Act
    const results = await Promise.all([secrets.test('acoustid'), secrets.test('acoustid')])
    clock = 4000
    results.push(await secrets.test('acoustid'))
    const requestsTooSoon = requests
    clock = 6000
    await secrets.test('acoustid')

    // Assert
    expect(results).toEqual(['valid', 'valid', 'valid'])
    expect(requestsTooSoon).toBe(1)
    expect(requests).toBe(2)
  })

  it('does not let saving or deleting keys reset the limit', async () => {
    // Arrange
    let requests = 0
    const counting = (async () => {
      requests += 1
      return new Response('{"status":"ok","results":[]}', { status: 200 })
    }) as typeof fetch
    const secrets = store({ fetch: counting, now: () => 0 })
    secrets.save({ name: 'acoustid', value: KEY })
    await secrets.test('acoustid')

    // Act
    const results: string[] = []
    for (let round = 0; round < 5; round += 1) {
      secrets.clear('discogsSecret')
      secrets.save({ name: 'acoustid', value: `other-key-${round}` })
      results.push(await secrets.test('acoustid'))
    }

    // Assert
    expect(requests).toBe(1)
    expect(results).toEqual(['throttled', 'throttled', 'throttled', 'throttled', 'throttled'])
  })

  it('tests a replaced key afresh once the interval has passed', async () => {
    // Arrange
    let clock = 0
    const sentKeys: string[] = []
    const recording = (async (_url: unknown, init?: RequestInit) => {
      sentKeys.push(new URLSearchParams(String(init?.body)).get('client') ?? '')
      return new Response('{"status":"ok","results":[]}', { status: 200 })
    }) as typeof fetch
    const secrets = store({ fetch: recording, now: () => clock })
    secrets.save({ name: 'acoustid', value: KEY })
    await secrets.test('acoustid')

    // Act
    secrets.save({ name: 'acoustid', value: 'another-key' })
    clock = 6000
    const result = await secrets.test('acoustid')

    // Assert
    expect(result).toBe('valid')
    expect(sentKeys).toEqual([KEY, 'another-key'])
  })

  it('never reports the result of a test that was still running when the key changed', async () => {
    // Arrange
    let clock = 0
    let answerOldKey: (response: Response) => void = () => {}
    const slowThenInvalid = (async (_url: unknown, init?: RequestInit) => {
      if (new URLSearchParams(String(init?.body)).get('client') === KEY) {
        return new Promise<Response>((resolve) => {
          answerOldKey = resolve
        })
      }
      return new Response('{"status":"error","error":{"code":4}}', { status: 400 })
    }) as typeof fetch
    const secrets = store({ fetch: slowThenInvalid, now: () => clock })
    secrets.save({ name: 'acoustid', value: KEY })
    const oldTest = secrets.test('acoustid')

    // Act
    secrets.save({ name: 'acoustid', value: 'wrong-new-key' })
    const whileOldRuns = await secrets.test('acoustid')
    answerOldKey(new Response('{"status":"ok","results":[]}', { status: 200 }))
    const oldResult = await oldTest
    const rightAfter = await secrets.test('acoustid')
    clock = 6000
    const afterInterval = await secrets.test('acoustid')

    // Assert
    expect(oldResult).toBe('valid')
    expect(whileOldRuns).toBe('throttled')
    expect(rightAfter).toBe('throttled')
    expect(afterInterval).toBe('invalid')
  })

  it('reports a missing key without asking the service', async () => {
    // Act
    const acoustid = await store().test('acoustid')
    const discogs = await store({ devEnv: { DISCOGS_CONSUMER_KEY: 'only-the-key' } }).test(
      'discogs'
    )

    // Assert
    expect([acoustid, discogs]).toEqual(['missing', 'missing'])
  })

  it('sends the stored Discogs key and secret together', async () => {
    // Arrange
    let authorization: string | undefined
    const fetchStub = (async (_url: unknown, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('Authorization') ?? undefined
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const secrets = store({ fetch: fetchStub })
    secrets.save({ name: 'discogsKey', value: 'the-key' })
    secrets.save({ name: 'discogsSecret', value: 'the-secret' })

    // Act
    const result = await secrets.test('discogs')

    // Assert
    expect(result).toBe('valid')
    expect(authorization).toBe('Discogs key=the-key, secret=the-secret')
  })
})
