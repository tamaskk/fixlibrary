// The main <-> Python sidecar contract: JSON-RPC 2.0, one JSON document per line.
// python/fixlib_py mirrors these methods by hand; change both sides in the same commit.
import { z } from 'zod'
import { COVER_NAMES } from './covers'
import { CAMELOT_KEYS, KEY_SCALES, keyOf } from './keys'

/** How many files one `tags.read` call may name. The same limit is in fixlib_py/tags.py. */
export const TAG_BATCH_SIZE = 40

// Tag text comes out of a file, so it is untrusted. The sidecar cuts it to one line of
// at most this length without characters that reverse the reading direction; main
// does not take the sidecar's word for it and refuses anything else. The length limit
// also keeps the largest possible answer for one batch below the line limit of the bridge.
const UNSAFE_TAG_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const tagText = z
  .string()
  .min(1)
  .max(300)
  .refine((text) => !UNSAFE_TAG_TEXT.test(text), { message: 'Tag text must be one clean line' })
  .nullable()
const positiveInt = z.number().int().positive().nullable()

export const fileTagsSchema = z.object({
  path: z.string().min(1),
  /** False for a file that is missing, damaged or not one of the app's formats. */
  readable: z.boolean(),
  durationMs: positiveInt,
  bitrateKbps: positiveInt,
  sampleRateHz: positiveInt,
  artist: tagText,
  title: tagText,
  album: tagText,
  label: tagText,
  year: z.number().int().min(1000).max(9999).nullable(),
  /** The first genre of the tag (TCON), an ID3v1 number named; at most 100 UTF-16 units. */
  genre: tagText.refine((text) => text === null || text.length <= 100),
  hasCover: z.boolean()
})

export type FileTags = z.output<typeof fileTagsSchema>

/**
 * Names the algorithm behind `analysis.bpm_key`. It is stored with every result, and
 * a track is analysed again only when it changes. The same text is ANALYZER_VERSION
 * in fixlib_py/analysis/bpm_key.py.
 */
export const BPM_KEY_ANALYZER_VERSION = 'essentia-2.1b6-multifeature-edma-1'

/**
 * Names the model and the envelopes behind `analysis.stems`. It is stored with every
 * result, and a track is separated again only when it changes. The same text is
 * ANALYZER_VERSION in fixlib_py/analysis/stems.py.
 */
export const STEMS_ANALYZER_VERSION = 'htdemucs-8726e21a-rms100ms-1'

/**
 * Names the measure behind `analysis.loudness`: EBU R128 by ffmpeg's `ebur128`. It is
 * stored with every result, and a track is measured again only when it changes.
 */
export const LOUDNESS_ANALYZER_VERSION = 'ffmpeg-ebur128-1'

/** What `analysis.loudness` found: the values, or why a file has none. */
export const loudnessResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('measured'),
    /** The integrated loudness, in LUFS; above the gate of −70 LUFS. */
    integratedLufs: z.number().gt(-70).max(10),
    /** The true peak, in dBTP. */
    truePeakDbtp: z.number().min(-200).max(30),
    /** The loudness range, in LU. */
    lra: z.number().nonnegative().max(100)
  }),
  z.object({
    status: z.literal('unreadable'),
    /** Silent, not decodable, no regular file, or no audio format of the app. */
    reason: z.enum(['silent', 'decode', 'file', 'format'])
  })
])

export type LoudnessResult = z.output<typeof loudnessResultSchema>

/** How the sidecar is to change a file's loudness (src/shared/normalize.ts plans it). */
export const normalizeApplyPlanSchema = z.discriminatedUnion('kind', [
  /** An MP3 in steps of 1.5 dB by mp3gain, the audio not encoded again. */
  z.object({
    kind: z.literal('mp3gain'),
    steps: z
      .number()
      .int()
      .min(-26)
      .max(26)
      .refine((steps) => steps !== 0)
  }),
  /** The samples of an AIFF or a WAV, by the exact gain. */
  z.object({
    kind: z.literal('pcm'),
    gainDb: z
      .number()
      .min(-40)
      .max(40)
      .refine((gain) => gain !== 0)
  }),
  /** An MP3 encoded again at 320 kbps with the exact gain, its tag carried over. */
  z.object({
    kind: z.literal('reencode'),
    gainDb: z
      .number()
      .min(-40)
      .max(40)
      .refine((gain) => gain !== 0)
  })
])

