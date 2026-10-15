// The settings contract between the renderer and the main process, with the defaults.
// The main process validates everything with these schemas; the renderer only displays.
import { z } from 'zod'
import { DUPLICATES_FOLDER } from './duplicates'
import type { XmlFolderWarning } from './rekordbox'

export const LIBRARY_MODES = ['in_place', 'clean_library'] as const
export const NORMALIZATION_METHODS = ['lossless', 'exact'] as const
export const LOUDNESS_PRESETS_LUFS = [-11, -8] as const
export const HOT_CUE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const
export const FOLDER_KINDS = [
  'libraryRoot',
  'cleanLibrary',
  'backup',
  'generatedXml',
  'exportedXml'
] as const
export const SECRET_NAMES = ['acoustid', 'discogsKey', 'discogsSecret'] as const
export const KEY_SERVICES = ['acoustid', 'discogs'] as const

/** The style that holds tracks the classifier is unsure about. It cannot be removed. */
export const UNSORTED_STYLE_NAME = 'Unsorted'
/** The folder the backups of a batch go to by default, next to the library. */
export const BACKUP_FOLDER_NAME = 'FixLibrary Backups'
/** Where new downloads arrive (T-034). */
export const INBOX_FOLDER_NAME = 'Inbox'
/** The folders of the app's own: no style may be named like one, as styles become folders. */
export const APP_FOLDER_NAMES = [DUPLICATES_FOLDER, BACKUP_FOLDER_NAME, INBOX_FOLDER_NAME]
/** How many styles the list may hold. */
export const MAX_STYLES = 50
/** How many new styles one batch may create; what it names beyond them stays Unsorted. */
export const NEW_STYLES_PER_BATCH = 5

export type LibraryMode = (typeof LIBRARY_MODES)[number]
export type NormalizationMethod = (typeof NORMALIZATION_METHODS)[number]
export type FolderKind = (typeof FOLDER_KINDS)[number]
export type SecretName = (typeof SECRET_NAMES)[number]
export type KeyService = (typeof KEY_SERVICES)[number]

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)
// A folder is chosen in a dialog of the main process; null means "not chosen, use the default".
const folderSchema = z.string().min(1).nullable()

// Names end up as folder names and in Rekordbox XML: one composed spelling, single
// spaces, and nothing a reader cannot see or XML cannot hold. `\p{C}` covers control
// and format characters, lone surrogates, private-use and unassigned code points;
// this also refuses joiners, so an emoji sequence is not a valid name.
function nameSchema(maxLength: number): z.ZodType<string, string> {
  return z
    .string()
    .transform((name) =>
      name
        .normalize('NFC')
        .replace(/\p{Zs}+/gu, ' ')
        .trim()
    )
    .pipe(
      z
        .string()
        .min(1)
        .max(maxLength)
        // The last four are letters by category but show nothing (Hangul fillers).
        .refine((name) => !/[\p{C}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0]/u.test(name), {
          message: 'A name must not contain control or invisible characters'
        })
        .refine((name) => /[\p{L}\p{N}]/u.test(name), {
          message: 'A name must contain a letter or a digit'
        })
    )
}

const hotCueSchema = z.object({
  name: nameSchema(24),
  color: hexColorSchema
})

/**
 * The bounds of the tempo range. The same numbers are in fixlib_py/analysis/bpm_key.py.
 */
export const BPM_MIN_LIMITS = { min: 40, max: 150 } as const
export const BPM_MAX_LIMITS = { min: 80, max: 300 } as const

const analysisSchema = z
  .object({
    /** A measured tempo below this is doubled until it is inside the range. */
    bpmMin: z.number().int().min(BPM_MIN_LIMITS.min).max(BPM_MIN_LIMITS.max),
    /** A measured tempo above this is halved until it is inside the range. */
    bpmMax: z.number().int().min(BPM_MAX_LIMITS.min).max(BPM_MAX_LIMITS.max)
  })
  // The range must hold a whole octave: in a narrower one a tempo could be doubled
  // out of its top and halved out of its bottom, and would have no place.
  .refine((range) => range.bpmMax >= 2 * range.bpmMin, {
    message: 'The tempo range must hold a whole octave'
  })

