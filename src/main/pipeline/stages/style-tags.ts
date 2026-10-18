// What the styles of a track are as a batch holds them, and what follows from them:
// the folder the file goes into, and its genre and comment tags (T-022). Pure: the
// names of the styles come from what the organize stage kept of the list.
import { z } from 'zod'
import type { Track } from '../../db/tracks'
import { folderNameOf } from '@shared/file-names'
import type { PreviewField, PreviewValue, Proposal } from '@shared/preview'
import { tagFieldsSchema, type TagFields } from '@shared/rpc'
import { MAX_STYLES, UNSORTED_STYLE_NAME } from '@shared/settings'
import { styleDetailsOf } from './style'

/**
 * What the organize stage keeps next to its proposal: the names of the styles, by id,
 * and whether the batch creates the new style the classification named for the row:
 * the five a batch may create and the room the list has decide that, batch-wide.
 */
export const organizeDetailsSchema = z.object({
  styles: z
    .array(
      z.object({
        id: z.number().int().positive(),
        // Any name the folder can be named by: a style saved before a name had to be
        // usable as a folder's may hold a `/`, and its folder is its name made safe.
        name: z
          .string()
          .min(1)
          .max(60)
          .refine((name) => folderNameOf(name) !== null)
      })
    )
    .max(MAX_STYLES),
  createsNew: z.boolean()
})

export type OrganizeDetails = z.output<typeof organizeDetailsSchema>

/** The organize details a batch item holds, or null when the batch does not organize. */
export function organizeDetailsOf(after: unknown): OrganizeDetails | null {
  const record = z.record(z.string(), z.unknown()).safeParse(after)
  const parsed = organizeDetailsSchema.safeParse(record.data?.['organize'])
  return parsed.success ? parsed.data : null
}

/** A field as the batch holds it for the track: the proposal, unless the track's own value is locked. */
export function fieldOf(
  track: Track,
  proposal: Proposal,
  field: PreviewField,
  own: PreviewValue
): { value: PreviewValue; source: string | null } {
  const proposed = proposal.fields?.[field]
  const locked = track.lockedFields.includes(field) && proposed?.source !== 'manual'
  return proposed === undefined || locked
    ? { value: own, source: null }
    : { value: proposed.value, source: proposed.source }
}

/**
 * The names of the track's styles as the batch holds them: the primary (a style of
 * the list, or a new one the classification named), Unsorted where there is none,
 * and the secondary, or null.
 */
export function styleNamesOf(
  track: Track,
  proposal: Proposal & Record<string, unknown>,
  details: OrganizeDetails
): { primary: string; secondary: string | null } {
  const nameOf = (id: PreviewValue): string | null =>
    typeof id === 'number' ? (details.styles.find((style) => style.id === id)?.name ?? null) : null
  const primary = fieldOf(track, proposal, 'styleId', track.primaryStyleId)
  // A new style the batch does not create leaves the track Unsorted, as the commit does.
  const newName =
    primary.value === null && primary.source === 'claude' && details.createsNew
      ? (styleDetailsOf(proposal)?.newPrimary ?? null)
      : null
  const secondary = fieldOf(track, proposal, 'secondaryStyleId', track.secondaryStyleId)
  const primaryName = newName ?? nameOf(primary.value) ?? UNSORTED_STYLE_NAME
  const secondaryName = nameOf(secondary.value)
  return {
    primary: primaryName,
    secondary: secondaryName === primaryName ? null : secondaryName
  }
}

/** The style folder a track goes into: its primary style, or Unsorted. */
export function styleFolderOf(
  track: Track,
  proposal: Proposal & Record<string, unknown>,
  details: OrganizeDetails
): string {
  return folderNameOf(styleNamesOf(track, proposal, details).primary) ?? UNSORTED_STYLE_NAME
}

/**
 * The comment the app writes: the energy (`E7`) and the secondary style, those of
 * them there are, joined by ` | `. Empty when there is neither. The tag and the
 * Rekordbox XML say the same.
 */
export function styleComment(energy: number | null, secondary: string | null): string {
  return [energy === null ? null : `E${energy}`, secondary]
    .filter((part): part is string => part !== null)
    .join(' | ')
}

/**
 * The genre and the comment a track's tag is to hold when the batch organizes it:
 * the primary style as the genre, and as the comment the energy (`E7`) and the
 * secondary style, those of them there are, joined by ` | `. Nothing when the batch
 * does not organize, and no comment when there is nothing to say: a comment is never
 * taken away for nothing.
 */
export function styleTagsFor(
  track: Track,
  proposal: Proposal & Record<string, unknown>,
  details: OrganizeDetails | null = organizeDetailsOf(proposal)
): Pick<TagFields, 'genre' | 'comment'> {
  if (!details) return {}
  const names = styleNamesOf(track, proposal, details)
  const energy = fieldOf(track, proposal, 'energy', track.energy).value
  const comment = styleComment(typeof energy === 'number' ? energy : null, names.secondary)
  const fields: Pick<TagFields, 'genre' | 'comment'> = {}
  // Field by field: a value a tag cannot hold must not keep the other out.
  const genre = tagFieldsSchema.safeParse({ genre: names.primary })
  if (genre.success) fields.genre = genre.data.genre
  if (comment !== '') {
    const checked = tagFieldsSchema.safeParse({ comment })
    if (checked.success) fields.comment = checked.data.comment
  }
  return fields
}
