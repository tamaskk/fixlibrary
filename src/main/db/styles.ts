import { asc, eq, inArray, or } from 'drizzle-orm'
import { AppError } from '@shared/errors'
import {
  MAX_STYLES,
  newStyleNameSchema,
  styleInputSchema,
  styleKey,
  UNSORTED_STYLE_NAME,
  type Style,
  type StyleInput
} from '@shared/settings'
import type { AppDatabase } from './connection'
import { styles, tracks } from './schema'

export function listStyles(db: AppDatabase): Style[] {
  return db
    .select({ id: styles.id, name: styles.name, color: styles.color, isHouse: styles.isHouse })
    .from(styles)
    .orderBy(asc(styles.sortOrder), asc(styles.id))
    .all()
}

/**
 * Makes the stored list equal to `list`, in that order: rows with an id are updated,
 * rows without one are created, stored rows that are not in the list are deleted.
 * All of it or none. Throws STYLE_IN_USE instead of deleting a style that a track has,
 * because the delete would silently clear the style of those tracks.
 */
export function replaceStyles(db: AppDatabase, list: readonly StyleInput[]): Style[] {
  return db.transaction((tx) => {
    const stored = tx.select({ id: styles.id, name: styles.name }).from(styles).all()
    const storedIds = stored.map((row) => row.id)
    // Unsorted is one fixed row: it cannot be renamed, nor replaced by a new row of that name.
    const unsorted = stored.find((row) => row.name === UNSORTED_STYLE_NAME)
    if (
      unsorted &&
      !list.some((style) => style.id === unsorted.id && style.name === unsorted.name)
    ) {
      throw new AppError('INVALID_INPUT', `${UNSORTED_STYLE_NAME} must stay in the list unchanged`)
    }
    const keptIds = new Set(list.flatMap((style) => (style.id === undefined ? [] : [style.id])))
    if ([...keptIds].some((id) => !storedIds.includes(id))) {
      throw new AppError('INVALID_INPUT', 'The list names a style that does not exist')
    }

    const removedIds = storedIds.filter((id) => !keptIds.has(id))
    if (removedIds.length > 0) {
      const inUse = tx
        .select({ id: tracks.id })
        .from(tracks)
        .where(
          or(
            inArray(tracks.primaryStyleId, removedIds),
            inArray(tracks.secondaryStyleId, removedIds)
          )
        )
        .limit(1)
        .get()
      if (inUse) throw new AppError('STYLE_IN_USE', 'A track still uses a style that was removed')
      tx.delete(styles).where(inArray(styles.id, removedIds)).run()
    }

    // Names are unique, and two styles may swap names in one save: park the kept
    // rows on names no input can have (":" is not allowed in a style name) first.
    for (const id of keptIds) {
      tx.update(styles)
        .set({ name: `:${id}` })
        .where(eq(styles.id, id))
        .run()
    }
    list.forEach((style, sortOrder) => {
      const values = { name: style.name, color: style.color, isHouse: style.isHouse, sortOrder }
      if (style.id === undefined) {
        tx.insert(styles).values(values).run()
      } else {
        tx.update(styles).set(values).where(eq(styles.id, style.id)).run()
      }
    })
    return listStyles(tx)
  })
}

/**
 * Adds one style, as the last before Unsorted, and returns it; or returns the style
 * that has the name already, case, spaces and hyphens aside. For a style the app
 * names (a new style of the classification), never a house style. Null when the
 * list holds as many styles as it may.
 */
export function addStyle(db: AppDatabase, name: string, color: string): Style | null {
  const checked = styleInputSchema.parse({
    name: newStyleNameSchema.parse(name),
    color,
    isHouse: false
  })
  return db.transaction((tx) => {
    const stored = listStyles(tx)
    const same = stored.find((style) => styleKey(style.name) === styleKey(checked.name))
    if (same) return same
    // The list is full: the track stays without, rather than the list outgrow what
    // Settings can save.
    if (stored.length >= MAX_STYLES) return null
    const orders = tx.select({ name: styles.name, sortOrder: styles.sortOrder }).from(styles).all()
    const unsorted = orders.find((style) => style.name === UNSORTED_STYLE_NAME)
    const last = Math.max(-1, ...orders.map((style) => style.sortOrder))
    const sortOrder = unsorted ? unsorted.sortOrder : last + 1
    // Unsorted stays the last of the list.
    if (unsorted) {
      tx.update(styles)
        .set({ sortOrder: last + 1 })
        .where(eq(styles.name, UNSORTED_STYLE_NAME))
        .run()
    }
    tx.insert(styles)
      .values({ ...checked, sortOrder })
      .run()
    const added = listStyles(tx).find((style) => style.name === checked.name)
    if (!added) throw new Error('the style was not added')
    return added
  })
}
