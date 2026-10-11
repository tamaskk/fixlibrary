import { eq } from 'drizzle-orm'
import type { z } from 'zod'
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