export type NormalizeApplyPlan = z.output<typeof normalizeApplyPlanSchema>

export const stemsResultSchema = z.object({
  /** The name of the envelopes in the stems folder: the track's id. */
  file: z.string().regex(/^[1-9][0-9]{0,15}\.npz$/u),
  /** How many 100 ms windows: 20 minutes at most. */
  frames: z.number().int().positive().max(12_000),
  bytes: z.number().int().positive(),
  /** How long the separation took, for the estimate of what is left. */
  seconds: z.number().nonnegative(),
  /** How much of the track was separated: 20 minutes at most. */
  durationSeconds: z
    .number()
    .positive()
    .max(20 * 60),
  /** True when the track is longer, and only its first 20 minutes have envelopes. */
  truncated: z.boolean(),
  analyzerVersion: z.literal(STEMS_ANALYZER_VERSION)
})

export type StemsResult = z.output<typeof stemsResultSchema>

/**
 * Names the rules behind `analysis.structure`. It is stored with every result. The same
 * text is ANALYZER_VERSION in fixlib_py/analysis/structure.py.
 */
export const STRUCTURE_ANALYZER_VERSION = 'structure-house-1'

/**
 * The bounds of a grid of Rekordbox, wherever it is read, kept or written back: the
 * two hours a track may last, the tempos Rekordbox offers, and a marker per tempo
 * change, which a real track has a few of.
 */
export const GRID_BOUNDS = {
  maxSeconds: 2 * 60 * 60,
  minBpm: 20,
  maxBpm: 999,
  maxBattito: 16,
  maxMarkers: 4000,
  metro: /^\d{1,2}\/\d{1,2}$/u
} as const

/** One beat marker of Rekordbox's grid, as `rb_grid` keeps it and the sidecar takes it. */
export const gridMarkerSchema = z.object({
  inizio: z.number().nonnegative().max(GRID_BOUNDS.maxSeconds),
  bpm: z.number().min(GRID_BOUNDS.minBpm).max(GRID_BOUNDS.maxBpm),
  metro: z.string().regex(GRID_BOUNDS.metro),
  battito: z.number().int().min(1).max(GRID_BOUNDS.maxBattito)
})

/** A whole grid: a track whose grid breaks a bound has none, never part of one. */
export const gridSchema = z.array(gridMarkerSchema).max(GRID_BOUNDS.maxMarkers)

export const structureResultSchema = z.object({
  /** The slots found, 1 (A Start) to 8 (H Drop 3), each at a beat of the grid. */
  cues: z
    .array(
      z.object({
        slot: z.number().int().min(1).max(8),
        timeSec: z
          .number()
          .nonnegative()
          .max(2 * 60 * 60)
      })
    )
    .max(8)
    .refine((cues) => new Set(cues.map((cue) => cue.slot)).size === cues.length),
  /** True when a slot was emptied because it broke the order of the scheme. */
  review: z.boolean(),
  instrumental: z.boolean(),
  analyzerVersion: z.literal(STRUCTURE_ANALYZER_VERSION)
})

export type StructureResult = z.output<typeof structureResultSchema>