export const settingsSchema = z.object({
  library: z.object({
    rootFolder: folderSchema,
    mode: z.enum(LIBRARY_MODES),
    cleanLibraryFolder: folderSchema,
    backupFolder: folderSchema
  }),
  rekordbox: z.object({
    /** Where the app writes the XML that Rekordbox imports. */
    generatedXmlFolder: folderSchema,
    /** Where the user saves the XML exported from Rekordbox. */
    exportedXmlFolder: folderSchema
  }),
  loudness: z.object({
    targetLufs: z.number().min(-23).max(-5),
    method: z.enum(NORMALIZATION_METHODS)
  }),
  hotCues: z.array(hotCueSchema).length(HOT_CUE_LETTERS.length),
  performance: z.object({
    /** null: one less than the number of CPU cores. */
    workerCount: z.number().int().min(1).max(64).nullable()
  }),
  analysis: analysisSchema
})

export type Settings = z.output<typeof settingsSchema>

/** What the renderer may change directly. Folders are missing on purpose: see pickFolder. */
export const settingsPatchSchema = z.strictObject({
  library: z.strictObject({ mode: z.enum(LIBRARY_MODES) }).optional(),
  loudness: settingsSchema.shape.loudness.partial().strict().optional(),
  hotCues: settingsSchema.shape.hotCues.optional(),
  performance: settingsSchema.shape.performance.strict().optional(),
  // Both ends at once: one end alone could not be checked against the other.
  analysis: z.strictObject({ bpmMin: z.number(), bpmMax: z.number() }).optional()
})

export type SettingsPatch = z.input<typeof settingsPatchSchema>

export const DEFAULT_SETTINGS: Settings = {
  library: {
    rootFolder: null,
    // The originals stay untouched unless the user chooses otherwise.
    mode: 'clean_library',
    cleanLibraryFolder: null,
    backupFolder: null
  },
  rekordbox: { generatedXmlFolder: null, exportedXmlFolder: null },
  loudness: { targetLufs: -11, method: 'lossless' },
  // The fixed scheme of the product spec; the colors mirror the --color-cue-* tokens.
  hotCues: [
    { name: 'Start', color: '#22c55e' },
    { name: 'Bassline', color: '#22d3ee' },
    { name: 'Vocal', color: '#a855f7' },
    { name: 'Drop 1', color: '#ef4444' },
    { name: 'Breakdown', color: '#3b82f6' },
    { name: 'Drop 2', color: '#f97316' },
    { name: 'Outro', color: '#eab308' },
    { name: 'Drop 3', color: '#ec4899' }
  ],
  performance: { workerCount: null },
  // House at half its tempo is doubled into the range; 174 drum and bass stays.
  analysis: { bpmMin: 85, bpmMax: 175 }
}

/** The values in use where a setting is left at its default. */
export interface EffectiveSettings {
  backupFolder: string | null
  generatedXmlFolder: string
  /** Why the folder of the generated XML is a poor place for it, or null. */
  generatedXmlWarning: XmlFolderWarning
  exportedXmlFolder: string
  workerCount: number
}

export interface SettingsSnapshot {
  settings: Settings
  effective: EffectiveSettings
}

// A style name becomes a folder name in the library.
export const styleNameSchema = nameSchema(40).refine(
  (name) =>
    // What a folder name may not hold on any drive the library can be on (exFAT
    // refuses `* ? < > | "`), nor end in, nor be: a folder of the app's own.
    !/[/\\:*?<>|"]/.test(name) &&
    !name.startsWith('.') &&
    !name.endsWith('.') &&
    !APP_FOLDER_NAMES.some((folder) => styleKey(folder) === styleKey(name)),
  {
    message: 'A style name must be usable as a folder name'
  }
)

export const styleInputSchema = z.strictObject({
  /** Missing for a style that does not exist yet. */
  id: z.number().int().positive().optional(),
  name: styleNameSchema,
  color: hexColorSchema,
  isHouse: z.boolean()
})

/** The whole list, in display order. Saving replaces the stored list with it. */
export const styleListSchema = z
  .array(styleInputSchema)
  .min(1)
  .max(MAX_STYLES)
  .refine(
    (styles) => new Set(styles.map((style) => style.name.toLowerCase())).size === styles.length,
    {
      message: 'Style names must be unique'
    }
  )
  .refine(
    (styles) => {
      const ids = styles.flatMap((style) => (style.id === undefined ? [] : [style.id]))
      return new Set(ids).size === ids.length
    },
    { message: 'A style may appear in the list only once' }
  )
  .refine((styles) => styles.filter((style) => style.name === UNSORTED_STYLE_NAME).length === 1, {
    message: `The list must contain ${UNSORTED_STYLE_NAME} exactly once`
  })

export type StyleInput = z.input<typeof styleInputSchema>

export interface Style {
  id: number
  name: string
  color: string
  isHouse: boolean
}

/**
 * A style name as names are compared: without case, spaces, hyphens and the like, so
 * that `Tech-House` and `tech house` are the one style `Tech House`.
 */
export function styleKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_.·]+/gu, '')
}

