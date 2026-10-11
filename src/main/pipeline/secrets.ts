// Where the lookup API keys live: encrypted in the settings table, with the
// developer's .env.local as a fallback outside the packaged app.
import { z } from 'zod'
import type { AppDatabase } from '../db/connection'
import {
  deleteEncryptedSecret,
  getEncryptedSecret,
  setEncryptedSecret,
  type EncryptedSecret
} from '../db/settings'
import type { SecretCipher } from '../services/keychain'
import {
  checkAcoustIdKey,
  checkDiscogsKey,
  type KeyCheckOptions
} from '../services/lookup/key-check'
import type { Result } from '@shared/errors'
import {
  KEY_SERVICES,
  secretInputSchema,
  SECRET_NAMES,
  type KeyService,
  type KeyTestResult,
  type SecretName,
  type SecretSource,
  type SecretStatus
} from '@shared/settings'

export const SECRET_ENV_NAMES: Record<SecretName, string> = {
  acoustid: 'ACOUSTID_API_KEY',
  discogsKey: 'DISCOGS_CONSUMER_KEY',
  discogsSecret: 'DISCOGS_CONSUMER_SECRET'
}

const SERVICE_OF_SECRET: Record<SecretName, KeyService> = {
  acoustid: 'acoustid',
  discogsKey: 'discogs',
  discogsSecret: 'discogs'
}

// A key test is a real request made with the owner's key, so a page cannot fire them
// at will: one at a time per service, and never two requests within this interval.
const MIN_TEST_INTERVAL_MS = 5000

const secretValueSchema = secretInputSchema.shape.value
// What is encrypted. The name travels with the value, so a ciphertext moved to
// another row in the database is not accepted as that row's secret.
const storedSecretSchema = z.object({ name: z.enum(SECRET_NAMES), value: secretValueSchema })

/** Keeps only the variables that are API keys; the rest of an env file is not held on to. */
export function pickSecretEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const names = Object.values(SECRET_ENV_NAMES)
  return Object.fromEntries(Object.entries(env).filter(([name]) => names.includes(name)))
}

export interface SecretStoreOptions {
  db: AppDatabase
  cipher: SecretCipher
  /** Values of the development env file. Pass an empty object in the packaged app. */
  devEnv: Readonly<Record<string, string>>
  keyCheck: KeyCheckOptions
  now?: () => number
}

export interface SecretStore {
  /** The plain value, for use inside the main process only. */
  read: (name: SecretName) => string | undefined
  status: () => SecretStatus
  save: (input: unknown) => Result<SecretStatus>
  clear: (name: SecretName) => SecretStatus
  test: (service: KeyService) => Promise<KeyTestResult>
}

interface TestState {
  /** Goes up whenever a key of the service changes; a result belongs to one generation. */
  generation: number
  running?: { generation: number; promise: Promise<KeyTestResult> }
  verdict?: { generation: number; result: KeyTestResult }
  /** When the last request left. Nothing a page can do resets this. */
  lastRequestAt?: number
}

export function createSecretStore(options: SecretStoreOptions): SecretStore {
  const { db, cipher, devEnv } = options
  const now = options.now ?? Date.now
  const tests = Object.fromEntries(
    KEY_SERVICES.map((service) => [service, { generation: 0 }])
  ) as Record<KeyService, TestState>

  function decryptStored(name: SecretName): string | undefined {
    try {
      const stored = getEncryptedSecret(db, name)
      if (stored === undefined) return undefined
      // A value decrypted with the wrong key is usually an error, but can also come
      // out as noise; either way it is not a usable key.
      const secret = storedSecretSchema.parse(
        JSON.parse(cipher.decrypt(Buffer.from(stored, 'base64')))
      )
      return secret.name === name ? secret.value : undefined
    } catch {
      return undefined
    }
  }

  function readStored(name: SecretName): { source: SecretSource; value?: string } {
    let isStored: boolean
    try {
      isStored = getEncryptedSecret(db, name) !== undefined
    } catch {
      // The row exists but is not a ciphertext.
      isStored = true
    }
    if (isStored) {
      const value = decryptStored(name)
      // Typically a Keychain item that belongs to another build of the app.
      return value === undefined ? { source: 'unreadable' } : { source: 'stored', value }
    }
    const fromEnv = secretValueSchema.safeParse(devEnv[SECRET_ENV_NAMES[name]])
    return fromEnv.success ? { source: 'env', value: fromEnv.data } : { source: 'missing' }
  }

  function status(): SecretStatus {
    const entries = SECRET_NAMES.map((name) => [name, readStored(name).source] as const)
    return Object.fromEntries(entries) as SecretStatus
  }

  /** The keys of a service, or null if one is missing. */
  function keysFor(service: KeyService): string[] | null {
    const names: SecretName[] =
      service === 'acoustid' ? ['acoustid'] : ['discogsKey', 'discogsSecret']
    const values = names.map((name) => readStored(name).value)
    return values.every((value) => value !== undefined) ? (values as string[]) : null
  }

  function request(service: KeyService, keys: string[]): Promise<KeyTestResult> {
    const [key = '', secret = ''] = keys
    return service === 'acoustid'
      ? checkAcoustIdKey(key, options.keyCheck)
      : checkDiscogsKey(key, secret, options.keyCheck)
  }

  /** A test that ran, or still runs, with the old key says nothing about the new one. */
  function keyChanged(name: SecretName): void {
    tests[SERVICE_OF_SECRET[name]].generation += 1
  }

  return {
    read: (name) => readStored(name).value,
    status,

    save(input) {
      const parsed = secretInputSchema.safeParse(input)
      if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
      // No plain-text fallback: without the Keychain the key is not stored at all.
      if (!cipher.isAvailable()) return { ok: false, code: 'SECRET_STORAGE_UNAVAILABLE' }

      let cipherText: EncryptedSecret
      try {
        cipherText = cipher
          .encrypt(JSON.stringify(parsed.data))
          .toString('base64') as EncryptedSecret
      } catch {
        return { ok: false, code: 'SECRET_STORAGE_UNAVAILABLE' }
      }
      setEncryptedSecret(db, parsed.data.name, cipherText)
      keyChanged(parsed.data.name)
      return { ok: true, value: status() }
    },

    clear(name) {
      deleteEncryptedSecret(db, name)
      keyChanged(name)
      return status()
    },

    test(service) {
      const state = tests[service]
      const { generation } = state
      if (state.running?.generation === generation) return state.running.promise

      const keys = keysFor(service)
      // A missing key costs no request, so it is answered at once.
      if (keys === null) return Promise.resolve('missing')

      if (state.lastRequestAt !== undefined && now() - state.lastRequestAt < MIN_TEST_INTERVAL_MS) {
        // Too soon for another request: the answer for these same keys if there is
        // one, and otherwise an honest "not asked".
        return Promise.resolve(
          state.verdict?.generation === generation ? state.verdict.result : 'throttled'
        )
      }

      state.lastRequestAt = now()
      const promise = request(service, keys)
        .then((result) => {
          // The key may have changed while the request was under way.
          if (state.generation === generation) state.verdict = { generation, result }
          return result
        })
        .finally(() => {
          if (state.running?.promise === promise) delete state.running
        })
      state.running = { generation, promise }
      return promise
    }
  }
}