export const bpmKeyResultSchema = z
  .object({
    /** The tempo inside the range that was asked for, moved there by octaves. */
    bpm: z.number().positive().max(1000),
    /** The tempo as it was measured. */
    rawBpm: z.number().positive().max(10_000),
    /** Essentia's own scale: below 1.5 is a weak guess, above 3.5 a sure one. */
    bpmConfidence: z.number().min(0).max(10),
    keyName: z.string().min(1).max(2),
    scale: z.enum(KEY_SCALES),
    keyStrength: z.number().min(-1).max(1),
    camelot: z.enum(CAMELOT_KEYS),
    musical: z.string().min(1).max(3),
    // A sidecar that runs another algorithm than this build expects is a bug of the
    // build; its results must not be stored under this build's version.
    analyzerVersion: z.literal(BPM_KEY_ANALYZER_VERSION)
  })
  // Both sides hold the table of keys; an answer they disagree on is not taken.
  .refine((result) => {
    const key = keyOf(result.keyName, result.scale)
    return key !== null && key.camelot === result.camelot && key.musical === result.musical
  })

export type BpmKeyResult = z.output<typeof bpmKeyResultSchema>

export const fingerprintResultSchema = z.object({
  /** As fpcalc prints it: URL-safe base64. The same limit is in fixlib_py/fingerprint.py. */
  fingerprint: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z0-9_-]+$/),
  /** The length of the whole track in seconds, as AcoustID asks for it. */
  duration: z.number().int().min(1).max(86_400)
})

export type Fingerprint = z.output<typeof fingerprintResultSchema>

/** The most a result of `convert.wav_to_aiff` may hold: what every Pioneer player takes. */
export const MAX_CONVERTED_SAMPLE_RATE = 48_000

export const convertResultSchema = z.object({
  sampleRateHz: z.number().int().positive().max(MAX_CONVERTED_SAMPLE_RATE),
  bitDepth: z.union([z.literal(16), z.literal(24)]),
  channels: z.number().int().min(1).max(8),
  durationMs: z.number().int().positive(),
  /** False when the file held the result already and was only copied. */
  converted: z.boolean(),
  /**
   * The ids of the tag frames of the source that the result does not hold: frames
   * that ID3v2.3 has no place for, and frames no reader of the app knows.
   */
  tagsLost: z.array(z.string().regex(/^[A-Z0-9]{3,4}$/)).max(32)
})

export type ConvertResult = z.output<typeof convertResultSchema>

const writtenText = z
  .string()
  .min(1)
  .max(300)
  .refine((text) => !UNSAFE_TAG_TEXT.test(text), { message: 'Tag text must be one clean line' })
  // As the sidecar reads it back: no space at an end, none doubled, and no half of a
  // pair of code units, which cannot be written as UTF-16.
  .refine((text) => text === text.replace(/\s+/gu, ' ').trim() && text.isWellFormed(), {
    message: 'Tag text must be written as it will read back'
  })

/**
 * The tags `tags.write` can write. A field that is not named stays as it is in the
 * file; none can be taken away. The same rules are in fixlib_py/tag_write.py.
 */