// Folder names a style the app names must not take: they are the app's own folders.
const RESERVED_STYLE_NAMES = [...APP_FOLDER_NAMES, UNSORTED_STYLE_NAME]

/**
 * A name of a style the app creates from what Claude named: stricter than a name the
 * user types, because it comes from untrusted text and becomes a folder. A common
 * genre name: plain letters and digits, spaces, `&`, `'`, `+` and `-`, at most 30
 * characters and four words, no name of a folder of the app's own.
 */
export const newStyleNameSchema = z
  .string()
  .transform((name) => name.trim().replace(/\s+/gu, ' '))
  .pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9 &'+-]{0,29}$/u)
      .refine((name) => name.split(' ').length <= 4)
      .refine(
        (name) => !RESERVED_STYLE_NAMES.some((reserved) => styleKey(reserved) === styleKey(name))
      )
  )

/**
 * The new styles a batch may create, of those its rows name in their order: the first
 * five, as names are compared. Main and the page apply the same rule.
 */
export function newStylesTaken(names: readonly string[]): string[] {
  const taken = new Map<string, string>()
  for (const name of names) {
    const key = styleKey(name)
    if (!taken.has(key) && taken.size < NEW_STYLES_PER_BATCH) taken.set(key, name)
  }
  return [...taken.values()]
}

/** The color a style gets when it is added; the user picks its own afterwards. */
export const NEW_STYLE_COLOR = '#9a9aa3'

/**
 * The colors a style the app adds gets, in turn: the first no style has yet. They are
 * the default cue colors (DESIGN_SYSTEM §02); a style's color is data, shown with its hex.
 */
export const NEW_STYLE_PALETTE = [
  '#22c55e',
  '#22d3ee',
  '#a855f7',
  '#ef4444',
  '#3b82f6',
  '#f97316',
  '#eab308',
  '#ec4899'
] as const

export const DEFAULT_STYLES: readonly Omit<Style, 'id'>[] = [
  { name: 'Afro House', color: '#f97316', isHouse: true },
  { name: 'Organic House', color: '#22c55e', isHouse: true },
  { name: 'Melodic House', color: '#a855f7', isHouse: true },
  { name: 'Tech House', color: '#3b82f6', isHouse: true },
  { name: 'Latin House', color: '#ef4444', isHouse: true },
  { name: UNSORTED_STYLE_NAME, color: '#9a9aa3', isHouse: false }
]

export const secretInputSchema = z.strictObject({
  name: z.enum(SECRET_NAMES),
  // API keys are short tokens without spaces or control characters.
  value: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\x21-\x7e]+$/)
})

/**
 * Where a secret comes from. The value itself never leaves the main process.
 *
 * - `stored`: saved from the Settings page, encrypted;
 * - `env`: taken from the development env file;
 * - `unreadable`: saved, but this build of the app cannot decrypt it;
 * - `missing`: not set.
 */
export type SecretSource = 'stored' | 'env' | 'unreadable' | 'missing'
export type SecretStatus = Record<SecretName, SecretSource>

/**
 * - `unreachable`: the service could not be asked, so nothing is known about the key;
 * - `throttled`: asked again too soon, so no request was made.
 */
export type KeyTestResult = 'valid' | 'invalid' | 'missing' | 'unreachable' | 'throttled'
