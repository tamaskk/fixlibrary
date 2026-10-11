import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppDatabase } from './connection'
import { settings } from './schema'

// Secrets never go through this module: they are stored only as safeStorage-encrypted
// values, by the keychain service (T-006). The prefix is reserved so a plain write fails.
export const SECRET_KEY_PREFIX = 'secret.'

/** Reads a setting and validates it. Throws if the stored value does not fit the schema. */
export function getSetting<T>(db: AppDatabase, key: string, schema: z.ZodType<T>): T | undefined {
  const row = db.select().from(settings).where(eq(settings.key, key)).get()
  return row === undefined ? undefined : schema.parse(row.value)
}

export function setSetting(db: AppDatabase, key: string, value: unknown): void {
  if (key.startsWith(SECRET_KEY_PREFIX)) {
    throw new Error('Secrets are not stored through setSetting')
  }
  const updatedAt = new Date()
  db.insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
    .run()
}

declare const encryptedSecretBrand: unique symbol

/** Ciphertext from the keychain service, base64 encoded. Never a plain value. */
export type EncryptedSecret = string & { readonly [encryptedSecretBrand]: true }

const encryptedSecretSchema = z.string().min(1)

/** The only write path under the reserved prefix; its type keeps plain text out. */
export function setEncryptedSecret(db: AppDatabase, name: string, value: EncryptedSecret): void {
  const key = SECRET_KEY_PREFIX + name
  const updatedAt = new Date()
  db.insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
    .run()
}

export function getEncryptedSecret(db: AppDatabase, name: string): EncryptedSecret | undefined {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, SECRET_KEY_PREFIX + name))
    .get()
  return row === undefined ? undefined : (encryptedSecretSchema.parse(row.value) as EncryptedSecret)
}

export function deleteEncryptedSecret(db: AppDatabase, name: string): void {
  db.delete(settings)
    .where(eq(settings.key, SECRET_KEY_PREFIX + name))
    .run()
}