export const tagFieldsSchema = z
  .strictObject({
    artist: writtenText,
    /** With the mix in brackets, as a tag holds a title. */
    title: writtenText,
    album: writtenText,
    label: writtenText,
    year: z.number().int().min(1000).max(9999),
    bpm: z.number().int().min(20).max(400),
    /** The musical name of the key, as ID3 writes one: `Am`, `F#m`. */
    key: z.string().regex(/^[A-G][#b]?m?$/),
    /** The primary style, as the genre (TCON). */
    genre: writtenText,
    /**
     * The one comment (COMM) of the file, in place of every comment it held: the
     * energy and the secondary style, `E7 | Melodic House`.
     */
    comment: writtenText,
    /**
     * The name of a cover the app made in its covers folder, to be the one front
     * cover of the file. The sidecar reads it as a 600 × 600 JPEG before it writes it.
     */
    cover: z.string().regex(COVER_NAMES.cover)
  })
  .partial()

export type TagFields = z.output<typeof tagFieldsSchema>

const pixels = z.number().int().positive().max(1_000_000)

/** The cover a file holds: `null` when it has none, and no size when it cannot be decoded. */
export const coverInspectResultSchema = z.object({
  cover: z
    .object({
      width: pixels.nullable(),
      height: pixels.nullable(),
      thumb: z.string().regex(COVER_NAMES.thumb).nullable(),
      /** True for a placeholder the app drew: a later run looks for a real cover again. */
      placeholder: z.boolean(),
      /**
       * True for a real picture the app does not decode (larger than it decodes, or a
       * GIF, BMP, TIFF or WebP), as opposed to damaged bytes.
       */
      other: z.boolean()
    })
    .nullable()
})

export type CoverInspectResult = z.output<typeof coverInspectResultSchema>

/** What a placeholder shows: the same text on the same colour is the same cover. */
export const placeholderSpecSchema = z.object({
  artist: writtenText.nullable(),
  title: writtenText.nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/)
})
export type PlaceholderSpec = z.output<typeof placeholderSpecSchema>

export const coverPrepareResultSchema = z.object({
  cover: z.string().regex(COVER_NAMES.cover),
  thumb: z.string().regex(COVER_NAMES.thumb),
  /** The size of the picture as it was downloaded. */
  width: pixels,
  height: pixels
})

export const RPC_SCHEMAS = {
  ping: {
    params: z.object({}),
    result: z.object({ version: z.string() })
  },
  echo: {
    params: z.object({ value: z.json() }),
    result: z.object({ value: z.json() })
  },
  shutdown: {
    params: z.object({}),
    result: z.null()
  },
  /** Asks a running job to stop. `cancelled` is false when no such job is running. */
  'job.cancel': {
    params: z.object({ jobId: z.string().min(1).max(64) }),
    result: z.object({ cancelled: z.boolean() })
  },
  'tags.read': {
    params: z.object({ paths: z.array(z.string().min(1)).min(1).max(TAG_BATCH_SIZE) }),
    // One entry per path, in input order. Each entry is checked on its own with
    // `fileTagsSchema` by the caller, so one bad entry cannot reject the others.
    result: z.object({ files: z.array(z.unknown()).max(TAG_BATCH_SIZE) })
  },
  /** Whether writing these tags would change the file. Reads the file only. */
  'tags.would_change': {
    params: z.object({ path: z.string().min(1), fields: tagFieldsSchema }),
    result: z.object({ changed: z.boolean() })
  },
  /**
   * Writes the named tags as ID3v2.3 into a copy of `src` at `dst`, a temp file the
   * file rules of the app named, and reads them back before it answers.
   */
  'tags.write': {
    params: z.object({
      src: z.string().min(1),
      dst: z.string().min(1),
      fields: tagFieldsSchema,
      jobId: z.string().min(1).max(64)
    }),
    result: z.object({ written: z.literal(true) })
  },
  /**
   * The size of the cover a file holds, and a thumbnail of it in the covers folder.
   * Reads the file only.
   */
  'cover.inspect': {
    params: z.object({ path: z.string().min(1) }),
    result: coverInspectResultSchema
  },
  /**
   * Makes the 600 × 600 JPEG and the thumbnail of a downloaded picture in the covers
   * folder, under the hash of the download. Touches nothing outside that folder.
   */
  'cover.prepare': {
    params: z.object({
      source: z.string().regex(COVER_NAMES.download),
      /** A picture the user chose, which may also be a WebP. */
      manual: z.boolean().optional()
    }),
    result: coverPrepareResultSchema
  },
  /**
   * Draws the placeholder cover of a track (its artist and title on a colour) and its
   * thumbnail into the covers folder. Touches nothing outside that folder.
   */
  'cover.placeholder': {
    params: placeholderSpecSchema,
    result: z.object({
      cover: z.string().regex(COVER_NAMES.cover),
      thumb: z.string().regex(COVER_NAMES.thumb)
    })
  },
  /** Measures tempo and key from the audio of one file. Reads the file only. */
  'analysis.bpm_key': {
    params: z.object({
      path: z.string().min(1),
      jobId: z.string().min(1).max(64),
      bpmMin: z.number(),
      bpmMax: z.number()
    }),
    result: bpmKeyResultSchema
  },
  /** The loudness of one file by EBU R128. Reads the file only. */
  'analysis.loudness': {
    params: z.object({
      path: z.string().min(1),
      jobId: z.string().min(1).max(64)
    }),
    result: loudnessResultSchema
  },
  /**
   * Writes `src` with its loudness changed by the plan into `dst`, a temp file the file
   * rules of the app named. A linear gain only, never a limiter.
   */
  'normalize.apply': {
    params: z.object({
      src: z.string().min(1),
      dst: z.string().min(1),
      plan: normalizeApplyPlanSchema,
      jobId: z.string().min(1).max(64)
    }),
    result: z.object({ written: z.literal(true) })
  },
  /**
   * Writes a WAV as an AIFF to `dst`, a temp file the file rules of the app named.
   * Reads `src`, writes `dst`, and touches nothing else.
   */
  'convert.wav_to_aiff': {
    params: z.object({
      src: z.string().min(1),
      dst: z.string().min(1),
      jobId: z.string().min(1).max(64)
    }),
    result: convertResultSchema
  },
  /**
   * Separates one file into stems and keeps them as envelopes in the stems folder, under
   * the track's id. Reads the file, writes only that file of the stems folder.
   */
  'analysis.stems': {
    params: z.object({
      path: z.string().min(1),
      trackId: z.number().int().positive(),
      jobId: z.string().min(1).max(64)
    }),
    result: stemsResultSchema
  },
  /**
   * The eight hot cues of a track from its stem envelopes (read from the stems folder by
   * the track's id) and Rekordbox's grid. Reads only.
   */
  'analysis.structure': {
    params: z.object({
      trackId: z.number().int().positive(),
      grid: gridSchema.min(1),
      durationSeconds: z
        .number()
        .positive()
        .max(2 * 60 * 60)
    }),
    result: structureResultSchema
  },
  /** The AcoustID fingerprint of one file. Reads the file only. */
  'fingerprint.compute': {
    params: z.object({ path: z.string().min(1), jobId: z.string().min(1).max(64) }),
    result: fingerprintResultSchema
  }
} as const

export type RpcMethods = {
  [M in keyof typeof RPC_SCHEMAS]: {
    params: z.input<(typeof RPC_SCHEMAS)[M]['params']>
    result: z.output<(typeof RPC_SCHEMAS)[M]['result']>
  }
}

export type RpcMethod = keyof RpcMethods

const rpcIdSchema = z.number().int()

const rpcErrorResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  // null when the sidecar could not read the id of a broken request.
  id: rpcIdSchema.nullable(),
  error: z.object({ code: z.number().int(), message: z.string() })
})

const rpcResultResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: rpcIdSchema,
  result: z.unknown()
})

const rpcProgressSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('progress'),
  params: z.object({ jobId: z.string().min(1), percent: z.number().min(0).max(100) })
})

export type RpcProgress = z.output<typeof rpcProgressSchema>['params']

export type RpcMessage =
  | { kind: 'result'; id: number; result: unknown }
  | { kind: 'error'; id: number | null; code: number; message: string }
  | { kind: 'progress'; progress: RpcProgress }

export function encodeRpcRequest(id: number, method: RpcMethod, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
}

/** Reads one line from the sidecar. Returns null for anything that is not a valid message. */
export function parseRpcLine(line: string): RpcMessage | null {
  let payload: unknown
  try {
    payload = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null

  if ('error' in payload) {
    const parsed = rpcErrorResponseSchema.safeParse(payload)
    if (!parsed.success) return null
    const { id, error } = parsed.data
    return { kind: 'error', id, code: error.code, message: error.message }
  }
  if ('result' in payload) {
    const parsed = rpcResultResponseSchema.safeParse(payload)
    return parsed.success
      ? { kind: 'result', id: parsed.data.id, result: parsed.data.result }
      : null
  }
  const parsed = rpcProgressSchema.safeParse(payload)
  return parsed.success ? { kind: 'progress', progress: parsed.data.params } : null
}
